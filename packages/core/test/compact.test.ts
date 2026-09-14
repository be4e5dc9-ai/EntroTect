import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@entrotect/shared";
import { compactMessages, estimateTokens, shouldAutoCompact, COMPACT_TIMEOUT_MS } from "../src/compact.js";
import type { Provider } from "../src/provider/types.js";
import { toOpenAiMessages } from "../src/provider/openai-compatible.js";
import { MockProvider, textBlock, textDelta, turnComplete } from "./helpers/mock-provider.js";

const text = (role: Message["role"], value: string): Message => ({ role, content: [{ type: "text", text: value }] });
const summaryProvider = () => new MockProvider([{ events: [textDelta("保留任务目标、已完成的改动与验证结果。"), turnComplete()] }]);
afterEach(() => vi.useRealTimers());

describe("context compaction", () => {
  it.each([4, 10])("shrinks %s messages even when recent messages dominate the budget", async (count) => {
    const messages = Array.from({ length: count }, (_, i) => text(i % 2 ? "assistant" : "user", "x".repeat(count === 4 ? 1000 : i < 4 ? 5 : 10000)));
    const result = await compactMessages(summaryProvider(), messages);
    expect(result.changed).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens * 0.5);
    expect(result.compacted[0]!.compaction).toMatchObject({ beforeTokens: result.beforeTokens, afterTokens: result.afterTokens });
    expect(messages).toHaveLength(count);
  });

  it("retains the latest unsent user request verbatim and summarizes only the removed prefix", async () => {
    const current = text("user", "CURRENT_REQUEST_KEEP_EXACT");
    const messages = [text("user", "x".repeat(8000)), text("assistant", "y".repeat(8000)), current];
    const provider = summaryProvider();
    const result = await compactMessages(provider, messages);
    expect(result.changed).toBe(true);
    expect(result.compacted.at(-1)).toBe(current);
    expect(JSON.stringify(provider.receivedHistory[0])).not.toContain("CURRENT_REQUEST_KEEP_EXACT");
  });

  it("never retains a tool result without its tool call", async () => {
    const call = (id: string): Message => ({ role: "assistant", content: [{ type: "tool-call", id, name: "read", arguments: "{}" }] });
    const result = (id: string): Message => ({ role: "user", content: [{ type: "tool-result", toolCallId: id, name: "read", content: "evidence", isError: false }] });
    const messages = [text("user", "x".repeat(10000)), text("assistant", "inspecting"), call("a"), result("a"), text("assistant", "found"), text("user", "next"), call("b"), result("b"), text("assistant", "done")];
    const compacted = await compactMessages(summaryProvider(), messages);
    expect(compacted.changed).toBe(true);
    const wire = toOpenAiMessages(compacted.compacted) as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
    const calls = new Set(wire.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []));
    expect(wire.filter((message) => message.role === "tool" && !calls.has(message.tool_call_id!))).toEqual([]);
  });

  it("does not replace history or announce success when the summary would enlarge it", async () => {
    const messages = [text("user", "x".repeat(2000)), text("assistant", "done")];
    const provider = new MockProvider([{ events: [textDelta("y".repeat(3000)), turnComplete()] }]);
    const result = await compactMessages(provider, messages);
    expect(result.changed).toBe(false);
    expect(result.compacted).toBe(messages);
    expect(result.afterTokens).toBe(result.beforeTokens);
  });

  it("skips small histories without calling a model", async () => {
    const provider = summaryProvider();
    expect((await compactMessages(provider, [text("user", "hi"), text("assistant", "hello")])).changed).toBe(false);
    expect(provider.receivedHistory).toHaveLength(0);
  });

  it.each(["length", "max_tokens", "MAX_TOKENS", "content_filter"])("rejects incomplete summaries (%s)", async (finishReason) => {
    const provider = new MockProvider([{ events: [textDelta("partial"), { type: "turn-complete", finishReason, usage: null }] }]);
    await expect(compactMessages(provider, [text("assistant", "x".repeat(5000))])).rejects.toThrow("未完整生成");
  });

  it("accepts final text blocks without duplicating streamed deltas", async () => {
    for (const events of [[textBlock("summary"), turnComplete()], [textDelta("sum"), textDelta("mary"), textBlock("summary"), turnComplete()]]) {
      const result = await compactMessages(new MockProvider([{ events }]), [text("assistant", "x".repeat(5000))]);
      expect(result.summary).toBe("summary");
    }
  });

  it("times out before any response arrives, even if the provider ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const provider: Provider = { model: "mock", async *streamBlocks(_messages, _options, nextSignal) {
      signal = nextSignal;
      await new Promise(() => {});
    } };
    const pending = compactMessages(provider, [text("assistant", "x".repeat(5000))]);
    const rejected = expect(pending).rejects.toThrow("压缩超时");
    await vi.advanceTimersByTimeAsync(COMPACT_TIMEOUT_MS);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a stalled provider immediately and does not start an already cancelled request", async () => {
    const controller = new AbortController();
    const provider: Provider = { model: "mock", async *streamBlocks() { await new Promise(() => {}); } };
    const pending = compactMessages(provider, [text("assistant", "x".repeat(5000))], controller.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    const mock = summaryProvider();
    await expect(compactMessages(mock, [], controller.signal)).rejects.toThrow("cancelled");
    expect(mock.receivedHistory).toEqual([]);
  });

  it("large inputs and preserved reasoning count towards automatic compaction regardless of message count", () => {
    const messages = [text("user", "x".repeat(700000))];
    expect(shouldAutoCompact(messages, "unknown-model")).toBe(true);
    expect(estimateTokens([{ ...text("assistant", "ok"), reasoningContent: "x".repeat(10000) }])).toBeGreaterThan(4000);
  });
});
