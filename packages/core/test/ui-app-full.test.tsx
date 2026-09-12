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
  it("Todo 显示在输入框上方的独立计划区，不混入对话流", async () => {
    render(<App />);
    feed({
      type: "message-appended",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "todo-1",
            name: "todowrite",
            arguments: JSON.stringify({
              todos: [
                { content: "重构计划展示", status: "in_progress", priority: "high" },
                { content: "验证对话流", status: "pending", priority: "medium" },
              ],
            }),
          },
        ],
      },
    });
    feed({
      type: "message-appended",
      message: {
        role: "user",
        content: [
          { type: "tool-result", toolCallId: "todo-1", name: "todowrite", isError: false, content: "ok" },
        ],
      },
    });

    const dock = await screen.findByRole("complementary", { name: "当前任务计划" });
    expect(dock.textContent).toContain("重构计划展示");
    expect(document.querySelector(".message-list")?.textContent).not.toContain("重构计划展示");
    const composer = document.querySelector(".composer");
    expect(dock.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

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
        all: {
          sessions: 14,
          messages: 5203,
          totalTokens: 15_000_000,
          activeDays: 12,
          currentStreak: 0,
          longestStreak: 3,
          peakHour: 17,
          favoriteModel: "deepseek-chat",
        },
        d30: {
          sessions: 5,
          messages: 100,
          totalTokens: 500_000,
          activeDays: 4,
          currentStreak: 0,
          longestStreak: 2,
          peakHour: 17,
          favoriteModel: "deepseek-chat",
        },
        d7: {
          sessions: 2,
          messages: 30,
          totalTokens: 50_000,
          activeDays: 2,
          currentStreak: 0,
          longestStreak: 1,
          peakHour: 17,
          favoriteModel: "deepseek-chat",
        },
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

  it("空会话也有常驻详情栏开关，切换时保持同一个按钮", async () => {
    render(<App />);
    const toggle = screen.getByLabelText("展开详情栏");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".detail-panel")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("收起详情栏")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("在这里查看文件与子代理")).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("展开详情栏")).toBe(toggle);
    expect(document.querySelector(".detail-panel")).toBeNull();
    expect(localStorage.getItem("entrotect-detail-collapsed")).toBe("1");
  });

  it("折叠详情栏后不回弹，关闭最后一个标签仍保留面板和开关", async () => {
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
    await waitFor(() => expect(screen.getByLabelText("收起详情栏")).toBeDefined());
    const toggle = screen.getByLabelText("收起详情栏");
    fireEvent.click(toggle);
    // 面板收起，常驻按钮原位切换为展开，消息流卡片仍在。
    await waitFor(() => expect(screen.getByLabelText("展开详情栏")).toBe(toggle));
    expect(screen.getByText("调研 hello.txt")).toBeDefined();
    // 等待一会儿确保没有回弹(手动折叠后不应被自动展开)
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".detail-panel")).toBeNull();
    fireEvent.click(toggle);
    // 关闭当前标签 → activeDetailId 变为 null → 展示空态而非消失。
    await waitFor(() => expect(screen.getByLabelText("收起详情栏")).toBe(toggle));
    fireEvent.click(screen.getByLabelText("关闭当前页"));
    await waitFor(() => {
      expect(useStore.getState().activeDetailId).toBeNull();
      expect(useStore.getState().detailTabs.length).toBe(0);
    });
    expect(screen.getByLabelText("收起详情栏")).toBe(toggle);
    expect(screen.getByText("在这里查看文件与子代理")).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("展开详情栏")).toBe(toggle);
  });
});
