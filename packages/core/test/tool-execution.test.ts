import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppEvent, ContentBlock } from "@entrotect/shared";
import { runAgent, type AgentDeps } from "../src/loop/agent.js";
import { MAX_PARALLEL_TOOLS } from "../src/loop/tool-scheduler.js";
import { readTool } from "../src/tools/read.js";
import { editTool } from "../src/tools/edit.js";
import { grepTool } from "../src/tools/grep.js";
import { createTaskTool } from "../src/tools/task.js";
import { truncateOutput, MAX_BATCH_OUTPUT_BYTES } from "../src/tools/output.js";
import type { Tool, ToolContext } from "../src/tools/types.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "entrotect-execution-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  const ctx: ToolContext = { cwd, artifactDir: path.join(root, "private", "artifacts"), protectedPaths: [path.join(root, "private")], sandboxMode: "full", fileStates: new Map() };
  const events: AppEvent[] = [];
  const deps: AgentDeps = { ...ctx, tools: [], provider: new MockProvider([]), systemPrompt: "test", approve: vi.fn(async () => ({ decision: "allow-once" })), emit: (event) => events.push(event) };
  return { ctx, deps, events, root };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function scripted(calls: ReturnType<typeof toolCall>[]) {
  return new MockProvider([{ events: [...calls, turnComplete()] }, { events: [textBlock("done"), turnComplete()] }]);
}
function testTool(name: string, call: Tool["call"], parallel = false): Tool {
  return { name, call, description: name, inputSchema: z.object({}), isReadOnly: parallel, isConcurrencySafe: parallel, preview: () => name };
}

describe("tool execution boundaries", () => {
  it("waits for ordinary-mode delegates before sampling parent reads in the same batch", async () => {
    const { deps } = await setup();
    const gate = deferred();
    const started = deferred();
    let value = "before";
    const observe = vi.fn(async () => value);
    deps.tools = [createTaskTool(async () => { started.resolve(); await gate.promise; value = "after"; return "done"; }), testTool("observe", observe, true)];
    deps.provider = scripted([toolCall("child", "task", '{"prompt":"independent change"}'), toolCall("parent", "observe", "{}")]);
    const running = runAgent([], deps);
    try {
      await started.promise;
      expect(observe).not.toHaveBeenCalled();
      gate.resolve();
      const result = await running;
      expect(result.messages[1]!.content[1]).toMatchObject({ toolCallId: "parent", content: "after" });
    } finally { gate.resolve(); await running; }
  });

  it("parallelizes consecutive reads, drains them before a mutation and exposes its result to the following read", async () => {
    const { deps } = await setup();
    const gates = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    const order: string[] = [];
    let value = "before";
    deps.tools = gates.map((gate, i) => testTool(`read${i}`, async () => {
      started[i]!.resolve(); await gate.promise; order.push(`read${i}`); return value;
    }, true));
    deps.tools.push(testTool("mutate", async () => { order.push("mutate"); value = "after"; return value; }));
    deps.tools.push(testTool("observe", async () => { order.push("observe"); return value; }, true));
    const provider = scripted([toolCall("0", "read0", "{}"), toolCall("1", "read1", "{}"), toolCall("2", "mutate", "{}"), toolCall("3", "observe", "{}")]);
    deps.provider = provider;
    const running = runAgent([], deps);
    try {
      await Promise.all(started.map((gate) => gate.promise));
      gates[1]!.resolve();
      await vi.waitFor(() => expect(order).toEqual(["read1"]));
      gates[0]!.resolve();
      await running;
      expect(order).toEqual(["read1", "read0", "mutate", "observe"]);
      expect(provider.receivedHistory[1]!.at(-1)!.content).toMatchObject([
        { toolCallId: "0", content: "before" }, { toolCallId: "1", content: "before" },
        { toolCallId: "2", content: "after" }, { toolCallId: "3", content: "after" },
      ]);
    } finally { gates.forEach((gate) => gate.resolve()); await running; }
  });

  it("bounds the pool, starts a queued call as soon as a slot opens and pairs every skipped call on cancellation", async () => {
    const { deps } = await setup();
    const controller = new AbortController();
    deps.abortSignal = controller.signal;
    const count = MAX_PARALLEL_TOOLS + 3;
    const gates = Array.from({ length: count }, deferred);
    const started: number[] = [];
    deps.tools = gates.map((gate, i) => testTool(`read${i}`, async () => { started.push(i); await gate.promise; return "ok"; }, true));
    deps.provider = scripted(gates.map((_, i) => toolCall(String(i), `read${i}`, "{}")));
    const running = runAgent([], deps);
    try {
      await vi.waitFor(() => expect(started).toHaveLength(MAX_PARALLEL_TOOLS));
      gates[3]!.resolve();
      await vi.waitFor(() => expect(started).toHaveLength(MAX_PARALLEL_TOOLS + 1));
      controller.abort();
      gates.forEach((gate) => gate.resolve());
      const result = await running;
      expect(result.interrupted).toBe(true);
      expect(started).toHaveLength(MAX_PARALLEL_TOOLS + 1);
      expect(result.messages.at(-1)!.content).toHaveLength(count);
      expect(result.messages.at(-1)!.content.slice(-2)).toMatchObject([{ isError: true }, { isError: true }]);
    } finally { gates.forEach((gate) => gate.resolve()); await running; }
  });

  it("validates rewritten arguments before approval and returns actionable errors without executing", async () => {
    const { deps } = await setup();
    const call = vi.fn(async () => "must not run");
    deps.tools = [{ ...testTool("write", call), inputSchema: z.strictObject({ file_path: z.string(), content: z.string() }) }];
    deps.plugins = [{ "tool.execute.before": () => ({ file_path: 123 }) }];
    deps.provider = scripted([toolCall("bad-json", "write", "{"), toolCall("bad-schema", "write", '{"file_path":"ok","content":"ok"}')]);
    const result = await runAgent([], deps);
    expect(call).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
    expect(result.messages[1]!.content).toMatchObject([
      { toolCallId: "bad-json", isError: true, content: expect.stringContaining("尚未执行") },
      { toolCallId: "bad-schema", isError: true, content: expect.stringContaining("file_path") },
    ]);
  });

  it("does not report an already-completed action as failed if output storage is unavailable", async () => {
    const { deps, root } = await setup();
    const blocked = path.join(root, "not-a-directory");
    await writeFile(blocked, "file");
    deps.artifactDir = blocked;
    const call = vi.fn(async () => "操作已成功\n" + "x".repeat(70_000));
    deps.tools = [testTool("mutate", call)];
    deps.provider = scripted([toolCall("a", "mutate", "{}")]);
    const result = await runAgent([], deps);
    expect(call).toHaveBeenCalledOnce();
    expect(result.messages[1]!.content).toMatchObject([{ isError: false, content: expect.stringContaining("无法保存完整日志") }]);
  });

  it("caps aggregate output, preserves call order and makes saved evidence readable", async () => {
    const { deps, ctx } = await setup();
    deps.tools = [testTool("read", async () => "中文证据\n".repeat(3000), true)];
    deps.provider = scripted(Array.from({ length: 12 }, (_, i) => toolCall(String(i), "read", "{}")));
    const result = await runAgent([], deps);
    const results = result.messages[1]!.content as Extract<ContentBlock, { type: "tool-result" }>[];
    expect(results.map((block) => block.toolCallId)).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
    expect(results.reduce((sum, block) => sum + Buffer.byteLength(block.content), 0)).toBeLessThanOrEqual(MAX_BATCH_OUTPUT_BYTES);
    const saved = results.find((block) => block.content.includes("完整内容保存在"))!.content.match(/完整内容保存在: ([^\n]+)/)![1]!;
    expect(await readTool.call({ file_path: saved, offset: 100, limit: 2 }, ctx)).toContain("   100| 中文证据");
  });
});

