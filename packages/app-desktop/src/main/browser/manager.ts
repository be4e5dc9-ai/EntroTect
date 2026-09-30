import { BrowserWindow, WebContentsView, nativeImage, session, type NativeImage, type Session } from "electron";
import { createHash, randomUUID } from "node:crypto";
import {
  browserCommandSchema,
  type BrowserCommand, type BrowserExtraction, type BrowserReply,
  type BrowserSnapshot, type BrowserTabState, type BrowserViewport,
} from "@entrotect/shared";
import { assertBrowserDestination, isAllowedEmbeddedScheme, normalizeBrowserUrl } from "./security.js";
import { extractionScript, interactionScript, pressGuardScript, snapshotScript } from "./scripts.js";

export interface BrowserAuthorization {
  sessionId: string;
  action: "browser.navigate" | "browser.interact" | "browser.read";
  url: string;
  reason?: string;
}
export interface BrowserManagerDeps {
  getWindow: () => BrowserWindow | null;
  onChange: (sessionId: string, tabs: BrowserTabState[]) => void;
  authorize?: (request: BrowserAuthorization) => Promise<boolean>;
}
interface ManagedTab {
  id: string;
  sessionId: string;
  view: WebContentsView;
  generation: string;
  error?: string;
  userInitiated: boolean;
  authorizedNavigations: Set<string>;
  abortSignal?: AbortSignal;
  initializing: boolean;
  bounds: BrowserViewport;
}
interface BrowserTask {
  session: Session;
  privateOrigins: Set<string>;
  tabs: Map<string, ManagedTab>;
  downloadHandler?: (event: { preventDefault(): void }, item: unknown, contents: { id: number }) => void;
}

const WORLD_ID = 1819;
const MAX_TABS = 12;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("浏览器操作已取消。")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, ms);
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Owns remote renderers. None of these views receives the application's preload. */
export class BrowserManager {
  private readonly tasks = new Map<string, BrowserTask>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly closedSessions = new Set<string>();
  private readonly sessionAbort = new Map<string, AbortController>();
  private attached: { tab: ManagedTab; window: BrowserWindow } | null = null;
  private readonly capturing = new Set<ManagedTab>();
  private viewportRequest: { sessionId: string; tabId: string; bounds: BrowserViewport | null } | null = null;
  private disposed = false;

  constructor(private readonly deps: BrowserManagerDeps) {}

  list(sessionId: string): BrowserTabState[] {
    return [...(this.tasks.get(sessionId)?.tabs.values() ?? [])]
      .filter((tab) => !tab.view.webContents.isDestroyed())
      .map((tab) => this.state(tab));
  }

  /** May ONLY be called after an explicit user confirmation in trusted application UI. */
  grantPrivateOrigin(sessionId: string, rawUrl: string): void {
    this.task(sessionId).privateOrigins.add(normalizeBrowserUrl(rawUrl).origin);
  }

  hasPrivateOrigin(sessionId: string, rawUrl: string): boolean {
    return this.tasks.get(sessionId)?.privateOrigins.has(normalizeBrowserUrl(rawUrl).origin) ?? false;
  }

