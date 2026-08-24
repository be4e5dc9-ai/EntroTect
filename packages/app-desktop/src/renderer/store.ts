// =====================================================================
// UI 状态仓库(zustand)+ AppEvent → 状态的事件归约
// 流式文本用 rAF 合帧,避免 per-token 重渲染(感知性能纪律)。
// =====================================================================

import { create } from "zustand";
import type {
  AppEvent,
  SessionMeta,
  SubagentPart,
  ToolCallState,
  TokenUsage,
  AppConfig,
} from "@entrotect/shared";
import { bridge } from "./bridge";

export interface UiBlock {
  kind: "text";
  text: string;
}

export interface UiToolBlock {
  kind: "tool-call";
  id: string;
  name: string;
  preview: string;
  state: ToolCallState;
  summary?: string;
  /** 子代理内部活动日志(task 工具专用,按行拼接) */
  log?: string;
  /** 工具调用实参(JSON.parse 后的原始 arguments;解析失败为 undefined) */
  args?: unknown;
}

/** 文件产出卡片:紧跟对应工具卡片之后展示 */
export interface UiFileBlock {
  kind: "file";
  path: string;
  action: "written" | "edited";
}

export type UiAnyBlock = UiBlock | UiToolBlock | UiFileBlock;

/**
 * 右侧详情栏标签页:浏览器式多标签。
 * id 生成规则:`file-<path>` / `subagent-<toolCallId>`(天然去重,
 * 重复点击聚焦既有标签)。
 */
export type DetailTab =
  | { id: string; kind: "file"; path: string }
  | { id: string; kind: "subagent"; toolCallId: string };

export interface UiMessage {
  key: number;
  role: "user" | "assistant";
  blocks: UiAnyBlock[];
  streaming: boolean;
  /** 思考过程(不回喂历史,仅 UI 展示;未持久化) */
  reasoning: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: "error" | "info";
  leaving?: boolean;
}

export type Theme = "dark" | "light";

/** 主区视图:chat = 聊天,settings = 设置页(替代旧设置弹窗) */
export type View = "chat" | "settings";

export type ModelsByProvider = Record<string, string[]>;
export type ContextWindowsByProvider = Record<string, Record<string, number>>;

export type ContextSnapshot = {
  inputTokens: number;
  contextWindow: number;
  usedRatio: number;
  remainingTokens: number;
};

/** 计算当前回合的上下文占用;缺少有效窗口时不伪造百分比。 */
export function getContextSnapshot(
  inputTokens: number | undefined,
  contextWindow: number | undefined,
): ContextSnapshot | null {
  if (
    inputTokens === undefined ||
    contextWindow === undefined ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(contextWindow) ||
    inputTokens <= 0 ||
    contextWindow <= 0
  ) {
    return null;
  }

  return {
    inputTokens,
    contextWindow,
    usedRatio: Math.min(1, Math.max(0, inputTokens / contextWindow)),
    remainingTokens: Math.max(0, contextWindow - inputTokens),
  };
}

interface UiState {
  sessions: SessionMeta[];
  currentSession: SessionMeta | null;
  messages: UiMessage[];
  busy: boolean;
  usage: TokenUsage | null;
  activeRunId: string | null;
  usageUpdatesBlocked: boolean;
  usageBlockedRunId: string | null;
  usageGeneration: number;
  invalidatedRunIds: string[];
  /** 各供应商的模型缓存(models-listed 事件写入,key = 供应商 id) */
  modelsByProvider: ModelsByProvider;
  /** 各供应商的上下文窗口缓存;仅显式保存时写入配置,供设置页/后续上下文 UI 使用 */
  contextWindowsByProvider: ContextWindowsByProvider;
  approval: {
    toolCallId: string;
    toolName: string;
    preview: string;
    description: string;
  } | null;
  config: AppConfig | null;
  view: View;
  toasts: Toast[];
  error: string | null;
  theme: Theme;
  /** 右侧详情栏标签页(浏览器式,可多开) */
  detailTabs: DetailTab[];
  /** 当前激活标签 id;null = 详情栏隐藏(回两段布局) */
  activeDetailId: string | null;
  /** 文件内容缓存(key = 展示 path;null = 读取失败) */
  fileContents: Record<string, string | null>;
  /** 子代理对话页(key = task 工具调用 id;每条即一个对话流) */
  subagentChats: Record<string, UiMessage[]>;
}

