// =====================================================================
// Provider 抽象缝(唯一必须实现:streamBlocks)
// 设计依据:deepseek-harness/11 §2 阶段1——只实现 stream,失败规范化为
// 终结事件;codex/12 第2步——SSE 事件映射为自己的事件类型。
// =====================================================================

import type { ContentBlock, Message, ReasoningEffort, TokenUsage } from "@entrotect/shared";

/** provider 层统一事件(与模型协议无关) */
export type BlockEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "block"; block: ContentBlock }
  | {
      type: "turn-complete";
      finishReason: string | null;
      usage: TokenUsage | null;
    }
  | { type: "error"; message: string };

export interface GenerateOptions {
  systemPrompt: string;
  /** 工具 json schema 数组(顺序固定,保 prompt cache 前缀稳定) */
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  maxTokens: number;
  temperature?: number;
  /** OpenAI 兼容 reasoning_effort(DeepSeek: low / high / xhigh / max;"off" = 不发送) */
  reasoningEffort?: ReasoningEffort;
}

/**
 * LLM 适配缝。换模型家族只换这个实现,主循环不变。
 * messages 为共享词汇层消息(见 @entrotect/shared protocol.ts)。
 */
export interface Provider {
  readonly model: string;
  streamBlocks(
    messages: Message[],
    options: GenerateOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<BlockEvent>;
}
