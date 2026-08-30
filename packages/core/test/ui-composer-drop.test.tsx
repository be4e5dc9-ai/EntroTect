/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

import { Composer } from "../../app-desktop/src/renderer/components/Composer.js";
import { useStore } from "../../app-desktop/src/renderer/store.js";
import type { AppConfig as SharedConfig } from "@entrotect/shared";

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
  localStorage.clear();
  window.entrotect = {
    send: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    chooseFolder: vi.fn(async () => null),
    setTheme: vi.fn(),
    setAccentColor: vi.fn(),
    listSkills: vi.fn(async () => []),
    pathOfDragFile: vi.fn(() => "C:\\fake\\path\\file.txt"),
  };
  useStore.setState({
    config: makeConfig(),
    currentSession: {
      id: "s1",
      title: "会话",
      model: "deepseek-chat",
      cwd: "C:\\fake",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Composer 拖拽附件", () => {
  it("拖入文件显示文件芯片并随消息发送", async () => {
    const send = window.entrotect.send as ReturnType<typeof vi.fn>;
    render(<Composer />);
    const composer = document.querySelector(".composer");
    expect(composer).not.toBeNull();

    // 模拟拖入一个文件
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    fireEvent.drop(composer!, {
      dataTransfer: { files: [file] },
    });

    // 文件芯片出现
    await waitFor(() => expect(screen.getByText("hello.txt")).toBeDefined());

    // 输入文本并发送,附件应带出
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "帮我看看" } });
    fireEvent.click(screen.getByLabelText("发送"));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SendMessage",
        text: "帮我看看",
        attachments: [{ kind: "file", path: "C:\\fake\\path\\file.txt", name: "hello.txt" }],
      }),
    );
  });

  it("图片拖入产生图片芯片(base64)", async () => {
    render(<Composer />);
    const composer = document.querySelector(".composer");
    // 用 data URL 构造 png blob,避免真实二进制
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngBytes], "shot.png", { type: "image/png" });
    fireEvent.drop(composer!, {
      dataTransfer: { files: [file] },
    });
    await waitFor(() => expect(document.querySelectorAll(".attachment-image").length).toBe(1));
  });

  it("移除附件后发送不携带", async () => {
    render(<Composer />);
    const composer = document.querySelector(".composer");
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    fireEvent.drop(composer!, {
      dataTransfer: { files: [file] },
    });
    await waitFor(() => expect(screen.getByText("a.txt")).toBeDefined());
    fireEvent.click(screen.getByLabelText("移除附件"));
    const send = window.entrotect.send as ReturnType<typeof vi.fn>;
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.anything() }),
    );
  });
});
