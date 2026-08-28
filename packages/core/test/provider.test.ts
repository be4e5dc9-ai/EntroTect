import { describe, expect, it } from "vitest";
import type { BlockEvent, GenerateOptions } from "../src/provider/types.js";
import {
  OpenAiCompatibleProvider,
  toOpenAiMessages,
} from "../src/provider/openai-compatible.js";
import { AnthropicProvider } from "../src/provider/anthropic.js";
import { GoogleProvider } from "../src/provider/google.js";
import type { Message } from "@entrotect/shared";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function makeFetch(chunks: string[], status = 200): (url: string, init: RequestInit) => Promise<Response> {
  return async () => new Response(streamOf(chunks), { status });
}

async function runProvider(
  chunks: string[],
  messages: Message[],
): Promise<BlockEvent[]> {
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: makeFetch(chunks),
  });
  const events: BlockEvent[] = [];
  const options: GenerateOptions = { systemPrompt: "sys", tools: [], maxTokens: 2048 };
  for await (const event of provider.streamBlocks(messages, options)) {
    events.push(event);
  }
  return events;
}

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "帮我看看" }],
};

describe("OpenAiCompatibleProvider.streamBlocks", () => {
  it("装配:文本块 + 工具调用块 + turn-complete(含 usage)", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"好的"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
      "data: [DONE]\n\n",
    ];
    const events = await runProvider(chunks, [userMessage]);

    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas.map((e) => (e.type === "text-delta" ? e.text : ""))).toEqual(["好的"]);

    const blocks = events.filter((e) => e.type === "block");
    expect(blocks[0]).toMatchObject({ block: { type: "text", text: "好的" } });
    expect(blocks[1]).toMatchObject({
      block: {
        type: "tool-call",
        id: "call_1",
        name: "read",
        arguments: '{"path":"a.txt"}',
      },
    });

    const complete = events.find((e) => e.type === "turn-complete");
    expect(complete).toMatchObject({
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it("无工具调用时产出纯文本回合", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"世界"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const events = await runProvider(chunks, [userMessage]);
    const textBlocks = events.filter(
      (e) => e.type === "block" && e.block.type === "text",
    );
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({ block: { text: "你好世界" } });
    const complete = events.find((e) => e.type === "turn-complete");
    expect(complete).toMatchObject({ finishReason: "stop", usage: null });
  });

  it("多个并行工具调用按 index 顺序产出", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"bash","arguments":"{}"}},{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const events = await runProvider(chunks, [userMessage]);
    const toolBlocks = events.filter(
      (e) => e.type === "block" && e.block.type === "tool-call",
    );
    expect(toolBlocks.map((e) => (e.type === "block" ? e.block : undefined))).toMatchObject([
      { id: "a", name: "read" },
      { id: "b", name: "bash" },
    ]);
  });

  it("HTTP 错误归一化为 error 事件而非抛出(错误规范化纪律)", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "bad",
      model: "m",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
          status: 401,
        }),
    });
    const events: BlockEvent[] = [];
    for await (const event of provider.streamBlocks(
      [userMessage],
      { systemPrompt: "s", tools: [], maxTokens: 100 },
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("401"),
    });
  });

  it("reasoning_content 增量产出 reasoning-delta 事件,不进内容块", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"让我想想"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"…应该先读文件"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"结论是 42"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const events = await runProvider(chunks, [userMessage]);

    const reasoning = events
      .filter((e) => e.type === "reasoning-delta")
      .map((e) => (e.type === "reasoning-delta" ? e.text : ""));
    expect(reasoning.join("")).toBe("让我想想…应该先读文件");

    // 思考内容不进消息块(不回喂历史)
    const blocks = events.filter((e) => e.type === "block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ block: { type: "text", text: "结论是 42" } });
  });

  it("reasoning_effort 只在非 off 时发送", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      // deepseek profile 才走 reasoning_effort 策略
      model: "deepseek-chat",
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(streamOf(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']), { status: 200 });
      },
    });
    const collect = async (effort?: "off" | "low" | "medium" | "high") => {
      for await (const _event of provider.streamBlocks(
        [userMessage],
        { systemPrompt: "s", tools: [], maxTokens: 100, reasoningEffort: effort },
      )) {
        void _event;
      }
    };
    await collect("high");
    await collect("off");
    await collect(undefined);
    expect(bodies[0]).toMatchObject({ reasoning_effort: "high" });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it("流中错误 chunk 产出 error 事件", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"部分"}}]}\n\n',
      'data: {"error":{"message":"上游炸了"}}\n\n',
    ];
    const events = await runProvider(chunks, [userMessage]);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("reasoning_effort 按声明集钳制", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-chat",
      supportedEfforts: ["low", "high", "max"],
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(streamOf(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']), { status: 200 });
      },
    });
    const collect = async (effort: "off" | "low" | "medium" | "high" | "xhigh" | "max") => {
      for await (const _event of provider.streamBlocks(
        [userMessage],
        { systemPrompt: "s", tools: [], maxTokens: 100, reasoningEffort: effort },
      )) {
        void _event;
      }
    };
    await collect("medium"); // deepseek 三档 medium->high
    await collect("xhigh"); // xhigh->high
    await collect("max");
    expect((bodies[0] as { reasoning_effort?: string }).reasoning_effort).toBe("high");
    expect((bodies[1] as { reasoning_effort?: string }).reasoning_effort).toBe("high");
    expect((bodies[2] as { reasoning_effort?: string }).reasoning_effort).toBe("max");
  });

  it("无声明的 DeepSeek 仍按三档映射（preset 回退）", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-v4-pro",
      // 不传 supportedEfforts，走 preset 回退
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(streamOf(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']), { status: 200 });
      },
    });
    for await (const _event of provider.streamBlocks(
      [userMessage],
      { systemPrompt: "s", tools: [], maxTokens: 100, reasoningEffort: "medium" },
    )) {
      void _event;
    }
    expect((bodies[0] as { reasoning_effort?: string }).reasoning_effort).toBe("high");
  });

  it("布尔 thinking 模型不发送 reasoning_effort", async () => {
    const bodies: unknown[] = [];
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "kimi-k2.6",
      supportedEfforts: [],
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(streamOf(['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']), { status: 200 });
      },
    });
    for await (const _event of provider.streamBlocks(
      [userMessage],
      { systemPrompt: "s", tools: [], maxTokens: 100, reasoningEffort: "high" },
    )) {
      void _event;
    }
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    // 布尔 thinking 模型走 thinking:{type} 而非 reasoning_effort
    expect(bodies[0]).toMatchObject({ thinking: { type: "enabled" } });
  });
});