export const useStore = create<UiState>()(() => ({
  sessions: [],
  currentSession: null,
  messages: [],
  busy: false,
  usage: null,
  activeRunId: null,
  usageUpdatesBlocked: false,
  usageBlockedRunId: null,
  usageGeneration: 0,
  invalidatedRunIds: [],
  modelsByProvider: {},
  contextWindowsByProvider: {},
  approval: null,
  config: null,
  view: "chat",
  toasts: [],
  error: null,
  theme: "dark",
  detailTabs: [],
  activeDetailId: null,
  fileContents: {},
  subagentChats: {},
}));

/** 把 renderer 内存中的拉取结果补回设置表单,不修改 store 中的配置快照。 */
export function mergeCachedProviderDataIntoConfig(
  config: AppConfig,
  modelsByProvider: ModelsByProvider,
  contextWindowsByProvider: ContextWindowsByProvider,
  providerIds?: ReadonlySet<string>,
): AppConfig {
  return {
    ...config,
    providers: config.providers?.map((provider) => {
      if (providerIds && !providerIds.has(provider.id)) return provider;
      const models = modelsByProvider[provider.id];
      const contextWindows = contextWindowsByProvider[provider.id];
      return {
        ...provider,
        ...(models && models.length > 0 ? { models: [...models] } : {}),
        ...(contextWindows === undefined
          ? {}
          : { contextWindows: { ...contextWindows } }),
      };
    }),
  };
}

// ---------- rAF 合帧的流式文本缓冲 ----------
let deltaBuffer = "";
let reasoningBuffer = "";
let rafId: number | null = null;

function flushDeltas(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    const textChunk = deltaBuffer;
    const reasoningChunk = reasoningBuffer;
    deltaBuffer = "";
    reasoningBuffer = "";
    if (!textChunk && !reasoningChunk) return;
    useStore.setState((state) => {
      const messages = state.messages.map((message, index) =>
        index === state.messages.length - 1 && message.role === "assistant"
          ? {
              ...message,
              blocks: textChunk ? appendText(message.blocks, textChunk) : message.blocks,
              reasoning: reasoningChunk
                ? message.reasoning + reasoningChunk
                : message.reasoning,
            }
          : message,
      );
      return { messages };
    });
  });
}

function appendText(blocks: UiAnyBlock[], text: string): UiAnyBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text" && !last.text.endsWith("\n")) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...blocks, { kind: "text", text }];
}

// ---------- 子代理对话页:per-key 的 rAF 流式缓冲 ----------
const subagentDeltaBuffers: Record<string, string> = {};
const subagentRafIds: Record<string, number | null> = {};

function flushSubagentDelta(toolCallId: string): void {
  if (subagentRafIds[toolCallId] !== null && subagentRafIds[toolCallId] !== undefined) {
    return;
  }
  subagentRafIds[toolCallId] = requestAnimationFrame(() => {
    subagentRafIds[toolCallId] = null;
    const chunk = subagentDeltaBuffers[toolCallId] ?? "";
    subagentDeltaBuffers[toolCallId] = "";
    if (!chunk) return;
    useStore.setState((state) => ({
      subagentChats: {
        ...state.subagentChats,
        [toolCallId]: updateSubagentLastAssistant(
          state.subagentChats[toolCallId] ?? [],
          (message) => ({
            ...message,
            blocks: appendText(message.blocks, chunk),
          }),
        ),
      },
    }));
  });
}

