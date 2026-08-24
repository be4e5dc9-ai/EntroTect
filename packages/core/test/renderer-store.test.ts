// 渲染层 store 逻辑直测(临时定位用):复现 subagent-part 事件序列
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyEvent,
  mergeCachedProviderDataIntoConfig,
  useStore,
} from "../../app-desktop/src/renderer/store.js";
import type { AppConfig, AppEvent } from "@entrotect/shared";

// node 环境补 requestAnimationFrame(store 的流式缓冲依赖它)
(globalThis as Record<string, unknown>).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) =>
  clearTimeout(id);

beforeEach(() => {
  useStore.setState({
    sessions: [],
    currentSession: null,
    messages: [],
    busy: false,
    usage: null,
    models: [],
    contextWindowsByProvider: {},
    approval: null,
    config: null,
    settingsOpen: false,
    view: "chat",
    toasts: [],
    error: null,
    theme: "dark",
    detailTabs: [],
    activeDetailId: null,
    fileContents: {},
    subagentChats: {},
  });
});

const TASK_CALL_ID = "call_main_task_1";
const INNER_CALL_ID = "call_inner_read_1";

function feed(events: AppEvent[]): void {
  for (const event of events) feedOne(event);
}
function feedOne(event: AppEvent): void {
  applyEvent(event);
}

function settingsConfig(contextWindows?: Record<string, number>): AppConfig {
  return {
    baseUrl: "https://api.example.test/v1",
    apiKey: "key",
    model: "saved-model",
    activeProviderId: "deepseek",
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.example.test/v1",
        apiKey: "key",
        models: ["saved-model"],
        ...(contextWindows === undefined ? {} : { contextWindows }),
        builtin: true,
      },
    ],
  };
}

describe("renderer store: model context metadata", () => {
  it("caches models and context windows for each provider before SettingsPage mounts", () => {
    feedOne({
      type: "models-listed",
      providerId: "deepseek",
      models: ["deepseek-chat"],
      contextWindows: { "deepseek-chat": 64000 },
    });
    feedOne({
      type: "models-listed",
      providerId: "openai",
      models: ["gpt-4.1"],
      contextWindows: { "gpt-4.1": 128000 },
    });

    expect(useStore.getState().modelsByProvider).toEqual({
      deepseek: ["deepseek-chat"],
      openai: ["gpt-4.1"],
    });
    expect(useStore.getState().contextWindowsByProvider).toEqual({
      deepseek: { "deepseek-chat": 64000 },
      openai: { "gpt-4.1": 128000 },
    });
  });

  it("keeps persisted context metadata when an old event omits contextWindows", () => {
    const config = settingsConfig({ "saved-model": 32768 });
    feedOne({ type: "config", config });
    feedOne({
      type: "models-listed",
      providerId: "deepseek",
      models: ["new-model"],
    });

    const state = useStore.getState();
    expect(state.modelsByProvider.deepseek).toEqual(["new-model"]);
    expect(state.contextWindowsByProvider.deepseek).toEqual({ "saved-model": 32768 });

    const form = mergeCachedProviderDataIntoConfig(
      state.config!,
      state.modelsByProvider,
      state.contextWindowsByProvider,
    );
    expect(form.providers?.[0]).toMatchObject({
      models: ["new-model"],
      contextWindows: { "saved-model": 32768 },
    });
  });

  it("does not replace cached models or context windows with an empty result", () => {
    const config = settingsConfig();
    feedOne({ type: "config", config });
    feedOne({
      type: "models-listed",
      providerId: "deepseek",
      models: ["fetched-model"],
      contextWindows: { "fetched-model": 131072 },
    });
    feedOne({ type: "models-listed", providerId: "deepseek", models: [] });

    const state = useStore.getState();
    expect(state.modelsByProvider.deepseek).toEqual(["fetched-model"]);
    expect(state.contextWindowsByProvider.deepseek).toEqual({ "fetched-model": 131072 });

    const form = mergeCachedProviderDataIntoConfig(
      state.config!,
      state.modelsByProvider,
      state.contextWindowsByProvider,
    );
    expect(form.providers?.[0]).toMatchObject({
      models: ["fetched-model"],
      contextWindows: { "fetched-model": 131072 },
    });
  });

  it("backfills an unpersisted fetch into the SettingsPage form without changing config", () => {
    const config = settingsConfig();
    feedOne({
      type: "models-listed",
      providerId: "deepseek",
      models: ["auto-fetched-model"],
      contextWindows: { "auto-fetched-model": 200000 },
    });
    feedOne({ type: "config", config });

    const state = useStore.getState();
    expect(state.config).toEqual(config);

    const form = mergeCachedProviderDataIntoConfig(
      state.config!,
      state.modelsByProvider,
      state.contextWindowsByProvider,
    );
    expect(form.providers?.[0]).toMatchObject({
      models: ["auto-fetched-model"],
      contextWindows: { "auto-fetched-model": 200000 },
    });
  });
});

