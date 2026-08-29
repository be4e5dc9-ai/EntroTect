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
  mergeContextWindows,
  knownMaxTokens,
  runAgent,
  saveConfig,
  SessionPermissionGate,
  SessionStore,
  applyChatMessage,
  loadPluginsFromDir,
  compactMessages,
  shouldAutoCompact,
  type PluginHooks,
  type Provider,
} from "@entrotect/core";
import { clampEffort, getSupportedEffortsForModel } from "@entrotect/shared";

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

interface AcceptedRun {
  runId: string;
  context: TurnContext;
  config: AppConfig;
  provider: Provider;
  gate: SessionPermissionGate;
  abort: AbortController;
}

/** ReadFile 应答的内容上限:超过则截断并在尾部加一行提示 */
const MAX_FILE_CONTENT_BYTES = 256 * 1024;

/** 模型最大输出:内置目录优先;未收录返回 undefined(请求侧省略字段,用模型默认) */
function resolveMaxTokens(model: string): number | undefined {
  return knownMaxTokens(model);
}

/** 复制 SendMessage 需要的完整配置,避免后续 SetConfig 改写运行参数。 */
function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    providers: config.providers?.map((provider) => ({
      ...provider,
      models: [...provider.models],
      ...(provider.contextWindows === undefined
        ? {}
        : { contextWindows: { ...provider.contextWindows } }),
      ...(provider.modelReasoningLevels === undefined
        ? {}
        : {
            modelReasoningLevels: Object.fromEntries(
              Object.entries(provider.modelReasoningLevels).map(([k, v]) => [k, [...v]]),
            ),
          }),
      ...(provider.modelReasoningDefaults === undefined
        ? {}
        : { modelReasoningDefaults: { ...provider.modelReasoningDefaults } }),
      ...(provider.modelsUrl === undefined ? {} : { modelsUrl: provider.modelsUrl }),
      ...(provider.apiFormat === undefined ? {} : { apiFormat: provider.apiFormat }),
      ...(provider.category === undefined ? {} : { category: provider.category }),
      ...(provider.icon === undefined ? {} : { icon: provider.icon }),
    })),
  };
}

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
  private activeProvider(config: AppConfig = this.config): ProviderConfig | undefined {
    const providers = config.providers ?? [];
    if (providers.length === 0) return undefined;
    return (
      providers.find((p) => p.id === config.activeProviderId) ?? providers[0]
    );
  }

  /** 与 renderer 相同的有效供应商选择,用于绑定回合上下文。 */
  private activeProviderId(config: AppConfig = this.config): string {
    return this.activeProvider(config)?.id ?? config.activeProviderId ?? "deepseek";
  }

  private makeProvider(config: AppConfig = this.config): Provider {
    const provider = this.activeProvider(config);
    if (!provider) return createProvider(config);
    return createProvider({
      ...config,
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
      case "Compact": {
        if (!this.active) {
          this.emit({ type: "error", message: "当前没有活动会话,无法压缩" });
          break;
        }
        if (this.active.running) {
          this.emit({ type: "error", message: "会话正在运行中,请先停止再压缩" });
          break;
        }
        const loaded = await this.store.load(this.active.meta.id);
        if (loaded.messages.length < 2) {
          this.emit({ type: "error", message: "会话内容太少,无需压缩" });
          break;
        }
        try {
          const { compacted, summary } = await compactMessages(
            this.provider,
            loaded.messages,
          );
          await this.store.replaceMessages(this.active.meta.id, compacted);
          this.emit({ type: "session-compacted", summary });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({ type: "error", message });
        }
        break;
      }
      case "ListModels": {
        const providerId = op.providerId ?? this.config.activeProviderId ?? "";
        let provider = this.config.providers?.find((p) => p.id === providerId) as
          | ProviderConfig
          | undefined;
        // 携带临时凭据时用表单最新值覆盖（允许未保存/非当前供应商拉取）
        if (
          provider &&
          (op.baseUrl !== undefined ||
            op.apiKey !== undefined ||
            op.modelsUrl !== undefined ||
            op.apiFormat !== undefined)
        ) {
          provider = {
            ...provider,
            baseUrl: op.baseUrl ?? provider.baseUrl,
            apiKey: op.apiKey ?? provider.apiKey,
            modelsUrl: op.modelsUrl ?? provider.modelsUrl,
            apiFormat: op.apiFormat ?? provider.apiFormat,
          };
        } else if (!provider && op.baseUrl) {
          provider = {
            id: providerId || "temp",
            name: "temp",
            baseUrl: op.baseUrl ?? "",
            apiKey: op.apiKey ?? "",
            models: [],
            modelsUrl: op.modelsUrl,
            apiFormat: op.apiFormat as ProviderConfig["apiFormat"],
          };
        }
        if (!provider) {
          this.emit({ type: "models-listed", providerId, models: [] });
          break;
        }
        try {
          const result = await listModelsForProvider(provider);
          // /models 未必给上下文:用内置表 + id 后缀兜底识别,未知保持未知
          const contextWindows = mergeContextWindows(result.models, result.contextWindows);
          this.emit({ type: "models-listed", providerId, models: result.models, contextWindows });
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
        // 先完成同步共享状态更新并通知 renderer,再等待落盘,避免新 run 先发 turn 事件。
        this.config = cloneConfig(op.config);
        this.active?.gate.setMode(this.config.permissionMode ?? "write");
        this.provider = this.makeProvider();
        this.emit({ type: "config", config: this.config });
        await saveConfig(this.deps.appDataDir, this.config);
        break;
      }
    }
  }

  private makeGate(config: AppConfig = this.config): SessionPermissionGate {
    return new SessionPermissionGate(
      buildBuiltinTools(),
      undefined,
      config.permissionMode ?? "write",
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

    let run = this.active;
    if (!run) run = await this.ensureSession();
    if (!run) return;
    if (run.running) {
      this.emit({ type: "error", message: "上一轮任务仍在运行中" });
      return;
    }
    if (text.trim().length === 0) return;

    const accepted = this.acceptRun(run);
    await this.executeSendMessage(text, run, accepted);
  }

  /** 在第一次 await 前固定本次 run 的配置、provider 和取消器。 */
  private acceptRun(run: ActiveRun): AcceptedRun {
    const config = cloneConfig(this.config);
    const context: TurnContext = {
      sessionId: run.meta.id,
      providerId: this.activeProviderId(config),
      model: config.model,
    };

    // 中断上一次的残留(如果有),开新 AbortController 与权限闸门。
    run.abort.abort();
    run.gate.dispose();
    run.abort = new AbortController();
    run.gate = this.makeGate(config);
    run.running = true;

    const accepted: AcceptedRun = {
      runId: String(++this.nextRunId),
      context,
      config,
      provider: this.makeProvider(config),
      gate: run.gate,
      abort: run.abort,
    };
    // registration 必须先于所有异步持久化和首个 turn-started。
    this.emit({ type: "run-registered", runId: accepted.runId, ...context });
    return accepted;
  }

  private async executeSendMessage(
    text: string,
    run: ActiveRun,
    accepted: AcceptedRun,
  ): Promise<void> {
    const { config, context, provider, gate, abort, runId } = accepted;

    const emitRunEvent = (event: AppEvent): void => {
      if (event.type === "turn-started" || event.type === "turn-completed") {
        this.emit({ ...event, runId, ...context });
        return;
      }
      this.emit(event);
    };

    // parent/child 共用 getter,SetConfig 后每次工具调用读取最新配置。
    const getSandboxMode = () => this.config.sandboxMode ?? "full";
    try {
      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text }],
      };
      await this.store.appendMessage(run.meta.id, userMessage);
      this.emit({ type: "message-appended", message: userMessage });

      // 首条消息提取标题
      let messages = (await this.store.load(run.meta.id)).messages;
      if (messages.length === 1) {
        const title = text.trim().slice(0, 24) || "新会话";
        await this.store.appendTitle(run.meta.id, title);
        run.meta.title = title;
        this.emit({ type: "session-meta", meta: run.meta });
        this.emit({ type: "sessions-listed", sessions: await this.store.list() });
      }

      // 自动压缩:开启且占用超阈值时,历史替换为 [摘要 + 最近 N 条]
      if (
        (config.autoCompact ?? true) &&
        shouldAutoCompact(messages, config.model, config.providers, config.autoCompactRatio)
      ) {
        try {
          const { compacted, summary } = await compactMessages(provider, messages, abort.signal);
          await this.store.replaceMessages(run.meta.id, compacted);
          messages = compacted;
          this.emit({ type: "session-compacted", summary });
        } catch {
          // 压缩失败不阻塞主流程,沿用原历史
        }
      }

      // 主循环与子代理共用的装配:同源提示词 / 审批 / 事件 / 工作目录
      const systemPrompt = buildSystemPrompt({
        cwd: run.meta.cwd,
        model: config.model,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
      });
      const approve = async (request: ApprovalRequest) => {
        // 仅在真正需要用户裁决时才上报弹窗;
        // full/write 只读/allow-always 等自动放行路径不打扰。
        if (gate.wantsApproval(request)) {
          this.emit({ type: "approval-requested", request });
        }
        return gate.request(request);
      };
      const activeProv = this.activeProvider(config);
      const imageProvider = activeProv
        ? {
            baseUrl: activeProv.baseUrl,
            apiKey: activeProv.apiKey,
            model: config.model,
            apiFormat: activeProv.apiFormat,
          }
        : undefined;
      // 推理强度按模型真实档位钳制（声明集或 preset）
      const supported = getSupportedEffortsForModel(config, context.providerId, config.model);
      const effectiveEffort =
        config.reasoningEffort && supported.length > 0
          ? clampEffort(config.reasoningEffort, supported)
          : config.reasoningEffort;
      const result = await runAgent(messages, {
        provider,
        // 注入子代理运行器 → task 工具可用;子代理工具池无 task,防递归
        tools: buildBuiltinTools({
          taskRunner: createSubagentRunner({
            provider,
            tools: buildBuiltinTools({ imageProvider }),
            systemPrompt,
            approve,
            cwd: run.meta.cwd,
            artifactDir: this.store.artifactDir(run.meta.id),
            sandboxMode: getSandboxMode,
            maxTokens: resolveMaxTokens(config.model),
            temperature: config.temperature,
            reasoningEffort: effectiveEffort,
            abortSignal: abort.signal,
          }),
          imageProvider,
        }),
        imageProvider,
        systemPrompt,
        maxTokens: resolveMaxTokens(config.model),
        temperature: config.temperature,
        reasoningEffort: effectiveEffort,
        emit: emitRunEvent,
        approve,
        cwd: run.meta.cwd,
        artifactDir: this.store.artifactDir(run.meta.id),
        sandboxMode: getSandboxMode,
        abortSignal: abort.signal,
        onMessage: (message) => this.store.appendMessage(run.meta.id, message),
        plugins: this.plugins,
      });
      if (result.error && !result.interrupted) {
        this.emit({ type: "error", message: result.error });
      }
    } finally {
      run.running = false;
      // 收口:中断/异常路径也要让 UI 退出忙碌态
      this.emit({ type: "turn-completed", usage: null, runId, ...context });
    }
  }
}
