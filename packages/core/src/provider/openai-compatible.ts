// =====================================================================
// OpenAI 兼容协议适配器(DeepSeek / OpenAI / Moonshot / Ollama 通用)
// 设计依据:ClaudeCode/02 §4 手写 SSE 状态机 + 90s 看门狗;
//          tool 参数字符串累积,结束后一次性 parse。
// =====================================================================

import type { Message, ReasoningEffort } from "@entrotect/shared";
import { clampEffort, getPresetEfforts, isReasoningEffort } from "@entrotect/shared";
import type { BlockEvent, GenerateOptions, Provider } from "./types.js";
import { readSseLines } from "./sse.js";

export class ProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface OpenAiToolCall {
  id?: string;
  function: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** DeepSeek/OpenAI 思考链增量(reasoning 内容不回喂历史) */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  error?: { message?: string };
}

/** 流空闲看门狗:90s 无任何数据即判定挂死(照抄 ClaudeCode) */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

/** 网络错误重试:指数退避,最多 2 次(照抄 withRetry 思路的精简版) */
const RETRY_DELAY_BASE_MS = 1000;
const RETRY_MAX = 2;

type TextBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "text" }>;
type ToolCallBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "tool-call" }>;

/**
 * 把共享词汇层消息翻译成 OpenAI 对话格式。
 * 注意 tool-result 展开为多条 role:"tool" 消息(tool_call_id 配对)。
 */
export function toOpenAiMessages(messages: Message[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) out.push({ role: "system", content: text });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = message.content.filter(
        (b): b is ToolCallBlock => b.type === "tool-call",
      );
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        });
      } else if (text) {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }

    // user:文本块拼成一条;tool-result 块各自成为 role:"tool" 消息
    const text = message.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) out.push({ role: "user", content: text });
    for (const block of message.content) {
      if (block.type !== "tool-result") continue;
      out.push({
        role: "tool",
        tool_call_id: block.toolCallId,
        content: block.content,
      });
    }
  }
  return out;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  /** 声明的真实档位（来自 ProviderConfig.modelReasoningLevels）；未声明时用 preset 回退 */
  supportedEfforts?: ReasoningEffort[];
}

/** OpenAI 兼容 SSE 流 → 统一 BlockEvent(内含块装配) */
export class OpenAiCompatibleProvider implements Provider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly supportedEfforts?: ReasoningEffort[];

  constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.supportedEfforts = options.supportedEfforts;
  }

  private resolveEffectiveEffort(requested: ReasoningEffort | undefined): ReasoningEffort | undefined {
    if (!requested || requested === "off") return undefined;
    if (!isReasoningEffort(requested)) return undefined;
    // 优先使用声明集
    if (this.supportedEfforts !== undefined) {
      if (this.supportedEfforts.length === 0) return undefined; // 布尔 thinking 模型，不发
      return clampEffort(requested, this.supportedEfforts);
    }
    // 无声明时按 preset 回退（DeepSeek 三档等）
    const preset = getPresetEfforts(this.model);
    if (preset !== undefined) {
      if (preset.length === 0) return undefined;
      return clampEffort(requested, preset);
    }
    // 未知模型保持原行为（不 clamp）
    return requested;
  }

  async *streamBlocks(
    messages: Message[],
    options: GenerateOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<BlockEvent> {
    // 外部取消 + 看门狗合并到同一 controller,保证 abort 真正掐断 HTTP 连接
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
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
      return;
    }

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        watchdogFired = true;
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    // 文本块与工具调用装配状态
    let textBuffer = "";
    let textStarted = false;
    const toolCalls = new Map<number, OpenAiToolCall>();
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
        if (!call.id || !call.function.name) continue;
        const rawArgs = call.function.arguments ?? "{}";
        events.push({
          type: "block",
          block: {
            type: "tool-call",
            id: call.id,
            name: call.function.name,
            arguments: rawArgs,
          },
        });
      }
      toolCalls.clear();
      return events;
    };

    // finish_reason 到达即收口内容块;但 usage 块通常在其之后,
    // 所以 turn-complete 必须等流真正结束([DONE]/EOF)才发。
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
        if (payload === "[DONE]") break;

        let chunk: OpenAiChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiChunk;
        } catch {
          continue; // 非 JSON 心跳行,忽略
        }

        if (chunk.error) {
          yield { type: "error", message: chunk.error.message ?? "模型返回错误" };
          controller.abort();
          return;
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.reasoning_content) {
            yield { type: "reasoning-delta", text: delta.reasoning_content };
          }
          if (delta.content) {
            textStarted = true;
            textBuffer += delta.content;
            yield { type: "text-delta", text: delta.content };
          }
          for (const tc of delta.tool_calls ?? []) {
            // 工具调用开始:文本块先行收口
            const textBlock = flushTextBlock();
            if (textBlock) yield textBlock;
            textStarted = false;
            const existing = toolCalls.get(tc.index) ?? { function: {} };
            if (tc.id) existing.id = tc.id;
            if (tc.function.name) existing.function.name = tc.function.name;
            existing.function.arguments =
              (existing.function.arguments ?? "") + (tc.function.arguments ?? "");
            toolCalls.set(tc.index, existing);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        if (finishReason !== null) {
          for (const event of flushBlocksOnce()) yield event;
        }
      }

      // 流结束:补一次收口(防御无 finish_reason 的流),再发 turn-complete
      for (const event of flushBlocksOnce()) yield event;
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
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", message };
    } finally {
      if (watchdog) clearTimeout(watchdog);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** 带重试的请求发起(网络错误指数退避;HTTP 错误直接抛 ProviderError) */
  private async requestWithRetry(
    messages: Message[],
    options: GenerateOptions,
    signal?: AbortSignal,
  ): Promise<Response> {
    const effectiveEffort = this.resolveEffectiveEffort(options.reasoningEffort);
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
              "api-key": this.apiKey,
              "x-api-key": this.apiKey,
            },
            body: JSON.stringify({
              model: this.model,
              messages: toOpenAiMessages(messages),
              tools: options.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
              stream: true,
              stream_options: { include_usage: true },
              ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
              ...(options.temperature !== undefined
                ? { temperature: options.temperature }
                : {}),
              ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
            }),
            signal,
          },
        );

        if (!response.ok) {
          let detail = "";
          try {
            const body = (await response.json()) as { error?: { message?: string } };
            detail = body.error?.message ?? "";
          } catch {
            detail = "";
          }
          throw new ProviderError(
            `模型接口返回 ${response.status}: ${detail || response.statusText}`,
            response.status,
          );
        }
        return response;
      } catch (error) {
        // 业务错误不重试;取消不重试;仅网络层失败重试
        if (error instanceof ProviderError) throw error;
        if (signal?.aborted) throw error;
        if (attempt >= RETRY_MAX) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ProviderError(`请求模型失败(已重试 ${RETRY_MAX} 次): ${message}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_BASE_MS * 2 ** attempt),
        );
        attempt += 1;
      }
    }
  }
}
