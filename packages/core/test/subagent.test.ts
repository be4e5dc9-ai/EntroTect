import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AppEvent,
  ApprovalRequest,
  Message,
  PermissionMode,
  SubagentPart,
} from "@entrotect/shared";
import { runAgent } from "../src/loop/agent.js";
import { SessionPermissionGate } from "../src/permission/gate.js";
import { buildBuiltinTools } from "../src/tools/registry.js";
import { taskTool, setTaskRunner } from "../src/tools/task.js";
import { createSubagentRunner, type SubagentRunner } from "../src/subagent/run.js";
import type { Provider } from "../src/provider/types.js";
import { MockProvider, textBlock, textDelta, toolCall, turnComplete } from "./helpers/mock-provider.js";

async function makeEnv(): Promise<{ cwd: string; artifactDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "entrotect-subagent-"));
  const artifactDir = path.join(cwd, ".artifacts");
  return { cwd, artifactDir };
}

function makeRequest(toolName: string, toolCallId: string): ApprovalRequest {
  return { toolName, toolCallId, preview: toolName, description: toolName };
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

  it("createSubagentRunner:emitPart 收到完整对话片段流(read→最终文本)", async () => {
    const { cwd, artifactDir } = await makeEnv();
    await writeFile(path.join(cwd, "note.txt"), "hello subagent", "utf8");

    // 子代理:第一轮先流式文本再调 read,第二轮给最终文本
    const subProvider = new MockProvider([
      {
        events: [
          textDelta("让我先读一下 note.txt"),
          textBlock("让我先读一下 note.txt"),
          toolCall("s1", "read", JSON.stringify({ file_path: "note.txt" })),
          turnComplete(),
        ],
      },
      { events: [textBlock("子代理汇报:文件内容为 hello subagent"), turnComplete()] },
    ]);

    const parts: SubagentPart[] = [];
    const logLines: string[] = [];
    const runner = createSubagentRunner({
      provider: subProvider,
      tools: buildBuiltinTools(),
      systemPrompt: "父提示词",
      approve: async () => ({ decision: "allow-once" as const }),
      cwd,
      artifactDir,
      maxTokens: 2048,
    });

    const final = await runner(
      "读取 note.txt 内容并汇报",
      (line) => logLines.push(line),
      (part) => parts.push(part),
    );
    expect(final).toContain("hello subagent");

    // 片段序列:turn-start 打头,turn-end 收尾,中间含 delta/block/tool-state
    expect(parts[0]?.kind).toBe("turn-start");
    expect(parts[parts.length - 1]?.kind).toBe("turn-end");

    const deltaPart = parts.find((p) => p.kind === "delta");
    expect(deltaPart?.kind === "delta" ? deltaPart.text : "").toContain("让我先读");

    const blockParts = parts.filter((p) => p.kind === "block");
    expect(
      blockParts.some((p) => p.kind === "block" && p.block.type === "text"),
    ).toBe(true);
    const readBlock = blockParts.find(
      (p) =>
        p.kind === "block" &&
        p.block.type === "tool-call" &&
        p.block.name === "read",
    );
    expect(readBlock).toBeDefined();
    expect(
      readBlock?.kind === "block" && readBlock.block.type === "tool-call"
        ? readBlock.block.id
        : "",
    ).toBe("s1");

    // inner tool-state:toolCallId 与工具块 id 一致,生命周期完整
    const toolStates = parts.filter((p) => p.kind === "tool-state");
    expect(toolStates).toHaveLength(2);
    expect(
      toolStates.some(
        (p) =>
          p.kind === "tool-state" && p.toolCallId === "s1" && p.state === "executing",
      ),
    ).toBe(true);
    expect(
      toolStates.some(
        (p) =>
          p.kind === "tool-state" && p.toolCallId === "s1" && p.state === "completed",
      ),
    ).toBe(true);

    // 顺序:delta 先于 text 块;read 工具块先于其 tool-state
    const deltaIdx = parts.findIndex((p) => p.kind === "delta");
    const textBlockIdx = parts.findIndex(
      (p) => p.kind === "block" && p.block.type === "text",
    );
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(textBlockIdx).toBeGreaterThan(deltaIdx);
    const readIdx = parts.findIndex(
      (p) =>
        p.kind === "block" && p.block.type === "tool-call" && p.block.name === "read",
    );
    const s1StateIdx = parts.findIndex(
      (p) => p.kind === "tool-state" && p.toolCallId === "s1",
    );
    expect(s1StateIdx).toBeGreaterThan(readIdx);

    // 活动日志行通道不受影响(既有折叠行为)
    expect(logLines.some((l) => l.includes("note.txt"))).toBe(true);
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

    // 子代理对话片段:subagent-part 挂 t1 上报,含 read 工具块与最终文本块
    const partEvents = events.filter(
      (e): e is Extract<AppEvent, { type: "subagent-part" }> =>
        e.type === "subagent-part",
    );
    const t1Parts = partEvents.filter((e) => e.toolCallId === "t1");
    expect(t1Parts.length).toBeGreaterThan(0);
    expect(
      t1Parts.some(
        (e) =>
          e.part.kind === "block" &&
          e.part.block.type === "tool-call" &&
          e.part.block.name === "read" &&
          e.part.block.id === "s1",
      ),
    ).toBe(true);
    expect(
      t1Parts.some(
        (e) =>
          e.part.kind === "block" &&
          e.part.block.type === "text" &&
          e.part.block.text.includes("hello subagent"),
      ),
    ).toBe(true);
    expect(
      t1Parts.some(
        (e) =>
          e.part.kind === "tool-state" &&
          e.part.toolCallId === "s1" &&
          e.part.state === "completed",
      ),
    ).toBe(true);
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

  it.each(["full", "write", "ask"] as const)(
    "子代理与父代理在 %s 模式下共享读写审批语义",
    async (mode: PermissionMode) => {
      const { cwd, artifactDir } = await makeEnv();
      await writeFile(path.join(cwd, "note.txt"), "parent and child", "utf8");

      const tools = buildBuiltinTools();
      const gate = new SessionPermissionGate(tools, 200, mode);
      const pendingTools: string[] = [];
      const approve = (request: ApprovalRequest) => {
        const outcome = gate.request(request);
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });
        queueMicrotask(() => {
          if (!settled) {
            pendingTools.push(request.toolName);
            gate.respond(request.toolCallId, "allow-once");
          }
        });
        return outcome;
      };
      const expectedPending =
        mode === "full" ? [] : mode === "write" ? ["write"] : ["read", "write"];

      await approve(makeRequest("read", `parent-read-${mode}`));
      await approve(makeRequest("write", `parent-write-${mode}`));
      expect(pendingTools).toEqual(expectedPending);
      pendingTools.length = 0;

      const childProvider = new MockProvider([
        {
          events: [
            toolCall(
              `child-read-${mode}`,
              "read",
              JSON.stringify({ file_path: "note.txt" }),
            ),
            turnComplete(),
          ],
        },
        {
          events: [
            toolCall(
              `child-write-${mode}`,
              "write",
              JSON.stringify({ file_path: `child-${mode}.txt`, content: mode }),
            ),
            turnComplete(),
          ],
        },
        { events: [textBlock("子代理完成"), turnComplete()] },
      ]);
      const runner = createSubagentRunner({
        provider: childProvider,
        tools,
        systemPrompt: "父提示词",
        approve,
        cwd,
        artifactDir,
        sandboxMode: "full",
      });

      expect(await runner("读取并写入文件")).toBe("子代理完成");
      expect(pendingTools).toEqual(expectedPending);
      expect(await readFile(path.join(cwd, `child-${mode}.txt`), "utf8")).toBe(mode);
    },
  );

  it("allow-always 记忆在父级工具检查与子代理工具检查之间共享", async () => {
    const { cwd, artifactDir } = await makeEnv();
    const tools = buildBuiltinTools();
    const gate = new SessionPermissionGate(tools, 50, "write");

    const parentApproval = gate.request(makeRequest("write", "parent-always"));
    gate.respond("parent-always", "allow-always");
    expect((await parentApproval).decision).toBe("allow-always");

    const childProvider = new MockProvider([
      {
        events: [
          toolCall(
            "child-always",
            "write",
            JSON.stringify({ file_path: "remembered.txt", content: "shared" }),
          ),
          turnComplete(),
        ],
      },
      { events: [textBlock("子代理写入完成"), turnComplete()] },
    ]);
    const childApprovals: ApprovalRequest[] = [];
    const runner = createSubagentRunner({
      provider: childProvider,
      tools,
      systemPrompt: "父提示词",
      approve: (request) => {
        childApprovals.push(request);
        return gate.request(request);
      },
      cwd,
      artifactDir,
      sandboxMode: "full",
    });

    expect(await runner("写入 remembered.txt")).toBe("子代理写入完成");
    expect(childApprovals.map((request) => request.toolName)).toEqual(["write"]);
    expect(await readFile(path.join(cwd, "remembered.txt"), "utf8")).toBe("shared");
  });
});