/** 立即冲刷挂起的 delta(块收口/回合收口前保证顺序) */
function flushSubagentDeltaNow(toolCallId: string): void {
  const pending = subagentDeltaBuffers[toolCallId] ?? "";
  subagentDeltaBuffers[toolCallId] = "";
  if (!pending) return;
  useStore.setState((state) => ({
    subagentChats: {
      ...state.subagentChats,
      [toolCallId]: updateSubagentLastAssistant(
        state.subagentChats[toolCallId] ?? [],
        (message) => ({
          ...message,
          blocks: appendText(message.blocks, pending),
        }),
      ),
    },
  }));
}

function clearSubagentDeltaBuffers(): void {
  for (const key of Object.keys(subagentDeltaBuffers)) {
    delete subagentDeltaBuffers[key];
  }
}

/** 更新对话流最后一条 assistant 消息(不存在则原样返回) */
function updateSubagentLastAssistant(
  messages: UiMessage[],
  update: (message: UiMessage) => UiMessage,
): UiMessage[] {
  return messages.map((message, index) =>
    index === messages.length - 1 && message.role === "assistant"
      ? update(message)
      : message,
  );
}

/** 文本块收口:deltas 构建的文本与定稿对齐,缺失时补块 */
function finalizeText(blocks: UiAnyBlock[], finalText: string): UiAnyBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text") {
    if (last.text === finalText) return blocks;
    return [...blocks.slice(0, -1), { ...last, text: finalText }];
  }
  return [...blocks, { kind: "text", text: finalText }];
}

// ---------- 小工具 ----------
let nextKey = 1;

const TOAST_LIFETIME_MS = 5000;
/** 退场时长须短于入场(emil:退出快于进入) */
const TOAST_EXIT_MS = 180;

function pushToast(kind: Toast["kind"], text: string): void {
  const id = Date.now() + Math.random();
  useStore.setState((state) => ({ toasts: [...state.toasts, { id, kind, text }] }));
  setTimeout(() => {
    // 先打退场标记,transition 播完再移除
    useStore.setState((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    }));
    setTimeout(() => {
      useStore.setState((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, TOAST_EXIT_MS);
  }, TOAST_LIFETIME_MS);
}

function updateToolState(toolCallId: string, patch: Partial<UiToolBlock>): void {
  useStore.setState((state) => ({
    messages: state.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.kind === "tool-call" && block.id === toolCallId
          ? { ...block, ...patch }
          : block,
      ),
    })),
  }));
}

/** 子代理活动日志:追加到对应任务卡片的 log(不占主对话流) */
function appendSubagentLog(toolCallId: string, line: string): void {
  useStore.setState((state) => ({
    messages: state.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.kind === "tool-call" && block.id === toolCallId
          ? { ...block, log: block.log ? `${block.log}\n${line}` : line }
          : block,
      ),
    })),
  }));
}

/** JSON.parse 工具实参;解析失败返回 undefined */
function parseToolArgs(arguments_: string): unknown {
  try {
    return JSON.parse(arguments_);
  } catch {
    return undefined;
  }
}

/** 跨 messages 查找工具卡片 */
function findToolBlock(toolCallId: string): UiToolBlock | undefined {
  for (const message of useStore.getState().messages) {
    const block = message.blocks.find(
      (b): b is UiToolBlock => b.kind === "tool-call" && b.id === toolCallId,
    );
    if (block) return block;
  }
  return undefined;
}

/** 在对应工具卡片之后插入文件卡片;找不到(竞态)则追加到最后一条 assistant 消息 */
function insertFileBlockAfterTool(toolCallId: string, file: UiFileBlock): void {
  useStore.setState((state) => {
    let inserted = false;
    const messages = state.messages.map((message) => {
      if (inserted) return message;
      const index = message.blocks.findIndex(
        (b) => b.kind === "tool-call" && b.id === toolCallId,
      );
      if (index === -1) return message;
      inserted = true;
      return {
        ...message,
        blocks: [
          ...message.blocks.slice(0, index + 1),
          file,
          ...message.blocks.slice(index + 1),
        ],
      };
    });
    if (inserted) return { messages };
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) return { messages };
    return {
      messages: messages.map((m) =>
        m.key === lastAssistant.key ? { ...m, blocks: [...m.blocks, file] } : m,
      ),
    };
  });
}

