/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";

// polyfills
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

// need to ensure crypto.randomUUID exists in jsdom
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => `uuid-${Math.random().toString(16).slice(2, 8)}` },
    writable: true,
    configurable: true,
  });
}

import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { deriveAccentTokens } from "../../app-desktop/src/appearance.js";
import { useStore } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig } from "@entrotect/shared";

function mockBridge() {
  const send = vi.fn();
  const onEvent = vi.fn(() => () => {});
  const chooseFolder = vi.fn(async () => null);
  const setTheme = vi.fn();
  const setAccentColor = vi.fn();
  const listSkills = vi.fn(async () => []);
  window.entrotect = { send, onEvent, chooseFolder, setTheme, setAccentColor, listSkills };
  return { send, onEvent, chooseFolder, setTheme, setAccentColor, listSkills };
}

function makeConfig(): AppConfig {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    activeProviderId: "deepseek",
    workspaceDir: "/tmp",
    showReasoning: false,
    sandboxMode: "full",
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-1",
        models: ["deepseek-chat"],
        contextWindows: { "deepseek-chat": 64000 },
        builtin: true,
      },
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-2",
        models: ["gpt-4o"],
        builtin: true,
      },
    ],
  };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  mockBridge();
  // reset store
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
    contextWindowsByProvider: {},
    approval: null,
    config: makeConfig(),
    view: "settings",
    toasts: [],
    error: null,
    theme: "dark",
    accentColor: "#B8A2FF",
    detailTabs: [],
    activeDetailId: null,
    fileContents: {},
    subagentChats: {},
    skills: [],
    skillsLoading: false,
  });
});

