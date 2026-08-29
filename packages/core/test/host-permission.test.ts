import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { AppConfig, AppEvent } from "@entrotect/shared";
import { SessionHost } from "../../app-desktop/src/main/host.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function streamBody(chunks: string[]): Response {
  return new Response(chunks.join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const sse = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}`;

function configFor(permissionMode: AppConfig["permissionMode"]): AppConfig {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-top",
    model: "deepseek-chat",
    activeProviderId: "deepseek",
    permissionMode,
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-provider",
        models: ["deepseek-chat"],
      },
    ],
  };
}

function fakeWindow(events: AppEvent[]): BrowserWindow {
  return {
    webContents: {
      send: (_channel: string, event: AppEvent) => events.push(event),
    },
  } as unknown as BrowserWindow;
}

describe("SessionHost 子代理权限跟随父级", () => {
  it("full 模式下子代理调用 write 工具不弹审批", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "entrotect-perm-"));
    const events: AppEvent[] = [];
    const approvals: AppEvent[] = [];
    const takenChunks: Array<Record<string, unknown>> = [];

    // 父流程:turn1 委派 task → 子代理脚本消费;父流程 turn1 就调用 task
    const mockStream = async () => {
      // 按调用轮次返回:1)父代 task 调用;2)子代理 write;3)子代理完成;4)父代收尾
      const step = takenChunks.length;
      if (step === 0) {
        return streamBody([
          sse({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "task", arguments: '{"prompt":"写一个 hello.txt"}' } }] }, finish_reason: null }],
          }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]",
        ]);
      }
      if (step === 1) {
        return streamBody([
          sse({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t2", function: { name: "write", arguments: '{"file_path":"%WORKSPACE%/child.txt","content":"hi"}' } }] }, finish_reason: null }],
          }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]",
        ]);
      }
      if (step === 2) {
        return streamBody([
          sse({ choices: [{ index: 0, delta: { content: "child done" } }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]",
        ]);
      }
      return streamBody([
        sse({ choices: [{ index: 0, delta: { content: "parent done" } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      takenChunks.push(JSON.parse(String(init?.body)));
      return mockStream();
    }) as typeof fetch;

    try {
      const host = new SessionHost({
        appDataDir,
        getWindow: () => fakeWindow(events),
      });
      await host.init();

      await host.handleOp({ kind: "SetConfig", config: configFor("full") });
      await host.handleOp({ kind: "NewProject", cwd: appDataDir });
      events.length = 0;

      await host.handleOp({ kind: "SendMessage", text: "委派子代理写文件" });
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const approvalEvents = events.filter((e) => e.type === "approval-requested");
      expect(approvalEvents).toHaveLength(0);
    } finally {
      await rm(appDataDir, { recursive: true, force: true });
    }
  });
});
