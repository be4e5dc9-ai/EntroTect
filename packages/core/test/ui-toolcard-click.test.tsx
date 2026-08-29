/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

import { useStore, openSubagentTab } from "../../app-desktop/src/renderer/store.js";
import { ToolCard } from "../../app-desktop/src/renderer/components/ToolCard.js";
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
