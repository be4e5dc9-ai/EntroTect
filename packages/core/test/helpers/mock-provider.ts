// =====================================================================
// 测试助手:可脚本化的 MockProvider
// 把 BlockEvent 序列"录制"成流,让主循环测试不依赖真实模型。
// =====================================================================

import type { Message } from "@entrotect/shared";
import type { BlockEvent, GenerateOptions, Provider } from "../src/provider/types.js";

export interface ScriptedChunk {
  events: BlockEvent[];
}

export class MockProvider implements Provider {
  readonly model = "mock-model";
  /** 每轮依次消费一个脚本;不足时返回空回合 */
  script: ScriptedChunk[] = [];
  /** 收到的历史快照(供断言) */
  receivedHistory: Message[][] = [];

  constructor(script: ScriptedChunk[]) {
    this.script = [...script];
  }

  async *streamBlocks(
    messages: Message[],
    _options: GenerateOptions,
    _signal?: AbortSignal,
  ): AsyncGenerator<BlockEvent> {
    this.receivedHistory.push(JSON.parse(JSON.stringify(messages)) as Message[]);
    const chunk = this.script.shift();
    if (!chunk) {
      yield { type: "turn-complete", finishReason: "stop", usage: null };
      return;
    }
    for (const event of chunk.events) yield event;
  }
}

/** 工具调用脚本块 */
export function toolCall(id: string, name: string, arguments_: string): BlockEvent {
  return {
    type: "block",
    block: { type: "tool-call", id, name, arguments: arguments_ },
  };
}

/** 文本块 */
export function textBlock(text: string): BlockEvent {
  return { type: "block", block: { type: "text", text } };
}

/** 文本增量(流式) */
export function textDelta(text: string): BlockEvent {
  return { type: "text-delta", text };
}

/** 回合收口 */
export function turnComplete(usage: { inputTokens: number; outputTokens: number } | null = null): BlockEvent {
  return { type: "turn-complete", finishReason: "stop", usage };
}
