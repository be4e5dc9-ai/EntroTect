/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

import { useStore, applyEvent, openSubagentTab } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig, AppEvent } from "@entrotect/shared";

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

function makeConfig(permissionMode: AppConfig["permissionMode"]): AppConfig {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-x",
    model: "deepseek-chat",
    activeProviderId: "deepseek",
    permissionMode,
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
    config: makeConfig("full"),
    detailTabs: [],
    activeDetailId: null,
    subagentChats: {},
    messages: [],
    approval: null,
  });
  mockBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("子代理卡片与详情栏联动", () => {
  it("openSubagentTab 打开对应标签并确保对话流存在", () => {
    useStore.setState({
      messages: [
        {
          key: 1,
          role: "assistant",
          streaming: false,
          reasoning: "",
          blocks: [
            {
              kind: "tool-call",
              id: "call-task-1",
              name: "task",
              preview: "task",
              state: "executing",
              args: { prompt: "diao yan hello.txt" },
            },
          ],
        },
      ],
    });
    openSubagentTab("call-task-1");
    const state = useStore.getState();
    expect(state.detailTabs.some((tab) => tab.id === "subagent-call-task-1")).toBe(true);
    expect(state.activeDetailId).toBe("subagent-call-task-1");
    expect(state.subagentChats["call-task-1"]).toBeDefined();
    expect(state.subagentChats["call-task-1"]?.[0]?.role).toBe("user");
  });

  it("full 模式下 approval-requested 事件仍会出现(说明宿主无条件上报)", () => {
    applyEvent({
      type: "approval-requested",
      request: { toolName: "write", toolCallId: "c", preview: "p", description: "d" },
    } satisfies AppEvent);
    expect(useStore.getState().approval).not.toBeNull();
  });
});
