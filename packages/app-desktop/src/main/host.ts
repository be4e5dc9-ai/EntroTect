// =====================================================================
// SessionHost:Op 命令 → Agent 核心 → AppEvent 事件
// 设计依据:codex/03——UI 与核心通过协议信封通信,UI 只是主循环的
// 消费者;单写者会话(同一时刻只有一个 runAgent 在跑)。
// =====================================================================

import { homedir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { AppConfig, AppEvent, Message, Op, SessionMeta } from "@entrotect/shared";
import {
  buildBuiltinTools,
  buildSystemPrompt,
  createProvider,
  listModels,
  loadConfig,
  runAgent,
  saveConfig,
  SessionPermissionGate,
  SessionStore,
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

export class SessionHost {
  private readonly deps: HostDeps;
  private readonly store: SessionStore;
  private config!: AppConfig;
  private provider!: Provider;
  private active: ActiveRun | null = null;

  constructor(deps: HostDeps) {
    this.deps = deps;
    this.store = new SessionStore(path.join(deps.appDataDir, "sessions"));
  }

  async init(): Promise<void> {
    this.config = await loadConfig(this.deps.appDataDir);
    this.provider = this.makeProvider();
  }

  private makeProvider(): Provider {
    return createProvider(this.config);
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
      case "ListModels":
        try {
          const models = await listModels(this.config);
          this.emit({ type: "models-listed", models });
        } catch {
          // 拉取失败不阻塞:至少保证当前模型可选
          this.emit({ type: "models-listed", models: [this.config.model] });
        }
        break;
      case "ApprovalDecision":
        this.active?.gate.respond(op.toolCallId, op.decision, op.reason);
        break;
      case "GetConfig":
        this.emit({ type: "config", config: this.config });
        break;
      case "SetConfig": {
        this.config = op.config;
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
    const run = await this.ensureSession();
    if (!run) return;
    if (run.running) {
      this.emit({ type: "error", message: "上一轮任务仍在运行中" });
      return;
    }
    if (text.trim().length === 0) return;

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

    const gate = run.gate;
    try {
      const result = await runAgent(messages, {
        provider: this.provider,
        tools: buildBuiltinTools(),
        systemPrompt: buildSystemPrompt({
          cwd: run.meta.cwd,
          model: this.config.model,
          platform: process.platform,
          date: new Date().toISOString().slice(0, 10),
        }),
        maxTokens: this.config.maxTokens ?? MAX_TOKENS_DEFAULT,
        temperature: this.config.temperature,
        reasoningEffort: this.config.reasoningEffort,
        emit: (event) => this.emit(event),
        approve: (request) => {
          this.emit({ type: "approval-requested", request });
          return gate.request(request);
        },
        cwd: run.meta.cwd,
        artifactDir: this.store.artifactDir(run.meta.id),
        abortSignal: run.abort.signal,
        onMessage: (message) => this.store.appendMessage(run.meta.id, message),
      });
      if (result.error && !result.interrupted) {
        this.emit({ type: "error", message: result.error });
      }
    } finally {
      run.running = false;
      // 收口:中断/异常路径也要让 UI 退出忙碌态
      this.emit({ type: "turn-completed", usage: null });
    }
  }
}
