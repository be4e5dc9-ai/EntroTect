/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

import { useStore, applyEvent, openFileTab } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig as SharedConfig, SessionMeta } from "@entrotect/shared";

function mockBridge() {
  window.entrotect = {
    send: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    chooseFolder: vi.fn(async () => null),
    setTheme: vi.fn(),
    setAccentColor: vi.fn(),
    listSkills: vi.fn(async () => []),
  };
}

beforeEach(() => {
  useStore.setState({
    config: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-x",
      model: "deepseek-chat",
      activeProviderId: "deepseek",
      permissionMode: "full",
      providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x", models: [] }],
    } as SharedConfig,
    currentSession: { id: "s1", title: "t", model: "deepseek-chat", cwd: "/tmp", createdAt: Date.now(), updatedAt: Date.now() },
    messages: [],
    busy: false,
  });
  mockBridge();
});

afterEach(() => vi.restoreAllMocks());

describe("首条用户消息归约", () => {
  it("message-appended(user 文本) 追加 messages", () => {
    applyEvent({
      type: "message-appended",
      message: { role: "user", content: [{ type: "text", text: "帮我调研" }] },
    } as unknown as Parameters<typeof applyEvent>[0]);
    const msgs = useStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.blocks).toEqual([{ kind: "text", text: "帮我调研" }]);
  });
});

const meta = (id: string, title = "t"): SessionMeta => ({
  id,
  title,
  model: "deepseek-chat",
  cwd: "/tmp",
  createdAt: "2026-08-30T00:00:00.000Z",
});

describe("session-meta 与首条消息(P1-1)", () => {
  it("同 id 的 session-meta(新标题)不清空首条消息", () => {
    applyEvent({
      type: "message-appended",
      message: { role: "user", content: [{ type: "text", text: "帮我调研" }] },
    } as unknown as Parameters<typeof applyEvent>[0]);
    applyEvent({ type: "session-meta", meta: meta("s1", "新标题") });
    const msgs = useStore.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.blocks).toEqual([{ kind: "text", text: "帮我调研" }]);
    expect(useStore.getState().currentSession?.title).toBe("新标题");
  });

  it("不同 id 的 session-meta 清空消息与详情标签", () => {
    useStore.setState({
      detailTabs: [{ id: "file-x", kind: "file", path: "x" }],
      activeDetailId: "file-x",
    });
    applyEvent({ type: "session-meta", meta: meta("s2") });
    expect(useStore.getState().messages).toEqual([]);
    expect(useStore.getState().detailTabs).toEqual([]);
    expect(useStore.getState().activeDetailId).toBeNull();
  });

  it("sessions-listed 当前会话被删 → 全清(P3-3e)", () => {
    useStore.setState({
      messages: [
        { key: 1, role: "user", blocks: [{ kind: "text", text: "x" }], streaming: false, reasoning: "" },
      ],
      detailTabs: [{ id: "file-x", kind: "file", path: "x" }],
      activeDetailId: "file-x",
      fileContents: { x: "content" },
      subagentChats: { task1: [{ key: 2, role: "user", blocks: [], streaming: false, reasoning: "" }] },
    });
    applyEvent({ type: "sessions-listed", sessions: [] });
    const s = useStore.getState();
    expect(s.messages).toEqual([]);
    expect(s.detailTabs).toEqual([]);
    expect(s.fileContents).toEqual({});
    expect(s.subagentChats).toEqual({});
    expect(s.currentSession).toBeNull();
  });
});

describe("file-content 缓存(P3-3f)", () => {
  it("读取失败不缓存 null,再次 openFileTab 重新发 ReadFile", () => {
    openFileTab("missing.txt");
    expect(window.entrotect!.send).toHaveBeenCalledWith({ kind: "ReadFile", path: "missing.txt" });

    applyEvent({
      type: "file-content",
      path: "missing.txt",
      content: null,
      error: "文件不存在",
    });
    expect(useStore.getState().fileContents["missing.txt"]).toBeUndefined();

    openFileTab("missing.txt");
    expect(window.entrotect!.send).toHaveBeenCalledTimes(2);
  });
});