describe("bounded evidence reading", () => {
  it("pages a file over 256KB and fingerprints the full file, including changes outside the visible window", async () => {
    const { ctx } = await setup();
    const file = path.join(ctx.cwd, "large.txt");
    const content = Array.from({ length: 40_000 }, (_, i) => `中文第${i + 1}行`).join("\r\n") + "\r\n";
    await writeFile(file, content);
    const result = await readTool.call({ file_path: file, offset: 20_000, limit: 2 }, ctx);
    expect(result).toContain(" 20000| 中文第20000行\n 20001| 中文第20001行");
    await editTool.call({ file_path: file, old_string: "中文第20000行", new_string: "已验证" }, ctx);
    await writeFile(file, (await readFile(file, "utf8")) + "external change");
    await expect(editTool.call({ file_path: file, old_string: "已验证", new_string: "bad" }, ctx)).rejects.toThrow("重新 read");
  });

  it("provides a real continuation line instead of recursively spilling read output", async () => {
    const { ctx } = await setup();
    const file = path.join(ctx.cwd, "many.txt");
    await writeFile(file, Array.from({ length: 6000 }, (_, i) => `第${i + 1}行 ${"数据".repeat(10)}`).join("\n"));
    const first = await readTool.call({ file_path: file, offset: 1, limit: 6000 }, ctx);
    expect(Buffer.byteLength(first)).toBeLessThan(41_000);
    expect(first).not.toContain("�");
    const next = Number(first.match(/offset=(\d+)/)![1]);
    expect(next).toBeGreaterThan(1);
    expect(await readTool.call({ file_path: file, offset: next, limit: 1 }, ctx)).toContain(`| 第${next}行`);
  });

  it("bounds a single huge line and preserves a readable spilled output without exposing other app data", async () => {
    const { ctx, root } = await setup();
    const original = "中文🙂".repeat(100_000);
    const spilled = await truncateOutput(original, ctx.artifactDir);
    expect(spilled.content).not.toContain("�");
    expect(Buffer.byteLength(spilled.content)).toBeLessThan(9_000);
    expect(await readFile(spilled.spilledTo!, "utf8")).toBe(original);
    const read = await readTool.call({ file_path: spilled.spilledTo!, offset: 1, limit: 1 }, ctx);
    expect(Buffer.byteLength(read)).toBeLessThan(41_000);
    expect(read).toContain("本行过长");
    expect(read).not.toContain("�");
    await expect(readTool.call({ file_path: path.join(root, "private", "config.json") }, ctx)).rejects.toThrow("已拦截");
    await expect(readTool.call({ file_path: spilled.spilledTo! }, { ...ctx, artifactDir: path.join(root, "different-session") })).rejects.toThrow("已拦截");
  });

  it("returns grep paths relative to the session workspace, not the application's launch directory", async () => {
    const { ctx } = await setup();
    await mkdir(path.join(ctx.cwd, "src"));
    await writeFile(path.join(ctx.cwd, "src", "a.ts"), "needle\n");
    const result = await grepTool.call({ pattern: "needle" }, ctx);
    expect(result).toBe(`${path.join("src", "a.ts")}:1: needle`);
  });
});
