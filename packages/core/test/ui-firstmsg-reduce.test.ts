/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

import { useStore, applyEvent } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig as SharedConfig } from "@entrotect/shared";

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