describe("settings-nav Task1: Nav Shell + State", () => {
  it("hides the conversation shell in settings view while keeping settings navigation", async () => {
    const { App } = await import("../../app-desktop/src/renderer/App.js");
    localStorage.setItem("entrotect-sidebar-collapsed", "1");
    localStorage.setItem("entrotect-detail-collapsed", "1");
    useStore.setState({
      view: "settings",
      detailTabs: [{ id: "file-readme", kind: "file", path: "README.md" }],
      activeDetailId: "file-readme",
    });
    render(<App />);

    expect(screen.queryByText("对话列表")).toBeNull();
    expect(screen.getByRole("button", { name: "通用" })).toBeDefined();
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelector(".sidebar-peek")).toBeNull();
    expect(document.querySelector(".detail-panel")).toBeNull();
    expect(document.querySelector(".detail-peek")).toBeNull();
  });

  it("keeps the conversation shell in chat view", async () => {
    const { App } = await import("../../app-desktop/src/renderer/App.js");
    useStore.setState({ view: "chat" });
    render(<App />);

    expect(screen.getByText("对话列表")).toBeDefined();
  });

  it("uses an accent-aware inline brand mark instead of the static renderer PNG", async () => {
    const { App } = await import("../../app-desktop/src/renderer/App.js");
    useStore.setState({ view: "chat", messages: [] });
    render(<App />);
    expect(document.querySelector(".brand-mark")).not.toBeNull();
    expect(document.querySelector('.empty-state img[src="./icon.png"]')).toBeNull();
  });

  it("renders 供应商 first and defaults to provider detail", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    const items = [...document.querySelectorAll(".settings-nav-item")].map((item) => item.textContent);
    expect(items).toEqual(["供应商", "Skills", "外观", "通用"]);
    expect(document.querySelector(".settings-nav-item.active")?.textContent).toContain("供应商");
    expect(screen.getByText("Base URL")).toBeDefined();
    expect(document.querySelector(".settings-nav-secondary")).not.toBeNull();
  });

  it("opens Appearance with theme and accent controls", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    expect(screen.getByRole("radiogroup", { name: "主题" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "日间模式" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "夜间模式" })).toBeDefined();
    expect(screen.getByRole("radiogroup", { name: "强调色" })).toBeDefined();
    expect(screen.getByLabelText("自定义颜色")).toBeDefined();
    const swatches = [...document.querySelectorAll<HTMLElement>(".appearance-color-swatch")];
    expect(swatches).toHaveLength(5);
    for (const swatch of swatches) {
      expect(swatch.style.display).toBe("inline-block");
      expect(swatch.style.width).toBe("20px");
      expect(swatch.style.height).toBe("20px");
    }
    expect(document.querySelector(".settings-nav-secondary")).toBeNull();
  });

  it("switches theme and persists a preset/custom accent immediately", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    const { setTheme, setAccentColor } = window.entrotect!;
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    fireEvent.click(screen.getByRole("radio", { name: "日间模式" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("entrotect-theme")).toBe("light");
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(useStore.getState().theme).toBe("light");
    fireEvent.click(screen.getByRole("radio", { name: "天空蓝" }));
    expect(localStorage.getItem("entrotect-accent-color")).toBe("#7CA7FF");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      deriveAccentTokens("#7CA7FF", "light").accent,
    );
    expect(setAccentColor).toHaveBeenCalledWith("#7CA7FF");
    expect(useStore.getState().accentColor).toBe("#7CA7FF");
    fireEvent.change(screen.getByLabelText("自定义颜色"), { target: { value: "#66c7a5" } });
    expect(localStorage.getItem("entrotect-accent-color")).toBe("#66C7A5");
    expect(setAccentColor).toHaveBeenLastCalledWith("#66C7A5");
    expect(useStore.getState().accentColor).toBe("#66C7A5");
  });

  it("keeps appearance synchronization when storage persistence throws", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "外观" }));

    const { setTheme, setAccentColor } = window.entrotect!;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    try {
      fireEvent.click(screen.getByRole("radio", { name: "日间模式" }));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(useStore.getState().theme).toBe("light");
      expect(setTheme).toHaveBeenCalledWith("light");

      fireEvent.click(screen.getByRole("radio", { name: "天空蓝" }));
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
        deriveAccentTokens("#7CA7FF", "light").accent,
      );
      expect(useStore.getState().accentColor).toBe("#7CA7FF");
      expect(setAccentColor).toHaveBeenCalledWith("#7CA7FF");
    } finally {
      setItem.mockRestore();
    }
  });

  it("removes the standalone theme button from chat Sidebar", async () => {
    const { App } = await import("../../app-desktop/src/renderer/App.js");
    useStore.setState({ view: "chat" });
    render(<App />);
    expect(screen.queryByRole("button", { name: /日间模式|夜间模式/ })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeDefined();
  });

  it("uses distinct gradient ids for multiple inline brand marks", async () => {
    const { BrandMark } = await import("../../app-desktop/src/renderer/components/BrandMark.js");
    const { container } = render(
      <>
        <BrandMark className="brand-mark" />
        <BrandMark className="brand-mark" />
      </>,
    );
    const marks = [...container.querySelectorAll<SVGSVGElement>("svg.brand-mark")];
    const gradientIds = marks.map((mark) => mark.querySelector("linearGradient")?.id);

    expect(gradientIds).toHaveLength(2);
    expect(gradientIds[0]).toBeTruthy();
    expect(new Set(gradientIds).size).toBe(2);
    expect(marks.map((mark) => mark.querySelector("rect")?.getAttribute("fill"))).toEqual(
      gradientIds.map((id) => `url(#${id})`),
    );
  });

  it("click 供应商 → secondary list appears and localStorage persists", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    const providersBtn = screen.getByText("供应商");
    fireEvent.click(providersBtn);
    await waitFor(() => {
      const secondary = document.querySelector(".settings-nav-secondary");
      expect(secondary).not.toBeNull();
    });
    // secondary should contain provider names
    expect(screen.getByText("DeepSeek")).toBeDefined();
    expect(screen.getByText("OpenAI")).toBeDefined();
    expect(localStorage.getItem("entrotect-settings-primary")).toBe("providers");
    // active provider persisted
    expect(localStorage.getItem("entrotect-settings-provider")).toBeDefined();
  });

  it("secondary provider selection persists to localStorage", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".settings-nav-secondary")).not.toBeNull());
    const openAiRow = screen.getByText("OpenAI");
    fireEvent.click(openAiRow);
    expect(localStorage.getItem("entrotect-settings-provider")).toBe("openai");
  });

  it("layout has nav-primary 160px and nav-secondary 220px widths via CSS or inline style", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".settings-nav-secondary")).not.toBeNull());
    const primary = document.querySelector(".settings-nav-primary") as HTMLElement | null;
    const secondary = document.querySelector(".settings-nav-secondary") as HTMLElement | null;
    expect(primary).not.toBeNull();
    expect(secondary).not.toBeNull();
    const fs = await import("node:fs");
    const path = await import("node:path");
    // from packages/core cwd, sibling app-desktop is ../app-desktop
    const cssPath = path.resolve(process.cwd(), "../app-desktop/src/renderer/styles/app.css");
    const css = fs.readFileSync(cssPath, "utf-8");
    expect(css).toMatch(/\.settings-nav-primary[\s\S]*?160px/);
    expect(css).toMatch(/\.settings-nav-secondary[\s\S]*?220px/);
  });
});

describe("settings-nav Task2: Provider Detail Table", () => {
  it("replaces chip list with table rows (model | context input | ×)", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".settings-nav-secondary")).not.toBeNull());
    // table should exist in detail
    const table = document.querySelector(".model-table");
    expect(table).not.toBeNull();
    // should have row for deepseek-chat with context input and remove button
    expect(screen.getByText("deepseek-chat")).toBeDefined();
    const ctxInput = screen.getByLabelText("deepseek-chat 的上下文窗口(tokens),留空为自动识别") as HTMLInputElement;
    expect(ctxInput.value).toBe("64000");
    expect(screen.getByLabelText("移除模型 deepseek-chat")).toBeDefined();
    // chip style should be gone (no .model-chip)
    expect(document.querySelector(".model-chip")).toBeNull();
  });

  it("wires add model via table input", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".model-table")).not.toBeNull());
    const input = document.querySelector(".model-add-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: "new-model-xyz" } });
    const addBtn = screen.getByText("添加");
    fireEvent.click(addBtn);
    expect(screen.getByText("new-model-xyz")).toBeDefined();
    // new row should have empty context input
    const newCtx = screen.getByLabelText("new-model-xyz 的上下文窗口(tokens),留空为自动识别") as HTMLInputElement;
    expect(newCtx.value).toBe("");
  });

  it("wires context edit and remove via table", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".model-table")).not.toBeNull());
    // edit context
    const ctxInput = screen.getByLabelText("deepseek-chat 的上下文窗口(tokens),留空为自动识别") as HTMLInputElement;
    fireEvent.change(ctxInput, { target: { value: "128000" } });
    expect(ctxInput.value).toBe("128000");
    // clear to auto -> should become empty
    fireEvent.change(ctxInput, { target: { value: "" } });
    expect(ctxInput.value).toBe("");
    // restore then remove
    fireEvent.change(ctxInput, { target: { value: "64000" } });
    const removeBtn = screen.getByLabelText("移除模型 deepseek-chat");
    fireEvent.click(removeBtn);
    expect(screen.queryByText("deepseek-chat")).toBeNull();
  });
});

