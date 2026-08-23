import { describe, expect, it } from "vitest";
import type { BlockEvent, GenerateOptions } from "../src/provider/types.js";
import {
  OpenAiCompatibleProvider,
  toOpenAiMessages,
} from "../src/provider/openai-compatible.js";
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

  it("流中错误 chunk 产出 error 事件", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"部分"}}]}\n\n',
      'data: {"error":{"message":"上游炸了"}}\n\n',
    ];
    const events = await runProvider(chunks, [userMessage]);
    expect(events.some((e) => e.type === "error")).toBe(true);
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
});
