// =====================================================================
// OpenAI 兼容协议适配器(DeepSeek / OpenAI / Moonshot / Mimo / Qwen 等)
//
// 重构纪律:
//   1. 请求格式由 profiles.ts 的供应商 profile 决定(鉴权头/token 字段/
//      思考参数/usage chunk),绝不靠 400 之后猜测换格式;
//   2. HTTP 错误走 errors.ts 统一解析(状态码 + 上游正文 + 脱敏 URL),
//      网络错误由 transport.ts 有限退避重试;
//   3. reasoning_content 双向保留:流中累积后随 turn-complete 上交,
//      历史 assistant 消息按 profile 回传(Mimo/Kimi 工具调用回合必需,
//      缺失会被上游 400 拒绝)。
// =====================================================================

import type { ApiProfile, Message, ReasoningEffort } from "@entrotect/shared";
import type { BlockEvent, GenerateOptions, Provider } from "./types.js";
import { readSseLines } from "./sse.js";
import { ProviderError } from "./errors.js";
import { requestWithNetworkRetry, type FetchLike } from "./transport.js";
import { clampMaxTokens } from "./contexts.js";
import {
  appendEndpoint,
  buildProviderHeaders,
  mapReasoningEffort,
  resolveProviderProfile,
  type ResolvedProviderProfile,
} from "./profiles.js";

export { ProviderError } from "./errors.js";

interface OpenAiToolCall {
  id?: string;
  function: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** 思考链增量(DeepSeek/Mimo/Kimi 等;按 profile 决定是否回喂历史) */
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

/** 流空闲看门狗:90s 无任何数据即判定挂死 */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

type TextBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "text" }>;
type ToolCallBlock = Extract<import("@entrotect/shared").ContentBlock, { type: "tool-call" }>;

export interface ToOpenAiMessagesOptions {
  /** 为 true 时把 assistant 消息的 reasoningContent 以 reasoning_content 字段回传 */
  preserveReasoning?: boolean;
}

/**
 * 把共享词汇层消息翻译成 OpenAI 对话格式。
 * 注意 tool-result 展开为多条 role:"tool" 消息(tool_call_id 配对)。
 */
export function toOpenAiMessages(
  messages: Message[],
  options: ToOpenAiMessagesOptions = {},
): unknown[] {
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
      const preserved =
        options.preserveReasoning && message.reasoningContent
          ? { reasoning_content: message.reasoningContent }
          : {};
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text || null,
          ...preserved,
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        });
      } else if (text) {
        out.push({ role: "assistant", content: text, ...preserved });
      } else if (options.preserveReasoning && message.reasoningContent) {
        // 纯思考回合:仅 reasoning_content、无文本/工具调用,保留之(P3-4c)
        out.push({ role: "assistant", content: null, ...preserved });
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
  /** 显式供应商 profile；缺省按 providerId/baseUrl/model 自动识别 */
  apiProfile?: ApiProfile;
  /** 供应商 id(自动识别 profile 用) */
  providerId?: string;
}

/** OpenAI 兼容 SSE 流 → 统一 BlockEvent(内含块装配) */
export class OpenAiCompatibleProvider implements Provider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly supportedEfforts?: ReasoningEffort[];
  private readonly profile: ResolvedProviderProfile;

  constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.supportedEfforts = options.supportedEfforts;
    this.profile = resolveProviderProfile({
      apiProfile: options.apiProfile,
      providerId: options.providerId,
      baseUrl: options.baseUrl,
      model: options.model,
    });
  }

  /** 组装请求体:字段取舍全部由 profile 决定,一次发对,不靠 400 猜。 */
  private buildRequestBody(messages: Message[], options: GenerateOptions): Record<string, unknown> {
    const profile = this.profile;

    const wireMessages = toOpenAiMessages(messages, {
      preserveReasoning: profile.preserveReasoningContent,
    }) as Record<string, unknown>[];

    // systemPrompt 是配置级系统提示,不在持久化历史里;注入为第一条 system 消息
    const systemText = options.systemPrompt?.trim() ?? "";
    if (systemText.length > 0) {
      const first = wireMessages[0];
      const alreadyLeadingSystem =
        first && first.role === "system" && first.content === systemText;
      if (!alreadyLeadingSystem) {
        wireMessages.unshift({ role: "system", content: systemText });
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: wireMessages,
      stream: true,
    };

    // 空 tools 数组会被部分严格网关 400,整个字段省略
    if (options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    if (profile.includeStreamUsage) {
      body.stream_options = { include_usage: true };
    }

    if (options.maxTokens) {
      // 按内置目录 clamp 到模型真实最大输出(Mimo 仅支持 131072,超限上游 400)
      body[profile.tokenField] = clampMaxTokens(this.model, options.maxTokens);
    }

    if (options.temperature !== undefined && !profile.omitTemperature) {
      body.temperature = options.temperature;
    }

    const requested = options.reasoningEffort;
    switch (profile.reasoning) {
      case "reasoning_effort": {
        // 布尔 thinking 模型(声明空档位集)不发分档参数
        if (this.supportedEfforts !== undefined && this.supportedEfforts.length === 0) break;
        const effort = mapReasoningEffort(requested, this.supportedEfforts, profile.reasoningValues);
        if (effort) body.reasoning_effort = effort;
        break;
      }
      case "enable_thinking": {
        if (requested !== undefined) body.enable_thinking = requested !== "off";
        break;
      }
      case "thinking": {
        if (requested === undefined) break;
        const disable = requested === "off" && profile.supportsExplicitThinkingToggle;
        body.thinking = { type: disable ? "disabled" : "enabled" };
        break;
      }
      case "none":
        break;
    }

    return body;
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
      const url = appendEndpoint(this.baseUrl, "/chat/completions");
      const headers = buildProviderHeaders({
        apiFormat: "openai",
        apiProfile: this.profile.id,
        apiKey: this.apiKey,
        includeContentType: true,
      });
      const init: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify(this.buildRequestBody(messages, options)),
        signal: controller.signal,
      };
      response = await requestWithNetworkRetry(
        this.fetchImpl,
        url,
        init,
        "模型",
        [this.apiKey],
        controller.signal,
      );
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
    let reasoningBuffer = "";
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
            reasoningBuffer += delta.reasoning_content;
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
      yield {
        type: "turn-complete",
        finishReason,
        usage,
        ...(reasoningBuffer.length > 0 ? { reasoningContent: reasoningBuffer } : {}),
      };
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
}
