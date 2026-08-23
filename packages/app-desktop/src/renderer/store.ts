// =====================================================================
// UI 状态仓库(zustand)+ AppEvent → 状态的事件归约
// 流式文本用 rAF 合帧,避免 per-token 重渲染(感知性能纪律)。
// =====================================================================

import { create } from "zustand";
import type {
  AppEvent,
  SessionMeta,
  ToolCallState,
  TokenUsage,
  AppConfig,
} from "@entrotect/shared";

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
}

export type UiAnyBlock = UiBlock | UiToolBlock;

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

interface UiState {
  sessions: SessionMeta[];
  currentSession: SessionMeta | null;
  messages: UiMessage[];
  busy: boolean;
  usage: TokenUsage | null;
  /** 各供应商的模型缓存(models-listed 事件写入,key = 供应商 id) */
  modelsByProvider: Record<string, string[]>;
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
}

export const useStore = create<UiState>()(() => ({
  sessions: [],
  currentSession: null,
  messages: [],
  busy: false,
  usage: null,
  modelsByProvider: {},
  approval: null,
  config: null,
  view: "chat",
  toasts: [],
  error: null,
  theme: "dark",
}));

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

// ---------- 事件归约 ----------
export function applyEvent(event: AppEvent): void {
  switch (event.type) {
    case "session-meta": {
      flushDeltas();
      deltaBuffer = "";
      reasoningBuffer = "";
      useStore.setState({
        currentSession: event.meta,
        messages: [],
        busy: false,
        usage: null,
        approval: null,
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
      useStore.setState((state) => ({
        modelsByProvider: {
          ...state.modelsByProvider,
          [event.providerId]: event.models,
        },
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
          updateToolState(result.toolCallId, {
            state: result.isError ? "failed" : "completed",
            summary: result.isError ? result.content.slice(0, 200) : undefined,
          });
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
      useStore.setState((state) => ({
        busy: true,
        messages: [
          ...state.messages,
          { key: nextKey++, role: "assistant", blocks: [], streaming: true, reasoning: "" },
        ],
      }));
      break;
    case "turn-completed":
      useStore.setState((state) => ({
        busy: false,
        usage: event.usage,
        messages: state.messages.map((message, index) =>
          index === state.messages.length - 1 && message.role === "assistant"
            ? { ...message, streaming: false }
            : message,
        ),
      }));
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
      useStore.setState({ config: event.config });
      break;
  }
}
