import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { AppConfig, AppEvent } from "@entrotect/shared";
import { SessionHost } from "../../app-desktop/src/main/host.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function streamResponse(delegate = false): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: delegate ? { reasoning_content: "delegate research", tool_calls: [{ index: 0, id: "research-task", function: { name: "task", arguments: JSON.stringify({ prompt: "只读比较开源记忆框架并回报来源" }) } }] } : { content: "ok" } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function configFor(providerId: string, baseUrl: string, model: string): AppConfig {
  return {
    baseUrl,
    apiKey: `${providerId}-top-level-key`,
    model,
    providers: [
      {
        id: providerId,
        name: providerId,
        baseUrl,
        apiKey: `${providerId}-key`,
        models: [model],
      },
    ],
    activeProviderId: providerId,
    permissionMode: "full",
    sandboxMode: "full",
    reasoningEffort: "low",
    temperature: 0.25,
  };
}

function fakeWindow(events: AppEvent[]): BrowserWindow {
  return {
    webContents: {
      send: (_channel: string, event: AppEvent) => events.push(event),
    },
  } as unknown as BrowserWindow;
}

describe("SessionHost run context", () => {
  it("preserves parent file observations across user turns", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "entrotect-host-file-state-"));
    const events: AppEvent[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      const step = calls++;
      if (step !== 0 && step !== 2) return streamResponse();
      const name = step === 0 ? "read" : "edit";
      const args = step === 0 ? { file_path: "code.js" } : { file_path: "code.js", old_string: "alpha", new_string: "overwrite" };
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `file-${step}`, function: { name, arguments: JSON.stringify(args) } }] } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
        "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      await writeFile(path.join(appDataDir, "code.js"), "alpha beta", "utf8");
      const host = new SessionHost({ appDataDir, getWindow: () => fakeWindow(events) });
      await host.init();
      const config = { ...configFor("deepseek", "https://api.deepseek.com/v1", "deepseek-chat"), workspaceDir: appDataDir };
      await host.handleOp({ kind: "SetConfig", config });
      await host.handleOp({ kind: "NewSession" });
      await host.handleOp({ kind: "SendMessage", text: "read code" });
      await writeFile(path.join(appDataDir, "code.js"), "alpha external change", "utf8");
      await host.handleOp({ kind: "SendMessage", text: "edit code" });
      expect(calls).toBe(4);
      expect(await readFile(path.join(appDataDir, "code.js"), "utf8")).toBe("alpha external change");
      expect(events.find((event) => event.type === "tool-state" && event.toolCallId === "file-2" && event.state === "failed")).toMatchObject({ summary: expect.stringContaining("重新 read") });
    } finally {
      await rm(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    ["deepseek", "https://api.deepseek.com/v1", "deepseek-chat", false],
    ["mimo", "https://api.xiaomimimo.com/v1", "mimo-v2.5-pro", false],
    ["mimo", "https://api.xiaomimimo.com/v1", "mimo-v2.5-pro", true],
  ] as const)("Ultra %s executes a child research run with native thinking parameters (%s, %s, plan=%s)", async (providerId, baseUrl, model, planning) => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "entrotect-host-ultra-"));
    const events: AppEvent[] = [];
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamResponse(calls.length === 1);
    }) as typeof fetch;

    try {
      const host = new SessionHost({
        appDataDir,
        getWindow: () => fakeWindow(events),
      });
      await host.init();
      const config = configFor(providerId, baseUrl, model);
      config.reasoningEffort = "ultra";
      config.providers![0]!.modelReasoningLevels = { [model]: ["low", "high", "max"] };
      await host.handleOp({ kind: "SetConfig", config });
      await host.handleOp({ kind: "NewSession" });
      if (planning) await host.handleOp({ kind: "SendMessage", text: "/plan" });
      await host.handleOp({ kind: "SendMessage", text: "调研类人脑 Agent 记忆系统的现有产品和开源项目" });

      expect(calls).toHaveLength(3); // parent dispatch, real child run, parent synthesis
      for (const call of calls) {
        if (providerId === "mimo") {
          expect(call.thinking).toEqual({ type: "enabled" });
          expect(call.reasoning_effort).toBe("high");
          expect(call.max_completion_tokens).toBe(131072);
        } else expect(call.reasoning_effort).toBe("max");
      }
      const serialized = JSON.stringify(calls[0]?.messages);
      expect(serialized).toContain("<ultra_mode>");
      expect(serialized).toContain("至少调用一次 task");
      const toolNames = (index: number) => (calls[index]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
      expect(toolNames(0)).toEqual(["task", "ultra_direct"]);
      expect(toolNames(1)).not.toContain("task");
      expect(toolNames(1)).not.toContain("ultra_direct");
      expect(JSON.stringify(calls[1]?.messages)).not.toContain("<ultra_mode>");
      expect(toolNames(2)).toContain("websearch");
      expect(JSON.stringify(calls[2]?.messages)).toContain("delegate research");
      expect(events.some((event) => event.type === "subagent-part")).toBe(true);
      if (planning) {
        expect(JSON.stringify(calls[1]?.messages)).toContain("<plan_mode>");
        for (const index of [1, 2]) {
          for (const forbidden of ["write", "edit", "generate_image", "todowrite", "kill_shell"]) {
            expect(toolNames(index)).not.toContain(forbidden);
          }
        }
      }
    } finally {
      await rm(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("captures SendMessage config before SetConfig and orders config before its turn", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "entrotect-host-context-"));
    const events: AppEvent[] = [];
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return streamResponse();
    }) as typeof fetch;

    try {
      const host = new SessionHost({
        appDataDir,
        getWindow: () => fakeWindow(events),
      });
      await host.init();

      const configA = configFor("provider-a", "https://provider-a.example/v1", "model-a");
      const configB = configFor("provider-b", "https://provider-b.example/v1", "model-b");
      await host.handleOp({ kind: "SetConfig", config: configA });
      await host.handleOp({ kind: "NewSession" });
      events.length = 0;

      const sendPromise = host.handleOp({ kind: "SendMessage", text: "use A" });
      const setConfigPromise = host.handleOp({ kind: "SetConfig", config: configB });
      await Promise.all([sendPromise, setConfigPromise]);

      const registration = events.find((event) => event.type === "run-registered");
      const turnStarted = events.find((event) => event.type === "turn-started");
      const configIndex = events.findIndex(
        (event) => event.type === "config" && event.config.model === "model-b",
      );
      const turnIndex = events.findIndex((event) => event.type === "turn-started");

      expect(registration).toMatchObject({
        type: "run-registered",
        providerId: "provider-a",
        model: "model-a",
      });
      expect(turnStarted).toMatchObject({
        type: "turn-started",
        runId: (registration as { runId: string }).runId,
        providerId: "provider-a",
        model: "model-a",
      });
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(configIndex).toBeLessThan(turnIndex);
      expect(calls[0]?.url).toBe("https://provider-a.example/v1/chat/completions");
      expect(calls[0]?.body).toMatchObject({
        model: "model-a",
        temperature: 0.25,
        reasoning_effort: "low",
      });
      // catalog 未知模型不发送 max_tokens,避免猜错上限
      expect(calls[0]?.body).not.toHaveProperty("max_tokens");
    } finally {
      await rm(appDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
