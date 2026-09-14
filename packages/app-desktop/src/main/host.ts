// =====================================================================
// SessionHost:Op 命令 → Agent 核心 → AppEvent 事件
// 设计依据:codex/03——UI 与核心通过协议信封通信,UI 只是主循环的
// 消费者;单写者会话(同一时刻只有一个 runAgent 在跑)。
// =====================================================================

import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import { aggregateUsageStats, type UsageRecord } from "@entrotect/core";
import { UsageStore } from "./usage-store.js";
import type {
  AppConfig,
  AppEvent,
  ApprovalRequest,
  Message,
  MessageAttachment,
  Op,
  ProviderConfig,
  SessionMeta,
  SessionControls,
  TurnContext,
} from "@entrotect/shared";
import {
  buildBuiltinTools,
  buildSystemPrompt,
  createGoalTool,
  toolsForSession,
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
  resolveContextWindow,
  resolveInsideCwd,
  stopBgJobsForOwner,
  type PluginHooks,
  type Provider,
} from "@entrotect/core";
import { clampEffort, getSupportedEffortsForModel, parseSlashCommand, SLASH_HELP, type SlashCommand } from "@entrotect/shared";

export interface HostDeps {
  appDataDir: string;
  getWindow: () => BrowserWindow | null;
}

interface ActiveRun {
  meta: SessionMeta;
  gate: SessionPermissionGate;
  abort: AbortController;
  running: boolean;
  /** Parent observations survive user turns; child runners own separate snapshots. */
  fileStates: Map<string, string>;
  shellState: { cwd?: string; pending?: Promise<void> };
  persistedShellCwd?: string;
}

interface AcceptedRun {
  runId: string;
  context: TurnContext;
  config: AppConfig;
  provider: Provider;
  gate: SessionPermissionGate;
  abort: AbortController;
  controls: SessionControls;
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
  private readonly usageStore: UsageStore;
  private config!: AppConfig;
  private provider!: Provider;
  private active: ActiveRun | null = null;
  private readonly runningSessionIds = new Set<string>();
  private nextRunId = 0;
  /** 插件 hooks:{appData}/plugins 下 *.mjs 加载而来,init 时填充 */
  private plugins: PluginHooks[] = [];

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.store = new SessionStore(path.join(deps.appDataDir, "sessions"));
    this.usageStore = new UsageStore(deps.appDataDir);
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

  /**
   * 应用自身数据目录里的受保护路径:模型经任何文件工具都不可读写。
   * 注意不要把整个 appDataDir 列入——sessions/{id}/artifacts 在其下,
   * 工具输出落盘与模型回读产物是正常流程。只保护 config/plugins/usage。
   */
  private protectedPaths(): string[] {
    return [
      path.join(this.deps.appDataDir, "config.json"),
      path.join(this.deps.appDataDir, "plugins"),
      path.join(this.deps.appDataDir, "usage.jsonl"),
    ];
  }

  /** 事件汇:发往 UI(主循环与 host 共用) */
  emit(event: AppEvent): void {
    this.deps.getWindow()?.webContents.send("entrotect:event", event);
  }

