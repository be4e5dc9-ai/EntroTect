import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppEvent, ApprovalRequest, Message } from "@entrotect/shared";
import { runAgent } from "../src/loop/agent.js";
import type { Tool } from "../src/tools/types.js";
import { buildBuiltinTools } from "../src/tools/registry.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";

async function makeEnv(): Promise<{ cwd: string; artifactDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "entrotect-loop-"));
  const artifactDir = path.join(cwd, ".artifacts");
  return { cwd, artifactDir };
}

function makeDeps(cwd: string, artifactDir: string, overrides: Record<string, unknown> = {}) {
  const events: AppEvent[] = [];
  const deps = {
    provider: new MockProvider([]),
    tools: buildBuiltinTools(),
    systemPrompt: buildSystemPrompt({ cwd, model: "mock", platform: "win32", date: "2026-08-23" }),
    maxTokens: 2048,
    emit: (event: AppEvent) => events.push(event),
    approve: async () => ({ decision: "allow-once" as const }),
    cwd,
    artifactDir,
    ...overrides,
  };
  return { deps, events };
}

describe("runAgent 主循环", () => {
  it("多轮闭环:文本→read 工具→结果回喂→最终答复,出口=无 tool_use", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "note.txt"), "hello entrotect", "utf8");

    const provider = new MockProvider([
      { events: [toolCall("c1", "read", JSON.stringify({ file_path: "note.txt" })), turnComplete()] },
      { events: [textBlock("读到内容了,任务完成。"), turnComplete({ inputTokens: 100, outputTokens: 50 })] },
    ]);
    const { deps, events } = makeDeps(cwd, artifactDir, { provider });

    const initial: Message[] = [{ role: "user", content: [{ type: "text", text: "读一下 note.txt" }] }];
    const result = await runAgent(initial, deps);

    expect(result.error).toBeNull();
    expect(result.finalText).toBe("读到内容了,任务完成。");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.messages).toHaveLength(4); // user + assistant + tool_result + assistant

    // tool_result 与 tool_use 配对铁律
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.role).toBe("user");
    const resultBlock = toolResultMsg?.content[0];
    expect(resultBlock).toMatchObject({
      type: "tool-result",
      toolCallId: "c1",
      isError: false,
    });
    expect(String(resultBlock?.content)).toContain("hello entrotect");

    // 事件序:tool-state 完整生命周期
    const toolStates = events.filter((e) => e.type === "tool-state");
    expect(toolStates.map((e) => (e.type === "tool-state" ? e.state : ""))).toEqual([
      "executing",
      "completed",
    ]);
    expect(toolStates[1]).toMatchObject({
      type: "tool-state",
      state: "completed",
      summary: expect.stringContaining("hello entrotect"),
    });
  });

  it("未知工具 fail-closed:is_error 回喂,循环继续", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const provider = new MockProvider([
      { events: [toolCall("x1", "nonexistent", "{}"), turnComplete()] },
      { events: [textBlock("换用正确工具完成。"), turnComplete()] },
    ]);
    const { deps } = makeDeps(cwd, artifactDir, { provider });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      deps,
    );

    expect(result.finalText).toBe("换用正确工具完成。");
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.content[0]).toMatchObject({ isError: true });
    expect(String(toolResultMsg?.content[0]?.content)).toContain("未知工具");
  });

  it("工具抛错 → is_error 回喂,模型下一轮自纠", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const provider = new MockProvider([
      { events: [toolCall("e1", "read", JSON.stringify({ file_path: "missing.txt" })), turnComplete()] },
      { events: [textBlock("文件不存在,换个路径。"), turnComplete()] },
    ]);
    const { deps } = makeDeps(cwd, artifactDir, { provider });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "读 missing.txt" }] }],
      deps,
    );

    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.content[0]).toMatchObject({ isError: true });
    expect(String(toolResultMsg?.content[0]?.content)).toContain("tool_use_error");
    // 第二轮历史里包含错误结果(错误回喂)
    const secondRoundHistory = provider.receivedHistory[1];
    expect(JSON.stringify(secondRoundHistory)).toContain("tool_use_error");
  });

  it("deny 回喂理由,且不执行工具", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "keep.txt"), "important", "utf8");
    const provider = new MockProvider([
      { events: [toolCall("d1", "write", JSON.stringify({ file_path: "keep.txt", content: "clobbered" })), turnComplete()] },
      { events: [textBlock("明白,不覆盖。"), turnComplete()] },
    ]);
    const { deps, events } = makeDeps(cwd, artifactDir, {
      provider,
      approve: async (_request: ApprovalRequest) => ({ decision: "deny" }),
    });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "覆盖 keep.txt" }] }],
      deps,
    );

    // 文件未被修改
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(cwd, "keep.txt"), "utf8")).toBe("important");

    const deniedState = events.find((e) => e.type === "tool-state" && e.state === "denied");
    expect(deniedState).toBeDefined();
    expect(result.finalText).toBe("明白,不覆盖。");
  });

  it("中断:未执行工具合成配对结果,已收历史完整", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const controller = new AbortController();
    const provider = new MockProvider([
      {
        events: [
          toolCall("a1", "read", JSON.stringify({ file_path: "x" })),
          toolCall("a2", "read", JSON.stringify({ file_path: "y" })),
          turnComplete(),
        ],
      },
    ]);
    const { deps } = makeDeps(cwd, artifactDir, { provider, abortSignal: controller.signal });

    // approve 第一次允许,第二次前中断
    let calls = 0;
    deps.approve = async () => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        return { decision: "allow-once" };
      }
      return { decision: "allow-once" };
    };

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      deps,
    );

    expect(result.interrupted).toBe(true);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.content).toHaveLength(2); // 两个 tool_use 都有配对结果
    expect(toolResultMsg?.content[1]).toMatchObject({
      type: "tool-result",
      toolCallId: "a2",
      isError: true,
    });
  });

  it("边跑边持久化:onMessage 收到 assistant 与 tool_result 消息", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "n.txt"), "ok", "utf8");
    const provider = new MockProvider([
      { events: [toolCall("p1", "read", JSON.stringify({ file_path: "n.txt" })), turnComplete()] },
      { events: [textBlock("完成。"), turnComplete()] },
    ]);
    const persisted: Message[] = [];
    const { deps } = makeDeps(cwd, artifactDir, {
      provider,
      onMessage: async (message: Message) => {
        persisted.push(message);
      },
    });

    await runAgent(
      [{ role: "user", content: [{ type: "text", text: "读 n.txt" }] }],
      deps,
    );

    // assistant(工具调用) → user(tool_result) → assistant(最终文本)
    expect(persisted.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(persisted[1]?.content[0]).toMatchObject({ type: "tool-result", toolCallId: "p1" });
  });

  it("多个工具调用轮次正确执行", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const provider = new MockProvider([
      { events: [toolCall("r1", "glob", JSON.stringify({ pattern: "*" })), turnComplete()] },
      { events: [toolCall("r2", "glob", JSON.stringify({ pattern: "*" })), turnComplete()] },
      { events: [toolCall("r3", "glob", JSON.stringify({ pattern: "*" })), turnComplete()] },
    ]);
    const { deps } = makeDeps(cwd, artifactDir, { provider });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "loop" }] }],
      deps,
    );
    expect(result.error).toBeNull();
  });

  it("write 成功 → file-changed 事件(相对路径,action=written)", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const provider = new MockProvider([
      { events: [toolCall("w1", "write", JSON.stringify({ file_path: "out.txt", content: "hello" })), turnComplete()] },
      { events: [textBlock("写好了。"), turnComplete()] },
    ]);
    const { deps, events } = makeDeps(cwd, artifactDir, { provider });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "写个文件" }] }],
      deps,
    );

    expect(result.error).toBeNull();
    const changed = events.filter((e) => e.type === "file-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      type: "file-changed",
      toolCallId: "w1",
      path: "out.txt",
      action: "written",
    });
  });

  it("edit 成功 → file-changed 事件(相对路径,action=edited)", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "note.txt"), "alpha beta", "utf8");
    const provider = new MockProvider([
      { events: [toolCall("e1", "edit", JSON.stringify({ file_path: "note.txt", old_string: "alpha", new_string: "omega" })), turnComplete()] },
      { events: [textBlock("改好了。"), turnComplete()] },
    ]);
    const { deps, events } = makeDeps(cwd, artifactDir, { provider });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "改个文件" }] }],
      deps,
    );

    expect(result.error).toBeNull();
    const changed = events.filter((e) => e.type === "file-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      type: "file-changed",
      toolCallId: "e1",
      path: "note.txt",
      action: "edited",
    });
  });

  it("read 成功不发 file-changed", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "book.txt"), "content", "utf8");
    const provider = new MockProvider([
      { events: [toolCall("r9", "read", JSON.stringify({ file_path: "book.txt" })), turnComplete()] },
      { events: [textBlock("读完了。"), turnComplete()] },
    ]);
    const { deps, events } = makeDeps(cwd, artifactDir, { provider });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "读 book.txt" }] }],
      deps,
    );

    expect(result.error).toBeNull();
    expect(events.filter((e) => e.type === "file-changed")).toHaveLength(0);
  });

  it("write 失败不发 file-changed", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const provider = new MockProvider([
      { events: [toolCall("wf1", "write", JSON.stringify({ file_path: "x.txt", content: "x" })), turnComplete()] },
      { events: [textBlock("写失败了,换个方式。"), turnComplete()] },
    ]);
    // 同款 write 工具但 call 抛错:走失败分支,不产文件
    const failingWrite: Tool = {
      name: "write",
      description: "mock",
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      isReadOnly: false,
      preview: (args) => (args as { file_path: string }).file_path,
      async call(): Promise<string> {
        throw new Error("磁盘写入失败");
      },
    };
    const { deps, events } = makeDeps(cwd, artifactDir, {
      provider,
      tools: [failingWrite],
    });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "写文件" }] }],
      deps,
    );

    expect(result.finalText).toBe("写失败了,换个方式。");
    expect(events.filter((e) => e.type === "file-changed")).toHaveLength(0);
    const failedState = events.find((e) => e.type === "tool-state" && e.state === "failed");
    expect(failedState).toBeDefined();
  });
});
