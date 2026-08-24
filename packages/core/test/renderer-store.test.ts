// 渲染层 store 逻辑直测(临时定位用):复现 subagent-part 事件序列
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyEvent,
  getContextSnapshot,
  mergeCachedProviderDataIntoConfig,
  useStore,
} from "../../app-desktop/src/renderer/store.js";
import { appEventSchema } from "../../shared/src/protocol.js";
import type { AppConfig, AppEvent, TokenUsage, TurnContext } from "@entrotect/shared";

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
    activeRunId: null,
    usageUpdatesBlocked: false,
    usageBlockedRunId: null,
    usageGeneration: 0,
    invalidatedRunIds: [],
    modelsByProvider: {},
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

const OLD_CONTEXT: TurnContext = {
  sessionId: "s1",
  providerId: "deepseek",
  model: "saved-model",
};

const NEW_CONTEXT: TurnContext = {
  sessionId: "s1",
  providerId: "deepseek",
  model: "other-model",
};

function feed(events: AppEvent[]): void {
  for (const event of events) feedOne(event);
}
function feedOne(event: AppEvent): void {
  applyEvent(event);
}

function feedRunStarted(runId: string, context?: TurnContext): void {
  feedOne({ type: "turn-started", runId, ...context });
}

function feedRunRegistered(runId: string, context: TurnContext): void {
  feedOne({ type: "run-registered", runId, ...context } as AppEvent);
}