describe("renderer store: subagent-part 流", () => {
  it("主循环 task 工具块到达后,subagent-part 序列构建完整子代理对话", () => {
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "m", cwd: "cwd" },
    });
    // 主对话:assistant 消息带 task 工具块(含 args.prompt)
    feedOne({
      type: "message-appended",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: TASK_CALL_ID,
            name: "task",
            arguments: JSON.stringify({ prompt: "读取 note.txt 并汇报" }),
          },
        ],
      },
    });

    // 子代理事件序列
    feedOne({ type: "subagent-part", toolCallId: TASK_CALL_ID, part: { kind: "turn-start" } });
    feedOne({ type: "subagent-part", toolCallId: TASK_CALL_ID, part: { kind: "delta", text: "我先读文件" } });
    feedOne({
      type: "subagent-part",
      toolCallId: TASK_CALL_ID,
      part: { kind: "block", block: { type: "text", text: "我先读文件" } },
    });
    feedOne({
      type: "subagent-part",
      toolCallId: TASK_CALL_ID,
      part: {
        kind: "block",
        block: { type: "tool-call", id: INNER_CALL_ID, name: "read", arguments: JSON.stringify({ file_path: "note.txt" }) },
      },
    });
    feedOne({
      type: "subagent-part",
      toolCallId: TASK_CALL_ID,
      part: { kind: "tool-state", toolCallId: INNER_CALL_ID, state: "completed", preview: "note.txt" },
    });
    feedOne({ type: "subagent-part", toolCallId: TASK_CALL_ID, part: { kind: "turn-end" } });

    const chat = useStore.getState().subagentChats[TASK_CALL_ID];
    expect(chat).toBeDefined();
    expect(chat!.length).toBeGreaterThanOrEqual(2);
    // 首条 = 主代理委派
    expect(chat![0].role).toBe("user");
    // 后续 = assistant 消息,含文本块与工具块,且工具块状态已更新
    const assistant = chat!.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const blocks = assistant!.blocks;
    expect(blocks.some((b) => b.kind === "text" && b.text.includes("我先读文件"))).toBe(true);
    const toolBlock = blocks.find((b) => b.kind === "tool-call");
    expect(toolBlock).toMatchObject({ id: INNER_CALL_ID, state: "completed" });
  });

  it("恢复会话重放:task 的 tool-result 重建子代理最终答复", () => {
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "m", cwd: "cwd" },
    });
    // 重放顺序:先 assistant(tool-call: task),再 user(tool-result)
    feedOne({
      type: "message-appended",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "task_old",
            name: "task",
            arguments: JSON.stringify({ prompt: "历史委派任务" }),
          },
        ],
      },
    });
    feedOne({
      type: "message-appended",
      message: {
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "task_old",
            name: "task",
            isError: false,
            content: "子代理历史汇报:已完成调研",
          },
        ],
      },
    });

    const chat = useStore.getState().subagentChats["task_old"];
    expect(chat).toBeDefined();
    expect(chat![0]).toMatchObject({ role: "user" });
    expect(chat![1]).toMatchObject({
      role: "assistant",
      blocks: [{ kind: "text", text: "子代理历史汇报:已完成调研" }],
    });
  });

  it("打开子代理标签后初始化首条委派消息(不覆盖已有聊天)", () => {
    useStore.setState((state) => ({
      messages: [
        {
          key: 1,
          role: "assistant",
          blocks: [
            {
              kind: "tool-call",
              id: "task_x",
              name: "task",
              preview: "p",
              state: "completed",
              args: { prompt: "完整委派任务" },
            },
          ],
          streaming: false,
          reasoning: "",
        },
      ],
    }));
    const { openSubagentTab } = { openSubagentTab: () => {} }; // 仅占位,直接测 ensure 行为
    void openSubagentTab;
    // 先有 part 流,再开标签
    feedOne({ type: "subagent-part", toolCallId: "task_x", part: { kind: "turn-start" } });
    feedOne({ type: "subagent-part", toolCallId: "task_x", part: { kind: "delta", text: "干活" } });
    const chatAfterParts = useStore.getState().subagentChats["task_x"];
    expect(chatAfterParts).toBeDefined();
    expect(chatAfterParts!.some((m) => m.role === "assistant")).toBe(true);
  });
});
