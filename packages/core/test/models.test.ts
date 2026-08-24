import { describe, expect, it } from "vitest";
import type { AppConfig } from "@entrotect/shared";
import { listModels } from "../src/provider/models.js";

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function response(body: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const config: AppConfig = {
  baseUrl: "https://api.example.test/v1/",
  apiKey: "secret-key",
  model: "example-model",
};

describe("listModels", () => {
  it("keeps ids and reads OpenRouter context_length", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await listModels(config, async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({
        data: [{ id: "deepseek/deepseek-chat", context_length: 1000000 }],
      });
    });

    expect(requestUrl).toBe("https://api.example.test/v1/models");
    expect(requestInit).toEqual({ headers: { Authorization: "Bearer secret-key" } });
    expect(result).toEqual({
      models: ["deepseek/deepseek-chat"],
      contextWindows: { "deepseek/deepseek-chat": 1000000 },
    });
  });

  it("ignores missing and invalid context values", async () => {
    const result = await listModels(config, async () =>
      response({
        data: [
          { id: "plain-model" },
          { id: "bad-model", context_length: 0 },
          { id: "negative-model", context_window: -1 },
          { id: "valid-model", max_context_length: 131072 },
        ],
      }),
    );

    expect(result.contextWindows).toEqual({ "valid-model": 131072 });
  });

  it("uses the first positive finite context value", async () => {
    const result = await listModels(config, async () =>
      response({
        data: [
          {
            id: "fallback-model",
            context_length: "invalid",
            context_window: 4096,
            max_context_length: 8192,
          },
          {
            id: "first-model",
            context_length: 4096,
            context_window: 8192,
          },
          {
            id: "non-finite-model",
            context_length: Number.POSITIVE_INFINITY,
            context_window: 2048,
          },
        ],
      }),
    );

    expect(result.contextWindows).toEqual({
      "fallback-model": 4096,
      "first-model": 4096,
      "non-finite-model": 2048,
    });
  });

  it("keeps a standard id-only response compatible", async () => {
    const result = await listModels(config, async () =>
      response({ data: [{ id: "model-a" }, { id: "" }, { id: 42 }] }),
    );

    expect(result).toEqual({ models: ["model-a"], contextWindows: {} });
  });

  it("rejects non-2xx responses", async () => {
    await expect(
      listModels(config, async () => response({ error: "unauthorized" }, 401)),
    ).rejects.toThrow("模型列表接口返回 401");
  });
});
