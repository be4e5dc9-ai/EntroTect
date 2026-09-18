import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { DEFAULT_CONFIG, type AppEvent, type SessionMeta } from "@entrotect/shared";
import { SessionHost } from "../../app-desktop/src/main/host.js";
import { SessionStore } from "../src/session/store.js";
import { buildBuiltinTools } from "@entrotect/core";
import { COMPACT_TIMEOUT_MS } from "../src/compact.js";
import { useStore, applyEvent } from "../../app-desktop/src/renderer/store.js";

const originalFetch = globalThis.fetch;
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

function response(tool?: { name: string; args: object }): Response {
  const delta = tool ? { tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: "已检查" };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "entrotect-host-commands-")); dirs.push(dir);
  const events: AppEvent[] = [];
  const calls: any[] = [];
  globalThis.fetch = (async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return response(); }) as typeof fetch;
  const host = new SessionHost({ appDataDir: dir, getWindow: () => ({ webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } }) as unknown as BrowserWindow });
  await host.init();
  await host.handleOp({ kind: "SetConfig", config: { ...DEFAULT_CONFIG, providers: [], baseUrl: "https://model.test/v1", apiKey: "test", model: "test-model", permissionMode: "full", autoCompact: false, workspaceDir: dir } });
  await host.handleOp({ kind: "NewSession" });
  const meta = (events.find((event) => event.type === "session-meta") as { meta: SessionMeta }).meta;
  const store = new SessionStore(path.join(dir, "sessions"));
  const send = (text: string) => host.handleOp({ kind: "SendMessage", text });
  return { dir, host, events, calls, meta, store, send };
}

