import { z } from "zod";

// =====================================================================
// 词汇层:ContentBlock / Message
// 设计依据:agent-study/deepseek-harness/11 §2 阶段0、codex/12 第1步。
// 与 provider 的具体格式无关,任何模型协议最终都翻译成这三种块。
// =====================================================================

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | {
      type: "tool-result";
      toolCallId: string;
      name: string;
      isError: boolean;
      content: string;
    };

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  title: string;
  model: string;
  cwd: string;
}

// =====================================================================
// 应用配置
// =====================================================================

/** 单条供应商配置:baseUrl/apiKey 决定模型来源,models 为缓存列表 */
export interface ProviderConfig {
  /** 稳定 id:预设用固定名,自定义用 "custom-<randomUUID 前 8 位>" */
  id: string;
  /** 显示名,用户可改 */
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 拉取到的模型列表(缓存;用户可手动增删) */
  models: string[];
  /** 预设供应商不可删除(可编辑) */
  builtin?: boolean;
}

export interface AppConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 多供应商配置(缺省时由 core 迁移生成) */
  providers?: ProviderConfig[];
  /** 当前生效的供应商 id(缺省回退 deepseek) */
  activeProviderId?: string;
  /** 会话工作目录(空 = 用户主目录) */
  workspaceDir?: string;
  /** 思考强度(OpenAI 兼容 reasoning_effort;off = 不发) */
  reasoningEffort?: "off" | "low" | "high" | "xhigh" | "max";
  /** 权限模式:full = 全部自动放行;write = 写操作需批准;ask = 每个工具调用都需批准 */
  permissionMode?: PermissionMode;
  /** 沙箱模式;restricted 拦截危险命令 */
  sandboxMode?: "full" | "restricted";
  /** UI 是否显示模型思考过程 */
  showReasoning?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export type PermissionMode = "full" | "write" | "ask";

export const DEFAULT_CONFIG: AppConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  providers: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      models: [],
      builtin: true,
    },
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      models: [],
      builtin: true,
    },
    {
      id: "moonshot",
      name: "Moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "",
      models: [],
      builtin: true,
    },
    {
      id: "ollama",
      name: "Ollama(本地)",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      models: [],
      builtin: true,
    },
  ],
  activeProviderId: "deepseek",
  workspaceDir: "",
  reasoningEffort: "high",
  permissionMode: "write",
  sandboxMode: "full",
  showReasoning: false,
};

// =====================================================================
// Op:UI → 核心(照抄 codex Op 的思想:带判别字段的命令集)
// =====================================================================

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type Op =
  | { kind: "SendMessage"; text: string }
  | { kind: "Interrupt" }
  | { kind: "NewSession" }
  | { kind: "NewProject"; cwd: string }
  | { kind: "ResumeSession"; sessionId: string }
  | { kind: "DeleteSession"; sessionId: string }
  | { kind: "ListSessions" }
  | { kind: "ListModels"; providerId?: string }
  | {
      kind: "ApprovalDecision";
      toolCallId: string;
      decision: ApprovalDecision;
      reason?: string;
    }
  | { kind: "GetConfig" }
  | { kind: "SetConfig"; config: AppConfig };

// =====================================================================
// EventMsg:核心 → UI(同源信封,双向皆可演进)
// =====================================================================

export type ToolCallState =
  | "awaiting-approval"
  | "executing"
  | "completed"
  | "failed"
  | "denied";

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  /** 一行预览:命令文本或文件路径 */
  preview: string;
  /** 危险度说明 */
  description: string;
}

export type AppEvent =
  | { type: "session-meta"; meta: SessionMeta }
  | { type: "sessions-listed"; sessions: SessionMeta[] }
  | { type: "models-listed"; providerId: string; models: string[] }
  | { type: "message-appended"; message: Message }
  | { type: "assistant-delta"; text: string }
  | { type: "assistant-reasoning-delta"; text: string }
  | { type: "assistant-block"; block: ContentBlock }
  /** 子代理活动日志(任务卡片的可展开内部活动,不进主对话流) */
  | { type: "subagent-activity"; toolCallId: string; text: string }
  | { type: "turn-started" }
  | { type: "turn-completed"; usage: TokenUsage | null }
  | {
      type: "tool-state";
      toolCallId: string;
      state: ToolCallState;
      preview: string;
      summary?: string;
    }
  | { type: "approval-requested"; request: ApprovalRequest }
  | { type: "error"; message: string }
  | { type: "config"; config: AppConfig };

// =====================================================================
// zod 校验 schema:跨 IPC 边界的唯一事实源(工具 schema 也由 zod 派生)
// =====================================================================

export const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    name: z.string(),
    isError: z.boolean(),
    content: z.string(),
  }),
]);

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.array(contentBlockSchema),
});

export const sessionMetaSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  title: z.string(),
  model: z.string(),
  cwd: z.string(),
});

export const providerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  models: z.array(z.string()),
  builtin: z.boolean().optional(),
});

export const appConfigSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
  providers: z.array(providerConfigSchema).optional(),
  activeProviderId: z.string().optional(),
  workspaceDir: z.string().optional(),
  reasoningEffort: z.enum(["off", "low", "high", "xhigh", "max"]).optional(),
  permissionMode: z.enum(["full", "write", "ask"]).optional(),
  sandboxMode: z.enum(["full", "restricted"]).optional(),
  showReasoning: z.boolean().optional(),
  maxTokens: z.number().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const opSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SendMessage"), text: z.string() }),
  z.object({ kind: z.literal("Interrupt") }),
  z.object({ kind: z.literal("NewSession") }),
  z.object({ kind: z.literal("NewProject"), cwd: z.string().min(1) }),
  z.object({ kind: z.literal("ResumeSession"), sessionId: z.string() }),
  z.object({ kind: z.literal("DeleteSession"), sessionId: z.string() }),
  z.object({ kind: z.literal("ListSessions") }),
  z.object({ kind: z.literal("ListModels"), providerId: z.string().optional() }),
  z.object({
    kind: z.literal("ApprovalDecision"),
    toolCallId: z.string(),
    decision: z.enum(["allow-once", "allow-always", "deny"]),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal("GetConfig") }),
  z.object({ kind: z.literal("SetConfig"), config: appConfigSchema }),
]);

export const appEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session-meta"), meta: sessionMetaSchema }),
  z.object({ type: z.literal("sessions-listed"), sessions: z.array(sessionMetaSchema) }),
  z.object({
    type: z.literal("models-listed"),
    providerId: z.string(),
    models: z.array(z.string()),
  }),
  z.object({ type: z.literal("message-appended"), message: messageSchema }),
  z.object({ type: z.literal("assistant-delta"), text: z.string() }),
  z.object({ type: z.literal("assistant-reasoning-delta"), text: z.string() }),
  z.object({
    type: z.literal("subagent-activity"),
    toolCallId: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("assistant-block"), block: contentBlockSchema }),
  z.object({ type: z.literal("turn-started") }),
  z.object({ type: z.literal("turn-completed"), usage: tokenUsageSchema.nullable() }),
  z.object({
    type: z.literal("tool-state"),
    toolCallId: z.string(),
    state: z.enum([
      "awaiting-approval",
      "executing",
      "completed",
      "failed",
      "denied",
    ]),
    preview: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal("approval-requested"),
    request: z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      preview: z.string(),
      description: z.string(),
    }),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("config"), config: appConfigSchema }),
]);
