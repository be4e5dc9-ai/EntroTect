// =====================================================================
// 上下文压缩(autocompact):超阈值自动压缩 + /compact 手动压缩
// 设计依据:ClaudeCode compaction —— 模型把历史总结成摘要,
// 历史替换为 [摘要消息 + 最近 N 条],摘要作为 user 消息回填。
// =====================================================================

import type { Message, ProviderConfig, ReasoningEffort } from "@entrotect/shared";
import { randomUUID } from "node:crypto";
import type { Provider } from "./provider/types.js";
import { knownContextWindow, knownMaxTokens, suffixContextWindow } from "./provider/contexts.js";
import { normalizeToolHistory } from "./tool-history.js";

/** 保留的最近消息数(压缩后) */
export const COMPACT_KEEP_RECENT = 6;
/** 触发自动压缩的上下文占用阈值 */
export const COMPACT_RATIO = 0.7;
/** Legacy export; message count no longer overrides the context budget. */
export const COMPACT_MIN_MESSAGES = 8;
export const COMPACT_TIMEOUT_MS = 180_000;
const MIN_COMPACT_TOKENS = 512;
// Completion limits include hidden reasoning. Keep the summary target separate
// from the provider's total output allowance, with more room at higher efforts.
const COMPACT_OUTPUT_BY_EFFORT: Record<ReasoningEffort, number> = {
  off: 8_192,
  low: 8_192,
  medium: 12_288,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
  ultra: 32_768,
};
const COMPACT_MAX_RETRY_OUTPUT = 65_536;

export const COMPACT_SYSTEM_PROMPT = `把对话压缩成可直接继续工作的事实摘要。保留：
- 用户当前目标、明确偏好与仍有效的约束；
- 已完成改动、关键文件/命令、验证结果和重要决策；
- 最新计划状态、失败过的方法、未决风险和下一步。
以最新状态覆盖已过时状态，保留必须逐字准确的路径、标识符和命令。省略寒暄、重复叙述、原始工具日志与已失效计划。不要推测或补写不存在的事实，直接输出摘要。`;

/** 粗估 tokens:中文约 1.5 字符/token,英文约 4 字符/token,取 2.5 折中 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.reasoningContent?.length ?? 0;
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool-call") chars += block.name.length + block.arguments.length;
      else if (block.type === "tool-result") chars += block.content.length;
      else if (block.type === "image") chars += 2560; // Approximate visual input, not base64 length.
    }
  }
  return Math.ceil(chars / 2.5);
}

/** 解析模型上下文窗口:内置表 > id 后缀 > 默认 128k */
export function resolveContextWindow(
  model: string,
  providers?: ProviderConfig[],
): number {
  // 供应商配置里的 contextWindows(键为模型 id)
  for (const provider of providers ?? []) {
    const windows = provider.contextWindows as Record<string, number> | undefined;
    if (windows && typeof windows[model] === "number" && windows[model] > 0) {
      return windows[model];
    }
  }
  return knownContextWindow(model) ?? suffixContextWindow(model) ?? 128_000;
}

/** 是否需要自动压缩(ratio 为触发阈值比例,0.1–1) */
export function shouldAutoCompact(
  messages: Message[],
  model: string,
  providers?: ProviderConfig[],
  ratio: number = COMPACT_RATIO,
): boolean {
  if (messages.length === 0) return false;
  const window = resolveContextWindow(model, providers);
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0.1, ratio)) : COMPACT_RATIO;
  return estimateTokens(messages) >= window * clamped;
}

export interface CompactOptions {
  id?: string;
  contextWindow?: number;
  timeoutMs?: number;
  /** Use the session's effective native effort; ultra maps to max without delegation. */
  reasoningEffort?: ReasoningEffort;
}

export interface CompactResult {
  compacted: Message[];
  summary: string;
  changed: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/** A retained suffix must contain complete tool exchanges, including multi-call batches. */
function validToolPairs(messages: Message[]): boolean {
  return normalizeToolHistory(messages) === messages;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const edge = Math.max(0, Math.floor((limit - 24) / 2));
  return `${text.slice(0, edge)}\n[中间内容省略]\n${text.slice(-edge)}`;
}

function summaryInput(messages: Message[], contextWindow: number): string {
  const limit = Math.max(2048, Math.min(240_000, Math.floor(contextWindow * 1.2)));
  const perMessage = Math.max(160, Math.min(24_000, Math.floor(limit / Math.max(1, messages.length))));
  return clip(messages.map((message, index) => {
    const text = message.content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool-call") return `[工具调用 ${block.name} ${block.id}] ${block.arguments}`;
      if (block.type === "tool-result") return `[工具结果 ${block.toolCallId}${block.isError ? " 失败" : ""}] ${clip(block.content, 6000)}`;
      return `[图片附件 ${block.mime}]`;
    }).join("\n");
    return `#${index + 1} ${message.role}:\n${clip(text, perMessage)}`;
  }).join("\n\n"), limit);
}