  /** 回合结束落盘 usage,并推送最新用量统计 */
  private async recordUsage(usage: { inputTokens: number; outputTokens: number }, context: TurnContext): Promise<void> {
    const record: UsageRecord = {
      ts: new Date().toISOString(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      sessionId: context.sessionId,
      model: context.model,
    };
    await this.usageStore.append(record);
    await this.pushUsageStats();
  }

  /** 聚合全量用量(消息/会话数来自会话存储),推送 usage-stats 事件 */
  private async pushUsageStats(): Promise<void> {
    const [records, sessions] = await Promise.all([
      this.usageStore.loadAll(),
      this.store.list(),
    ]);
    let messages = 0;
    for (const meta of sessions) {
      try {
        messages += (await this.store.load(meta.id)).messages.length;
      } catch {
        // 损坏会话跳过
      }
    }
    this.emit({
      type: "usage-stats",
      stats: aggregateUsageStats(records, { allMessages: messages }),
    });
  }

  async handleOp(op: Op): Promise<void> {
    switch (op.kind) {
      case "SendMessage":
        await this.handleSendMessage(op.text, op.attachments);
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
        const run = this.active;
        if (!run) {
          this.emit({ type: "error", message: "当前没有活动会话,无法压缩" });
          break;
        }
        if (run.running || this.runningSessionIds.has(run.meta.id)) {
          this.emit({ type: "error", message: "会话正在运行中,请先停止再压缩" });
          break;
        }
        // Compaction is a session write too: hold the same run lock as a message/command.
        const accepted = this.acceptRun(run);
        try {
          const loaded = await this.store.load(run.meta.id);
          if (loaded.messages.length === 0) {
            this.emit({ type: "error", message: "会话内容太少,无需压缩" });
            break;
          }
          await this.compactHistory(run, accepted.provider, loaded.messages, accepted.abort.signal, this.contextWindow(accepted.config));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!accepted.abort.signal.aborted) this.emit({ type: "error", message });
        } finally {
          run.running = false;
          this.runningSessionIds.delete(run.meta.id);
          this.emit({ type: "turn-completed", usage: null, runId: accepted.runId, ...accepted.context });
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
      case "GetUsageStats":
        await this.pushUsageStats();
        break;
      case "ReadFile": {
        const cwd = this.active?.meta.cwd ?? this.workspaceDir();
        try {
          const absolute = resolveInsideCwd(cwd, op.path, this.protectedPaths());
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
      fileStates: new Map(),
      shellState: {},
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
      fileStates: new Map(),
      shellState: {},
    };
    this.emit({ type: "session-meta", meta });
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  /** 删除对话;正在运行的对话拒绝删除 */
  private async handleDelete(sessionId: string): Promise<void> {
    if (this.runningSessionIds.has(sessionId)) {
      this.emit({ type: "error", message: "该对话正在运行中,请先停止再删除" });
      return;
    }
    const deletingActive = this.active?.meta.id === sessionId;
    try {
      await stopBgJobsForOwner(this.store.artifactDir(sessionId));
    } catch (error) {
      this.emit({ type: "error", message: `删除会话前无法终止后台任务: ${String(error)}` });
      return;
    }
    if (deletingActive) this.teardownActive();
    await this.store.deleteSession(sessionId);
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  private async handleResume(sessionId: string): Promise<void> {
    this.teardownActive();
    const { meta, messages, shellCwd } = await this.store.load(sessionId);
    this.active = {
      meta,
      gate: this.makeGate(),
      abort: new AbortController(),
      running: false,
      fileStates: new Map(),
      shellState: shellCwd ? { cwd: shellCwd } : {},
      persistedShellCwd: shellCwd,
    };
    this.emit({ type: "session-meta", meta });
    // 回放历史:UI 按序重建消息与工具卡片
    const boundaries = new Map<number, NonNullable<Message["compaction"]>>();
    messages.forEach((message, index) => {
      if (message.compaction) {
        boundaries.set(Math.min(index + message.compaction.retainedMessages, messages.length - 1), message.compaction);
      }
    });
    for (const [index, message] of messages.entries()) {
      if (!message.compaction) this.emit({ type: "message-appended", message });
      const marker = boundaries.get(index);
      if (marker) this.emit({ type: "session-compacted", sessionId, marker, summary: "", replayed: true });
    }
    this.emit({ type: "sessions-listed", sessions: await this.store.list() });
  }

  private teardownActive(): void {
    if (!this.active) return;
    this.active.abort.abort();
    this.active.gate.dispose();
    this.active = null;
  }

  /** Persist the boundary with its summary and publish a matching lifecycle. */
  private contextWindow(config: AppConfig): number {
    const provider = this.activeProvider(config);
    return resolveContextWindow(config.model, provider ? [provider] : []);
  }

  private async compactHistory(run: ActiveRun, provider: Provider, messages: Message[], signal: AbortSignal, contextWindow: number): Promise<Message[]> {
    const id = randomUUID();
    this.emit({ type: "session-compacting", sessionId: run.meta.id, id });
    try {
      const { compacted, summary, changed } = await compactMessages(provider, messages, signal, { id, contextWindow });
      signal.throwIfAborted();
      if (!changed) {
        this.emit({ type: "session-compaction-skipped", sessionId: run.meta.id, id });
        return messages;
      }
      await this.store.replaceMessages(run.meta.id, compacted);
      this.emit({ type: "session-compacted", sessionId: run.meta.id, marker: compacted[0]!.compaction!, summary });
      return compacted;
    } catch (error) {
      this.emit({ type: "session-compaction-failed", sessionId: run.meta.id, id, cancelled: signal.aborted, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
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

  private async handleSendMessage(
    text: string,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    const command = parseSlashCommand(text);
    if (command) {
      await this.handleSlashCommand(command, attachments ?? []);
      return;
    }
    await this.sendPrompt(text, attachments);
  }

  private async saveControls(run: ActiveRun, controls: SessionControls): Promise<void> {
    await this.store.appendControls(run.meta.id, controls);
    run.meta = { ...run.meta, controls };
    this.emit({ type: "session-controls", sessionId: run.meta.id, controls });
  }

  private async handleSlashCommand(command: SlashCommand, attachments: MessageAttachment[]): Promise<void> {
    const run = this.active;
    if (!run) {
      this.emit({ type: "error", message: "请先新建一个会话再使用命令。" });
      return;
    }
    const reply = (message: string) => this.emit({ type: "command-result", sessionId: run.meta.id, message });
    if (run.running || this.runningSessionIds.has(run.meta.id)) {
      reply("任务正在运行，请先停止再使用命令。");
      return;
    }
    if (command.kind === "invalid") { reply(command.message); return; }
    const hasPrompt = (command.kind === "plan" && !!command.prompt) || (command.kind === "goal" && command.action === "set");
    if (attachments.length && !hasPrompt) {
      reply("此命令不发送附件。请填写 /plan 任务内容或 /goal 目标内容，或先移除附件。");
      return;
    }
    if (command.kind === "help") { reply(SLASH_HELP); return; }
    if (command.kind === "compact") { await this.handleOp({ kind: "Compact" }); return; }
    const current: SessionControls = run.meta.controls ?? { mode: "default", goal: null };
    let next = current;
    let prompt = "";
    if (command.kind === "plan") {
      if (command.action !== "status") next = { ...current, mode: command.action === "on" ? "plan" : "default" };
      prompt = command.prompt;
    } else {
      if (command.action === "status") {
        reply(current.goal
          ? `目标${{ active: "进行中", completed: "已完成", blocked: "受阻" }[current.goal.status]}：${current.goal.objective}${current.goal.summary ? `\n${current.goal.summary}` : ""}`
          : "尚未设置目标。输入 /goal 目标内容 开始。");
        return;
      }
      if (command.action === "set") {
        next = { ...current, goal: { objective: command.objective, status: "active" } };
        prompt = command.objective;
      } else if (command.action === "clear") {
        next = { ...current, goal: null };
      } else {
        if (!current.goal) { reply("尚未设置目标。输入 /goal 目标内容 开始。"); return; }
        next = { ...current, goal: { objective: current.goal.objective, status: command.action === "done" ? "completed" : "active" } };
        if (command.action === "resume") prompt = `继续推进当前目标：${current.goal.objective}`;
      }
    }
    // Lock before persistence so a second command/message cannot race this state change.
    run.running = true;
    try {
      if (next !== current) await this.saveControls(run, next);
    } finally {
      run.running = false;
    }
    if (this.active !== run) return;
    if (command.kind === "plan") {
      if (command.action === "status") reply(next.mode === "plan" ? "当前为仅规划模式 · 不修改项目；/plan off 退出。" : "当前为默认模式，可正常执行任务；/plan 开启仅规划模式。");
      else reply(next.mode === "plan" ? "仅规划模式已开启 · 不修改项目；/plan off 退出。" : "已退出规划模式，后续任务可正常执行。");
    }
    else reply(next.goal ? `目标${next.goal.status === "completed" ? "已完成" : "已设置"}：${next.goal.objective}` : "已清除会话目标。");
    if (prompt) await this.sendPrompt(prompt, attachments);
  }

  private async sendPrompt(
    text: string,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    // 插件 chat.message 钩子:发送前改写文本;改写成空则不发送
    text = applyChatMessage(this.plugins, text);
    if (text.length === 0 && !attachments?.length) return;

    let run = this.active;
    if (!run) run = await this.ensureSession();
    if (!run) return;
    if (run.running || this.runningSessionIds.has(run.meta.id)) {
      this.emit({ type: "error", message: "上一轮任务仍在运行中" });
      return;
    }
    if (text.trim().length === 0 && !attachments?.length) return;

    const accepted = this.acceptRun(run);
    await this.executeSendMessage(text, run, accepted, attachments ?? []);
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
      controls: structuredClone(run.meta.controls ?? { mode: "default", goal: null }),
    };
    this.runningSessionIds.add(run.meta.id);
    // registration 必须先于所有异步持久化和首个 turn-started。
    this.emit({ type: "run-registered", runId: accepted.runId, ...context });
    return accepted;
  }

  private async executeSendMessage(
    text: string,
    run: ActiveRun,
    accepted: AcceptedRun,
    attachments: MessageAttachment[] = [],
  ): Promise<void> {
    const { config, context, provider, gate, abort, runId, controls } = accepted;

    const emitRunEvent = (event: AppEvent): void => {
      if (event.type === "turn-started" || event.type === "turn-completed") {
        this.emit({ ...event, runId, ...context });
        if (event.type === "turn-completed" && event.usage) {
          void this.recordUsage(event.usage, context);
        }
        return;
      }
      this.emit(event);
    };

    // parent/child 共用 getter,SetConfig 后每次工具调用读取最新配置。
    const getSandboxMode = () => this.config.sandboxMode ?? "full";
    try {
      // 组装用户消息:文本 + 图片内嵌(image block) + 文件提示文本(agent 用 read 工具查看)
      const content: Message["content"] = [];
      if (text.length > 0) content.push({ type: "text", text });
      for (const attachment of attachments) {
        if (attachment.kind === "image") {
          content.push({ type: "image", mime: attachment.mime, dataBase64: attachment.dataBase64 });
        } else {
          content.push({
            type: "text",
            text: `[用户拖入文件附件: ${attachment.name}]\n路径: ${attachment.path}\n如果需要,请先用 read 工具查看其内容后继续。`,
          });
        }
      }
      const userMessage: Message = {
        role: "user",
        content,
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

      // 主循环与子代理共用的装配:同源提示词 / 审批 / 事件 / 工作目录
      const promptEnv = {
        cwd: run.meta.cwd,
        model: config.model,
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        reasoningEffort: config.reasoningEffort,
        controls,
      } as const;
      const systemPrompt = buildSystemPrompt(promptEnv);
      // 子代理工具池没有 task，不向它传递 Ultra 的主代理委派指令。
      const subagentSystemPrompt = buildSystemPrompt({
        ...promptEnv,
        // Goal ownership stays with the main agent; children cannot complete the parent goal.
        controls: { ...controls, goal: null },
        reasoningEffort: config.reasoningEffort === "ultra" ? "max" : config.reasoningEffort,
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
      // ultra 是 harness 编排模式，供应商请求仍使用模型原生 max。
      const requestedEffort =
        config.reasoningEffort === "ultra" ? "max" : config.reasoningEffort;
      const nativeSupported = supported.filter((effort) => effort !== "ultra");
      const effectiveEffort =
        requestedEffort && nativeSupported.length > 0
          ? clampEffort(requestedEffort, nativeSupported)
          : requestedEffort;
      const selectedProvider = this.activeProvider(config);
      const contextWindow = this.contextWindow(config);
      const needsCompaction = (history: Message[]) => shouldAutoCompact(history, config.model, selectedProvider ? [selectedProvider] : [], config.autoCompactRatio);
      const result = await runAgent(messages, {
        provider,
        // 注入子代理运行器 → task 工具可用;子代理工具池无 task,防递归
        tools: toolsForSession([...buildBuiltinTools({
          taskRunner: createSubagentRunner({
            provider,
            tools: toolsForSession(buildBuiltinTools({ imageProvider }), controls),
            systemPrompt: subagentSystemPrompt,
            approve,
            cwd: run.meta.cwd,
            artifactDir: this.store.artifactDir(run.meta.id),
            protectedPaths: this.protectedPaths(),
            sandboxMode: getSandboxMode,
            maxTokens: resolveMaxTokens(config.model),
            temperature: config.temperature,
            reasoningEffort: effectiveEffort,
            abortSignal: abort.signal,
            compact: (config.autoCompact ?? true) ? {
              shouldCompact: needsCompaction,
              run: async (history) => {
                const result = await compactMessages(provider, history, abort.signal, { contextWindow });
                return result.compacted;
              },
            } : undefined,
          }),
          imageProvider,
        }), ...(controls.goal && controls.goal.status !== "completed" ? [createGoalTool(async (status, summary) => {
          if (abort.signal.aborted) throw new Error("操作已取消");
          await this.saveControls(run, { ...controls, goal: { objective: controls.goal!.objective, status, summary } });
        })] : [])], controls),
        imageProvider,
        systemPrompt,
        orchestration: config.reasoningEffort === "ultra" ? "ultra" : undefined,
        maxTokens: resolveMaxTokens(config.model),
        temperature: config.temperature,
        reasoningEffort: effectiveEffort,
        emit: emitRunEvent,
        approve,
        cwd: run.meta.cwd,
        artifactDir: this.store.artifactDir(run.meta.id),
        protectedPaths: this.protectedPaths(),
        sandboxMode: getSandboxMode,
        abortSignal: abort.signal,
        fileStates: run.fileStates,
        shellState: run.shellState,
        onMessage: (message) => this.store.appendMessage(run.meta.id, message),
        compact: (config.autoCompact ?? true) ? {
          shouldCompact: needsCompaction,
          run: (history) => this.compactHistory(run, provider, history, abort.signal, contextWindow),
        } : undefined,
        plugins: this.plugins,
      });
      if (result.error && !result.interrupted) {
        this.emit({ type: "error", message: result.error });
      }
    } finally {
      if (run.shellState.cwd && run.shellState.cwd !== run.persistedShellCwd) {
        try {
          await this.store.appendShellCwd(run.meta.id, run.shellState.cwd);
          run.persistedShellCwd = run.shellState.cwd;
        } catch (error) {
          this.emit({ type: "error", message: `无法保存 Shell 工作目录: ${String(error)}` });
        }
      }
      run.running = false;
      this.runningSessionIds.delete(run.meta.id);
      // 收口:中断/异常路径也要让 UI 退出忙碌态
      this.emit({ type: "turn-completed", usage: null, runId, ...context });
    }
  }
}
