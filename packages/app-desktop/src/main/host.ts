// =====================================================================
// SessionHost:Op 命令 → Agent 核心 → AppEvent 事件
// 设计依据:codex/03——UI 与核心通过协议信封通信,UI 只是主循环的
// 消费者;单写者会话(同一时刻只有一个 runAgent 在跑)。
// =====================================================================

import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type {
  AppConfig,
  AppEvent,
  ApprovalRequest,
  Message,
  Op,
  ProviderConfig,
  SessionMeta,
  TurnContext,
} from "@entrotect/shared";
import {
  buildBuiltinTools,
  buildSystemPrompt,
  createProvider,
  createSubagentRunner,
  listModelsForProvider,
  loadConfig,
  runAgent,
  saveConfig,
  SessionPermissionGate,
  SessionStore,
  applyChatMessage,
  loadPluginsFromDir,
  type PluginHooks,
  type Provider,
} from "@entrotect/core";

export interface HostDeps {
  appDataDir: string;
  getWindow: () => BrowserWindow | null;
}

interface ActiveRun {
  meta: SessionMeta;
  gate: SessionPermissionGate;
  abort: AbortController;
  running: boolean;
}

const MAX_TOKENS_DEFAULT = 8192;
/** ReadFile 应答的内容上限:超过则截断并在尾部加一行提示 */
const MAX_FILE_CONTENT_BYTES = 256 * 1024;

/** 按 UTF-8 字节数安全截断(不劈开多字节字符) */
function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let bytes = 0;
  let result = "";
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    result += char;
  }
  return result;
}