describe("toOpenAiMessages", () => {
  it("system/user/assistant 基础转换", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "你是助手" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "好" },
          { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool-result", toolCallId: "c1", name: "read", isError: false, content: "OK" }],
      },
    ];
    expect(toOpenAiMessages(messages)).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "好",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "OK" },
    ]);
  });

  it("tool-result 展开为独立 role:tool 消息", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool-result", toolCallId: "a", name: "read", isError: false, content: "1" },
          { type: "tool-result", toolCallId: "b", name: "read", isError: true, content: "2" },
        ],
      },
    ];
    expect(toOpenAiMessages(messages)).toEqual([
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "2" },
    ]);
  });

  it("思考内容按 profile 决定是否回传", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "读一下" }],
        reasoningContent: "让我先想",
      },
      { role: "user", content: [{ type: "text", text: "继续" }] },
    ];
    expect(toOpenAiMessages(messages, { preserveReasoning: true })[0]).toMatchObject({
      reasoning_content: "让我先想",
    });
    expect(toOpenAiMessages(messages)[0]).not.toHaveProperty("reasoning_content");
  });
});

// =====================================================================
// 请求构建:由供应商 profile 决定,不发多余字段(400 的根源在请求格式)
// =====================================================================

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function captureRequests(chunks: string[]): { requests: CapturedRequest[]; fetchImpl: (url: string, init: RequestInit) => Promise<Response> } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(streamOf(chunks), { status: 200 });
  };
  return { requests, fetchImpl };
}

