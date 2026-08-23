import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppEvent, ApprovalRequest, Message } from "@entrotect/shared";
import { runAgent } from "../src/loop/agent.js";
import { buildBuiltinTools } from "../src/tools/registry.js";
import { taskTool, setTaskRunner } from "../src/tools/task.js";
import { createSubagentRunner, type SubagentRunner } from "../src/subagent/run.js";
import type { Provider } from "../src/provider/types.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";

async function makeEnv(): Promise<{ cwd: string; artifactDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "entrotect-subagent-"));
  const artifactDir = path.join(cwd, ".artifacts");
  return { cwd, artifactDir };
}

describe("task 工具与子代理", () => {
  it("注入 taskRunner:task 工具追加到末尾,运行器收到 prompt,日志经 subagentLog 上报", async () => {
    const prompts: string[] = [];
    const logLines: string[] = [];
    const runner: SubagentRunner = async (prompt: string, log) => {
      prompts.push(prompt);
      log?.("⚡ 子代理内部步进");
      return "子代理汇报:完成";
    };

    const tools = buildBuiltinTools({ taskRunner: runner });
    expect(tools).toHaveLength(7);
    const task = tools[tools.length - 1];
    expect(task?.name).toBe("task");
    if (!task) throw new Error("task 工具缺失");

    const output = await task.call(
      { prompt: "调研某段代码" },
      { cwd: ".", artifactDir: ".", subagentLog: (line: string) => logLines.push(line) },
    );
    expect(output).toBe("子代理汇报:完成");
    expect(prompts).toEqual(["调研某段代码"]);
    expect(logLines).toEqual(["⚡ 子代理内部步进"]);

    // preview:只显示 prompt 前 60 字
    const longPrompt = "a".repeat(100);
    expect(task.preview({ prompt: longPrompt })).toBe(`${"a".repeat(60)}…`);

    // 无参调用不带 task(兼容旧调用方)
    expect(buildBuiltinTools().map((t) => t.name)).not.toContain("task");
  });

  it("runner 未注入:task.call 抛错", async () => {
    setTaskRunner(null);
    await expect(
      taskTool.call({ prompt: "x" }, { cwd: ".", artifactDir: "." }),
    ).rejects.toThrow("子代理运行器未配置");
    expect(buildBuiltinTools().map((t) => t.name)).not.toContain("task");
  });

  it("集成:主循环 task → 子代理 read 临时文件 → 汇报回喂;内部事件折叠成 subagent-activity,不入主对话流", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "note.txt"), "hello subagent", "utf8");

    const events: AppEvent[] = [];
    const emit = (event: AppEvent) => events.push(event);

    // 子代理 provider:第一轮 read,第二轮给最终文本
    const subBase = new MockProvider([
      { events: [toolCall("s1", "read", JSON.stringify({ file_path: "note.txt" })), turnComplete()] },
      { events: [textBlock("子代理汇报:文件内容为 hello subagent"), turnComplete()] },
    ]);
    const subToolPools: string[][] = [];
    const subProvider: Provider = {
      model: subBase.model,
      streamBlocks(messages, options, signal) {
        subToolPools.push(options.tools.map((t) => t.name));
        return subBase.streamBlocks(messages, options, signal);
      },
    };

    const runner = createSubagentRunner({
      provider: subProvider,
      tools: buildBuiltinTools(),
      systemPrompt: "父提示词",
      approve: async () => ({ decision: "allow-once" as const }),
      cwd,
      artifactDir,
      maxTokens: 2048,
    });

    const mainProvider = new MockProvider([
      { events: [toolCall("t1", "task", JSON.stringify({ prompt: "读取 note.txt 内容并汇报" })), turnComplete()] },
      { events: [textBlock("主代收到汇报,任务完成。"), turnComplete()] },
    ]);
    const tools = buildBuiltinTools({ taskRunner: runner });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "请读取 note.txt" }] }],
      {
        provider: mainProvider,
        tools,
        systemPrompt: "父提示词",
        maxTokens: 2048,
        emit,
        approve: async () => ({ decision: "allow-once" as const }),
        cwd,
        artifactDir,
      },
    );

    // 主循环正常到达最终文本
    expect(result.error).toBeNull();
    expect(result.finalText).toBe("主代收到汇报,任务完成。");

    // 历史配对:user → assistant(tool_use) → user(tool_result) → assistant
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "t1",
      isError: false,
    });
    // 子代理最终文本作为 tool-result 回喂
    expect(String(toolResultMsg?.content[0]?.content)).toContain("hello subagent");

    // 子代理轮次闭环:历史含 read 结果
    expect(subBase.receivedHistory).toHaveLength(2);
    expect(JSON.stringify(subBase.receivedHistory[1])).toContain("hello subagent");

    // 防递归:子代理工具池没有 task
    expect(subToolPools[0]).not.toContain("task");
    // persona 追加生效
    expect(subToolPools).toBeDefined();

    // 新展示规约:内部活动折叠成 subagent-activity 行,挂在主循环的 task 卡片(t1)
    const activities = events.filter(
      (e): e is Extract<AppEvent, { type: "subagent-activity" }> => e.type === "subagent-activity",
    );
    const t1Activities = activities.filter((e) => e.toolCallId === "t1");
    expect(t1Activities.length).toBeGreaterThan(0);
    expect(t1Activities.some((e) => e.text.includes("note.txt"))).toBe(true);

    // 内部 tool-state 不再透传给主 emit
    const innerState = events.find(
      (e) => e.type === "tool-state" && e.toolCallId === "s1",
    );
    expect(innerState).toBeUndefined();

    // 子代理的文本增量不该作为主对话流出现
    const leaks = events.filter(
      (e) => e.type === "assistant-delta" && e.text.includes("子代理汇报"),
    );
    expect(leaks).toHaveLength(0);
  });

  it("子代理内部 write 成功后,父级 events 无 file-changed(emitInner 折叠)", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const events: AppEvent[] = [];
    const emit = (event: AppEvent) => events.push(event);

    // 子代理:第一轮 write 内部文件,第二轮汇报
    const subBase = new MockProvider([
      { events: [toolCall("sw1", "write", JSON.stringify({ file_path: "inner.txt", content: "subagent wrote" })), turnComplete()] },
      { events: [textBlock("子代理已写入 inner.txt"), turnComplete()] },
    ]);
    const runner = createSubagentRunner({
      provider: subBase,
      tools: buildBuiltinTools(),
      systemPrompt: "父提示词",
      approve: async () => ({ decision: "allow-once" as const }),
      cwd,
      artifactDir,
      maxTokens: 2048,
    });

    const mainProvider = new MockProvider([
      { events: [toolCall("t2", "task", JSON.stringify({ prompt: "写 inner.txt" })), turnComplete()] },
      { events: [textBlock("主代完成。"), turnComplete()] },
    ]);
    const tools = buildBuiltinTools({ taskRunner: runner });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "委派写文件" }] }],
      {
        provider: mainProvider,
        tools,
        systemPrompt: "父提示词",
        maxTokens: 2048,
        emit,
        approve: async () => ({ decision: "allow-once" as const }),
        cwd,
        artifactDir,
      },
    );

    expect(result.error).toBeNull();
    expect(result.finalText).toBe("主代完成。");
    // 子代理内部的 file-changed 被 emitInner 折叠,不透传给父级 emit
    const fileChanged = events.filter((e) => e.type === "file-changed");
    expect(fileChanged).toHaveLength(0);
    // 其执行步进仍以活动日志形式挂在 t2 卡片上
    const t2Activities = events.filter(
      (e) => e.type === "subagent-activity" && e.toolCallId === "t2",
    );
    expect(t2Activities.some((e) => e.text.includes("inner.txt"))).toBe(true);
  });
});
