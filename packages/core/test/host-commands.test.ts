import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { DEFAULT_CONFIG, type AppEvent, type SessionMeta } from "@entrotect/shared";
import { SessionHost } from "../../app-desktop/src/main/host.js";
import { SessionStore } from "../src/session/store.js";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => {
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
    const { send, store, meta, events } = await setup();
    await send("/goal 验证项目");
    await send("/plan");
    await Promise.all([send("/compact"), send("压缩期间发送")]);
    expect(events.some((event) => event.type === "error" && event.message.includes("运行中"))).toBe(true);
    expect(events.some((event) => event.type === "session-compacted")).toBe(true);
    expect((await store.load(meta.id)).meta.controls).toMatchObject({ mode: "plan", goal: { objective: "验证项目", status: "active" } });
  });
});
