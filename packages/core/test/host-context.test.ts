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

function streamResponse(): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
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

function configFor(
  providerId: string,
  baseUrl: string,
  model: string,
  maxTokens: number,
): AppConfig {
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
    maxTokens,
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

      const configA = configFor("provider-a", "https://provider-a.example/v1", "model-a", 111);
      const configB = configFor("provider-b", "https://provider-b.example/v1", "model-b", 999);
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
        max_tokens: 111,
        temperature: 0.25,
        reasoning_effort: "low",
      });
    } finally {
      await rm(appDataDir, { recursive: true, force: true });
    }
  });
});
