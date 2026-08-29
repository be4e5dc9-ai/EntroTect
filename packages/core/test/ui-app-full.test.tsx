/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

import { App } from "../../app-desktop/src/renderer/App.js";
import { useStore, applyEvent } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig as SharedConfig } from "@entrotect/shared";

function mockBridge() {
  const send = vi.fn();
  window.entrotect = {
    send,
    onEvent: vi.fn((handler: (event: unknown) => void) => {
      // 真实预加载桥:事件直达 applyEvent
      mockEvents.push(handler);
      return () => {};
    }),
    chooseFolder: vi.fn(async () => null),
    setTheme: vi.fn(),
    setAccentColor: vi.fn(),
    listSkills: vi.fn(async () => []),
  };
  return { send };
}

const mockEvents: Array<(event: unknown) => void> = [];

function feed(event: unknown) {
  act(() => {
    for (const handler of mockEvents) handler(event);
  });
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
  localStorage.clear();
  mockEvents.length = 0;
  useStore.setState({
    config: makeConfig(),
    currentSession: {
      id: "s1",
      title: "会话",
      model: "deepseek-chat",
      cwd: "/tmp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    subagentChats: {},
    detailTabs: [],
    activeDetailId: null,
  });
  mockBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App 首条消息与子代理点击", () => {
  it("首条用户消息渲染 You 标签与文本", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/早上好|中午好|下午好|晚上好|夜深了/)).toBeDefined());
    feed({
      type: "message-appended",
      message: { role: "user", content: [{ type: "text", text: "帮我调研" }] },
    });
    await waitFor(() => expect(screen.getByText("You")).toBeDefined());
    expect(screen.getByText("帮我调研")).toBeDefined();
  });

  it("空态显示用量概览与统计卡", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/早上好|中午好|下午好|晚上好|夜深了/)).toBeDefined());
    feed({
      type: "usage-stats",
      stats: {
        sessions: 14,
        messages: 5203,
        totalTokens: 15_000_000,
        activeDays: 12,
        currentStreak: 0,
        longestStreak: 3,
        peakHour: 17,
        favoriteModel: "deepseek-chat",
        daily: [],
      },
    });
    await waitFor(() => expect(screen.getByText("用量概览")).toBeDefined());
    expect(screen.getAllByText("会话").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("14")).toBeDefined();
    expect(screen.getByText("15M")).toBeDefined();
    expect(screen.getByText("常用模型")).toBeDefined();
    expect(screen.getAllByText("deepseek-chat").length).toBeGreaterThanOrEqual(1);
  });

  it("折叠详情栏后点击子代理卡自动展开并显示面板", async () => {
    localStorage.setItem("entrotect-detail-collapsed", "1");
    render(<App />);
    // 模拟既有会话重放:assistant 带 task 工具块
    feed({
      type: "session-meta",
      meta: { id: "s1", title: "会话", model: "deepseek-chat", cwd: "/tmp", createdAt: "x", updatedAt: "x" },
    });
    feed({
      type: "message-appended",
      message: {
        role: "assistant",
        content: [
          { type: "tool-call", id: "ct1", name: "task", arguments: JSON.stringify({ prompt: "调研 hello.txt" }) },
        ],
      },
    });
    // 子代理最终答复回填
    feed({
      type: "message-appended",
      message: {
        role: "user",
        content: [{ type: "tool-result", toolCallId: "ct1", name: "task", isError: false, content: "完成" }],
      },
    });

    // 点击 task 卡头部
    const card = screen.getByText("调研 hello.txt").closest("button");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    await waitFor(() => {
      const state = useStore.getState();
      expect(state.activeDetailId).toBe("subagent-ct1");
    });
    // 详情面板出现(子代理头部与委派)
    await waitFor(() => {
      expect(screen.getAllByText("子代理").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/主代理委派/)).toBeDefined();
    });
  });

  it("折叠详情栏后不再被自动弹回;再次关闭标签栏收起面板", async () => {
    localStorage.setItem("entrotect-detail-collapsed", "1");
    render(<App />);
    await waitFor(() => expect(screen.getByText(/早上好|中午好|下午好|晚上好|夜深了/)).toBeDefined());
    feed({
      type: "session-meta",
      meta: { id: "s1", title: "会话", model: "deepseek-chat", cwd: "/tmp", createdAt: "x", updatedAt: "x" },
    });
    feed({
      type: "message-appended",
      message: {
        role: "assistant",
        content: [
          { type: "tool-call", id: "ct1", name: "task", arguments: JSON.stringify({ prompt: "调研 hello.txt" }) },
        ],
      },
    });
    feed({
      type: "message-appended",
      message: {
        role: "user",
        content: [{ type: "tool-result", toolCallId: "ct1", name: "task", isError: false, content: "完成" }],
      },
    });
    // 首次激活 → 自动展开(点击任务卡打开子代理标签)
    fireEvent.click(screen.getByText("调研 hello.txt").closest("button")!);
    await waitFor(() => expect(screen.getByLabelText("Collapse details")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Collapse details"));
    // 面板收起:右栏折叠按钮消失,消息流卡片仍在
    await waitFor(() => expect(screen.queryByLabelText("Collapse details")).toBeNull());
    expect(screen.getByText("调研 hello.txt")).toBeDefined();
    // 等待一会儿确保没有回弹(手动折叠后不应被自动展开)
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByLabelText("Collapse details")).toBeNull();
    // 点击幽灵按钮重新展开
    fireEvent.click(screen.getByLabelText("Open details"));
    // 关闭当前标签 → activeDetailId 应变为 null → 面板隐藏
    await waitFor(() => expect(screen.getByLabelText("Collapse details")).toBeDefined());
    fireEvent.click(screen.getByLabelText("关闭当前页"));
    await waitFor(() => {
      expect(useStore.getState().activeDetailId).toBeNull();
      expect(useStore.getState().detailTabs.length).toBe(0);
    });
    expect(screen.queryByLabelText("Collapse details")).toBeNull();
  });
});
