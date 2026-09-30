/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BrowserReply, BrowserTabState } from "@entrotect/shared";
import { BrowserPanel } from "../../app-desktop/src/renderer/components/BrowserPanel.js";
import { Composer } from "../../app-desktop/src/renderer/components/Composer.js";
import { DetailPanel } from "../../app-desktop/src/renderer/components/DetailPanel.js";
import { App } from "../../app-desktop/src/renderer/App.js";
import {
  activateBrowserTab, applyBrowserTabs, applyEvent, closeDetailTab,
  openBrowserTab, useComposerPrompt, useStore,
} from "../../app-desktop/src/renderer/store.js";

const session = (id = "s1") => ({ id, title: id, model: "deepseek-chat", cwd: "C:\\workspace", createdAt: 1, updatedAt: 1 });
const page = (id = "page1"): BrowserTabState => ({ id, title: `页面 ${id}`, url: `https://example.com/${id}`, loading: false, canGoBack: false, canGoForward: false });

function setupPage(tab = page()) {
  useStore.setState({ browserTabs: { s1: [tab] }, detailTabs: [{ id: `browser-${tab.id}`, kind: "browser", tabId: tab.id }], activeDetailId: `browser-${tab.id}` });
  return render(<BrowserPanel sessionId="s1" tabId={tab.id} tab={tab} />);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 300, y: 80, width: 420, height: 500, left: 300, top: 80, right: 720, bottom: 580, toJSON: () => ({}) });
  window.entrotect = {
    send: vi.fn(), onEvent: vi.fn(() => () => {}), chooseFolder: vi.fn(async () => null),
    setTheme: vi.fn(), setAccentColor: vi.fn(), listSkills: vi.fn(async () => []), pathOfDragFile: vi.fn(() => ""),
    browserCommand: vi.fn(async () => ({ ok: true, tabs: [page()] })), browserViewport: vi.fn(),
    onBrowserTabs: vi.fn(() => () => {}), researchCommand: vi.fn(async () => ({ sources: [] })),
  };
  useStore.setState({ currentSession: session(), detailTabs: [], activeDetailId: null, browserTabs: {},
    composerDraft: null, approval: null, toasts: [], view: "chat", messages: [], skills: [], busy: false,
    config: { baseUrl: "https://example.com/v1", apiKey: "", model: "deepseek-chat", permissionMode: "full" },
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("浏览器详情状态", () => {
  it("模型新增网页保留文件、资料库和用户未提交的地址草稿，不抢已有详情焦点", () => {
    useStore.setState({ detailTabs: [
      { id: "file-readme", kind: "file", path: "README.md" },
      { id: "research-library", kind: "research" },
      { id: "browser-new", kind: "browser", tabId: null },
    ], activeDetailId: "research-library" });
    applyBrowserTabs("s1", [page()]);
    expect(useStore.getState().detailTabs.map((tab) => tab.id)).toEqual(["file-readme", "research-library", "browser-new", "browser-page1"]);
    expect(useStore.getState().activeDetailId).toBe("research-library");
  });

  it("首次模型打开网页可展示，后台会话的网页变化不会打开当前详情", () => {
    applyBrowserTabs("s2", [page("background")]);
    expect(useStore.getState().detailTabs).toEqual([]);
    expect(useStore.getState().activeDetailId).toBeNull();
    applyBrowserTabs("s1", [page()]);
    expect(useStore.getState().activeDetailId).toBe("browser-page1");
  });

  it("用户提交新地址成功后激活实际网页并移除新页草稿", async () => {
    openBrowserTab();
    vi.mocked(window.entrotect!.browserCommand).mockResolvedValue({ ok: true, tabId: "page1", tabs: [page()] });
    render(<BrowserPanel sessionId="s1" tabId={null} tab={undefined} />);
    fireEvent.change(screen.getByLabelText("网页地址"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "打开", exact: true }));
    await waitFor(() => expect(useStore.getState().activeDetailId).toBe("browser-page1"));
    expect(window.entrotect!.browserCommand).toHaveBeenCalledWith("s1", { action: "open", url: "https://example.com" });
    expect(useStore.getState().detailTabs.some((tab) => tab.id === "browser-new")).toBe(false);
  });

  it("等待地址加载期间切换到其他详情后，完成响应不抢回焦点", () => {
    openBrowserTab();
    applyBrowserTabs("s1", [page()]);
    useStore.setState({ detailTabs: [...useStore.getState().detailTabs, { id: "research-library", kind: "research" }], activeDetailId: "research-library" });
    activateBrowserTab("s1", "page1");
    expect(useStore.getState().activeDetailId).toBe("research-library");
    expect(useStore.getState().detailTabs.some((tab) => tab.id === "browser-new")).toBe(true);
  });

  it("关闭实际后端网页成功后才移除详情，同一网页重复关闭只发一次", async () => {
    let resolveClose!: (reply: BrowserReply) => void;
    vi.mocked(window.entrotect!.browserCommand).mockReturnValue(new Promise((resolve) => { resolveClose = resolve; }));
    applyBrowserTabs("s1", [page()]);
    closeDetailTab("browser-page1");
    closeDetailTab("browser-page1");
    expect(window.entrotect!.browserCommand).toHaveBeenCalledTimes(1);
    expect(useStore.getState().detailTabs).toHaveLength(1);
    await act(async () => resolveClose({ ok: true, tabs: [] }));
    expect(useStore.getState().detailTabs).toEqual([]);
    expect(useStore.getState().activeDetailId).toBeNull();
  });

  it("后端拒绝关闭保留网页并报告错误", async () => {
    vi.mocked(window.entrotect!.browserCommand).mockResolvedValue({ ok: false, tabs: [page()], error: "关闭失败" });
    applyBrowserTabs("s1", [page()]);
    closeDetailTab("browser-page1");
    await waitFor(() => expect(useStore.getState().toasts.some((toast) => toast.text === "关闭失败")).toBe(true));
    expect(useStore.getState().activeDetailId).toBe("browser-page1");
  });

  it("收藏来源包含正文供报告和课程模板使用，选区摘录只保存选区", async () => {
    setupPage();
    const extraction = { title: "课程资料", url: "https://example.com/page1", author: "作者", text: "网页完整正文", selection: "用户选中的段落", tables: [], extractedAt: "2026-09-30T00:00:00.000Z" };
    vi.mocked(window.entrotect!.browserCommand).mockResolvedValue({ ok: true, tabs: [page()], extraction });
    fireEvent.click(screen.getByRole("button", { name: "收藏来源" }));
    await waitFor(() => expect(window.entrotect!.researchCommand).toHaveBeenCalledWith({
      action: "save", sessionId: "s1", source: {
        title: "课程资料", url: "https://example.com/page1", authors: ["作者"], excerpt: "网页完整正文",
      },
    }));
    await waitFor(() => expect((screen.getByRole("button", { name: "摘录选区" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "摘录选区" }));
    await waitFor(() => expect(window.entrotect!.researchCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      source: expect.objectContaining({ excerpt: "用户选中的段落" }),
    })));
  });
});

describe("原生网页遮挡与生命周期", () => {
  it("审批弹出和移除时隐藏并恢复原生网页", async () => {
    setupPage();
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.objectContaining({ width: 420 }));
    act(() => useStore.setState({ approval: { toolCallId: "c", toolName: "browser_click", preview: "click", description: "click" } }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    act(() => useStore.setState({ approval: null }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.objectContaining({ width: 420 }));
  });

  it("浏览器独立审批ID结束后清理对应弹窗，旧审批事件不清理当前其他审批", () => {
    setupPage();
    act(() => applyEvent({ type: "approval-requested", request: { toolCallId: "browser-request-1", toolName: "browser_click", preview: "click", description: "click" } }));
    act(() => applyEvent({ type: "approval-resolved", toolCallId: "original-core-call" }));
    expect(useStore.getState().approval?.toolCallId).toBe("browser-request-1");
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    act(() => applyEvent({ type: "approval-resolved", toolCallId: "browser-request-1" }));
    expect(useStore.getState().approval).toBeNull();
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.any(Object));
    act(() => applyEvent({ type: "approval-requested", request: { toolCallId: "next-request", toolName: "write", preview: "write", description: "write" } }));
    act(() => applyEvent({ type: "approval-resolved", toolCallId: "browser-request-1" }));
    expect(useStore.getState().approval?.toolCallId).toBe("next-request");
  });

  it("等待原生导航审批时保持网页隐藏，操作结束后恢复", async () => {
    let resolveNavigation!: (reply: BrowserReply) => void;
    setupPage();
    vi.mocked(window.entrotect!.browserCommand).mockReturnValue(new Promise((resolve) => { resolveNavigation = resolve; }));
    fireEvent.change(screen.getByLabelText("网页地址"), { target: { value: "https://localhost:3000" } });
    fireEvent.click(screen.getByRole("button", { name: "打开", exact: true }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    const update = document.createElement("div");
    document.body.appendChild(update);
    await act(async () => { await Promise.resolve(); });
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    await act(async () => resolveNavigation({ ok: true, tabs: [page()] }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.any(Object));
    update.remove();
  });

  it("DOM对话框和动态添加的modal class会隐藏网页，移除后恢复", async () => {
    setupPage();
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    overlay.setAttribute("role", "dialog");
    await waitFor(() => expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null));
    overlay.removeAttribute("role");
    await waitFor(() => expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.any(Object)));
    overlay.className = "modal-backdrop";
    await waitFor(() => expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null));
    overlay.remove();
    await waitFor(() => expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.any(Object)));
  });

  it("错误提示显示时隐藏网页，操作重试成功后恢复", async () => {
    setupPage();
    vi.mocked(window.entrotect!.browserCommand).mockResolvedValueOnce({ ok: false, tabs: [page()], error: "请求失败" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("alert");
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.any(Object));
  });

  it("切换会话卸载旧网页视口，旧会话状态消息不会重新打开", () => {
    applyBrowserTabs("s1", [page()]);
    render(<DetailPanel width={420} onWidthChange={() => {}} />);
    act(() => applyEvent({ type: "session-meta", meta: session("s2") }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    act(() => applyBrowserTabs("s1", [page("late")]));
    expect(useStore.getState().detailTabs).toEqual([]);
    expect(screen.queryByLabelText("网页地址")).toBeNull();
  });

  it("收起详情栏和切换设置时隐藏网页，展开保留原网页", () => {
    localStorage.setItem("entrotect-detail-collapsed", "0");
    applyBrowserTabs("s1", [page()]);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "收起详情栏" }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
    fireEvent.click(screen.getByRole("button", { name: "展开详情栏" }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", expect.any(Object));
    act(() => useStore.setState({ view: "settings" }));
    expect(window.entrotect!.browserViewport).toHaveBeenLastCalledWith("s1", "page1", null);
  });
});

describe("办公学习模板草稿", () => {
  it("模板保留已输入文本，并等待用户主动发送", async () => {
    render(<Composer />);
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "我已有的会议重点" } });
    act(() => useComposerPrompt("按决策和待办整理会议记录"));
    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe("我已有的会议重点\n\n按决策和待办整理会议记录"));
    expect(window.entrotect!.send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "SendMessage" }));
    expect(useStore.getState().composerDraft).toBeNull();
  });
});
