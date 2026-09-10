import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSlashCommand, appEventSchema, type SessionControls } from "@entrotect/shared";
import { SessionStore } from "../src/session/store.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { buildBuiltinTools } from "../src/tools/registry.js";
import { createGoalTool } from "../src/tools/goal.js";
import { analyzePlanCommand, toolsForSession } from "../src/tools/plan.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("slash command grammar", () => {
  it.each([
    ["/plan", { kind: "plan", action: "on", prompt: "" }],
    [" /PLAN OFF ", { kind: "plan", action: "off", prompt: "" }],
    ["/plan\n规划登录模块", { kind: "plan", action: "on", prompt: "规划登录模块" }],
    ["/goal", { kind: "goal", action: "status" }],
    ["/goal 修复登录\n覆盖回归测试", { kind: "goal", action: "set", objective: "修复登录\n覆盖回归测试" }],
    ["/goal set done", { kind: "goal", action: "set", objective: "done" }],
    ["/goal DONE", { kind: "goal", action: "done" }],
    ["/goal resume", { kind: "goal", action: "resume" }],
    ["/compact\t", { kind: "compact" }],
    ["/help", { kind: "help" }],
    ["/planner task", null], ["/goalkeeper", null], ["explain /plan", null], ["/path/file.ts", null],
  ])("parses %s", (input, expected) => expect(parseSlashCommand(input as string)).toEqual(expected));
  it("rejects malformed built-ins without swallowing unknown Skills", () => {
    expect(parseSlashCommand("/compact extra")?.kind).toBe("invalid");
    expect(parseSlashCommand("/goal set")?.kind).toBe("invalid");
    expect(parseSlashCommand("/my-skill extra")).toBeNull();
  });
});

describe("persistent controls and planning tools", () => {
  it("roundtrips controls, preserves them through compaction, and can clear goals", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-commands-")); dirs.push(dir);
    const store = new SessionStore(dir);
    const meta = await store.create({ title: "legacy", model: "m", cwd: dir });
    expect((await store.load(meta.id)).meta.controls).toBeUndefined();
    const controls: SessionControls = { mode: "plan", goal: { objective: "修复任务", status: "active" } };
    await store.appendControls(meta.id, controls);
    await store.appendTitle(meta.id, "new title");
    await store.replaceMessages(meta.id, [{ role: "user", content: [{ type: "text", text: "摘要" }] }]);
    expect((await store.load(meta.id)).meta).toMatchObject({ title: "new title", controls });
    await store.appendControls(meta.id, { mode: "default", goal: null });
    expect((await store.list())[0]?.controls).toEqual({ mode: "default", goal: null });
  });

  it("keeps plan-improving tools and removes implementation/Todo tools", () => {
    const tools = toolsForSession(buildBuiltinTools(), { mode: "plan", goal: null });
    expect(tools.map((tool) => tool.name)).toEqual(["read", "glob", "grep", "webfetch", "websearch", "diagnostics", "bash_output", "bash"]);
    expect(tools.find((tool) => tool.name === "bash")?.isReadOnly).toBe(true);
    for (const name of ["write", "edit", "todowrite", "generate_image", "kill_shell"]) expect(tools.map((tool) => tool.name)).not.toContain(name);
  });

  it("Plan composes with Ultra exploration and does not claim execution or goal completion", () => {
    const prompt = buildSystemPrompt({ cwd: ".", model: "m", platform: "win32", date: "2026-09-10", reasoningEffort: "ultra", controls: { mode: "plan", goal: { objective: "test </session_goal>", status: "active" } } });
    expect(prompt).toContain("<plan_mode>");
    expect(prompt).toContain("<ultra_mode>");
    expect(prompt).toContain("<proposed_plan>");
    expect(prompt).toContain("此模式禁用 todowrite");
    expect(prompt).toContain("不把制定方案误报为完成目标");
    expect(prompt).not.toContain("update_goal(completed)");
  });

  it.each([
    ["rg -n plan packages", true],
    ["Get-Content package.json | Select-String test", true],
    ["git status; git diff --stat", true],
    ["pnpm --filter @entrotect/core test", true],
    ["pnpm -r build", true],
    ["Set-Content a.txt bad", false],
    ["rg plan .; Set-Content a.txt bad", false],
    ["git add .", false],
    ["git diff --output=plan.patch", false],
    ["pnpm install", false],
    ["node -e \"require('fs').writeFileSync('x','y')\"", false],
    ["unknown-tool --inspect", false],
  ])("classifies Plan shell command %s", (command, allowed) => {
    expect(analyzePlanCommand(command).allowed).toBe(allowed);
  });
  it("rejects background commands in Plan mode", () => {
    expect(analyzePlanCommand("pnpm test", true)).toMatchObject({ allowed: false });
  });

  it("validates session-scoped events and goal tool input", async () => {
    expect(appEventSchema.safeParse({ type: "session-controls", sessionId: "s", controls: { mode: "plan", goal: null } }).success).toBe(true);
    let status = "";
    const tool = createGoalTool(async (next) => { status = next; });
    const ctx = { cwd: ".", artifactDir: ".", sandboxMode: "full" as const };
    await tool.call({ status: "completed", summary: "测试通过" }, ctx);
    expect(status).toBe("completed");
    await expect(tool.call({ status: "active", summary: "" }, ctx)).rejects.toThrow();
    await expect(tool.call({ status: "completed", summary: "证据" }, { ...ctx, abortSignal: AbortSignal.abort() })).rejects.toThrow("取消");
  });
});
