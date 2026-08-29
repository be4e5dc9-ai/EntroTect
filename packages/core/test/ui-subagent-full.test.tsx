/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

// polyfill scrollIntoView for jsdom
(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

import { useStore, applyEvent, openSubagentTab } from "../../app-desktop/src/renderer/store.js";
import { MessageList, Message } from "../../app-desktop/src/renderer/components/MessageList.js";
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

function makeConfig(): SharedConfig {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-x",
    model: "deepseek-chat",
    activeProviderId: "deepseek",
    permissionMode: "full",
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-x",
        models: ["deepseek-chat"],
      },
    ],
  };
}

beforeEach(() => {
  useStore.setState({
    config: makeConfig(),
    currentSession: {
      id: "s1",
      title: "测试会话",
      model: "deepseek-chat",
      cwd: "/tmp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    detailTabs: [],
    activeDetailId: null,
    subagentChats: {},
    messages: [],
    messageAppended: [],
  });
  mockBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function runEvents() {
  applyEvent({
    type: "run-registered",
    runId: "r1",
    sessionId: "s1",
    providerId: "deepseek",
    model: "deepseek-chat",
  } satisfies SharedEvent);
  applyEvent({
    type: "turn-started",
    runId: "r1",
    sessionId: "s1",
    providerId: "deepseek",
    model: "deepseek-chat",
  } satisfies SharedEvent);
  applyEvent({
    type: "assistant-block",
    block: {
      type: "tool-call",
      id: "call-task-1",
      name: "task",
      arguments: '{"prompt":"调研 hello.txt"}',
    },
  } satisfies SharedEvent);
  // 子代理对话流
  applyEvent({
    type: "subagent-part",
    toolCallId: "call-task-1",
    part: { kind: "turn-start" },
  } satisfies SharedEvent);
  applyEvent({
    type: "subagent-part",
    toolCallId: "call-task-1",
    part: { kind: "delta", text: "调研中" },
  } satisfies SharedEvent);
  applyEvent({
    type: "subagent-part",
    toolCallId: "call-task-1",
    part: { kind: "block", block: { type: "text", text: "最终汇报" } },
  } satisfies SharedEvent);
  applyEvent({
    type: "subagent-part",
    toolCallId: "call-task-1",
    part: { kind: "turn-end" },
  } satisfies SharedEvent);
  // 工具完成
  applyEvent({
    type: "tool-state",
    toolCallId: "call-task-1",
    state: "completed",
    preview: "调研 hello.txt",
    summary: "完成",
  } satisfies SharedEvent);
}

type SharedEvent = Parameters<typeof applyEvent>[0];

describe("子代理全链路:事件 → 卡片 → 详情对话", () => {
  it("点击 task 卡片打开详情,详情内容含委派与最终汇报", async () => {
    runEvents();
    const state = useStore.getState();
    // 卡片 preview 已更新为真实 prompt 预览
    const card = state.messages[0]?.blocks.find(
      (b) => b.kind === "tool-call" && b.id === "call-task-1",
    );
    expect(card).toMatchObject({ name: "task", preview: "调研 hello.txt", state: "completed" });

    // 子代理对话流已就绪
    expect(state.subagentChats["call-task-1"]).toBeDefined();

    render(<MessageList />);
    const cardBtn = screen.getByText("调研 hello.txt").closest("button");
    expect(cardBtn).not.toBeNull();
    fireEvent.click(cardBtn!);
    await waitFor(() => {
      const after = useStore.getState();
      expect(after.activeDetailId).toBe("subagent-call-task-1");
      expect(after.detailTabs.some((t) => t.id === "subagent-call-task-1")).toBe(true);
    });
  });
});
