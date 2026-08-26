// =====================================================================
// Anthropic Messages API 适配器
// 端点:{baseUrl}/messages  鉴权:x-api-key  流式:SSE event: 行
// =====================================================================

import type { Message, ReasoningEffort } from "@entrotect/shared";
import type { BlockEvent, GenerateOptions, Provider } from "./types.js";
import { readSseLines } from "./sse.js";
import { ProviderError } from "./openai-compatible.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const STREAM_IDLE_TIMEOUT_MS = 90_000;
const RETRY_DELAY_BASE_MS = 1000;
const RETRY_MAX = 2;

type TextBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "text" }>;
type ToolCallBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "tool-call" }>;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessages(messages: Message[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  let system = "";
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = msg.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) system += (system ? "\n" : "") + text;
      continue;
    }

    if (msg.role === "assistant") {
      const parts: AnthropicContentBlock[] = [];
      for (const b of msg.content) {
        if (b.type === "text") {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "tool-call") {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(b.arguments);
          } catch { /* keep empty */ }
          parts.push({
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: parsed,
          });
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
      continue;
    }

    // user: 文本块 + tool_result 块合并到同一条 user 消息
    const parts: AnthropicContentBlock[] = [];
    const text = msg.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) parts.push({ type: "text", text });
    for (const b of msg.content) {
      if (b.type === "tool-result") {
        parts.push({
          type: "tool_result",
          tool_use_id: b.toolCallId,
          content: b.content,
        });
      }
    }
    if (parts.length > 0) out.push({ role: "user", content: parts });
  }

  return { system, messages: out };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens: number; output_tokens: number }; stop_reason?: string };
  error?: { type?: string; message?: string };
}

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
}

export class AnthropicProvider implements Provider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: AnthropicProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async *streamBlocks(
    messages: Message[],
    options: GenerateOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<BlockEvent> {
    const controller = new AbortController();
    let watchdogFired = false;
    let watchdog: NodeJS.Timeout | undefined;
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    let response: Response;
    try {
      response = await this.requestWithRetry(messages, options, controller.signal);
    } catch (error) {
      if (signal?.aborted) return;
      const msg = error instanceof Error ? error.message : String(error);
      yield { type: "error", message: msg };
      return;
    }

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        watchdogFired = true;
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    let textBuffer = "";
    let textStarted = false;
    const toolCalls = new Map<number, { id: string; name: string; inputBuffer: string }>();
    let finishReason: string | null = null;
    let blocksFlushed = false;
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    const flushTextBlock = (): BlockEvent | null => {
      if (textStarted && textBuffer.length > 0) {
        const event: BlockEvent = {
          type: "block",
          block: { type: "text", text: textBuffer },
        };
        textBuffer = "";
        return event;
      }
      textBuffer = "";
      return null;
    };

    const flushToolBlocks = (): BlockEvent[] => {
      const events: BlockEvent[] = [];
      const sorted = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, call] of sorted) {
        if (!call.id || !call.name) continue;
        events.push({
          type: "block",
          block: {
            type: "tool-call",
            id: call.id,
            name: call.name,
            arguments: call.inputBuffer || "{}",
          },
        });
      }
      toolCalls.clear();
      return events;
    };

    const flushBlocksOnce = (): BlockEvent[] => {
      if (blocksFlushed) return [];
      blocksFlushed = true;
      const events: BlockEvent[] = [];
      const textBlock = flushTextBlock();
      if (textBlock) events.push(textBlock);
      events.push(...flushToolBlocks());
      return events;
    };

    try {
      armWatchdog();
      const lines = readSseLines(response.body!);
      let currentEvent = "";

      while (true) {
        const next = await lines.next();
        if (next.done) break;
        armWatchdog();
        const line = next.value;

        // Anthropic SSE: "event: xxx" 行在 "data: ..." 行之前
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(line) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        if (event.error) {
          yield { type: "error", message: event.error.message ?? "Anthropic 返回错误" };
          controller.abort();
          return;
        }

        switch (currentEvent) {
          case "content_block_start": {
            const cb = event.content_block;
            if (cb?.type === "tool_use") {
              toolCalls.set(event.index!, {
                id: cb.id ?? "",
                name: cb.name ?? "",
                inputBuffer: "",
              });
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (!delta) break;
            if (delta.type === "text_delta" && delta.text) {
              textStarted = true;
              textBuffer += delta.text;
              yield { type: "text-delta", text: delta.text };
            } else if (delta.type === "input_json_delta" && delta.text) {
              // tool_use input 片段
              const call = toolCalls.get(event.index!);
              if (call) call.inputBuffer += delta.text;
            }
            break;
          }
          case "content_block_stop": {
            // 文本块结束:收口
            if (textStarted) {
              const block = flushTextBlock();
              if (block) yield block;
              textStarted = false;
            }
            break;
          }
          case "message_delta": {
            const delta = event.delta;
            if (delta?.stop_reason) finishReason = delta.stop_reason;
            const msgUsage = event.message?.usage;
            if (msgUsage) {
              usage = {
                inputTokens: msgUsage.input_tokens,
                outputTokens: msgUsage.output_tokens,
              };
            }
            break;
          }
          case "message_start": {
            const msgUsage = event.message?.usage;
            if (msgUsage) {
              usage = {
                inputTokens: msgUsage.input_tokens,
                outputTokens: msgUsage.output_tokens,
              };
            }
            break;
          }
        }
      }

      for (const ev of flushBlocksOnce()) yield ev;
      yield { type: "turn-complete", finishReason, usage };
    } catch (error) {
      if (controller.signal.aborted) {
        if (watchdogFired) {
          yield {
            type: "error",
            message: `流空闲超过 ${STREAM_IDLE_TIMEOUT_MS / 1000}s,连接已重置`,
          };
        }
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      yield { type: "error", message: msg };
    } finally {
      if (watchdog) clearTimeout(watchdog);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async requestWithRetry(
    messages: Message[],
    options: GenerateOptions,
    signal?: AbortSignal,
  ): Promise<Response> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);

    const tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens,
      messages: anthropicMsgs,
      tools,
      stream: true,
    };
    if (system) body.system = system;

    let attempt = 0;
    for (;;) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
            signal,
          },
        );

        if (!response.ok) {
          let detail = "";
          try {
            const errBody = (await response.json()) as { error?: { message?: string } };
            detail = errBody.error?.message ?? "";
          } catch { /* ignore */ }
          throw new ProviderError(
            `Anthropic 接口返回 ${response.status}: ${detail || response.statusText}`,
            response.status,
          );
        }
        return response;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (signal?.aborted) throw error;
        if (attempt >= RETRY_MAX) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new ProviderError(`请求 Anthropic 失败(已重试 ${RETRY_MAX} 次): ${msg}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_BASE_MS * 2 ** attempt),
        );
        attempt++;
      }
    }
  }
}
