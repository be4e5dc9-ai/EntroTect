/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { appEventSchema, messageSchema, type AppEvent } from "@entrotect/shared";
import { compactMessages } from "../src/compact.js";
import { MockProvider, textDelta, turnComplete } from "./helpers/mock-provider.js";
import { applyEvent, useStore } from "../../app-desktop/src/renderer/store.js";
import { Message } from "../../app-desktop/src/renderer/components/MessageList.js";
import { Composer } from "../../app-desktop/src/renderer/components/Composer.js";

const marker = { id: "compact-1", createdAt: "2026-09-13T08:00:00.000Z", retainedMessages: 2 };
const complete: AppEvent = { type: "session-compacted", sessionId: "s1", marker, summary: "内部摘要不作为普通消息展示" };
beforeEach(() => {
  window.entrotect = { send: vi.fn(), onEvent: () => () => {}, chooseFolder: async () => null, setTheme() {}, setAccentColor() {}, listSkills: async () => [], pathOfDragFile: () => "" };
  useStore.setState({ currentSession: { id: "s1", title: "test", model: "test", cwd: ".", createdAt: marker.createdAt }, messages: [], busy: false, contextEstimate: null });
});
afterEach(cleanup);

describe("compaction markers", () => {
  it("shows Stop instead of Send while compacting, then restores Send after cancellation", () => {
    render(<Composer />);
    act(() => applyEvent({ type: "session-compacting", sessionId: "s1", id: marker.id }));
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(window.entrotect!.send).toHaveBeenCalledWith({ kind: "Interrupt" });
    act(() => {
      applyEvent({ type: "session-compaction-failed", sessionId: "s1", id: marker.id, cancelled: true });
      applyEvent({ type: "turn-completed", usage: null });
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });

  it("replaces stale usage with a labelled estimate until new provider usage arrives", () => {
    useStore.setState({ usage: { inputTokens: 90000, outputTokens: 100 }, usageUpdatesBlocked: false });
    applyEvent({ ...complete, marker: { ...marker, beforeTokens: 90000, afterTokens: 4000 } });
    expect(useStore.getState().usage).toBeNull();
    expect(useStore.getState().contextEstimate).toBe(4000);
    applyEvent({ type: "turn-completed", usage: { inputTokens: 5500, outputTokens: 200 } });
    expect(useStore.getState().contextEstimate).toBeNull();
    expect(useStore.getState().usage?.inputTokens).toBe(5500);
  });
  it("updates an inline marker in place and never renders the summary as chat text", () => {
    applyEvent({ type: "message-appended", message: { role: "user", content: [{ type: "text", text: "已有内容" }] } });
    applyEvent(appEventSchema.parse({ type: "session-compacting", sessionId: "s1", id: marker.id }));
    const key = useStore.getState().messages[1]!.key;
    const view = render(<Message message={useStore.getState().messages[1]!} />);
    expect(screen.getByRole("status").textContent).toBe("正在压缩上下文…");
    applyEvent(appEventSchema.parse(complete));
    applyEvent(complete);
    const messages = useStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]!.key).toBe(key);
    expect(messages[1]!.blocks).toEqual([]);
    view.rerender(<Message message={messages[1]!} />);
    expect(screen.getByRole("status").textContent).toBe("上下文已压缩");
    expect(screen.queryByText(complete.summary)).toBeNull();
    expect(view.container.querySelector(".tool-card")).toBeNull();
  });

  it.each([false, true])("shows failure/cancellation without claiming success (cancel: %s)", (cancelled) => {
    applyEvent({ type: "session-compacting", sessionId: "s1", id: marker.id });
    applyEvent(appEventSchema.parse({ type: "session-compaction-failed", sessionId: "s1", id: marker.id, cancelled }));
    render(<Message message={useStore.getState().messages[0]!} />);
    expect(screen.getByRole("status").textContent).toBe(cancelled ? "上下文压缩已取消" : "上下文压缩失败");
  });

  it("ignores other sessions and hides persisted context summaries from the user transcript", () => {
    applyEvent({ ...complete, sessionId: "other" });
    applyEvent({ type: "message-appended", message: messageSchema.parse({ role: "user", content: [{ type: "text", text: "内部摘要" }], compaction: marker }) });
    expect(useStore.getState().messages).toEqual([]);
    applyEvent(complete);
    expect(useStore.getState().messages).toHaveLength(1);
  });

  it("supersedes earlier summary metadata on repeated compaction", async () => {
    const provider = new MockProvider([
      { events: [textDelta("第一次摘要"), turnComplete()] },
      { events: [textDelta("第二次摘要"), turnComplete()] },
    ]);
    const original = [{ role: "user" as const, content: [{ type: "text" as const, text: "任务".repeat(3000) }] }, { role: "assistant" as const, content: [{ type: "text" as const, text: "结果" }] }];
    const first = await compactMessages(provider, original);
    const second = await compactMessages(provider, [...first.compacted, ...original]);
    expect(second.compacted.filter((message) => message.compaction)).toHaveLength(1);
    expect(second.compacted[0]!.compaction?.id).not.toBe(first.compacted[0]!.compaction?.id);
    expect(messageSchema.parse(second.compacted[0]).compaction?.retainedMessages).toBe(second.compacted.length - 1);
  });
});