  async execute(sessionId: string, rawCommand: BrowserCommand, options: { userInitiated?: boolean; abortSignal?: AbortSignal } = {}): Promise<BrowserReply> {
    const parsed = browserCommandSchema.safeParse(rawCommand);
    if (!parsed.success) return { ok: false, tabs: this.list(sessionId), error: "浏览器命令参数不合法。" };
    if (this.disposed || this.closedSessions.has(sessionId)) return { ok: false, tabs: this.list(sessionId), error: "对话已关闭。" };
    const sessionController = this.sessionAbort.get(sessionId) ?? new AbortController();
    this.sessionAbort.set(sessionId, sessionController);
    const abortSignal = options.abortSignal ? AbortSignal.any([sessionController.signal, options.abortSignal]) : sessionController.signal;
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      try {
        if (this.disposed) throw new Error("浏览器已关闭。");
        if (this.closedSessions.has(sessionId)) throw new Error("对话已关闭。");
        abortSignal.throwIfAborted();
        return await this.run(sessionId, parsed.data, !!options.userInitiated, abortSignal);
      } catch (error) {
        return { ok: false, tabs: this.list(sessionId), error: error instanceof Error ? error.message : String(error) };
      } finally {
        // A command's approval must not authorize later page-triggered navigations.
        for (const tab of this.tasks.get(sessionId)?.tabs.values() ?? []) {
          tab.userInitiated = false;
          tab.abortSignal = undefined;
          tab.authorizedNavigations.clear();
        }
      }
    });
    this.queues.set(sessionId, work);
    try { return await work; }
    finally { if (this.queues.get(sessionId) === work) this.queues.delete(sessionId); }
  }

  setViewport(sessionId: string, tabId: string, bounds: BrowserViewport | null): void {
    this.viewportRequest = { sessionId, tabId, bounds };
    const tab = this.tasks.get(sessionId)?.tabs.get(tabId);
    if (!bounds || !tab || tab.view.webContents.isDestroyed()) { this.detach(); return; }
    if (this.capturing.has(tab)) return;
    const window = this.deps.getWindow();
    if (!window || window.isDestroyed()) return;
    const [width = 0, height = 0] = window.getContentSize();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return;
    const x = Math.max(0, Math.min(Math.round(bounds.x), width));
    const y = Math.max(0, Math.min(Math.round(bounds.y), height));
    const w = Math.min(Math.max(0, Math.round(bounds.width)), width - x);
    const h = Math.min(Math.max(0, Math.round(bounds.height)), height - y);
    if (w < 1 || h < 1) { this.detach(); return; }
    if (this.attached?.tab !== tab || this.attached.window !== window) {
      this.detach();
      window.contentView.addChildView(tab.view);
      this.attached = { tab, window };
    }
    tab.bounds = { x, y, width: w, height: h };
    tab.view.setBounds(tab.bounds);
    tab.view.setVisible(true);
  }

  closeSession(sessionId: string): void {
    this.closedSessions.add(sessionId);
    this.sessionAbort.get(sessionId)?.abort(new Error("对话已关闭。"));
    this.sessionAbort.delete(sessionId);
    const task = this.tasks.get(sessionId);
    if (!task) return;
    for (const tab of [...task.tabs.values()]) this.closeTab(tab);
    task.session.webRequest.onBeforeRequest(null);
    if (task.downloadHandler) task.session.removeListener("will-download", task.downloadHandler);
    this.tasks.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.tasks.keys()]) this.closeSession(id);
    for (const controller of this.sessionAbort.values()) controller.abort(new Error("浏览器已关闭。"));
    this.sessionAbort.clear();
  }

  private task(sessionId: string): BrowserTask {
    if (this.disposed || this.closedSessions.has(sessionId)) throw new Error("对话已关闭。");
    if (!sessionId || sessionId.length > 200) throw new Error("缺少有效的对话标识。");
    const existing = this.tasks.get(sessionId);
    if (existing) return existing;
    const partition = `persist:entrotect-browser-${createHash("sha256").update(sessionId).digest("hex").slice(0,32)}`;
    const ses = session.fromPartition(partition, { cache: true });
    const task: BrowserTask = { session: ses, privateOrigins: new Set(), tabs: new Map() };
    this.tasks.set(sessionId, task);
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setDevicePermissionHandler(() => false);
    task.downloadHandler = (event, _item, contents) => {
      event.preventDefault();
      const tab = [...task.tabs.values()].find((candidate) => candidate.view.webContents === contents);
      if (tab) this.fail(tab, "已阻止文件下载：当前版本尚未提供下载目录授权，请使用系统浏览器完成下载。");
    };
    ses.on("will-download", task.downloadHandler);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const tab = [...task.tabs.values()].find((candidate) => candidate.view.webContents.id === details.webContentsId);
      if (tab?.initializing && details.url === "about:blank") { callback({}); return; }
      if (details.resourceType !== "mainFrame" && isAllowedEmbeddedScheme(details.url)) { callback({}); return; }
      const checked = details.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
      void withTimeout(assertBrowserDestination(checked, task.privateOrigins), 8000, "网址解析超时。").then(async (url) => {
        if (details.resourceType === "mainFrame" && tab && !tab.userInitiated && !tab.authorizedNavigations.has(url.href)) {
          await this.authorize(tab, "browser.navigate", url.href, "网页重定向或链接导航");
          tab.authorizedNavigations.add(url.href);
        }
        callback({});
      }).catch((error) => {
        if (tab && details.resourceType === "mainFrame") this.fail(tab, error instanceof Error ? error.message : String(error));
        callback({ cancel: true });
      });
    });
    return task;
  }

  private async createTab(sessionId: string, userInitiated: boolean, abortSignal?: AbortSignal): Promise<ManagedTab> {
    const task = this.task(sessionId);
    if (task.tabs.size >= MAX_TABS) throw new Error(`每个对话最多打开 ${MAX_TABS} 个网页，请先关闭不用的标签页。`);
    const view = new WebContentsView({ webPreferences: {
      session: task.session, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false,
    } });
    view.setBounds({ x: 0, y: 0, width: 1100, height: 760 });
    view.setVisible(false);
    const tab: ManagedTab = { id: randomUUID(), sessionId, view, generation: randomUUID(), userInitiated, authorizedNavigations: new Set(), initializing: true, abortSignal, bounds: { x: 0, y: 0, width: 1100, height: 760 } };
    task.tabs.set(tab.id, tab);
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => {
      this.fail(tab, "网页尝试打开新窗口，已阻止。请复制目标链接，在地址栏打开。");
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (tab.initializing && url === "about:blank") return;
      try { normalizeBrowserUrl(url); } catch (error) { event.preventDefault(); this.fail(tab, String(error)); }
    });
    contents.on("will-frame-navigate", (event) => {
      if (event.url === "about:blank") return;
      try { normalizeBrowserUrl(event.url); } catch { event.preventDefault(); }
    });
    contents.on("did-start-loading", () => this.changed(sessionId));
    contents.on("did-stop-loading", () => this.changed(sessionId));
    contents.on("page-title-updated", () => this.changed(sessionId));
    contents.on("did-navigate", () => { tab.generation = randomUUID(); this.changed(sessionId); });
    contents.on("did-navigate-in-page", () => { tab.generation = randomUUID(); this.changed(sessionId); });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.fail(tab, tab.error || `网页加载失败：${description} (${code})`);
    });
    contents.on("render-process-gone", (_event, details) => this.fail(tab, `网页进程已退出：${details.reason}，请刷新重试。`));
    try {
      // WebContentsView creates its renderer lazily. CDP commands otherwise hang before the first document.
      await withTimeout(contents.loadURL("about:blank"), 10000, "浏览器初始化超时。", abortSignal);
      contents.debugger.attach("1.3");
      contents.debugger.on("message", (_event, method) => {
        if (method === "Page.fileChooserOpened") this.fail(tab, "已阻止文件上传：尚未提供本地文件授权选择器。");
      });
      await withTimeout(contents.debugger.sendCommand("Page.enable"), 5000, "浏览器安全控制初始化超时。", abortSignal);
      await withTimeout(contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }), 5000, "浏览器文件控制初始化超时。", abortSignal);
      tab.initializing = false;
    } catch (error) {
      this.closeTab(tab);
      throw error;
    }
    this.changed(sessionId);
    return tab;
  }

  private async run(sessionId: string, command: BrowserCommand, userInitiated: boolean, abortSignal?: AbortSignal): Promise<BrowserReply> {
    if (command.action === "list") return { ok: true, tabs: this.list(sessionId) };
    if (command.action === "open") {
      const url = await withTimeout(assertBrowserDestination(command.url, this.task(sessionId).privateOrigins), 8000, "网址解析超时。", abortSignal);
      abortSignal?.throwIfAborted();
      if (!userInitiated && (!this.deps.authorize || !await withTimeout(this.deps.authorize({ sessionId, action: "browser.navigate", url: url.href }), 300000, "浏览器导航授权等待超时。", abortSignal))) throw new Error("浏览器导航未获授权。");
      abortSignal?.throwIfAborted();
      const tab = await this.createTab(sessionId, userInitiated, abortSignal);
      tab.abortSignal = abortSignal;
      tab.authorizedNavigations.add(url.href);
      await this.load(tab, url.href);
      return { ok: true, tabs: this.list(sessionId), tabId: tab.id };
    }
    const tab = this.tasks.get(sessionId)?.tabs.get(command.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error("网页标签不存在，或不属于当前对话。请先 browser_open 或 browser_list。");
    tab.userInitiated = userInitiated;
    tab.abortSignal = abortSignal;
    tab.authorizedNavigations.clear();
    const contents = tab.view.webContents;
    const reply = (extra: Partial<BrowserReply> = {}): BrowserReply => ({ ok: true, tabs: this.list(sessionId), tabId: tab.id, ...extra });
    if (command.action === "close") { this.closeTab(tab); return reply(); }
    if (command.action === "navigate") {
      const url = await withTimeout(assertBrowserDestination(command.url, this.task(sessionId).privateOrigins), 8000, "网址解析超时。", abortSignal);
      await this.authorize(tab, "browser.navigate", url.href);
      tab.authorizedNavigations.add(url.href);
      await this.load(tab, url.href);
      return reply();
    }
    if (["back", "forward", "reload"].includes(command.action)) {
      const history = contents.navigationHistory;
      const entries = history.getAllEntries();
      const offset = command.action === "back" ? -1 : command.action === "forward" ? 1 : 0;
      const target = entries[history.getActiveIndex() + offset]?.url;
      if (!target) throw new Error("没有可跳转的历史网页。");
      const url = await withTimeout(assertBrowserDestination(target, this.task(sessionId).privateOrigins), 8000, "网址解析超时。", abortSignal);
      await this.authorize(tab, "browser.navigate", url.href);
      tab.authorizedNavigations.add(url.href);
      tab.error = undefined;
      if (command.action === "back") history.goBack();
      else if (command.action === "forward") history.goForward();
      else contents.reload();
      await this.wait(tab, undefined, 15000);
      return reply();
    }
    if (command.action === "wait") {
      if (command.text) await this.authorize(tab, "browser.read", contents.getURL());
      await this.wait(tab, command.text, command.timeoutMs ?? 10000);
      return reply();
    }
    if (["snapshot", "extract", "screenshot"].includes(command.action)) await this.authorize(tab, "browser.read", contents.getURL());
    else await this.authorize(tab, "browser.interact", contents.getURL());
    switch (command.action) {
      case "snapshot": return reply({ snapshot: await this.evaluate<BrowserSnapshot>(tab, snapshotScript(tab.generation)) });
      case "extract": return reply({ extraction: await this.evaluate<BrowserExtraction>(tab, extractionScript) });
      case "screenshot": {
        let screenshot = await this.capture(tab);
        if (screenshot.getSize().width > 1600) screenshot = screenshot.resize({ width: 1600 });
        return reply({ screenshot: { dataUrl: screenshot.toDataURL(), ...screenshot.getSize() } });
      }
      case "click": case "type":
        if (!command.ref.startsWith(`${tab.generation}:`)) throw new Error("页面已经变化，元素引用已失效。请重新获取 browser_snapshot。");
        await this.evaluate(tab, interactionScript(command.action, command.ref, command.action === "type" ? command.text : undefined));
        return reply();
      case "press":
        await this.evaluate(tab, pressGuardScript);
        contents.sendInputEvent({ type: "keyDown", keyCode: command.key });
        contents.sendInputEvent({ type: "keyUp", keyCode: command.key });
        return reply();
      case "scroll": {
        const pixels = command.pixels ?? 600;
        const x = command.direction === "left" ? -pixels : command.direction === "right" ? pixels : 0;
        const y = command.direction === "up" ? -pixels : command.direction === "down" ? pixels : 0;
        await this.evaluate(tab, `window.scrollBy({left:${x},top:${y},behavior:'instant'})`);
        return reply();
      }
      default: throw new Error("不支持的浏览器命令。");
    }
  }

  private async load(tab: ManagedTab, url: string): Promise<void> {
    this.checkActive(tab);
    tab.error = undefined;
    const signal = tab.abortSignal;
    const stop = () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop(); };
    signal?.addEventListener("abort", stop, { once: true });
    try { await withTimeout(tab.view.webContents.loadURL(url), 25000, "网页加载超时，请检查网络后刷新重试。", signal); }
    catch (error) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop();
      signal?.throwIfAborted();
      throw new Error(tab.error || (error instanceof Error ? error.message : String(error)));
    }
    finally { signal?.removeEventListener("abort", stop); }
    this.checkActive(tab);
    this.changed(tab.sessionId);
  }

  private async evaluate<T>(tab: ManagedTab, code: string): Promise<T> {
    this.checkActive(tab);
    const result = await withTimeout(tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]), 12000, "网页读取/操作超时，请刷新后重试。", tab.abortSignal) as T;
    this.checkActive(tab);
    return result;
  }

  private async capture(tab: ManagedTab): Promise<NativeImage> {
    this.checkActive(tab);
    const contents = tab.view.webContents;
    try {
      const image = await withTimeout(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 2000, "网页截图等待渲染超时。", tab.abortSignal);
      this.checkActive(tab);
      if (this.usableScreenshot(tab, image)) return image;
    } catch {
      this.checkActive(tab);
    }
    // Detached/hidden native views sometimes have no compositor surface at all.
    // An invisible, non-activating host supplies one without showing or focusing a window.
    const originalBounds = tab.bounds;
    const captureWindow = new BrowserWindow({
      show: false, opacity: 0, x: -10000, y: -10000,
      width: Math.max(1, originalBounds.width), height: Math.max(1, originalBounds.height),
      frame: false, skipTaskbar: true, focusable: false, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.capturing.add(tab);
    try {
      if (this.attached?.tab === tab) this.detach();
      captureWindow.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: 0, y: 0, width: Math.max(1, originalBounds.width), height: Math.max(1, originalBounds.height) });
      tab.view.setVisible(true);
      captureWindow.showInactive();
      await this.evaluate(tab, "new Promise(resolve => { setTimeout(resolve, 300); requestAnimationFrame(() => requestAnimationFrame(resolve)); })");
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const image = await withTimeout(contents.capturePage(undefined, { stayHidden: true, stayAwake: true }), 2500, "网页截图等待渲染超时。", tab.abortSignal);
          this.checkActive(tab);
          if (this.usableScreenshot(tab, image)) return image;
        } catch {
          this.checkActive(tab);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return await this.captureCdp(tab);
    } finally {
      if (!captureWindow.isDestroyed()) {
        try { captureWindow.contentView.removeChildView(tab.view); }
        finally { captureWindow.destroy(); }
      }
      this.capturing.delete(tab);
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.setVisible(false);
        tab.view.setBounds(originalBounds);
      }
      const requested = this.viewportRequest;
      if (!this.disposed && !this.closedSessions.has(tab.sessionId) && requested?.sessionId === tab.sessionId && requested.tabId === tab.id && requested.bounds) {
        this.setViewport(requested.sessionId, requested.tabId, requested.bounds);
      }
    }
  }

  private async captureCdp(tab: ManagedTab): Promise<NativeImage> {
    const contents = tab.view.webContents;
    this.checkActive(tab);
    const metrics = await withTimeout(contents.debugger.sendCommand("Page.getLayoutMetrics"), 3000, "网页截图尺寸读取超时。", tab.abortSignal);
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
    const bounds = tab.bounds;
    const width = Math.max(1, Math.min(viewport?.clientWidth ?? bounds.width, 1600));
    const height = Math.max(1, Math.min(viewport?.clientHeight ?? bounds.height, 2000));
    const result = await withTimeout(contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: true,
      clip: { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0, width, height, scale: 1 },
    }), 7000, "网页截图超时，请等待页面加载后重试。", tab.abortSignal);
    this.checkActive(tab);
    const image = nativeImage.createFromBuffer(Buffer.from(result.data ?? "", "base64"));
    if (!this.usableScreenshot(tab, image)) throw new Error("当前页面还没有可用截图，请等待页面加载后重试。");
    return image;
  }

  private usableScreenshot(tab: ManagedTab, image: NativeImage): boolean {
    const size = image.getSize();
    const bounds = tab.bounds;
    // Hidden native views can return a non-empty 1x1 placeholder instead of the webpage.
    return !image.isEmpty() && size.width >= Math.min(32, bounds.width) && size.height >= Math.min(32, bounds.height);
  }

  private async wait(tab: ManagedTab, text: string | undefined, timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      this.checkActive(tab);
      if (tab.view.webContents.isDestroyed()) throw new Error("网页已关闭。");
      const ready = !tab.view.webContents.isLoading();
      const found = text ? await this.evaluate<boolean>(tab, `(document.body?.innerText || '').includes(${JSON.stringify(text)})`) : true;
      if (ready && found) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(text ? "等待指定网页文字超时，请重新检查快照。" : "等待网页加载超时，可重新获取快照检查当前状态。");
  }

  private async authorize(tab: ManagedTab, action: BrowserAuthorization["action"], url: string, reason?: string): Promise<void> {
    this.checkActive(tab);
    if (tab.userInitiated) return;
    if (!this.deps.authorize || !await withTimeout(this.deps.authorize({ sessionId: tab.sessionId, action, url, reason }), 300000, "浏览器操作授权等待超时。", tab.abortSignal)) throw new Error("浏览器操作未获授权。");
    this.checkActive(tab);
  }

  private checkActive(tab: ManagedTab): void {
    if (this.disposed || tab.view.webContents.isDestroyed()) throw new Error("网页已关闭。");
    tab.abortSignal?.throwIfAborted();
  }

  private state(tab: ManagedTab): BrowserTabState {
    const contents = tab.view.webContents;
    return { id: tab.id, title: contents.getTitle() || "新网页", url: contents.getURL(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), error: tab.error };
  }
  private changed(sessionId: string): void { this.deps.onChange(sessionId, this.list(sessionId)); }
  private fail(tab: ManagedTab, error: string): void { tab.error = error; this.changed(tab.sessionId); }
  private detach(): void {
    if (!this.attached) return;
    const { tab, window } = this.attached;
    if (!tab.view.webContents.isDestroyed()) tab.view.setVisible(false);
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    this.attached = null;
  }
  private closeTab(tab: ManagedTab): void {
    if (this.attached?.tab === tab) this.detach();
    this.tasks.get(tab.sessionId)?.tabs.delete(tab.id);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    this.changed(tab.sessionId);
  }
}