describe("SessionHost commands", () => {
  it("reports a small history as unchanged without making a summary request", async () => {
    const { send, calls, events, store, meta } = await setup();
    await send("你好");
    const before = (await store.load(meta.id)).messages;
    const requests = calls.length;
    await send("/compact");
    expect(calls).toHaveLength(requests);
    expect(events.some((event) => event.type === "session-compaction-skipped")).toBe(true);
    expect(events.some((event) => event.type === "session-compacted")).toBe(false);
    expect((await store.load(meta.id)).messages).toEqual(before);
  });

  it("manual compact passes the selected native reasoning tier and a larger output limit", async () => {
    const { host, send, calls, store, meta } = await setup();
    await host.handleOp({ kind: "SetConfig", config: { ...(host as any).config, model: "deepseek-flash", reasoningEffort: "ultra" } });
    await store.appendMessage(meta.id, { role: "assistant", content: [{ type: "text", text: "历史内容".repeat(1000) }] });
    await send("/compact");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "deepseek-flash", reasoning_effort: "max", max_tokens: 65_536 });
    expect(calls[0]).not.toHaveProperty("thinking", { type: "disabled" });
  });

  it.each(["cancel", "timeout"])("manual compaction enters busy immediately and releases a stalled request on %s", async (mode) => {
    const { host, send, store, meta, events } = await setup();
    await send("历史内容".repeat(1000));
    const before = (await store.load(meta.id)).messages;
    useStore.setState({ config: (host as any).config, currentSession: meta, messages: [], busy: false, activeRunId: null, invalidatedRunIds: [], contextEstimate: null });
    host.emit = (event) => { events.push(event); applyEvent(event); };
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    globalThis.fetch = (async () => { entered(); return await new Promise(() => {}); }) as typeof fetch;
    vi.useFakeTimers();
    const pending = send("/compact");
    // Registration happens before the first disk/network await.
    expect(useStore.getState().busy).toBe(true);
    await ready;
    expect(useStore.getState().messages.at(-1)?.compaction?.state).toBe("running");
    if (mode === "cancel") await host.handleOp({ kind: "Interrupt" });
    else await vi.advanceTimersByTimeAsync(COMPACT_TIMEOUT_MS);
    await pending;
    expect(useStore.getState().busy).toBe(false);
    expect(useStore.getState().messages.at(-1)?.compaction?.state).toBe(mode === "cancel" ? "cancelled" : "failed");
    expect((await store.load(meta.id)).messages).toEqual(before);
    vi.useRealTimers();
    globalThis.fetch = (async () => response()) as typeof fetch;
    await send("现在继续");
    expect(events.filter((event) => event.type === "error").some((event) => event.type === "error" && event.message.includes("上一轮任务仍在运行中"))).toBe(false);
    expect((await store.load(meta.id)).messages.length).toBe(before.length + 2);
  });

  it("toggles plan locally, strips its prefix, and restores executable tools on exit", async () => {
    const { send, calls, events, meta, store } = await setup();
    await send("/plan");
    expect(calls).toHaveLength(0);
    await send("/plan status");
    expect(events.at(-1)).toMatchObject({ type: "command-result", message: expect.stringContaining("当前为仅规划模式") });
    await send("/plan 设计登录流程");
    const names = calls[0].tools.map((tool: any) => tool.function.name);
    expect(names).toContain("read");
    expect(names).toContain("bash");
    expect(names).toContain("diagnostics");
    expect(names).toContain("task");
    expect(names).not.toContain("todowrite");
    expect(names).not.toContain("write");
    expect(JSON.stringify(calls[0].messages)).toContain("<plan_mode>");
    expect((await store.load(meta.id)).messages[0]?.content).toEqual([{ type: "text", text: "设计登录流程" }]);
    await send("/plan off");
    await send("实现登录流程");
    expect(calls[1].tools.map((tool: any) => tool.function.name)).toContain("write");
    expect(JSON.stringify(calls[1].messages)).not.toContain("<plan_mode>");
  });

  it("blocks a hallucinated write call even with full permission", async () => {
    const { send, calls } = await setup();
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return calls.length === 1 ? response({ name: "write", args: { file_path: "must-not-exist.txt", content: "bad" } }) : response();
    }) as typeof fetch;
    await send("/plan 调研项目");
    expect(JSON.stringify(calls[1].messages)).toContain("未知工具: write");
  });

  it("blocks a mutating shell call in Plan mode even with full permission", async () => {
    const { dir, send, calls } = await setup();
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return calls.length === 1
        ? response({ name: "bash", args: { command: "Set-Content must-not-exist.txt bad" } })
        : response();
    }) as typeof fetch;
    await send("/plan 调研项目");
    expect(JSON.stringify(calls[1].messages)).toContain("[Plan mode]");
    await expect(import("node:fs/promises").then(({ stat }) => stat(path.join(dir, "must-not-exist.txt")))).rejects.toThrow();
  });

  it("keeps goal across turns and resume, supports status/done/clear without model calls", async () => {
    const { host, send, calls, store, meta } = await setup();
    await send("/goal 修复登录错误");
    expect(calls[0].tools.map((tool: any) => tool.function.name)).toContain("update_goal");
    await send("继续验证");
    expect(JSON.stringify(calls[1].messages)).toContain("<session_goal>");
    await send("/goal status");
    await host.handleOp({ kind: "NewSession" });
    await send("你好");
    expect(JSON.stringify(calls[2].messages)).not.toContain("<session_goal>");
    await host.handleOp({ kind: "ResumeSession", sessionId: meta.id });
    await send("/goal done");
    expect((await store.load(meta.id)).meta.controls?.goal?.status).toBe("completed");
    await send("/goal clear");
    expect((await store.load(meta.id)).meta.controls?.goal).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("persists Shell directory across session switch and resume", async () => {
    const { dir, host, send, calls, store, meta } = await setup();
    const sub = path.join(dir, "sub");
    await mkdir(sub);
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) return response({ name: "bash", args: { command: "Set-Location -LiteralPath 'sub'" } });
      if (calls.length === 3) return response({ name: "bash", args: { command: "(Get-Location).Path" } });
      return response();
    }) as typeof fetch;
    await send("切到子目录");
    const first = await store.load(meta.id);
    expect(first.shellCwd, JSON.stringify(first.messages)).toBe(sub);
    await host.handleOp({ kind: "NewSession" });
    await host.handleOp({ kind: "ResumeSession", sessionId: meta.id });
    await send("当前目录是什么");
    const results = (await store.load(meta.id)).messages.flatMap((message) => message.content);
    expect(results.some((block) => block.type === "tool-result" && String(block.content).includes(sub))).toBe(true);
  });

  it("deleting a session stops and removes its background processes", async () => {
    const { host, send, calls, store, meta } = await setup();
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return calls.length === 1 ? response({ name: "bash", args: { command: "Start-Sleep -Seconds 60", background: true } }) : response();
    }) as typeof fetch;
    await send("启动后台任务");
    const owner = store.artifactDir(meta.id);
    const messages = (await store.load(meta.id)).messages;
    const id = messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool-result")?.content.match(/id: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    const output = buildBuiltinTools().find((tool) => tool.name === "bash_output")!;
    const ctx = { cwd: meta.cwd, artifactDir: owner, sandboxMode: "full" as const };
    expect(await output.call({ jobId: id }, ctx)).toContain(`任务: ${id}`);
    await host.handleOp({ kind: "DeleteSession", sessionId: meta.id });
    await expect(output.call({ jobId: id }, ctx)).rejects.toThrow("未找到后台任务");
  }, 15000);

  it("allows model to report verified completion and persists its evidence", async () => {
    const { send, calls, store, meta, events } = await setup();
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return calls.length === 1 ? response({ name: "update_goal", args: { status: "completed", summary: "所有验收测试通过" } }) : response();
    }) as typeof fetch;
    await send("/goal 验证项目");
    expect((await store.load(meta.id)).meta.controls?.goal).toMatchObject({ status: "completed", summary: "所有验收测试通过" });
    expect(events.some((event) => event.type === "session-controls" && event.controls.goal?.status === "completed")).toBe(true);
  });

  it("handles help/invalid input locally and preserves attached plan/goal input", async () => {
    const { host, send, calls, store, meta } = await setup();
    await send("/help"); await send("/compact bad"); await send("/goal set");
    await host.handleOp({ kind: "SendMessage", text: "/goal status", attachments: [{ kind: "file", path: "a.ts", name: "a.ts" }] });
    expect(calls).toHaveLength(0);
    await host.handleOp({ kind: "SendMessage", text: "/plan 审查附件", attachments: [{ kind: "file", path: "a.ts", name: "a.ts" }] });
    expect((await store.load(meta.id)).messages[0]?.content).toHaveLength(2);
  });

  it("serializes a mode update against a concurrent message", async () => {
    const { send, calls, events } = await setup();
    await Promise.all([send("/plan"), send("同时发送")]);
    expect(calls).toHaveLength(0);
    expect(events.some((event) => event.type === "error" && event.message.includes("运行中"))).toBe(true);
    await send("正常发送");
    expect(JSON.stringify(calls[0].messages)).toContain("<plan_mode>");
  });

  it("locks compaction against new messages and preserves goal/mode", async () => {
    const { host, send, store, meta, events } = await setup();
    await send("/goal 验证项目");
    await send("/plan");
    await store.appendMessage(meta.id, { role: "assistant", content: [{ type: "text", text: "已完成的工作。".repeat(1000) }] });
    await Promise.all([send("/compact"), send("压缩期间发送")]);
    expect(events.some((event) => event.type === "error" && event.message.includes("运行中"))).toBe(true);
    expect(events.some((event) => event.type === "session-compacted")).toBe(true);
    expect((await store.load(meta.id)).meta.controls).toMatchObject({ mode: "plan", goal: { objective: "验证项目", status: "active" } });
    const lifecycle = events.filter((event) => event.type === "session-compacting" || event.type === "session-compacted");
    expect(lifecycle.map((event) => event.type)).toEqual(["session-compacting", "session-compacted"]);
    const completed = lifecycle[1] as Extract<AppEvent, { type: "session-compacted" }>;
    expect(lifecycle[0]).toMatchObject({ sessionId: meta.id, id: completed.marker.id });
    expect((await store.load(meta.id)).messages[0]?.compaction).toEqual(completed.marker);
    await send("压缩后继续");
    await host.handleOp({ kind: "NewSession" });
    events.length = 0;
    await host.handleOp({ kind: "ResumeSession", sessionId: meta.id });
    const replay = events.filter((event) => event.type === "message-appended" || event.type === "session-compacted");
    expect(replay.filter((event) => event.type === "session-compacted")).toHaveLength(1);
    const markerIndex = replay.findIndex((event) => event.type === "session-compacted");
    expect(markerIndex).toBe(completed.marker.retainedMessages);
    expect(replay[markerIndex + 1]).toMatchObject({ type: "message-appended", message: { content: [{ type: "text", text: "压缩后继续" }] } });
    expect(JSON.stringify(replay)).not.toContain("【对话压缩摘要】");
  });

  it("publishes the same compaction lifecycle for automatic compaction", async () => {
    const { host, send, store, meta, dir, events, calls } = await setup();
    for (let i = 0; i < 8; i++) await store.appendMessage(meta.id, { role: "user", content: [{ type: "text", text: "x".repeat(35_000) }] });
    await host.handleOp({ kind: "SetConfig", config: { ...DEFAULT_CONFIG, providers: [], baseUrl: "https://model.test/v1", apiKey: "test", model: "deepseek-flash", reasoningEffort: "low", permissionMode: "full", autoCompact: true, autoCompactRatio: 0.1, workspaceDir: dir } });
    await send("继续");
    expect(events.filter((event) => event.type.startsWith("session-compact")).map((event) => event.type)).toEqual(["session-compacting", "session-compacted"]);
    expect((await store.load(meta.id)).messages[0]?.compaction).toBeDefined();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: "deepseek-flash", reasoning_effort: "low" });
    expect(calls[0].max_tokens).toBeGreaterThanOrEqual(8_192);
    expect(JSON.stringify(calls[1].messages)).not.toContain("retainedMessages");
  });

  it.each([false, true])("clears compression progress on failure/cancellation and keeps history (cancel: %s)", async (cancel) => {
    const { host, send, store, meta, events } = await setup();
    await send("准备历史".repeat(1000));
    const before = (await store.load(meta.id)).messages;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async () => {
      started();
      await held;
      return cancel ? response() : new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const pending = send("/compact");
    await ready;
    if (cancel) await host.handleOp({ kind: "Interrupt" });
    release();
    await pending;
    expect(events.filter((event) => event.type.startsWith("session-compact")).map((event) => event.type)).toEqual(["session-compacting", "session-compaction-failed"]);
    expect(events.find((event) => event.type === "session-compaction-failed")).toMatchObject({ sessionId: meta.id, cancelled: cancel });
    expect((await store.load(meta.id)).messages).toEqual(before);
  });
});
