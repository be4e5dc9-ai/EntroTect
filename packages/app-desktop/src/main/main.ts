// =====================================================================
// Electron 主进程:窗口 + IPC 桥 + SessionHost 装配
// =====================================================================

import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { opSchema, browserCommandSchema, researchCommandSchema, type Op, type BrowserViewport, type ResearchReply } from "@entrotect/shared";
import { stopAllBgJobs, createBrowserTools, createResearchTools, ResearchService } from "@entrotect/core";
import { BrowserManager } from "./browser/manager.js";
import { assertBrowserDestination, BrowserPrivateAddressError } from "./browser/security.js";
import { SessionHost } from "./host.js";
import { createAccentWindowIcon } from "./window-icon.js";
import { discoverSkills } from "./skills.js";
import { SessionOperationScopes } from "./session-operations.js";

// 主进程产物为 CJS,直接用 __dirname 定位资源
const here = __dirname;

let mainWindow: BrowserWindow | null = null;
let host: SessionHost | null = null;
let browserManager: BrowserManager | null = null;
let research: ResearchService | null = null;
const uiOperations = new SessionOperationScopes();
const rendererUrl = pathToFileURL(path.join(here, "../renderer/index.html")).href;

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && event.senderFrame?.url.split("#")[0] === rendererUrl;
}

function requireTrusted(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!trustedSender(event)) throw new Error("不受信任的 IPC 来源");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    hasShadow: false,
    backgroundColor: "#0d0d10",
    autoHideMenuBar: true,
    icon: path.join(here, "../../build/icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0d0d10",
      symbolColor: "#8f8f9d",
      height: 40,
    },
    webPreferences: {
      preload: path.join(here, "../preload/preload.cjs"),
      // 渲染层加固(P3-1):显式写死与当前默认一致,防未来 Electron 默认变化
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.loadFile(path.join(here, "../renderer/index.html"));
  // 渲染层加固(P3-1):禁 window.open,只允许本地 index.html 自身导航,
  // 防聊天内链接把整窗导航到外部并把 preload 桥暴露给远程页面。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.split("#")[0] !== rendererUrl) e.preventDefault();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("entrotect:op", (event, raw: unknown) => {
  if (!trustedSender(event)) return;
  const parsed = opSchema.safeParse(raw);
  if (!parsed.success) {
    host?.emit({ type: "error", message: `非法操作: ${parsed.error.message}` });
    return;
  }
  void host?.handleOp(parsed.data as Op).catch((error) => host?.emit({ type: "error", message: String(error) }));
});