describe("settings-nav Task3: General Pane + Actions", () => {
  it("moves general fields to detail when primary=general, provider detail keeps fetch/modelsUrl/apiFormat", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    localStorage.setItem("entrotect-settings-primary", "general");
    render(<SettingsPage />);
    // general pane visible initially
    expect(screen.getByText(/工作目录/)).toBeDefined();
    expect(screen.getByText(/显示模型思考过程/)).toBeDefined();
    expect(document.querySelector(".switch")).not.toBeNull();
    // provider detail not visible yet
    expect(document.querySelector(".provider-grid")).toBeNull();
    // switch to providers
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".provider-grid")).not.toBeNull());
    // now general fields hidden in provider detail
    expect(screen.queryByText(/工作目录/)).toBeNull();
    // provider detail has baseUrl, apiKey, modelsUrl, apiFormat, fetch
    expect(screen.getByText("Base URL")).toBeDefined();
    expect(screen.getByText("API Key")).toBeDefined();
    expect(screen.getByText("Models URL")).toBeDefined();
    expect(screen.getByText("API Format")).toBeDefined();
    expect(screen.getByText("拉取模型")).toBeDefined();
  });

  it("save persists general fields via explicit 保存", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    const { bridge } = await import("../../app-desktop/src/renderer/bridge.js");
    localStorage.setItem("entrotect-settings-primary", "general");
    render(<SettingsPage />);
    // edit workspaceDir
    const input = screen.getByPlaceholderText("留空 = 用户主目录") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "/new/workspace" } });
    const saveBtn = screen.getByText("保存");
    // mock send to capture
    const sendMock = (window as unknown as { entrotect: { send: ReturnType<typeof vi.fn> } }).entrotect.send as unknown as ReturnType<typeof vi.fn>;
    fireEvent.click(saveBtn);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "SetConfig",
      config: expect.objectContaining({ workspaceDir: "/new/workspace" }),
    }));
    // save again with a toggle change(显示模型思考过程)to prove merge persists
    const switchBtn = document.querySelector(".switch") as HTMLButtonElement;
    fireEvent.click(switchBtn);
    fireEvent.click(saveBtn);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ showReasoning: true }),
    }));
  });

  it("provider detail edits modelsUrl/apiFormat and save persists", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".provider-grid")).not.toBeNull());
    const modelsUrlInput = screen.getByPlaceholderText("https://api.example.com/models") as HTMLInputElement;
    fireEvent.change(modelsUrlInput, { target: { value: "https://custom.example.com/models" } });
    const apiFormatSelect = screen.getByLabelText("API Format") as HTMLSelectElement;
    fireEvent.change(apiFormatSelect, { target: { value: "anthropic" } });
    const saveBtn = screen.getAllByText("保存")[0] as HTMLButtonElement;
    const sendMock = (window as unknown as { entrotect: { send: ReturnType<typeof vi.fn> } }).entrotect.send as unknown as ReturnType<typeof vi.fn>;
    fireEvent.click(saveBtn);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "SetConfig",
      config: expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "deepseek", modelsUrl: "https://custom.example.com/models", apiFormat: "anthropic" }),
        ]),
      }),
    }));
  });

  it("reuses modelsByProvider/contextWindowsByProvider cache via mergeCachedProviderDataIntoConfig", async () => {
    // This checks that the page still merges cached data into form
    const { applyEvent, useStore } = await import("../../app-desktop/src/renderer/store.js");
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    // simulate cached data before mount
    applyEvent({ type: "models-listed", providerId: "deepseek", models: ["cached-model"], contextWindows: { "cached-model": 99999 } });
    render(<SettingsPage />);
    fireEvent.click(screen.getByText("供应商"));
    await waitFor(() => expect(document.querySelector(".model-table")).not.toBeNull());
    // cached model should appear via merge
    expect(screen.getByText("cached-model")).toBeDefined();
    const ctx = screen.getByLabelText("cached-model 的上下文窗口(tokens),留空为自动识别") as HTMLInputElement;
    expect(ctx.value).toBe("99999");
  });
});
