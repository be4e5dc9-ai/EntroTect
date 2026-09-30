import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { AppEvent, SessionMeta } from "@entrotect/shared";
import { DEFAULT_CONFIG } from "@entrotect/shared";
import { SessionHost } from "../../app-desktop/src/main/host.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("browser host approvals", () => {
  it("queues concrete webpage approvals, remembers origin-scoped grants and rejects stale sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "entrotect-browser-host-")); roots.push(root);
    const events: AppEvent[] = [];
    const host = new SessionHost({ appDataDir: root, getWindow: () => ({ webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } }) as unknown as BrowserWindow });
    await host.init();
    await host.handleOp({ kind: "SetConfig", config: { ...DEFAULT_CONFIG, providers: [], baseUrl: "https://model.test/v1", apiKey: "test", model: "test-model", autoCompact: false, permissionMode: "write", workspaceDir: root } });
    await host.handleOp({ kind: "NewSession" });
    const meta = (events.find((event) => event.type === "session-meta") as { meta: SessionMeta }).meta;
    const first = host.authorizeBrowser({ sessionId: meta.id, action: "browser.navigate", url: "https://example.com/first" });
    const second = host.authorizeBrowser({ sessionId: meta.id, action: "browser.navigate", url: "https://different.example/second" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approvals = () => events.filter((event): event is Extract<AppEvent, { type: "approval-requested" }> => event.type === "approval-requested");
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]!.request.targets).toEqual([{ action: "browser.navigate", resource: "https://example.com/first" }]);
    await host.handleOp({ kind: "ApprovalDecision", toolCallId: approvals()[0]!.request.toolCallId, decision: "allow-always" });
    expect(await first).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approvals()).toHaveLength(2);
    await host.handleOp({ kind: "ApprovalDecision", toolCallId: approvals()[1]!.request.toolCallId, decision: "deny" });
    expect(await second).toBe(false);
    expect(await host.authorizeBrowser({ sessionId: meta.id, action: "browser.navigate", url: "https://example.com/other" })).toBe(true);
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await host.handleOp({ kind: "SendMessage", text: "Continue in this session" });
    expect(await host.authorizeBrowser({ sessionId: meta.id, action: "browser.navigate", url: "https://example.com/next-turn" })).toBe(true);
    expect(approvals()).toHaveLength(2);
    const abandoned = host.authorizeBrowser({ sessionId: meta.id, action: "browser.navigate", url: "https://next.example/" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.handleOp({ kind: "NewSession" });
    expect(await abandoned).toBe(false);
    expect(() => host.requireActiveSession(meta.id)).toThrow("会话已切换");
    expect(await host.authorizeBrowser({ sessionId: meta.id, action: "browser.read", url: "https://example.com/" })).toBe(false);
  });
});