/** A deadline covers connection setup and streaming, even if a provider ignores cancellation. */
async function readSummary(
  provider: Provider,
  body: string,
  budget: number,
  effort: ReasoningEffort,
  contextWindow: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  signal?.throwIfAborted();
  const nativeEffort = effort === "ultra" ? "max" : effort;
  const systemPrompt = `${COMPACT_SYSTEM_PROMPT}\n只总结提供的早期历史；后续原文会另行保留。摘要尽量不超过 ${budget} tokens。`;
  // Reserve context for the summary request itself and avoid asking the model
  // for more output than its known capability or remaining context allows.
  const inputTokens = Math.ceil((body.length + systemPrompt.length) / 2.5) + 512;
  const outputLimit = Math.min(knownMaxTokens(provider.model) ?? COMPACT_MAX_RETRY_OUTPUT, COMPACT_MAX_RETRY_OUTPUT, contextWindow - inputTokens);
  if (outputLimit < 512) throw new Error("压缩输入超过模型可用上下文，已保留原上下文。");
  const firstLimit = Math.min(outputLimit, Math.max(COMPACT_OUTPUT_BY_EFFORT[nativeEffort], budget * 3));
  const retryLimit = Math.min(outputLimit, firstLimit * 2);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason ?? new Error("压缩已取消"));
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`上下文压缩超时（${Math.round(timeoutMs / 1000)} 秒），已保留原上下文。`)), timeoutMs);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  let stream: ReturnType<Provider["streamBlocks"]> | undefined;
  try {
    for (const maxTokens of firstLimit < retryLimit ? [firstLimit, retryLimit] : [firstLimit]) {
      const blocks: string[] = [];
      let deltas = "";
      let completed = false;
      let finishReason: string | null = null;
      stream = provider.streamBlocks(
        [{ role: "user", content: [{ type: "text", text: body }] }],
        { systemPrompt, tools: [], maxTokens, temperature: 0, reasoningEffort: nativeEffort },
        controller.signal,
      );
      for (;;) {
        const next = await Promise.race([stream.next(), aborted]);
        if (next.done) break;
        const event = next.value;
        if (event.type === "error") throw new Error(`压缩失败: ${event.message}`);
        if (event.type === "text-delta") deltas += event.text;
        if (event.type === "block" && event.block.type === "text") {
          blocks.push(event.block.text);
          deltas = ""; // Final blocks already contain their streamed deltas.
        }
        if (event.type === "turn-complete") {
          completed = true;
          finishReason = event.finishReason?.toLowerCase() ?? null;
        }
      }
      stream = undefined;
      controller.signal.throwIfAborted();
      const summary = [...blocks, deltas].join("").trim();
      if (completed && (!finishReason || ["stop", "end_turn", "stop_sequence"].includes(finishReason)) && summary) return summary;
      if ((finishReason === "length" || finishReason === "max_tokens") && maxTokens < retryLimit) continue;
      if (finishReason && !["stop", "end_turn", "stop_sequence"].includes(finishReason)) {
        throw new Error(`压缩摘要未完整生成（${finishReason}），已保留原上下文。`);
      }
      throw new Error("压缩失败: 模型未返回完整摘要，已保留原上下文。");
    }
    throw new Error("压缩摘要未完整生成（length），已保留原上下文。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    // A stalled iterator may not settle return(); never let it keep the session locked.
    void stream?.return(undefined).catch(() => {});
  }
}

/** Summarize only the removed prefix; retain recent, complete tool exchanges within budget. */
export async function compactMessages(
  provider: Provider,
  messages: Message[],
  signal?: AbortSignal,
  options: CompactOptions = {},
): Promise<CompactResult> {
  signal?.throwIfAborted();
  const beforeTokens = estimateTokens(messages);
  const unchanged = (): CompactResult => ({ compacted: messages, summary: "", changed: false, beforeTokens, afterTokens: beforeTokens });
  if (beforeTokens < MIN_COMPACT_TOKENS) return unchanged();
  const contextWindow = options.contextWindow ?? resolveContextWindow(provider.model);
  const retentionBudget = Math.floor(Math.min(beforeTokens * 0.25, contextWindow * 0.2));
  // Preserve an unsent user request verbatim, including images. Earlier user
  // instructions are summarized together with the work they led to.
  const last = messages.at(-1);
  const protectLast = last?.role === "user" && last.content.some((block) => block.type === "text" || block.type === "image");
  const maxStart = messages.length - (protectLast ? 1 : 0);
  let split = -1;
  for (let index = Math.max(1, messages.length - COMPACT_KEEP_RECENT); index <= maxStart; index++) {
    const suffix = messages.slice(index);
    if (suffix.some((message) => message.compaction) || !validToolPairs(suffix)) continue;
    if (estimateTokens(suffix) <= retentionBudget || index === maxStart) { split = index; break; }
  }
  if (split < 1) return unchanged();
  const keep = messages.slice(split);
  const summaryBudget = Math.max(256, Math.min(4000, Math.floor((beforeTokens - estimateTokens(keep)) * 0.35)));
  const summary = await readSummary(provider, summaryInput(messages.slice(0, split), contextWindow), summaryBudget, options.reasoningEffort ?? "high", contextWindow, signal, options.timeoutMs ?? COMPACT_TIMEOUT_MS);
  const summaryMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `【对话压缩摘要】以下为本次会话早期历史的压缩总结，请以此为上下文继续，不要重复已完成的工作：\n\n${summary}`,
      },
    ],
  };
  const compacted = [summaryMessage, ...keep];
  const afterTokens = estimateTokens(compacted);
  if (afterTokens >= beforeTokens) return unchanged();
  summaryMessage.compaction = { id: options.id ?? randomUUID(), createdAt: new Date().toISOString(), retainedMessages: keep.length, beforeTokens, afterTokens };
  return { compacted, summary, changed: true, beforeTokens, afterTokens };
}