ipcMain.handle("entrotect:choose-folder", async (event) => {
  requireTrusted(event);
  const options = {
    properties: ["openDirectory" as const],
    title: "选择工作目录",
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// 主题切换:同步 titleBarOverlay 颜色,否则标题栏与内容区色差突兀
ipcMain.handle("entrotect:set-theme", (_event, theme: unknown) => {
  requireTrusted(_event);
  if (!mainWindow) return;
  const light = theme === "light";
  mainWindow.setTitleBarOverlay({
    color: light ? "#f7f5f1" : "#0d0d10",
    symbolColor: light ? "#55514a" : "#8f8f9d",
    height: 40,
  });
});

ipcMain.handle("entrotect:set-accent-color", (_event, raw: unknown) => {
  requireTrusted(_event);
  if (typeof raw !== "string" || !mainWindow) return;
  try {
    mainWindow.setIcon(createAccentWindowIcon(raw));
  } catch {
    // A native icon failure must not affect renderer appearance state.
  }
});

ipcMain.handle("entrotect:list-skills", async (event) => {
  requireTrusted(event);
  try {
    return await discoverSkills();
  } catch {
    return [];
  }
});

ipcMain.handle("entrotect:browser", async (event, sessionId: unknown, raw: unknown) => {
  requireTrusted(event);
  try {
    if (typeof sessionId !== "string" || !host || !browserManager) throw new Error("浏览器未就绪");
    host.requireActiveSession(sessionId);
    const abortSignal = uiOperations.signal(sessionId);
    const command = browserCommandSchema.parse(raw);
    if ((command.action === "open" || command.action === "navigate") && !browserManager.hasPrivateOrigin(sessionId, command.url)) {
      try { await assertBrowserDestination(command.url); }
      catch (error) {
        abortSignal.throwIfAborted();
        host.requireActiveSession(sessionId);
        if (!(error instanceof BrowserPrivateAddressError)) throw error;
        browserManager.setViewport(sessionId, "", null);
        const options = {
          type: "question" as const, title: "访问本机或内网网页", message: `允许当前任务访问 ${error.origin}？`,
          detail: "用于开发预览、校园内网或办公网站。授权只覆盖这个来源和当前任务，不包含其他地址。",
          buttons: ["取消", "允许本会话访问"], defaultId: 0, cancelId: 0, noLink: true,
        };
        const choice = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
        abortSignal.throwIfAborted();
        host.requireActiveSession(sessionId);
        if (choice.response !== 1) return { ok: false, tabs: browserManager.list(sessionId), error: "已取消访问本机或内网网页" };
        browserManager.grantPrivateOrigin(sessionId, command.url);
      }
    }
    abortSignal.throwIfAborted();
    host.requireActiveSession(sessionId);
    return await browserManager.execute(sessionId, command, { userInitiated: true, abortSignal });
  } catch (error) { return { ok: false, tabs: typeof sessionId === "string" ? browserManager?.list(sessionId) ?? [] : [], error: String(error) }; }
});

ipcMain.on("entrotect:browser-viewport", (event, sessionId: unknown, tabId: unknown, raw: unknown) => {
  if (!trustedSender(event) || typeof sessionId !== "string" || typeof tabId !== "string" || !host) return;
  try {
    host.requireActiveSession(sessionId);
    if (raw === null) { browserManager?.setViewport(sessionId, tabId, null); return; }
    if (!raw || typeof raw !== "object") return;
    const bounds = raw as BrowserViewport;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 20_000)) return;
    browserManager?.setViewport(sessionId, tabId, bounds);
  } catch { /* A late layout update from the previous task is ignored. */ }
});

ipcMain.handle("entrotect:research", async (event, raw: unknown): Promise<ResearchReply> => {
  requireTrusted(event);
  try {
    if (!host || !research) throw new Error("资料库未就绪");
    const command = researchCommandSchema.parse(raw);
    const meta = host.requireActiveSession(command.sessionId);
    const abortSignal = uiOperations.signal(command.sessionId);
    const reply = await research.execute(command, abortSignal);
    abortSignal.throwIfAborted();
    host.requireActiveSession(command.sessionId);
    if (!reply.export) return reply;
    browserManager?.setViewport(command.sessionId, "", null);
    const options = { title: "导出资料", defaultPath: path.join(meta.cwd, reply.export.fileName), filters: [{ name: "资料文件", extensions: [path.extname(reply.export.fileName).slice(1)] }] };
    const selected = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return { canceled: true };
    abortSignal.throwIfAborted();
    host.requireActiveSession(command.sessionId);
    await writeFile(selected.filePath, reply.export.content, "utf8");
    return { exportedPath: selected.filePath };
  } catch (error) { return { error: String(error) }; }
});

// 单实例:重复启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let cleanupStarted = false;
  let cleanupFinished = false;
  app.on("before-quit", (event) => {
    if (cleanupFinished) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    uiOperations.dispose();
    browserManager?.dispose();
    void stopAllBgJobs().catch(() => {}).finally(() => {
      cleanupFinished = true;
      app.quit();
    });
  });
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    research = new ResearchService(app.getPath("userData"));
    browserManager = new BrowserManager({
      getWindow: () => mainWindow,
      onChange: (sessionId, tabs) => mainWindow?.webContents.send("entrotect:browser-tabs", { sessionId, tabs }),
      authorize: (request) => host?.authorizeBrowser(request) ?? Promise.resolve(false),
    });
    host = new SessionHost({
      appDataDir: app.getPath("userData"),
      getWindow: () => mainWindow,
      desktopTools: (sessionId, config) => [
        ...createBrowserTools(async (command, signal) => {
          signal?.throwIfAborted();
          host!.requireActiveSession(sessionId);
          return browserManager!.execute(sessionId, command, { abortSignal: signal });
        }, { model: config.model }),
        ...createResearchTools(sessionId, async (command, signal) => {
          host!.requireActiveSession(sessionId);
          return research!.execute(command, signal);
        }),
      ],
      onSessionDeactivated: (sessionId) => {
        uiOperations.cancel(sessionId);
        browserManager?.setViewport(sessionId, "", null);
      },
      onSessionDeleted: async (sessionId) => {
        uiOperations.cancel(sessionId);
        browserManager?.closeSession(sessionId);
        await research?.deleteSession(sessionId);
      },
    });
    await host.init();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