export class SessionHost {
  private readonly deps: HostDeps;
  private readonly store: SessionStore;
  private config!: AppConfig;
  private provider!: Provider;
  private active: ActiveRun | null = null;
  private nextRunId = 0;
  /** 插件 hooks:{appData}/plugins 下 *.mjs 加载而来,init 时填充 */
  private plugins: PluginHooks[] = [];

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.store = new SessionStore(path.join(deps.appDataDir, "sessions"));
  }

  async init(): Promise<void> {
    this.config = await loadConfig(this.deps.appDataDir);
    this.provider = this.makeProvider();
    const plugins = await loadPluginsFromDir(path.join(this.deps.appDataDir, "plugins"));
    this.plugins = plugins.map((plugin) => plugin.hooks);
  }

  /** 当前生效的供应商:按 activeProviderId 找,失效回退第一个 */
  private activeProvider(): ProviderConfig | undefined {
    const providers = this.config.providers ?? [];
    if (providers.length === 0) return undefined;
    return (
      providers.find((p) => p.id === this.config.activeProviderId) ?? providers[0]
    );
  }

  /** 与 renderer 相同的有效供应商选择,用于绑定回合上下文。 */
  private activeProviderId(): string {
    return this.activeProvider()?.id ?? this.config.activeProviderId ?? "deepseek";
  }

  private makeProvider(): Provider {
    const provider = this.activeProvider();
    if (!provider) return createProvider(this.config);
    // 模型仍取顶层 model(compat 字段,切换供应商时由 UI 同步)
    return createProvider({
      ...this.config,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  }

  private workspaceDir(): string {
    const dir = this.config.workspaceDir?.trim();
    return dir && dir.length > 0 ? dir : homedir();
  }

  /** 事件汇:发往 UI(主循环与 host 共用) */
  emit(event: AppEvent): void {
    this.deps.getWindow()?.webContents.send("entrotect:event", event);
  }

  async handleOp(op: Op): Promise<void> {
    switch (op.kind) {
      case "SendMessage":
        await this.handleSendMessage(op.text);
        break;
      case "Interrupt":
        this.handleInterrupt();
        break;
      case "NewSession":
        await this.handleNewSession();
        break;
      case "NewProject":
        await this.handleNewProject(op.cwd);
        break;
      case "ResumeSession":
        await this.handleResume(op.sessionId);
        break;
      case "DeleteSession":
        await this.handleDelete(op.sessionId);
        break;
      case "ListSessions":
        this.emit({ type: "sessions-listed", sessions: await this.store.list() });
        break;
      case "ListModels": {
        const providerId = op.providerId ?? this.config.activeProviderId ?? "";
        const provider = this.config.providers?.find((p) => p.id === providerId);
        if (!provider) {
          this.emit({ type: "models-listed", providerId, models: [] });
          break;
        }
        try {
          const result = await listModelsForProvider(provider);
          this.emit({ type: "models-listed", providerId, ...result });
        } catch {
          // 拉取失败不打扰用户:renderer 显示"拉取失败"
          this.emit({ type: "models-listed", providerId, models: [] });
        }
        break;
      }
      case "ApprovalDecision":
        this.active?.gate.respond(op.toolCallId, op.decision, op.reason);
        break;
      case "GetConfig":
        this.emit({ type: "config", config: this.config });
        break;
      case "ReadFile": {
        const cwd = this.active?.meta.cwd ?? this.workspaceDir();
        const absolute = path.isAbsolute(op.path)
          ? op.path
          : path.resolve(cwd, op.path);
        try {
          let content = await readFile(absolute, "utf8");
          if (Buffer.byteLength(content, "utf8") > MAX_FILE_CONTENT_BYTES) {
            content = `${truncateUtf8(content, MAX_FILE_CONTENT_BYTES)}\n…(文件过大已截断)`;
          }
          this.emit({ type: "file-content", path: op.path, content });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({ type: "file-content", path: op.path, content: null, error: message });
        }
        break;
      }
      case "SetConfig": {
        this.config = op.config;
        this.active?.gate.setMode(this.config.permissionMode ?? "write");
        await saveConfig(this.deps.appDataDir, this.config);
        this.provider = this.makeProvider();
        this.emit({ type: "config", config: this.config });
        break;
      }
    }
  }

  private makeGate(): SessionPermissionGate {
    return new SessionPermissionGate(
      buildBuiltinTools(),
      undefined,
      this.config.permissionMode ?? "write",
    );
  }

  private async handleNewSession(): Promise<void> {
    this.teardownActive();
    const meta = await this.store.create({
      title: "新会话",
      model: this.config.model,
      cwd: this.workspaceDir(),
    });
    this.active = {
      meta,
      gate: this.makeGate(),
      abort: new AbortController(),
      running: false,
    };
    this.emit({ type: "session-meta", meta });
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  /** 新建任务(指定工作目录)并激活其下第一个对话 */
  private async handleNewProject(cwd: string): Promise<void> {
    this.teardownActive();
    const meta = await this.store.create({
      title: "新对话",
      model: this.config.model,
      cwd,
    });
    this.active = {
      meta,
      gate: this.makeGate(),
      abort: new AbortController(),
      running: false,
    };
    this.emit({ type: "session-meta", meta });
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  /** 删除对话;正在运行的对话拒绝删除 */
  private async handleDelete(sessionId: string): Promise<void> {
    if (this.active?.meta.id === sessionId) {
      if (this.active.running) {
        this.emit({ type: "error", message: "该对话正在运行中,请先停止再删除" });
        return;
      }
      this.teardownActive();
    }
    await this.store.deleteSession(sessionId);
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  private async handleResume(sessionId: string): Promise<void> {
    this.teardownActive();
    const { meta, messages } = await this.store.load(sessionId);
    this.active = {
      meta,
      gate: this.makeGate(),
      abort: new AbortController(),
      running: false,
    };
    this.emit({ type: "session-meta", meta });
    // 回放历史:UI 按序重建消息与工具卡片
    for (const message of messages) {
      this.emit({ type: "message-appended", message });
    }
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  private teardownActive(): void {
    if (!this.active) return;
    this.active.abort.abort();
    this.active.gate.dispose();
    this.active = null;
  }

  private handleInterrupt(): void {
    if (!this.active) return;
    this.active.abort.abort();
    this.active.gate.dispose();
  }

  private async ensureSession(): Promise<ActiveRun | null> {
    if (!this.active) {
      await this.handleNewSession();
    }
    return this.active;
  }

  private async handleSendMessage(text: string): Promise<void> {
    // 插件 chat.message 钩子:发送前改写文本;改写成空则不发送
    text = applyChatMessage(this.plugins, text);
    if (text.length === 0) return;

    const run = await this.ensureSession();
    if (!run) return;
    if (run.running) {
      this.emit({ type: "error", message: "上一轮任务仍在运行中" });
      return;
    }
    if (text.trim().length === 0) return;

    // 在所有异步持久化之前固定本次 SendMessage 的上下文,避免迟到事件借用新配置。
    const turnContext: TurnContext = {
      sessionId: run.meta.id,
      providerId: this.activeProviderId(),
      model: this.config.model,
    };

    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text }],
    };
    await this.store.appendMessage(run.meta.id, userMessage);
    this.emit({ type: "message-appended", message: userMessage });

    // 首条消息提取标题
    const messages = (await this.store.load(run.meta.id)).messages;
    if (messages.length === 1) {
      const title = text.trim().slice(0, 24) || "新会话";
      await this.store.appendTitle(run.meta.id, title);
      run.meta.title = title;
      this.emit({ type: "session-meta", meta: run.meta });
      this.emit({ type: "sessions-listed", sessions: await this.store.list() });
    }

    // 中断上一次的残留(如果有),开新 AbortController
    run.abort.abort();
    run.gate.dispose();
    run.abort = new AbortController();
    run.gate = this.makeGate();
    run.running = true;

    const runId = String(++this.nextRunId);
    const emitRunEvent = (event: AppEvent): void => {
      if (event.type === "turn-started" || event.type === "turn-completed") {
        this.emit({ ...event, runId, ...turnContext });
        return;
      }
      this.emit(event);
    };

    const gate = run.gate;
    // parent/child 共用 getter,SetConfig 后每次工具调用读取最新配置。
    const getSandboxMode = () => this.config.sandboxMode ?? "full";
    // 主循环与子代理共用的装配:同源提示词 / 审批 / 事件 / 工作目录
    const systemPrompt = buildSystemPrompt({
      cwd: run.meta.cwd,
      model: this.config.model,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
    });
    const approve = (request: ApprovalRequest) => {
      this.emit({ type: "approval-requested", request });
      return gate.request(request);
    };
    try {
      const result = await runAgent(messages, {
        provider: this.provider,
        // 注入子代理运行器 → task 工具可用;子代理工具池无 task,防递归
        tools: buildBuiltinTools({
          taskRunner: createSubagentRunner({
            provider: this.provider,
            tools: buildBuiltinTools(),
            systemPrompt,
            approve,
            cwd: run.meta.cwd,
            artifactDir: this.store.artifactDir(run.meta.id),
            sandboxMode: getSandboxMode,
            maxTokens: this.config.maxTokens ?? MAX_TOKENS_DEFAULT,
            temperature: this.config.temperature,
            reasoningEffort: this.config.reasoningEffort,
            abortSignal: run.abort.signal,
          }),
        }),
        systemPrompt,
        maxTokens: this.config.maxTokens ?? MAX_TOKENS_DEFAULT,
        temperature: this.config.temperature,
        reasoningEffort: this.config.reasoningEffort,
        emit: emitRunEvent,
        approve,
        cwd: run.meta.cwd,
        artifactDir: this.store.artifactDir(run.meta.id),
        sandboxMode: getSandboxMode,
        abortSignal: run.abort.signal,
        onMessage: (message) => this.store.appendMessage(run.meta.id, message),
        plugins: this.plugins,
      });
      if (result.error && !result.interrupted) {
        this.emit({ type: "error", message: result.error });
      }
    } finally {
      run.running = false;
      // 收口:中断/异常路径也要让 UI 退出忙碌态
      this.emit({ type: "turn-completed", usage: null, runId, ...turnContext });
    }
  }
}