// ---------- 详情栏标签操作 ----------
/** 子代理标签标题源:task 卡片的 args.prompt,缺省回落 preview */
function subagentPromptOf(toolCallId: string): string {
  const block = findToolBlock(toolCallId);
  const prompt = (block?.args as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt === "string" && prompt.length > 0) return prompt;
  return block?.preview ?? "";
}

/** 确保子代理对话存在:首条 user 消息 = 主代理委派的 prompt */
export function ensureSubagentChat(toolCallId: string): void {
  if (useStore.getState().subagentChats[toolCallId]) return;
  const text = subagentPromptOf(toolCallId);
  useStore.setState((state) => ({
    subagentChats: {
      ...state.subagentChats,
      [toolCallId]: [
        {
          key: nextKey++,
          role: "user",
          blocks: [{ kind: "text", text }],
          streaming: false,
          reasoning: "",
        },
      ],
    },
  }));
}

/** 打开或聚焦文件标签;无缓存时发 ReadFile */
export function openFileTab(path: string): void {
  const id = `file-${path}`;
  useStore.setState((state) => {
    const exists = state.detailTabs.some((tab) => tab.id === id);
    return {
      detailTabs: exists
        ? state.detailTabs
        : [...state.detailTabs, { id, kind: "file", path }],
      activeDetailId: id,
    };
  });
  const cached = useStore.getState().fileContents[path];
  if (cached === undefined) {
    bridge().send({ kind: "ReadFile", path });
  }
}

/** 打开或聚焦子代理标签(顺带初始化对话流) */
export function openSubagentTab(toolCallId: string): void {
  ensureSubagentChat(toolCallId);
  const id = `subagent-${toolCallId}`;
  useStore.setState((state) => {
    const exists = state.detailTabs.some((tab) => tab.id === id);
    return {
      detailTabs: exists
        ? state.detailTabs
        : [...state.detailTabs, { id, kind: "subagent", toolCallId }],
      activeDetailId: id,
    };
  });
}

/** 激活既有标签(点击标签条) */
export function activateDetailTab(id: string): void {
  useStore.setState({ activeDetailId: id });
}

/** 关闭标签:激活标签被关则顺延到邻位;关光则隐藏详情栏 */
export function closeDetailTab(id: string): void {
  useStore.setState((state) => {
    const index = state.detailTabs.findIndex((tab) => tab.id === id);
    if (index === -1) return {};
    const tabs = state.detailTabs.filter((tab) => tab.id !== id);
    let activeDetailId = state.activeDetailId;
    if (state.activeDetailId === id) {
      const neighbor = tabs[Math.min(index, tabs.length - 1)];
      activeDetailId = neighbor?.id ?? null;
    }
    return { detailTabs: tabs, activeDetailId };
  });
}

