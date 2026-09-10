/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_CONFIG } from "@entrotect/shared";
import { Composer } from "../../app-desktop/src/renderer/components/Composer.js";
import { applyEvent, uiBlockForAssistantText, useStore } from "../../app-desktop/src/renderer/store.js";
import { MessageList } from "../../app-desktop/src/renderer/components/MessageList.js";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.entrotect = {
    send: vi.fn(), onEvent: vi.fn(() => () => {}), chooseFolder: vi.fn(async () => null),
    setTheme: vi.fn(), setAccentColor: vi.fn(), listSkills: vi.fn(async () => []), pathOfDragFile: vi.fn(() => "E:\\file.txt"),
  };
  useStore.setState({
    config: { ...DEFAULT_CONFIG }, currentSession: { id: "s1", title: "任务", model: "test", cwd: "E:\\", createdAt: "2026-09-10" },
    busy: false, commandNotice: null, messages: [],
    skills: [{ name: "review", description: "审查代码", path: "E:\\review\\SKILL.md", source: "project" }],
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function input(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}
function key(key: string, extra = {}) { fireEvent.keyDown(screen.getByRole("textbox"), { key, ...extra }); }

describe("slash completion", () => {
  it("uses a single keyboard cursor for built-ins and skills", () => {
    render(<Composer />); input("/");
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/plan");
    key("ArrowDown"); key("Tab");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/goal ");
    expect(window.entrotect.send).not.toHaveBeenCalled();
    input("/"); key("ArrowUp"); key("Enter");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/review ");
  });
  it("works with built-ins only, filters by description, and submits compact", () => {
    useStore.setState({ skills: [] }); render(<Composer />); input("/压缩"); key("Tab");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/compact ");
    key("Enter");
    expect(window.entrotect.send).toHaveBeenCalledWith({ kind: "SendMessage", text: "/compact", attachments: [] });
  });
  it("unknown skills and multiline arguments still send; IME does not select commands", () => {
    render(<Composer />); input("/"); key("ArrowDown", { isComposing: true });
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/plan");
    input("/unknown"); key("ArrowDown"); key("Enter");
    expect(window.entrotect.send).toHaveBeenCalledWith(expect.objectContaining({ text: "/unknown" }));
    input("/plan\n调研"); expect(screen.queryByRole("listbox")).toBeNull(); key("Enter");
    expect(window.entrotect.send).toHaveBeenCalledWith(expect.objectContaining({ text: "/plan\n调研" }));
  });
  it("Escape closes suggestions, Shift+Enter does not select, and errors retain draft", () => {
    render(<Composer />); input("/plan"); key("Enter", { shiftKey: true });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/plan");
    key("Escape"); expect(screen.queryByRole("listbox")).toBeNull();
    input("/goal set"); key("Enter");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/goal set");
    expect(screen.getByRole("status").textContent).toContain("填写目标");
  });
  it("shows session controls outside conversation and ignores stale session updates", () => {
    render(<Composer />);
    act(() => applyEvent({ type: "session-controls", sessionId: "s1", controls: { mode: "plan", goal: { objective: "验证登录", status: "active" } } }));
    expect(screen.getByText("退出规划")).toBeDefined();
    expect(screen.getByText("验证登录")).toBeDefined();
    fireEvent.click(screen.getByText("退出规划"));
    expect(window.entrotect.send).toHaveBeenCalledWith({ kind: "SendMessage", text: "/plan off" });
    act(() => applyEvent({ type: "command-result", sessionId: "old", message: "不应显示" }));
    expect(screen.queryByText("不应显示")).toBeNull();
    expect(useStore.getState().messages).toHaveLength(0);
  });
  it("does not discard attachments on a non-message command", () => {
    render(<Composer />);
    fireEvent.drop(document.querySelector(".composer")!, { dataTransfer: { files: [new File(["hello"], "file.txt", { type: "text/plain" })] } });
    input("/help "); key("Enter");
    expect(screen.getByText("file.txt")).toBeDefined();
    expect(window.entrotect.send).not.toHaveBeenCalled();
  });

  it("promotes only a complete proposed_plan response to a dedicated plan block", () => {
    expect(uiBlockForAssistantText("<proposed_plan>\n# 登录方案\n- 加入测试\n</proposed_plan>")).toEqual({ kind: "plan", text: "# 登录方案\n- 加入测试" });
    expect(uiBlockForAssistantText("前言\n<proposed_plan>x</proposed_plan>").kind).toBe("text");
    act(() => applyEvent({ type: "message-appended", message: { role: "assistant", content: [{ type: "text", text: "<proposed_plan>\n# 登录方案\n- 加入测试\n</proposed_plan>" }] } }));
    render(<MessageList />);
    expect(screen.getByLabelText("实施计划")).toBeDefined();
    expect(screen.getByText("登录方案")).toBeDefined();
    expect(document.body.textContent).not.toContain("proposed_plan");
  });
});
