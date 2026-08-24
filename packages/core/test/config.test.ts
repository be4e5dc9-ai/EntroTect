import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { PROVIDER_PRESETS } from "../src/provider/presets.js";
import type { AppConfig } from "@entrotect/shared";describe("config 持久化回环", () => {
  it("showReasoning / reasoningEffort / permissionMode 落盘后可完整读回(回归:曾丢失)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      showReasoning: true,
      reasoningEffort: "max",
      permissionMode: "ask",
    };
    await saveConfig(dir, config);
    const loaded = await loadConfig(dir);
    expect(loaded.showReasoning).toBe(true);
    expect(loaded.reasoningEffort).toBe("max");
    expect(loaded.permissionMode).toBe("ask");
  });

  it("旧文件缺失新字段时回退默认值", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    await saveConfig(dir, {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
    } as AppConfig);
    const loaded = await loadConfig(dir);
    expect(loaded.showReasoning).toBe(false);
    expect(loaded.reasoningEffort).toBe("high");
    expect(loaded.permissionMode).toBe("write");
  });
});

describe("config 多供应商迁移与回环", () => {
  it("旧配置(无 providers)迁移:生成预设、旧 key 注入 deepseek、activeProviderId=deepseek", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    await saveConfig(dir, {
      baseUrl: "https://legacy.example/v1",
      apiKey: "sk-legacy",
      model: "legacy-model",
    } as AppConfig);
    const loaded = await loadConfig(dir);

    expect(loaded.providers).toHaveLength(PROVIDER_PRESETS.length);
    const ids = loaded.providers?.map((p) => p.id);
    expect(ids).toEqual(PROVIDER_PRESETS.map((p) => p.id));
    expect(loaded.providers?.every((p) => p.builtin === true)).toBe(true);
    // deepseek 的 modelsUrl 等预设字段应完整保留
    expect(loaded.providers?.find((p) => p.id === "deepseek")?.modelsUrl).toBe(
      PROVIDER_PRESETS.find((p) => p.id === "deepseek")?.modelsUrl,
    );

    // 旧字段注入 deepseek 条目
    const deepseek = loaded.providers?.find((p) => p.id === "deepseek");
    expect(deepseek?.baseUrl).toBe("https://legacy.example/v1");
    expect(deepseek?.apiKey).toBe("sk-legacy");
    expect(deepseek?.models).toEqual(["legacy-model"]);

    expect(loaded.activeProviderId).toBe("deepseek");
    // 顶层 compat 字段保持原值(model 仍与迁移前一致)
    expect(loaded.model).toBe("legacy-model");
  });

  it("providers 完整回环:自定义条目与 activeProviderId 保留,缺预设补默认", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    const custom = {
      id: "custom-1234abcd",
      name: "我的网关",
      baseUrl: "https://gw.example/v1",
      apiKey: "sk-custom",
      models: ["gw-model-a", "gw-model-b"],
    };
    await saveConfig(dir, {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: "gw-model-a",
      providers: [
        custom,
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-deepseek",
          models: ["deepseek-chat"],
          builtin: true,
        },
      ],
      activeProviderId: "custom-1234abcd",
    });

    const loaded = await loadConfig(dir);
    expect(loaded.activeProviderId).toBe("custom-1234abcd");
    // 自定义条目原样保留(含模型列表)
    const loadedCustom = loaded.providers?.find((p) => p.id === "custom-1234abcd");
    expect(loadedCustom).toEqual(custom);
    // 文件里缺失的预设补默认
    const ids = loaded.providers?.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("moonshot");
    expect(ids).toContain("ollama");
    // 文件里已有的预设不被默认值覆盖
    expect(loaded.providers?.find((p) => p.id === "deepseek")?.apiKey).toBe("sk-deepseek");
  });

  it("activeProviderId 失效时回退 deepseek", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    await saveConfig(dir, {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: "deepseek-chat",
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "",
          models: [],
          builtin: true,
        },
      ],
      activeProviderId: "custom-gone",
    });
    const loaded = await loadConfig(dir);
    expect(loaded.activeProviderId).toBe("deepseek");
  });
});
