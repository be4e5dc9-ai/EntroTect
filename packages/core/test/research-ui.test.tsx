/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ResearchCommand, ResearchReply, ResearchSource } from "@entrotect/shared";
import { researchCommandSchema } from "@entrotect/shared";
import { ResearchLibrary } from "../../app-desktop/src/renderer/components/ResearchLibrary.js";

const source: ResearchSource = { id: "b42cda07-132c-4a0e-8f52-a0e6fbc328f3", title: "课程资料", url: "https://example.org/course", authors: ["Alice", "Bob"], publishedAt: "2026-09-30", doi: "10.1/test", excerpt: "真实原文", note: "笔记", tags: ["学习"], createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", accessedAt: "2026-09-30T00:00:00.000Z" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("资料库面板", () => {
  it("编辑资料提交合法patch，不夹带id和时间字段，也不丢失作者摘录", async () => {
    const request = vi.fn(async (raw: ResearchCommand): Promise<ResearchReply> => {
      const command = researchCommandSchema.parse(raw);
      if (command.action === "list") return { sources: [source] };
      if (command.action === "update") return { source: { ...source, ...command.patch }, sources: [{ ...source, ...command.patch }] };
      return {};
    });
    render(<ResearchLibrary sessionId="s1" request={request} onUsePrompt={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /课程资料/ }));
    fireEvent.change(screen.getByLabelText("我的笔记"), { target: { value: "更新笔记" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await screen.findByText("资料已保存");
    const update = request.mock.calls.map(([command]) => command).find((command) => command.action === "update");
    expect(update).toEqual({ action: "update", sessionId: "s1", id: source.id, patch: { title: source.title, url: source.url, authors: source.authors, publishedAt: source.publishedAt, doi: source.doi, excerpt: source.excerpt, note: "更新笔记", tags: source.tags } });
  });

  it("模板仅使用选中来源，填入草稿而不自动发送", async () => {
    const onUsePrompt = vi.fn();
    const request = vi.fn(async (command: ResearchCommand): Promise<ResearchReply> => command.action === "list" ? { sources: [source] } : { prompt: "学习指南草稿" });
    render(<ResearchLibrary sessionId="s1" request={request} onUsePrompt={onUsePrompt} />);
    await screen.findByRole("button", { name: /课程资料/ });
    expect((screen.getByRole("button", { name: "学习指南" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 课程资料" }));
    fireEvent.click(screen.getByRole("button", { name: "学习指南" }));
    await waitFor(() => expect(onUsePrompt).toHaveBeenCalledWith("学习指南草稿"));
    expect(request).toHaveBeenLastCalledWith({ action: "prompt", sessionId: "s1", template: "study", sourceIds: [source.id] });
  });

  it("切换任务后迟到的旧资料响应不会污染新任务", async () => {
    let resolveOld!: (reply: ResearchReply) => void;
    const old = new Promise<ResearchReply>((resolve) => { resolveOld = resolve; });
    const request = vi.fn((command: ResearchCommand): Promise<ResearchReply> => command.sessionId === "s1" ? old : Promise.resolve({ sources: [{ ...source, title: "新任务资料" }] }));
    const view = render(<ResearchLibrary sessionId="s1" request={request} onUsePrompt={vi.fn()} />);
    view.rerender(<ResearchLibrary sessionId="s2" request={request} onUsePrompt={vi.fn()} />);
    await screen.findByRole("button", { name: /新任务资料/ });
    await act(async () => { resolveOld({ sources: [source] }); await old; });
    expect(screen.queryByRole("button", { name: /课程资料/ })).toBeNull();
    expect(screen.getByRole("button", { name: /新任务资料/ })).toBeDefined();
  });
});