const EMPTY_STREAM = [
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

async function runOnce(
  options: ConstructorParameters<typeof OpenAiCompatibleProvider>[0],
  messages: Message[],
  generate: Partial<GenerateOptions> = {},
): Promise<CapturedRequest> {
  const { requests, fetchImpl } = captureRequests(EMPTY_STREAM);
  const provider = new OpenAiCompatibleProvider({ ...options, fetchImpl });
  for await (const _event of provider.streamBlocks(messages, {
    systemPrompt: "SYS",
    tools: [],
    maxTokens: 4096,
    ...generate,
  })) {
    void _event;
  }
  return requests[0]!;
}

describe("OpenAiCompatibleProvider 请求构建(profile 驱动)", () => {
  it("Mimo: 仅 api-key 头 / max_completion_tokens / thinking.type,且不发 stream_options", async () => {
    const request = await runOnce(
      { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "sk-x", model: "mimo-v2.5", apiProfile: "mimo" },
      [userMessage],
      { reasoningEffort: "high", temperature: 0.3 },
    );

    expect(request.url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(request.headers["api-key"]).toBe("sk-x");
    expect(request.headers).not.toHaveProperty("Authorization");
    expect(request.headers).not.toHaveProperty("x-api-key");

    expect(request.body).toMatchObject({
      model: "mimo-v2.5",
      stream: true,
      max_completion_tokens: 4096,
      thinking: { type: "enabled" },
    });
    // 官方只支持 thinking enabled/disabled,没有分档参数
    expect(request.body).not.toHaveProperty("reasoning_effort");
    // 思考模式下自定义 temperature 不生效,直接不发
    expect(request.body).not.toHaveProperty("temperature");
    // 未声明 stream_options 支持,不发
    expect(request.body).not.toHaveProperty("stream_options");
    // 空 tools 全字段省略(严格网关会对 tools:[] 400)
    expect(request.body).not.toHaveProperty("tools");
  });

  it("Mimo 关闭思考时发 thinking.type=disabled", async () => {
    const request = await runOnce(
      { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "sk-x", model: "mimo-v2.5-pro", providerId: "mimo" },
      [userMessage],
      { reasoningEffort: "off" },
    );
    expect(request.body).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("DeepSeek: Bearer 鉴权 + max_tokens + stream_options + reasoning_effort", async () => {
    const request = await runOnce(
      { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-d", model: "deepseek-chat" },
      [userMessage],
      { reasoningEffort: "max", temperature: 0.6 },
    );
    expect(request.headers.Authorization).toBe("Bearer sk-d");
    expect(request.body).toMatchObject({
      max_tokens: 4096,
      stream_options: { include_usage: true },
      reasoning_effort: "max",
      temperature: 0.6,
    });
    expect(request.body).not.toHaveProperty("max_completion_tokens");
  });

  it("systemPrompt 注入为首个 system 消息,且不重复注入", async () => {
    const request = await runOnce(
      { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "k", model: "mimo-v2.5", providerId: "mimo" },
      [userMessage],
    );
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("非空 tools 正常下发", async () => {
    const request = await runOnce(
      { baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat" },
      [userMessage],
      { tools: [{ name: "read", description: "读文件", parameters: { type: "object" } }] },
    );
    expect(request.body.tools).toEqual([
      { type: "function", function: { name: "read", description: "读文件", parameters: { type: "object" } } },
    ]);
  });
});

describe("reasoning_content 双向保留", () => {
  it("流中累积的 thinking 随 turn-complete 上交", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"先想"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"再想"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"结论"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { fetchImpl } = captureRequests(chunks);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "k",
      model: "mimo-v2.5",
      providerId: "mimo",
      fetchImpl,
    });
    let complete: Extract<BlockEvent, { type: "turn-complete" }> | undefined;
    for await (const event of provider.streamBlocks([userMessage], { systemPrompt: "", tools: [], maxTokens: 8 })) {
      if (event.type === "turn-complete") complete = event;
    }
    expect(complete?.reasoningContent).toBe("先想再想");
  });

  it("Mimo 历史 assistant 思考内容回传,不保留思考的 profile 不回传", async () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "读文件" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }],
        reasoningContent: "应该先读再改",
      },
      { role: "user", content: [{ type: "tool-result", toolCallId: "c1", name: "read", isError: false, content: "OK" }] },
    ];

    const mimoRequest = await runOnce(
      { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "k", model: "mimo-v2.5", providerId: "mimo" },
      history,
    );
    const assistant = (mimoRequest.body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant",
    );
    expect(assistant).toMatchObject({ reasoning_content: "应该先读再改" });

    // OpenRouter 自己管理 thinking,不要把 reasoning_content 塞回去
    const routerRequest = await runOnce(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "some-model", providerId: "openrouter" },
      history,
    );
    const routerAssistant = (routerRequest.body.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant",
    );
    expect(routerAssistant).not.toHaveProperty("reasoning_content");
  });

  it("模型名识别网关托管的 thinking 模型(DeepSeek 走 reasoning_effort)", async () => {
    const request = await runOnce(
      { baseUrl: "https://gateway.example/v1", apiKey: "k", model: "deepseek-v4-pro" },
      [userMessage],
      { reasoningEffort: "max" },
    );
    expect(request.body).toMatchObject({ reasoning_effort: "max" });
    expect(request.body).not.toHaveProperty("thinking");
  });
});