/** 子代理对话页:part → 对话流(镜像主对话的事件语义) */
function applySubagentPart(toolCallId: string, part: SubagentPart): void {
  switch (part.kind) {
    case "turn-start":
      ensureSubagentChat(toolCallId);
      useStore.setState((state) => ({
        subagentChats: {
          ...state.subagentChats,
          [toolCallId]: [
            ...(state.subagentChats[toolCallId] ?? []),
            {
              key: nextKey++,
              role: "assistant",
              blocks: [],
              streaming: true,
              reasoning: "",
            },
          ],
        },
      }));
      break;
    case "delta":
      ensureSubagentChat(toolCallId);
      subagentDeltaBuffers[toolCallId] =
        (subagentDeltaBuffers[toolCallId] ?? "") + part.text;
      flushSubagentDelta(toolCallId);
      break;
    case "block":
      ensureSubagentChat(toolCallId);
      flushSubagentDeltaNow(toolCallId);
      if (part.block.type === "text") {
        const text = part.block.text;
        useStore.setState((state) => ({
          subagentChats: {
            ...state.subagentChats,
            [toolCallId]: updateSubagentLastAssistant(
              state.subagentChats[toolCallId] ?? [],
              (message) => ({
                ...message,
                blocks: finalizeText(message.blocks, text),
              }),
            ),
          },
        }));
      } else if (part.block.type === "tool-call") {
        const call = part.block;
        useStore.setState((state) => ({
          subagentChats: {
            ...state.subagentChats,
            [toolCallId]: updateSubagentLastAssistant(
              state.subagentChats[toolCallId] ?? [],
              (message) => ({
                ...message,
                blocks: [
                  ...message.blocks,
                  {
                    kind: "tool-call",
                    id: call.id,
                    name: call.name,
                    preview: call.name,
                    state: "awaiting-approval",
                    args: parseToolArgs(call.arguments),
                  },
                ],
              }),
            ),
          },
        }));
      }
      break;
    case "turn-end":
      ensureSubagentChat(toolCallId);
      flushSubagentDeltaNow(toolCallId);
      useStore.setState((state) => ({
        subagentChats: {
          ...state.subagentChats,
          [toolCallId]: updateSubagentLastAssistant(
            state.subagentChats[toolCallId] ?? [],
            (message) => ({ ...message, streaming: false }),
          ),
        },
      }));
      break;
    case "tool-state":
      ensureSubagentChat(toolCallId);
      useStore.setState((state) => ({
        subagentChats: {
          ...state.subagentChats,
          [toolCallId]: (state.subagentChats[toolCallId] ?? []).map((message) => ({
            ...message,
            blocks: message.blocks.map((block) =>
              block.kind === "tool-call" && block.id === part.toolCallId
                ? {
                    ...block,
                    state: part.state,
                    ...(part.summary !== undefined ? { summary: part.summary } : {}),
                  }
                : block,
            ),
          })),
        },
      }));
      break;
  }
}

// ---------- 事件归约 ----------
function invalidateUsage(state: UiState): Pick<
  UiState,
  "usage" | "usageUpdatesBlocked" | "usageBlockedRunId" | "usageGeneration" | "invalidatedRunIds"
> {
  const invalidatedRunIds =
    state.activeRunId === null || state.invalidatedRunIds.includes(state.activeRunId)
      ? state.invalidatedRunIds
      : [...state.invalidatedRunIds, state.activeRunId];
  return {
    usage: null,
    usageUpdatesBlocked: true,
    usageBlockedRunId: state.activeRunId,
    usageGeneration: state.usageGeneration + 1,
    invalidatedRunIds,
  };
}

