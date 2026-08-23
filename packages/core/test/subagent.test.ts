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
  it("注入 taskRunner:task 工具追加到末尾,调用转发给 runner,preview 截前 60 字", async () => {
    const prompts: string[] = [];
    const runner: SubagentRunner = async (prompt: string) => {
      prompts.push(prompt);
      return "子代理汇报:完成";
    };

    const tools = buildBuiltinTools({ taskRunner: runner });
    expect(tools).toHaveLength(7);
    const task = tools[tools.length - 1];
    expect(task?.name).toBe("task");
    if (!task) throw new Error("task 工具缺失");

    const output = await task.call(
      { prompt: "调研某段代码" },
      { cwd: ".", artifactDir: "." },
    );
    expect(output).toBe("子代理汇报:完成");
    expect(prompts).toEqual(["调研某段代码"]);

    // preview:仅显示 prompt 前 60 字
    const longPrompt = "a".repeat(100);
    expect(task.preview({ prompt: longPrompt })).toBe(`${"a".repeat(60)}…`);

    // 无参调用不含 task(兼容旧调用方)
    expect(buildBuiltinTools().map((t) => t.name)).not.toContain("task");
  });

  it("runner 未注入:task.call 抛错", async () => {
    setTaskRunner(null);
    await expect(
      taskTool.call({ prompt: "x" }, { cwd: ".", artifactDir: "." }),
    ).rejects.toThrow("子代理运行器未配置");
    expect(buildBuiltinTools().map((t) => t.name)).not.toContain("task");
  });

  it("集成:主代理派 task → 子代理 read 临时文件 → 汇报作为 tool-result 回喂 → 主代理收口", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "note.txt"), "hello subagent", "utf8");

    // 共用事件汇:验证 emit 透传(子代理的工具卡片也上屏)
    const events: AppEvent[] = [];

    // 子代理 provider:第一轮 read,第二轮给最终文本;主/子两个 provider 各自消费自己的脚本
    const subBase = new MockProvider([
      { events: [toolCall("s1", "read", JSON.stringify({ file_path: "note.txt" })), turnComplete()] },
      { events: [textBlock("子代理汇报:文件内容是 hello subagent"), turnComplete()] },
    ]);
    // 间谍 provider:记录子代理看到的工具池与系统提示词
    const subToolPools: string[][] = [];
    const subSystemPrompts: string[] = [];
    const subProvider: Provider = {
      model: subBase.model,
      streamBlocks(messages, options, signal) {
        subToolPools.push(options.tools.map((t) => t.name));
        subSystemPrompts.push(options.systemPrompt);
        return subBase.streamBlocks(messages, options, signal);
      },
    };

    const runner = createSubagentRunner({
      provider: subProvider,
      tools: buildBuiltinTools(),
      systemPrompt: "父级提示词",
      approve: async () => ({ decision: "allow-once" as const }),
      emit: (event: AppEvent) => events.push(event),
      cwd,
      artifactDir,
      maxTokens: 2048,
    });

    const mainProvider = new MockProvider([
      { events: [toolCall("t1", "task", JSON.stringify({ prompt: "读出 note.txt 的内容并汇报" })), turnComplete()] },
      { events: [textBlock("主代理收到汇报,任务完成。"), turnComplete()] },
    ]);
    const tools = buildBuiltinTools({ taskRunner: runner });

    const result = await runAgent(
      [{ role: "user", content: [{ type: "text", text: "帮我调研 note.txt" }] }],
      {
        provider: mainProvider,
        tools,
        systemPrompt: "主提示词",
        maxTokens: 2048,
        emit: (event: AppEvent) => events.push(event),
        approve: async () => ({ decision: "allow-once" as const }),
        cwd,
        artifactDir,
      },
    );

    // 主循环出口与最终文本
    expect(result.error).toBeNull();
    expect(result.finalText).toBe("主代理收到汇报,任务完成。");

    // 历史配对完整:user → assistant(tool_use) → user(tool_result) → assistant
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "t1",
      isError: false,
    });
    // 子代理最终文本被作为 tool-result 回喂
    expect(String(toolResultMsg?.content[0]?.content)).toContain("hello subagent");

    // 子代理独立闭环:两轮历史,read 结果回喂后才产出最终文本
    expect(subBase.receivedHistory).toHaveLength(2);
    expect(JSON.stringify(subBase.receivedHistory[1])).toContain("hello subagent");

    // 防递归:子代理工具池里没有 task
    expect(subToolPools[0]).not.toContain("task");
    // persona:子代理系统提示词含角色约束
    expect(subSystemPrompts[0]).toContain("EntroTect 的子代理");

    // emit 透传:子代理的 read 工具状态也出现在主事件流
    const readState = events.find(
      (e) => e.type === "tool-state" && e.toolCallId === "s1" && e.state === "completed",
    );
    expect(readState).toBeDefined();
  });
});
