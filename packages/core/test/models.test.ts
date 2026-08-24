import { describe, expect, it } from "vitest";
import type { AppConfig } from "@entrotect/shared";
import { buildModelsUrlCandidates, listModels } from "../src/provider/models.js";

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
    expect(requestInit?.headers).toEqual({ Authorization: "Bearer secret-key" });
    expect((requestInit as RequestInit & { signal?: AbortSignal })?.signal).toBeDefined();
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

describe("buildModelsUrlCandidates", () => {
  it("strips known compat suffix anthropic into root candidates", () => {
    expect(buildModelsUrlCandidates("https://api.deepseek.com/anthropic")).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/models",
    ]);
  });
  it("ends_with version segment v4 uses /models then /v1/models fallback", () => {
    expect(
      buildModelsUrlCandidates("https://open.bigmodel.cn/api/coding/paas/v4"),
    ).toEqual([
      "https://open.bigmodel.cn/api/coding/paas/v4/models",
      "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
    ]);
  });
  it("modelsUrl override returns single candidate", () => {
    expect(
      buildModelsUrlCandidates("https://x.com", "https://override/models"),
    ).toEqual(["https://override/models"]);
  });
  it("plain root produces single v1/models candidate", () => {
    expect(buildModelsUrlCandidates("https://api.example.com")).toEqual([
      "https://api.example.com/v1/models",
    ]);
  });
  it("trims trailing slash", () => {
    expect(buildModelsUrlCandidates("https://api.example.com/")).toEqual([
      "https://api.example.com/v1/models",
    ]);
  });
});

describe("listModels candidate fetch", () => {
  it("tries next candidate on 404 and sorts ids", async () => {
    const urls: string[] = [];
    const cfg: AppConfig & { modelsUrl?: string; apiFormat?: string } = {
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "k",
      model: "m",
    };
    const fetchImpl = async (input: string | URL | Request, _init?: RequestInit) => {
      urls.push(String(input));
      if (urls.length === 1) return response({ error: "not found" }, 404) as unknown as Response;
      return response({ data: [{ id: "b-model" }, { id: "a-model" }] }) as unknown as Response;
    };
    const result = await listModels(cfg as AppConfig, fetchImpl as typeof fetch);
    expect(urls[0]).toBe("https://api.deepseek.com/anthropic/v1/models");
    expect(urls[1]).toBe("https://api.deepseek.com/v1/models");
    expect(result.models).toEqual(["a-model", "b-model"]);
  });

  it("uses x-api-key header for anthropic format", async () => {
    let captured: RequestInit | undefined;
    const cfg: AppConfig & { apiFormat?: string } = {
      baseUrl: "https://api.example.com",
      apiKey: "anth-key",
      model: "m",
      apiFormat: "anthropic",
    };
    await listModels(cfg as AppConfig, async (_input, init) => {
      captured = init;
      return response({ data: [{ id: "m1" }] }) as unknown as Response;
    });
    expect(captured?.headers).toEqual({ "x-api-key": "anth-key" });
    expect(captured?.signal).toBeDefined();
  });

  it("uses x-goog-api-key header for google format", async () => {
    let captured: RequestInit | undefined;
    const cfg: AppConfig & { apiFormat?: string } = {
      baseUrl: "https://api.example.com",
      apiKey: "goog-key",
      model: "m",
      apiFormat: "google",
    };
    await listModels(cfg as AppConfig, async (_input, init) => {
      captured = init;
      return response({ data: [{ id: "m1" }] }) as unknown as Response;
    });
    expect(captured?.headers).toEqual({ "x-goog-api-key": "goog-key" });
  });

  it("overrides to single URL when modelsUrl provided", async () => {
    const urls: string[] = [];
    const cfg: AppConfig & { modelsUrl?: string } = {
      baseUrl: "https://api.example.com/anthropic",
      apiKey: "k",
      model: "m",
      modelsUrl: "https://override.example.com/models",
    };
    await listModels(cfg as AppConfig, async (input) => {
      urls.push(String(input));
      return response({ data: [{ id: "x" }] }) as unknown as Response;
    });
    expect(urls).toEqual(["https://override.example.com/models"]);
  });
});