export function applyEvent(event: AppEvent): void {
  switch (event.type) {
    case "session-meta": {
      flushDeltas();
      deltaBuffer = "";
      reasoningBuffer = "";
      clearSubagentDeltaBuffers();
      useStore.setState((state) => {
        const sessionChanged =
          state.currentSession?.id !== event.meta.id ||
          state.currentSession?.model !== event.meta.model;
        return {
          currentSession: event.meta,
          messages: [],
          busy: false,
          ...(sessionChanged ? invalidateUsage(state) : { usage: state.usage }),
          approval: null,
          detailTabs: [],
          activeDetailId: null,
          fileContents: {},
          subagentChats: {},
        };
      });
      break;
    }
    case "sessions-listed":
      useStore.setState((state) => {
        const current = state.currentSession;
        const stillExists = current && event.sessions.some((s) => s.id === current.id);
        if (current && !stillExists) {
          // 当前对话已被删除:清空视图
          return {
            sessions: event.sessions,
            currentSession: null,
            messages: [],
            busy: false,
            approval: null,
          };
        }
        return { sessions: event.sessions };
      });
      break;
    case "models-listed":
      // 空结果代表失败/无数据,不能抹掉已有缓存;状态页仍由原始事件更新失败提示。
      if (event.models.length === 0) break;
      useStore.setState((state) => ({
        modelsByProvider: {
          ...state.modelsByProvider,
          [event.providerId]: [...event.models],
        },
        ...(event.contextWindows === undefined
          ? {}
          : {
              contextWindowsByProvider: {
                ...state.contextWindowsByProvider,
                [event.providerId]: { ...event.contextWindows },
              },
            }),
      }));
      break;
    case "message-appended": {
      const message = event.message;
      const textBlocks = message.content.filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      );
      const toolResults = message.content.filter(
        (b): b is Extract<typeof b, { type: "tool-result" }> => b.type === "tool-result",
      );
      const toolCalls = message.content.filter(
        (b): b is Extract<typeof b, { type: "tool-call" }> => b.type === "tool-call",
      );

      // user 消息里的 tool-result:回填工具卡片状态(重放/恢复路径)
      if (message.role === "user" && toolResults.length > 0) {
        for (const result of toolResults) {
          const toolBlock = findToolBlock(result.toolCallId);
          updateToolState(result.toolCallId, {
            state: result.isError ? "failed" : "completed",
            summary: result.isError
              ? result.content.slice(0, 200)
              : toolBlock?.name === "task"
                ? result.content
                : undefined,
          });
          // 重放也能看到历史产出文件:write/edit 成功 → 卡片后插文件块
          if (
            !result.isError &&
            toolBlock &&
            (toolBlock.name === "write" || toolBlock.name === "edit")
          ) {
            const filePath = (toolBlock.args as { file_path?: unknown } | null)
              ?.file_path;
            if (typeof filePath === "string" && filePath.length > 0) {
              insertFileBlockAfterTool(result.toolCallId, {
                kind: "file",
                path: filePath,
                action: toolBlock.name === "edit" ? "edited" : "written",
              });
            }
          }
          // 恢复会话后点开子代理卡片:用 tool-result 内容重建最终答复
          // (subagent-part 是内存流,不落盘;历史恢复以此兜底)
          if (toolBlock?.name === "task") {
            ensureSubagentChat(result.toolCallId);
            useStore.setState((state) => ({
              subagentChats: {
                ...state.subagentChats,
                [result.toolCallId]: [
                  ...(state.subagentChats[result.toolCallId] ?? []),
                  {
                    key: nextKey++,
                    role: "assistant",
                    blocks: [{ kind: "text", text: result.content }],
                    streaming: false,
                    reasoning: "",
                  },
                ],
              },
            }));
          }
        }
        return;
      }

      // 普通 user 文本消息
      if (message.role === "user") {
        if (textBlocks.length === 0) return;
        useStore.setState((state) => ({
          messages: [
            ...state.messages,
            {
              key: nextKey++,
              role: "user",
              blocks: textBlocks.map((b) => ({ kind: "text" as const, text: b.text })),
              streaming: false,
              reasoning: "",
            },
          ],
        }));
        return;
      }

      // assistant:活跃回合期间由 block/delta 事件驱动,忽略此回显;
      // 非活跃(重放)时用完整消息重建。
      const busy = useStore.getState().busy;
      if (busy) return;
      useStore.setState((state) => ({
        messages: [
          ...state.messages,
          {
            key: nextKey++,
            role: "assistant",
            blocks: [
              ...textBlocks.map((b) => ({ kind: "text" as const, text: b.text })),
              ...toolCalls.map((b) => ({
                kind: "tool-call" as const,
                id: b.id,
                name: b.name,
                preview: b.name,
                state: "completed" as const,
                args: parseToolArgs(b.arguments),
              })),
            ],
            streaming: false,
            reasoning: "",
          },
        ],
      }));
      break;
    }
    case "assistant-delta":
      deltaBuffer += event.text;
      flushDeltas();
      break;
    case "assistant-reasoning-delta":
      reasoningBuffer += event.text;
      flushDeltas();
      break;
    case "subagent-activity":
      appendSubagentLog(event.toolCallId, event.text);
      break;
    case "subagent-part":
      applySubagentPart(event.toolCallId, event.part);
      break;
    case "file-changed":
      insertFileBlockAfterTool(event.toolCallId, {
        kind: "file",
        path: event.path,
        action: event.action,
      });
      break;
    case "file-content":
      useStore.setState((state) => ({
        fileContents: { ...state.fileContents, [event.path]: event.content },
      }));
      break;
    case "assistant-block": {
      // 文本块收口:deltas 已流式构建文本,此处只做对齐/补缺
      if (event.block.type === "text") {
        deltaBuffer = "";
        useStore.setState((state) => ({
          messages: state.messages.map((message, index) =>
            index === state.messages.length - 1 && message.role === "assistant"
              ? { ...message, blocks: finalizeText(message.blocks, event.block.type === "text" ? event.block.text : "") }
              : message,
          ),
        }));
      } else if (event.block.type === "tool-call") {
        const call = event.block;
        useStore.setState((state) => ({
          messages: state.messages.map((message, index) =>
            index === state.messages.length - 1 && message.role === "assistant"
              ? {
                  ...message,
                  blocks: [
                    ...message.blocks,
                    {
                      kind: "tool-call",
                      id: call.id,
                      name: call.name,
                      preview: call.name,
                      state: "awaiting-approval",
                      args: parseToolArgs(call.arguments),
                    },
                  ],
                }
              : message,
          ),
        }));
      }
      break;
    }
    case "turn-started":
      useStore.setState((state) => {
        if (event.runId !== undefined && state.invalidatedRunIds.includes(event.runId)) {
          return {};
        }
        // A changed config/session may leave an old run in flight. Its repeated
        // turn-started events must not reopen usage updates as a new run.
        const startsNewRun =
          !state.usageUpdatesBlocked ||
          state.usageBlockedRunId === null ||
          event.runId === undefined ||
          event.runId !== state.usageBlockedRunId;
        return {
          busy: true,
          activeRunId: event.runId ?? state.activeRunId,
          usageUpdatesBlocked: startsNewRun ? false : true,
          usageBlockedRunId: startsNewRun ? null : state.usageBlockedRunId,
          messages: [
            ...state.messages,
            { key: nextKey++, role: "assistant", blocks: [], streaming: true, reasoning: "" },
          ],
        };
      });
      break;
    case "turn-completed":
      useStore.setState((state) => {
        if (event.runId !== undefined && state.invalidatedRunIds.includes(event.runId)) {
          return {};
        }
        const isCurrentRun =
          event.runId === undefined ||
          state.activeRunId === null ||
          event.runId === state.activeRunId;
        return {
          busy: false,
          usage:
            event.usage !== null && !state.usageUpdatesBlocked && isCurrentRun
              ? event.usage
              : state.usage,
          messages: state.messages.map((message, index) =>
            index === state.messages.length - 1 && message.role === "assistant"
              ? { ...message, streaming: false }
              : message,
          ),
        };
      });
      break;
    case "tool-state":
      updateToolState(event.toolCallId, {
        state: event.state,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      });
      // 该工具已有裁决:关闭对应审批弹窗(含超时自动 deny 路径)
      useStore.setState((state) =>
        state.approval?.toolCallId === event.toolCallId
          ? { approval: null }
          : {},
      );
      break;
    case "approval-requested":
      useStore.setState({ approval: event.request });
      break;
    case "error":
      deltaBuffer = "";
      reasoningBuffer = "";
      useStore.setState({ error: event.message, busy: false });
      pushToast("error", event.message);
      break;
    case "config":
      useStore.setState((state) => {
        const contextWindowsByProvider = { ...state.contextWindowsByProvider };
        for (const provider of event.config.providers ?? []) {
          // 已有内存结果优先,避免 config 回包覆盖尚未显式保存的自动拉取结果。
          if (
            contextWindowsByProvider[provider.id] === undefined &&
            provider.contextWindows !== undefined
          ) {
            contextWindowsByProvider[provider.id] = { ...provider.contextWindows };
          }
        }
        const activeProviderChanged =
          (state.config?.activeProviderId ?? "deepseek") !==
          (event.config.activeProviderId ?? "deepseek");
        const activeModelChanged = state.config?.model !== event.config.model;
        const configChanged =
          state.config && (activeProviderChanged || activeModelChanged);
        return {
          config: event.config,
          contextWindowsByProvider,
          ...(configChanged ? invalidateUsage(state) : {}),
        };
      });
      break;
  }
}