describe("AnthropicProvider", () => {
  it("按 SSE event 行解析流式块(systemPrompt 进 system 字段)", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","text":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { requests, fetchImpl } = captureRequests(chunks);
    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-a",
      model: "claude-sonnet-5",
      fetchImpl,
    });

    const events: BlockEvent[] = [];
    for await (const event of provider.streamBlocks(
      [userMessage],
      { systemPrompt: "SYS", tools: [{ name: "read", description: "d", parameters: {} }], maxTokens: 1024 },
    )) {
      events.push(event);
    }

    const textBlocks = events.filter((e) => e.type === "block");
    expect(textBlocks[0]).toMatchObject({ block: { type: "text", text: "你好" } });
    expect(textBlocks[1]).toMatchObject({
      block: { type: "tool-call", id: "t1", name: "read", arguments: '{"path":"a.txt"}' },
    });
    const complete = events.find((e) => e.type === "turn-complete");
    expect(complete).toMatchObject({ finishReason: "tool_use", usage: { inputTokens: 11, outputTokens: 7 } });

    expect(requests[0]!.headers["x-api-key"]).toBe("sk-a");
    expect(requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]!.body).toMatchObject({ system: "SYS", max_tokens: 1024, stream: true });
  });

  it("HTTP 错误带上上游正文与状态码", async () => {
    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "bad",
      model: "claude-sonnet-5",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }),
    });
    const events: BlockEvent[] = [];
    for await (const event of provider.streamBlocks([userMessage], { systemPrompt: "", tools: [], maxTokens: 16 })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("401");
    expect((events[0] as { message: string }).message).toContain("invalid x-api-key");
  });
});

describe("GoogleProvider", () => {
  it("systemPrompt 进 systemInstruction,工具结果按工具名配对", async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n',
    ];
    const { requests, fetchImpl } = captureRequests(chunks);
    const provider = new GoogleProvider({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gk",
      model: "gemini-3.5-flash",
      fetchImpl,
    });
    const events: BlockEvent[] = [];
    for await (const event of provider.streamBlocks(
      [
        { role: "user", content: [{ type: "tool-result", toolCallId: "call_0", name: "read", isError: false, content: "内容" }] },
      ],
      { systemPrompt: "SYS", tools: [], maxTokens: 256 },
    )) {
      events.push(event);
    }

    expect(requests[0]!.url).toContain("/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
    expect(requests[0]!.headers["x-goog-api-key"]).toBe("gk");
    expect(requests[0]!.body).toMatchObject({ systemInstruction: { parts: [{ text: "SYS" }] } });
    const contents = requests[0]!.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents[0]!.parts[0]).toEqual({ functionResponse: { name: "read", response: { result: "内容" } } });
    expect(events.find((e) => e.type === "turn-complete")).toMatchObject({
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });
});
