import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppEvent, Message } from "@entrotect/shared";
import { runAgent, type AgentDeps } from "../src/loop/agent.js";
import { createTaskTool } from "../src/tools/task.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";

const user: Message = { role: "user", content: [{ type: "text", text: "调研类人脑 Agent 记忆系统的论文和开源实现" }] };

function setup(script: ConstructorParameters<typeof MockProvider>[0], overrides: Partial<AgentDeps> = {}) {
  const provider = new MockProvider(script);
  const dispatch = vi.fn(async (prompt: string) => `独立证据：${prompt}`);
  const search = vi.fn(async () => "搜索结果");
  const events: AppEvent[] = [];
  const approve = vi.fn(async () => ({ decision: "allow-once" as const }));
  const deps: AgentDeps = {
    provider, systemPrompt: "system", orchestration: "ultra", reasoningEffort: "max",
    tools: [createTaskTool(dispatch), { name: "websearch", description: "search", inputSchema: z.object({}), isReadOnly: true, preview: () => "search", call: search }],
    cwd: ".", artifactDir: ".", emit: (event) => events.push(event), approve, ...overrides,
  };
  return { deps, provider, dispatch, search, events, approve };
}

describe("Ultra runtime coordination", () => {
  it("executes independent research delegates before restoring the main tool pool", async () => {
    const env = setup([
      { events: [toolCall("a", "task", '{"prompt":"只读调研论文原始证据"}'), toolCall("b", "task", '{"prompt":"只读比较开源实现"}'), turnComplete()] },
      { events: [toolCall("c", "websearch", "{}"), turnComplete()] },
      { events: [textBlock("整合并交叉验证完成"), turnComplete()] },
    ]);
    const result = await runAgent([user], env.deps);
    expect(result.error).toBeNull();
    expect(env.dispatch.mock.calls.map(([prompt]) => prompt)).toEqual(["只读调研论文原始证据", "只读比较开源实现"]);
    expect(env.search).toHaveBeenCalledOnce();
    expect(JSON.stringify(env.provider.receivedHistory[1])).toContain("独立证据");
    expect(result.finalText).toBe("整合并交叉验证完成");
  });

  it("runs known same-turn writes only after every delegated task returns", async () => {
    const env = setup([
      { events: [
        toolCall("task-a", "task", '{"prompt":"独立核验 A"}'),
        toolCall("write-a", "write", '{"file_path":"a.md"}'),
        toolCall("task-b", "task", '{"prompt":"独立核验 B"}'),
        toolCall("write-b", "write", '{"file_path":"b.md"}'),
        turnComplete(),
      ] },
      { events: [textBlock("完成"), turnComplete()] },
    ]);
    const order: string[] = [];
    env.dispatch.mockImplementation(async (prompt) => {
      await Promise.resolve();
      order.push(`task:${prompt}`);
      return `证据：${prompt}`;
    });
    const write = vi.fn(async (args: unknown) => {
      order.push(`write:${(args as { file_path: string }).file_path}`);
      return "写入成功";
    });
    env.deps.tools.push({
      name: "write", description: "write", inputSchema: z.object({ file_path: z.string() }),
      isReadOnly: false, preview: (args) => (args as { file_path: string }).file_path, call: write,
    });
    env.deps.approve = vi.fn(async (request) => {
      order.push(`approve:${request.toolName}`);
      return { decision: "allow-once" as const };
    });

    const result = await runAgent([user], env.deps);
    expect(result.error).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
    expect(order.filter((entry) => entry.startsWith("task:"))).toHaveLength(2);
    expect(order.findIndex((entry) => entry === "approve:write")).toBeGreaterThan(order.findLastIndex((entry) => entry.startsWith("task:")));
    expect(order.findIndex((entry) => entry.startsWith("write:"))).toBeGreaterThan(order.findLastIndex((entry) => entry.startsWith("task:")));
    expect(result.messages[2]?.content.map((block) => block.type === "tool-result" ? [block.toolCallId, block.isError] : null)).toEqual([
      ["task-a", false], ["write-a", false], ["task-b", false], ["write-b", false],
    ]);
    expect(env.events.some((event) => event.type === "tool-state" && event.state === "failed")).toBe(false);
  });

  it("blocks research tools if the model skips coordination, then accepts corrected delegation", async () => {
    const env = setup([
      { events: [toolCall("a", "websearch", "{}"), turnComplete()] },
      { events: [toolCall("b", "task", '{"prompt":"独立核验论文"}'), turnComplete()] },
      { events: [textBlock("完成"), turnComplete()] },
    ]);
    const result = await runAgent([user], env.deps);
    expect(env.search).not.toHaveBeenCalled();
    expect(env.dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(env.provider.receivedHistory[1])).toContain("本轮尚未作出 Ultra 协作决定");
    expect(result.error).toBeNull();
  });

  it("does not approve or execute a same-turn write if delegation failed", async () => {
    const env = setup([
      { events: [toolCall("a", "task", '{"prompt":"独立核验"}'), toolCall("b", "write", '{"file_path":"a.md"}'), turnComplete()] },
      { events: [toolCall("c", "task", '{"prompt":"重试核验"}'), turnComplete()] },
      { events: [textBlock("完成"), turnComplete()] },
    ]);
    const write = vi.fn(async () => "写入成功");
    env.deps.tools.push({
      name: "write", description: "write", inputSchema: z.object({ file_path: z.string() }),
      isReadOnly: false, preview: () => "a.md", call: write,
    });
    env.dispatch.mockRejectedValueOnce(new Error("子代理失败"));

    const result = await runAgent([user], env.deps);
    expect(result.error).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(env.approve.mock.calls.map(([request]) => request.toolName)).toEqual(["task", "task"]);
    expect(result.messages[2]?.content[1]).toMatchObject({
      type: "tool-result", toolCallId: "b", isError: true,
      content: expect.stringContaining("当前回合的后续工具未执行"),
    });
  });

  it("holds same-turn writes when one of several delegates fails", async () => {
    const env = setup([
      { events: [
        toolCall("a", "task", '{"prompt":"成功的子任务"}'),
        toolCall("b", "task", '{"prompt":"失败的子任务"}'),
        toolCall("c", "write", '{"file_path":"a.md"}'),
        turnComplete(),
      ] },
      { events: [textBlock("根据报告处理失败"), turnComplete()] },
    ]);
    const write = vi.fn(async () => "写入成功");
    env.deps.tools.push({
      name: "write", description: "write", inputSchema: z.object({ file_path: z.string() }),
      isReadOnly: false, preview: () => "a.md", call: write,
    });
    env.dispatch.mockImplementation(async (prompt) => {
      if (prompt === "失败的子任务") throw new Error("子代理失败");
      return "核验完成";
    });
    const result = await runAgent([user], env.deps);
    expect(result.error).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(result.messages[2]?.content[2]).toMatchObject({
      type: "tool-result", toolCallId: "c", isError: true,
      content: expect.stringContaining("未全部成功"),
    });
  });

  it("does not silently complete or loop forever when the model keeps returning text", async () => {
    const env = setup([{ events: [textBlock("我会调研"), turnComplete()] }, { events: [textBlock("已完成"), turnComplete()] }]);
    const result = await runAgent([user], env.deps);
    expect(result.error).toContain("Ultra 子代理编排未完成");
    expect(result.finalText).toBeNull();
    expect(env.provider.receivedHistory).toHaveLength(2);
  });

  it.each(["simple_request", "user_opt_out", "needs_clarification"])("records an explicit %s exception without spawning", async (category) => {
    const env = setup([
      { events: [toolCall("a", "ultra_direct", JSON.stringify({ category, reason: "本轮具体原因" })), turnComplete()] },
      { events: [textBlock("直接回复"), turnComplete()] },
    ]);
    const result = await runAgent([user], env.deps);
    expect(result.error).toBeNull();
    expect(env.dispatch).not.toHaveBeenCalled();
    expect(env.approve).not.toHaveBeenCalled();
    expect(JSON.stringify(result.messages)).toContain("本轮具体原因");
  });

  it("does not retry user-denied delegation", async () => {
    const env = setup([
      { events: [toolCall("a", "task", '{"prompt":"独立研究"}'), turnComplete()] },
      { events: [textBlock("委派被拒绝，由我处理"), turnComplete()] },
    ], { approve: async () => ({ decision: "deny", reason: "用户拒绝" }) });
    const result = await runAgent([user], env.deps);
    expect(result.error).toBeNull();
    expect(env.dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(env.provider.receivedHistory[1])).toContain("用户拒绝");
  });

  it("retries invalid arguments and surfaces repeated child failures", async () => {
    const env = setup([
      { events: [toolCall("a", "task", "{}"), turnComplete()] },
      { events: [toolCall("b", "task", '{"prompt":"独立研究"}'), turnComplete()] },
    ]);
    env.dispatch.mockRejectedValue(new Error("upstream unavailable"));
    const result = await runAgent([user], env.deps);
    expect(result.error).toContain("Ultra 子代理编排未完成");
    expect(env.dispatch).toHaveBeenCalledOnce();
    expect(env.events.filter((event) => event.type === "tool-state" && event.state === "failed")).toHaveLength(2);
  });

  it("fails clearly if task is unavailable", async () => {
    const env = setup([], { tools: [] });
    const result = await runAgent([user], env.deps);
    expect(result.error).toContain("Ultra");
    expect(env.provider.receivedHistory).toHaveLength(0);
  });

  it("a previous turn's task does not bypass this run's coordination", async () => {
    const env = setup([{ events: [textBlock("done"), turnComplete()] }, { events: [textBlock("done"), turnComplete()] }]);
    const result = await runAgent([
      user,
      { role: "assistant", content: [{ type: "tool-call", id: "old", name: "task", arguments: '{"prompt":"old research"}' }] },
      { role: "user", content: [{ type: "tool-result", name: "task", toolCallId: "old", content: "old evidence", isError: false }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      user,
    ], env.deps);
    expect(result.error).toContain("Ultra");
    expect(env.provider.receivedHistory).toHaveLength(2);
  });

  it("honors cancellation before coordination and leaves normal max mode unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = setup([], { abortSignal: controller.signal });
    expect((await runAgent([user], aborted.deps)).interrupted).toBe(true);
    expect(aborted.dispatch).not.toHaveBeenCalled();
    const regular = setup([{ events: [textBlock("普通回复"), turnComplete()] }], { orchestration: undefined });
    expect((await runAgent([user], regular.deps)).finalText).toBe("普通回复");
  });
});
