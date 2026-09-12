import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppEvent, Message, SubagentPart } from "@entrotect/shared";
import { runAgent } from "../src/loop/agent.js";
import { createSubagentRunner } from "../src/subagent/run.js";
import { createTaskTool } from "../src/tools/task.js";
import type { Provider } from "../src/provider/types.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";

const environment = {
  cwd: process.cwd(), artifactDir: process.cwd(), systemPrompt: "test",
  approve: async () => ({ decision: "allow-once" as const }),
};
const prompt: Message[] = [{ role: "user", content: [{ type: "text", text: "research" }] }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("subagent completion and waiting", () => {
  it("parent waits for every parallel child, including the slower child", async () => {
    const gates = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    const events: AppEvent[] = [];
    const childProvider: Provider = {
      model: "mock",
      async *streamBlocks(messages) {
        const first = messages[0]?.content[0];
        const index = first?.type === "text" && first.text === "second" ? 1 : 0;
        started[index]!.resolve();
        await gates[index]!.promise;
        yield textBlock(`child ${index} report`);
        yield turnComplete();
      },
    };
    const child = createSubagentRunner({ ...environment, provider: childProvider, tools: [] });
    const parent = new MockProvider([
      { events: [toolCall("first", "task", '{"prompt":"first"}'), toolCall("second", "task", '{"prompt":"second"}'), turnComplete()] },
      { events: [textBlock("integrated"), turnComplete()] },
    ]);
    let settled = false;
    const running = runAgent(prompt, {
      ...environment, provider: parent, tools: [createTaskTool(child)], emit: (event) => events.push(event),
    }).then((result) => { settled = true; return result; });
    try {
      await Promise.all(started.map((item) => item.promise));
      expect(parent.receivedHistory).toHaveLength(1);
      expect(settled).toBe(false);
      expect(events.filter((event) => event.type === "tool-state" && event.state === "completed")).toHaveLength(0);
      gates[1]!.resolve();
      await vi.waitFor(() => expect(events.some((event) => event.type === "tool-state" && event.toolCallId === "second" && event.state === "completed")).toBe(true));
      expect(parent.receivedHistory).toHaveLength(1);
      expect(settled).toBe(false);
      gates[0]!.resolve();
      const result = await running;
      expect(result.finalText).toBe("integrated");
      expect(parent.receivedHistory).toHaveLength(2);
      expect(parent.receivedHistory[1]?.at(-1)?.content).toMatchObject([
        { type: "tool-result", toolCallId: "first", content: "child 0 report", isError: false },
        { type: "tool-result", toolCallId: "second", content: "child 1 report", isError: false },
      ]);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await running;
    }
  });

  it("resumes an empty child response with its evidence, without restarting completed actions", async () => {
    const action = vi.fn(async () => "already-written-evidence");
    const provider = new MockProvider([
      { events: [toolCall("action", "action", "{}"), turnComplete()] },
      { events: [{ type: "reasoning-delta", text: "thinking" }, turnComplete()] },
      { events: [textBlock("complete report"), turnComplete()] },
    ]);
    const parts: SubagentPart[] = [];
    const logs: string[] = [];
    const child = createSubagentRunner({
      ...environment, provider,
      tools: [{ name: "action", inputSchema: z.strictObject({}), description: "test", isReadOnly: false, preview: () => "action", call: action }],
    });
    expect(await child("do work", (line) => logs.push(line), (part) => parts.push(part))).toBe("complete report");
    expect(action).toHaveBeenCalledTimes(1);
    expect(provider.receivedHistory).toHaveLength(3);
    expect(JSON.stringify(provider.receivedHistory[2])).toContain("already-written-evidence");
    expect(JSON.stringify(provider.receivedHistory[2])).toContain("不要重启任务");
    expect(logs.some((line) => line.includes("续跑并等待"))).toBe(true);
    expect(parts.filter((part) => part.kind === "turn-start")).toHaveLength(3);
    expect(parts.filter((part) => part.kind === "turn-end")).toHaveLength(3);
  });

  it.each(["length", "max_tokens", "MAX_TOKENS"])("does not return truncated child text as success (%s)", async (finishReason) => {
    const provider = new MockProvider([
      { events: [textBlock("unfinished partial"), { type: "turn-complete", finishReason, usage: null }] },
      { events: [textBlock("full report"), turnComplete()] },
    ]);
    const child = createSubagentRunner({ ...environment, provider, tools: [] });
    expect(await child("research")).toBe("full report");
    expect(provider.receivedHistory).toHaveLength(2);
    expect(JSON.stringify(provider.receivedHistory[1])).toContain("unfinished partial");
  });

  it("repeated empty responses become a failed parent task, never a successful no-output result", async () => {
    const childProvider = new MockProvider([{ events: [turnComplete()] }, { events: [textBlock("  \n"), turnComplete()] }]);
    const child = createSubagentRunner({ ...environment, provider: childProvider, tools: [] });
    const parent = new MockProvider([
      { events: [toolCall("child", "task", '{"prompt":"research"}'), turnComplete()] },
      { events: [textBlock("report the error"), turnComplete()] },
    ]);
    const events: AppEvent[] = [];
    const result = await runAgent(prompt, { ...environment, provider: parent, tools: [createTaskTool(child)], emit: (event) => events.push(event) });
    expect(childProvider.receivedHistory).toHaveLength(2);
    expect(result.messages[2]?.content[0]).toMatchObject({ type: "tool-result", isError: true });
    expect(JSON.stringify(result.messages[2])).toContain("已续跑一次");
    expect(events.some((event) => event.type === "tool-state" && event.toolCallId === "child" && event.state === "failed")).toBe(true);
    expect(events.some((event) => event.type === "tool-state" && event.toolCallId === "child" && event.state === "completed")).toBe(false);
  });

  it("repeated truncation fails instead of returning a partial report", async () => {
    const provider = new MockProvider(Array.from({ length: 2 }, () => ({ events: [textBlock("partial"), { type: "turn-complete" as const, finishReason: "length", usage: null }] })));
    const child = createSubagentRunner({ ...environment, provider, tools: [] });
    await expect(child("research")).rejects.toThrow("续跑后仍未完成");
    expect(provider.receivedHistory).toHaveLength(2);
  });

  it("does not retry filtered or cancelled responses", async () => {
    const filtered = new MockProvider([{ events: [{ type: "turn-complete", finishReason: "content_filter", usage: null }] }]);
    await expect(createSubagentRunner({ ...environment, provider: filtered, tools: [] })("research")).rejects.toThrow("content_filter");
    expect(filtered.receivedHistory).toHaveLength(1);
    const controller = new AbortController();
    const streamBlocks = vi.fn(async function* () { controller.abort(); yield turnComplete(); });
    const cancelled = createSubagentRunner({ ...environment, provider: { model: "mock", streamBlocks }, tools: [], abortSignal: controller.signal });
    await expect(cancelled("research")).rejects.toThrow("中断");
    expect(streamBlocks).toHaveBeenCalledTimes(1);
  });
});
