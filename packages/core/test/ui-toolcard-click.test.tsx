/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

import { useStore, openSubagentTab } from "../../app-desktop/src/renderer/store.js";
import { ToolCard } from "../../app-desktop/src/renderer/components/ToolCard.js";
import { TodoCard } from "../../app-desktop/src/renderer/components/TodoCard.js";
import type { AppConfig, UiToolBlock } from "../../app-desktop/src/renderer/store.js";
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
    detailTabs: [],
    activeDetailId: null,
    subagentChats: {},
    messages: [],
  });
  mockBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolCard 子代理卡点击联动", () => {
  it("点击普通工具卡可展开并显示结果内容", () => {
    const block: UiToolBlock = {
      kind: "tool-call",
      id: "call-read-1",
      name: "read",
      preview: "note.txt",
      state: "completed",
      summary: "hello from note.txt",
    };

    render(<ToolCard block={block} />);
    const button = screen.getByRole("button", { name: /read/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("hello from note.txt").closest(".tool-card-body")?.classList.contains("open")).toBe(true);
  });

  it("点击 task 卡的头部调用 openDetail", () => {
    const block: UiToolBlock = {
      kind: "tool-call",
      id: "call-task-9",
      name: "task",
      preview: "task",
      state: "completed",
      args: { prompt: "调研 hello.txt" },
    };
    const onOpen = vi.fn(() => openSubagentTab(block.id));
    render(<ToolCard block={block} onOpenDetail={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /子代理|Subagent/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const state = useStore.getState();
    expect(state.detailTabs.some((t) => t.id === "subagent-call-task-9")).toBe(true);
    expect(state.activeDetailId).toBe("subagent-call-task-9");
  });
});

describe("TodoCard 任务计划板", () => {
  it("默认展示结构化进度、状态和优先级", () => {
    const block: UiToolBlock = {
      kind: "tool-call",
      id: "call-todo-1",
      name: "todowrite",
      preview: "测试网络延时",
      state: "completed",
      args: {
        todos: [
          { content: "准备测试环境", status: "completed", priority: "medium" },
          { content: "测试网络延时", status: "in_progress", priority: "high" },
          { content: "整理测试结果", status: "pending", priority: "low" },
        ],
      },
    };

    render(<TodoCard block={block} />);

    expect(screen.getByRole("region", { name: "任务进度，已完成 1 项，共 3 项" })).toBeTruthy();
    expect(screen.getByText("正在执行第 2 步")).toBeTruthy();
    expect(screen.getByText("测试网络延时")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("高优先")).toBeTruthy();
    expect(screen.getByText("整理测试结果")).toBeTruthy();
    expect(screen.getByText("低优先")).toBeTruthy();
  });
});