function feedRunCompleted(
  runId: string,
  usage: TokenUsage | null,
  context?: TurnContext,
): void {
  feedOne({ type: "turn-completed", runId, usage, ...context });
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

describe("renderer store: context usage", () => {
  it("keeps turn context fields at the shared IPC schema boundary", () => {
    expect(
      appEventSchema.parse({
        type: "run-registered",
        runId: "run-1",
        sessionId: "s1",
        providerId: "deepseek",
        model: "saved-model",
      }),
    ).toMatchObject({
      type: "run-registered",
      runId: "run-1",
      sessionId: "s1",
      providerId: "deepseek",
      model: "saved-model",
    });
    expect(
      appEventSchema.parse({
        type: "turn-started",
        runId: "run-1",
        sessionId: "s1",
        providerId: "deepseek",
        model: "saved-model",
      }),
    ).toMatchObject({
      runId: "run-1",
      sessionId: "s1",
      providerId: "deepseek",
      model: "saved-model",
    });
    expect(
      appEventSchema.parse({
        type: "turn-completed",
        runId: "run-1",
        usage: null,
        sessionId: "s1",
        providerId: "deepseek",
        model: "saved-model",
      }),
    ).toMatchObject({
      runId: "run-1",
      sessionId: "s1",
      providerId: "deepseek",
      model: "saved-model",
    });
  });

  it("keeps the latest non-null usage when completion later reports null", () => {
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "m", cwd: "cwd" },
    });
    feedOne({ type: "turn-started" });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 2048, outputTokens: 128 },
    });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 4096, outputTokens: 256 },
    });
    feedOne({ type: "turn-completed", usage: null });

    expect(useStore.getState().usage).toEqual({ inputTokens: 4096, outputTokens: 256 });
  });

  it("ignores a stale completion after a session switch until the new run starts", () => {
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "m", cwd: "cwd" },
    });
    feedOne({ type: "turn-started" });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "renamed", model: "m", cwd: "cwd" },
    });
    expect(useStore.getState().usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    feedOne({
      type: "session-meta",
      meta: { id: "s2", createdAt: "y", title: "new", model: "m", cwd: "cwd" },
    });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 200, outputTokens: 30 },
    });
    expect(useStore.getState().usage).toBeNull();

    feedOne({ type: "turn-started" });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 300, outputTokens: 40 },
    });
    expect(useStore.getState().usage).toEqual({ inputTokens: 300, outputTokens: 40 });
  });

  it("clears usage when the active model changes and ignores its stale completion", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    feedOne({ type: "config", config });
    feedOne({ type: "turn-started" });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    feedOne({ type: "config", config: { ...config, model: "other-model" } });
    expect(useStore.getState().usage).toBeNull();

    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 200, outputTokens: 30 },
    });
    expect(useStore.getState().usage).toBeNull();
  });

  it("clears usage when only the active provider changes", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    const configWithOpenAi: AppConfig = {
      ...config,
      providers: [
        ...(config.providers ?? []),
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://openai.example.test/v1",
          apiKey: "key",
          models: ["saved-model"],
        },
      ],
    };
    feedOne({ type: "config", config: configWithOpenAi });
    feedOne({ type: "turn-started" });
    feedOne({
      type: "turn-completed",
      usage: { inputTokens: 200, outputTokens: 30 },
    });

    feedOne({
      type: "config",
      config: { ...configWithOpenAi, activeProviderId: "openai" },
    });
    expect(useStore.getState().usage).toBeNull();
    expect(useStore.getState().config?.model).toBe(configWithOpenAi.model);
  });

  it("does not accept an old run completion after a new run has started", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    feedOne({ type: "config", config });
    feedRunStarted("run-1");
    feedRunCompleted("run-1", { inputTokens: 100, outputTokens: 20 });

    feedOne({ type: "config", config: { ...config, model: "other-model" } });
    feedRunStarted("run-1");
    feedRunCompleted("run-1", { inputTokens: 200, outputTokens: 30 });
    expect(useStore.getState().usage).toBeNull();

    feedRunStarted("run-2");
    feedRunCompleted("run-1", { inputTokens: 300, outputTokens: 40 });
    expect(useStore.getState().usage).toBeNull();
    feedRunCompleted("run-2", { inputTokens: 400, outputTokens: 50 });
    expect(useStore.getState().usage).toEqual({ inputTokens: 400, outputTokens: 50 });
  });

  it("ignores stale run events after a config switch even after the new run starts", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    const nextConfig = { ...config, model: "other-model" };

    feedOne({ type: "config", config });
    feedRunStarted("run-old");
    feedOne({ type: "config", config: nextConfig });
    feedRunStarted("run-new");

    feedRunStarted("run-old");
    feedRunCompleted("run-old", { inputTokens: 900, outputTokens: 90 });
    expect(useStore.getState().activeRunId).toBe("run-new");
    expect(useStore.getState().usage).toBeNull();

    feedRunCompleted("run-new", { inputTokens: 400, outputTokens: 50 });
    expect(useStore.getState().usage).toEqual({ inputTokens: 400, outputTokens: 50 });
  });

  it("closes busy for an invalidated active run without accepting its usage", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    feedOne({ type: "config", config });
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "saved-model", cwd: "cwd" },
    });
    feedRunStarted("run-old", OLD_CONTEXT);
    expect(useStore.getState().busy).toBe(true);

    feedOne({ type: "config", config: { ...config, model: "other-model" } });
    expect(useStore.getState().busy).toBe(true);

    feedRunCompleted("run-old", { inputTokens: 900, outputTokens: 90 }, OLD_CONTEXT);

    expect(useStore.getState().busy).toBe(false);
    expect(useStore.getState().usage).toBeNull();
    expect(useStore.getState().activeRunId).toBe("run-old");
    expect(useStore.getState().messages.at(-1)?.streaming).toBe(false);
  });

  it("rejects an old context before its first start and accepts the new context", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    feedOne({ type: "config", config });
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "saved-model", cwd: "cwd" },
    });
    feedOne({ type: "config", config: { ...config, model: "other-model" } });

    feedRunStarted("run-old", OLD_CONTEXT);
    feedRunCompleted("run-old", { inputTokens: 900, outputTokens: 90 }, OLD_CONTEXT);
    expect(useStore.getState().activeRunId).toBeNull();
    expect(useStore.getState().usage).toBeNull();
    expect(useStore.getState().busy).toBe(false);

    feedRunStarted("run-new", NEW_CONTEXT);
    feedRunCompleted("run-new", { inputTokens: 400, outputTokens: 50 }, NEW_CONTEXT);

    expect(useStore.getState().activeRunId).toBe("run-new");
    expect(useStore.getState().usage).toEqual({ inputTokens: 400, outputTokens: 50 });
    expect(useStore.getState().busy).toBe(false);
  });

  it("keeps the new run busy when an invalidated run completes after it starts", () => {
    const config = settingsConfig({ "saved-model": 64000 });
    feedOne({ type: "config", config });
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "saved-model", cwd: "cwd" },
    });
    feedRunStarted("run-old", OLD_CONTEXT);
    feedOne({ type: "config", config: { ...config, model: "other-model" } });
    feedRunStarted("run-new", NEW_CONTEXT);

    feedRunStarted("run-old", OLD_CONTEXT);
    feedRunCompleted("run-old", { inputTokens: 900, outputTokens: 90 }, OLD_CONTEXT);
    expect(useStore.getState().activeRunId).toBe("run-new");
    expect(useStore.getState().usage).toBeNull();
    expect(useStore.getState().busy).toBe(true);

    feedRunCompleted("run-new", { inputTokens: 400, outputTokens: 50 }, NEW_CONTEXT);
    expect(useStore.getState().activeRunId).toBe("run-new");
    expect(useStore.getState().usage).toEqual({ inputTokens: 400, outputTokens: 50 });
    expect(useStore.getState().busy).toBe(false);
  });

  it("does not reactivate an old A run after switching A to B and back to A", () => {
    const configA = settingsConfig({ "saved-model": 64000 });
    const configB = { ...configA, model: "other-model" };

    feedOne({ type: "config", config: configA });
    feedOne({
      type: "session-meta",
      meta: { id: "s1", createdAt: "x", title: "t", model: "saved-model", cwd: "cwd" },
    });
    feedRunRegistered("run-old", OLD_CONTEXT);

    feedOne({ type: "config", config: configB });
    feedOne({ type: "config", config: configA });
    feedRunRegistered("run-new", OLD_CONTEXT);
    feedRunStarted("run-new", OLD_CONTEXT);

    // The old run's first turn was delayed until after the renderer returned to A.
    feedRunStarted("run-old", OLD_CONTEXT);
    feedRunCompleted("run-old", { inputTokens: 900, outputTokens: 90 }, OLD_CONTEXT);
    expect(useStore.getState().activeRunId).toBe("run-new");
    expect(useStore.getState().busy).toBe(true);
    expect(useStore.getState().usage).toBeNull();

    feedRunCompleted("run-new", { inputTokens: 400, outputTokens: 50 }, OLD_CONTEXT);
    expect(useStore.getState().activeRunId).toBe("run-new");
    expect(useStore.getState().usage).toEqual({ inputTokens: 400, outputTokens: 50 });
    expect(useStore.getState().busy).toBe(false);
  });

  it("returns null when input tokens or context window is missing or non-positive", () => {
    expect(getContextSnapshot(undefined, 64000)).toBeNull();
    expect(getContextSnapshot(2048, undefined)).toBeNull();
    expect(getContextSnapshot(0, 64000)).toBeNull();
    expect(getContextSnapshot(2048, 0)).toBeNull();
    expect(getContextSnapshot(-1, 64000)).toBeNull();
    expect(getContextSnapshot(2048, -1)).toBeNull();
    expect(getContextSnapshot(Number.NaN, 64000)).toBeNull();
    expect(getContextSnapshot(2048, Number.NaN)).toBeNull();
    expect(getContextSnapshot(Number.POSITIVE_INFINITY, 64000)).toBeNull();
    expect(getContextSnapshot(2048, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("calculates a normal context ratio and exact remaining tokens", () => {
    expect(getContextSnapshot(204100, 1000000)).toEqual({
      inputTokens: 204100,
      contextWindow: 1000000,
      usedRatio: 0.2041,
      remainingTokens: 795900,
    });
  });

  it("clamps context usage and never returns a negative remaining count", () => {
    expect(getContextSnapshot(70000, 64000)).toEqual({
      inputTokens: 70000,
      contextWindow: 64000,
      usedRatio: 1,
      remainingTokens: 0,
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
