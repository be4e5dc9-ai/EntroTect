// =====================================================================
// Anthropic Messages API 适配器
// 端点:{baseUrl}/messages  鉴权:x-api-key + anthropic-version
// 流式:SSE event:/data: 行对(必须按事件边界解析,event 行不可丢)
// =====================================================================

import type { Message } from "@entrotect/shared";
import type { BlockEvent, GenerateOptions, Provider } from "./types.js";
import { readSseEvents } from "./sse.js";
import { requestWithNetworkRetry, type FetchLike } from "./transport.js";
import { appendEndpoint, buildProviderHeaders } from "./profiles.js";
import { clampMaxTokens } from "./contexts.js";

const STREAM_IDLE_TIMEOUT_MS = 90_000;

type TextBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "text" }>;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  source?: { type: "base64"; media_type?: string; data?: string };
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessages(messages: Message[]): {
  system: string;
  messages: AnthropicMessage[];
} {  let system = "";
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

    // user: 文本块 + 图片块 + tool_result 块合并到同一条 user 消息
    const parts: AnthropicContentBlock[] = [];
    const text = msg.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) parts.push({ type: "text", text });
    for (const b of msg.content) {
      if (b.type === "image") {
        parts.push({
          type: "image",
          source: { type: "base64", media_type: b.mime, data: b.dataBase64 },
        });
      } else if (b.type === "tool-result") {
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
  usage?: { output_tokens?: number };
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
      response = await this.requestOnce(messages, options, controller.signal);
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
    // message_start 报告输入,message_delta 只带累计输出,分头累积
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

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
      // Anthropic 的 event: 行是事件类型的唯一来源,必须按 SSE 事件边界解析
      const events = readSseEvents(response.body!);

      while (true) {
        const next = await events.next();
        if (next.done) break;
        armWatchdog();
        const sseEvent = next.value;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(sseEvent.data) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        if (event.error || sseEvent.event === "error") {
          yield {
            type: "error",
            message: event.error?.message ?? "Anthropic 返回错误",
          };
          controller.abort();
          return;
        }

        // 事件类型以 SSE event: 行为准,缺省时回退 data.type
        const kind = sseEvent.event || event.type;
        switch (kind) {
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
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              yield { type: "reasoning-delta", text: delta.thinking };
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
            // message_delta 的 usage 只带 output_tokens(累计值)
            if (typeof event.usage?.output_tokens === "number") {
              outputTokens = event.usage.output_tokens;
            }
            break;
          }
          case "message_start": {
            const msgUsage = event.message?.usage;
            if (msgUsage) {
              inputTokens = msgUsage.input_tokens;
              outputTokens = msgUsage.output_tokens;
            }
            break;
          }
        }
      }

      const usage =
        inputTokens === null && outputTokens === null
          ? null
          : { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };

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

  private async requestOnce(
    messages: Message[],
    options: GenerateOptions,
    signal?: AbortSignal,
  ): Promise<Response> {
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
    // options.systemPrompt 是配置级提示,优先级高于历史中的 system 消息
    const systemText = [options.systemPrompt?.trim(), system]
      .filter((s) => s && s.length > 0)
      .join("\n");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: clampMaxTokens(this.model, options.maxTokens ?? 8192),
      messages: anthropicMsgs,
      stream: true,
    };
    if (systemText) body.system = systemText;
    if (options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;

    return requestWithNetworkRetry(
      this.fetchImpl,
      appendEndpoint(this.baseUrl, "/messages"),
      {
        method: "POST",
        headers: buildProviderHeaders({
          apiFormat: "anthropic",
          apiKey: this.apiKey,
          includeContentType: true,
        }),
        body: JSON.stringify(body),
        signal,
      },
      "Anthropic",
      [this.apiKey],
      signal,
    );
  }
}
