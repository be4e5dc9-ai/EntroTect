// =====================================================================
// Google Gemini API 适配器
// 端点:{baseUrl}/models/{model}:streamGenerateContent?alt=sse
// 鉴权:x-goog-api-key  流式:SSE data: 行(每行一个完整 JSON chunk)
// =====================================================================

import type { Message } from "@entrotect/shared";
import type { BlockEvent, GenerateOptions, Provider } from "./types.js";
import { readSseLines } from "./sse.js";
import { ProviderError } from "./openai-compatible.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const STREAM_IDLE_TIMEOUT_MS = 90_000;
const RETRY_DELAY_BASE_MS = 1000;
const RETRY_MAX = 2;

type TextBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "text" }>;

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { role?: string; parts: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; code?: number };
}

function toGeminiMessages(messages: Message[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: Array<{ role: string; parts: GeminiPart[] }>;
} {
  let systemText = "";
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = msg.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) systemText += (systemText ? "\n" : "") + text;
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const b of msg.content) {
        if (b.type === "text") {
          parts.push({ text: b.text });
        } else if (b.type === "tool-call") {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(b.arguments);
          } catch { /* keep empty */ }
          parts.push({ functionCall: { name: b.name, args } });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    // user: 文本 + tool_result 合并
    const parts: GeminiPart[] = [];
    const text = msg.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) parts.push({ text });
    for (const b of msg.content) {
      if (b.type === "tool-result") {
        parts.push({
          functionResponse: {
            name: b.toolCallId, // Gemini 用 tool name 而非 id 配对
            response: { result: b.content },
          },
        });
      }
    }
    if (parts.length > 0) contents.push({ role: "user", parts });
  }

  return {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents,
  };
}

export interface GoogleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
}

export class GoogleProvider implements Provider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GoogleProviderOptions) {
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
    const toolCalls = new Map<number, { id: string; name: string; args: Record<string, unknown> }>();
    let toolCallIndex = 0;
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
            arguments: JSON.stringify(call.args),
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

      while (true) {
        const next = await lines.next();
        if (next.done) break;
        armWatchdog();
        const payload = next.value;

        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(payload) as GeminiChunk;
        } catch {
          continue;
        }

        if (chunk.error) {
          yield {
            type: "error",
            message: `Google API 错误(${chunk.error.code}): ${chunk.error.message}`,
          };
          controller.abort();
          return;
        }

        if (chunk.usageMetadata) {
          const um = chunk.usageMetadata;
          if (um.promptTokenCount !== undefined || um.candidatesTokenCount !== undefined) {
            usage = {
              inputTokens: um.promptTokenCount ?? 0,
              outputTokens: um.candidatesTokenCount ?? 0,
            };
          }
        }

        for (const candidate of chunk.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.text) {
              textStarted = true;
              textBuffer += part.text;
              yield { type: "text-delta", text: part.text };
            }
            if (part.functionCall) {
              const textBlock = flushTextBlock();
              if (textBlock) yield textBlock;
              textStarted = false;
              const idx = toolCallIndex++;
              toolCalls.set(idx, {
                id: `call_${idx}`,
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
              });
            }
          }
          if (candidate.finishReason) {
            finishReason = candidate.finishReason;
          }
        }

        if (finishReason !== null) {
          for (const ev of flushBlocksOnce()) yield ev;
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
    const { systemInstruction, contents } = toGeminiMessages(messages);

    const tools = options.tools.length > 0
      ? [{ functionDeclarations: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })) }]
      : undefined;

    const body: Record<string, unknown> = {
      contents,
      tools,
      generationConfig: {
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`;

    let attempt = 0;
    for (;;) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          let detail = "";
          try {
            const errBody = (await response.json()) as { error?: { message?: string } };
            detail = errBody.error?.message ?? "";
          } catch { /* ignore */ }
          throw new ProviderError(
            `Google API 返回 ${response.status}: ${detail || response.statusText}`,
            response.status,
          );
        }
        return response;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (signal?.aborted) throw error;
        if (attempt >= RETRY_MAX) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new ProviderError(`请求 Google API 失败(已重试 ${RETRY_MAX} 次): ${msg}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_BASE_MS * 2 ** attempt),
        );
        attempt++;
      }
    }
  }
}
