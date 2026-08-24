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
import { useStore } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig } from "@entrotect/shared";

function mockBridge() {
  const send = vi.fn();
  const onEvent = vi.fn(() => () => {});
  const chooseFolder = vi.fn(async () => null);
  const setTheme = vi.fn();
  // @ts-expect-error mock
  window.entrotect = { send, onEvent, chooseFolder, setTheme };
  return { send, onEvent, chooseFolder, setTheme };
}

function makeConfig(): AppConfig {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    activeProviderId: "deepseek",
    workspaceDir: "/tmp",
    maxTokens: 4096,
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
    detailTabs: [],
    activeDetailId: null,
    fileContents: {},
    subagentChats: {},
  });
});

describe("settings-nav Task1: Nav Shell + State", () => {
  it("renders nav-primary with 通用 and 供应商, defaults to general", async () => {
    const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
    render(<SettingsPage />);
    // primary nav exists
    const primary = document.querySelector(".settings-nav-primary");
    expect(primary).not.toBeNull();
    // should have both primary items in nav
    const nav = primary as HTMLElement;
    expect(nav.textContent).toContain("通用");
    expect(nav.textContent).toContain("供应商");
    // secondary should be hidden when primary=general
    expect(document.querySelector(".settings-nav-secondary")).toBeNull();
    // default primary is general -> detail shows 通用 fields
    expect(screen.getByText(/工作目录/)).toBeDefined();
    // primary nav active state
    const active = document.querySelector(".settings-nav-item.active");
    expect(active?.textContent).toContain("通用");
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
