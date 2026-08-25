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

  it("reasoningEffort medium 落盘回环", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      reasoningEffort: "medium",
    };
    await saveConfig(dir, config);
    const loaded = await loadConfig(dir);
    expect(loaded.reasoningEffort).toBe("medium");
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

describe("per-model reasoning levels 持久化与预设", () => {
  it("modelReasoningLevels / modelReasoningDefaults 回环", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    await saveConfig(dir, {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: "deepseek-chat",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          models: ["deepseek-chat"],
          modelReasoningLevels: { "deepseek-chat": ["low", "high", "max"] },
          modelReasoningDefaults: { "deepseek-chat": "high" },
          builtin: true,
        },
      ],
      activeProviderId: "deepseek",
    } as AppConfig);
    const loaded = await loadConfig(dir);
    const p = loaded.providers?.find((x) => x.id === "deepseek");
    expect(p?.modelReasoningLevels?.["deepseek-chat"]).toEqual(["low", "high", "max"]);
    expect(p?.modelReasoningDefaults?.["deepseek-chat"]).toBe("high");
  });

  it("未知 effort 值直接丢弃", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    // 直接写文件以绕过 zod 校验，模拟旧文件含非法值
    const raw = JSON.stringify({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      providers: [
        {
          id: "custom",
          name: "Custom",
          baseUrl: "https://example.test/v1",
          apiKey: "",
          models: ["my-model"],
          // @ts-expect-error 非法值
          modelReasoningLevels: { "my-model": ["low", "ultra", "high"] },
          modelReasoningDefaults: { "my-model": "ultra" },
        },
      ],
      activeProviderId: "custom",
    });
    const { writeFile } = await import("node:fs/promises");
    const { configFilePath } = await import("../src/config.js");
    await writeFile(configFilePath(dir), raw, "utf8");
    const loaded = await loadConfig(dir);
    const p = loaded.providers?.find((x) => x.id === "custom");
    expect(p?.modelReasoningLevels?.["my-model"]).toEqual(["low", "high"]);
    // default 非法值被丢弃，回退到最高档 high
    expect(p?.modelReasoningDefaults?.["my-model"]).toBe("high");
  });

  it("预设自动填充：deepseek-chat / kimi-k3 / qwen3.8-max", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    await saveConfig(dir, {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-chat",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          models: ["deepseek-chat", "deepseek-reasoner", "unknown-model-xyz"],
          builtin: true,
        },
        {
          id: "moonshot",
          name: "Moonshot",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKey: "",
          models: ["moonshotai/kimi-k3", "kimi-k2.6"],
          builtin: true,
        },
        {
          id: "qwen",
          name: "Qwen",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          apiKey: "",
          models: ["qwen3.8-max", "qwen3-coder-plus"],
          builtin: true,
        },
      ],
      activeProviderId: "deepseek",
    } as AppConfig);
    const loaded = await loadConfig(dir);
    const deepseek = loaded.providers?.find((p) => p.id === "deepseek");
    expect(deepseek?.modelReasoningLevels?.["deepseek-chat"]).toEqual(["low", "high", "max"]);
    expect(deepseek?.modelReasoningLevels?.["unknown-model-xyz"]).toBeUndefined();
    const moonshot = loaded.providers?.find((p) => p.id === "moonshot");
    expect(moonshot?.modelReasoningLevels?.["moonshotai/kimi-k3"]).toEqual(["low", "high", "max"]);
    expect(moonshot?.modelReasoningLevels?.["kimi-k2.6"]).toEqual([]);
    const qwen = loaded.providers?.find((p) => p.id === "qwen");
    expect(qwen?.modelReasoningLevels?.["qwen3.8-max"]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(qwen?.modelReasoningLevels?.["qwen3-coder-plus"]).toEqual([]);
  });

  it("default 回退到过滤后集合的最高档", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-config-"));
    const raw = JSON.stringify({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      providers: [
        {
          id: "custom",
          name: "Custom",
          baseUrl: "https://example.test/v1",
          apiKey: "",
          models: ["my-model"],
          modelReasoningLevels: { "my-model": ["low", "high"] },
          modelReasoningDefaults: { "my-model": "max" },
        },
      ],
      activeProviderId: "custom",
    });
    const { writeFile } = await import("node:fs/promises");
    const { configFilePath } = await import("../src/config.js");
    await writeFile(configFilePath(dir), raw, "utf8");
    const loaded = await loadConfig(dir);
    const p = loaded.providers?.find((x) => x.id === "custom");
    expect(p?.modelReasoningDefaults?.["my-model"]).toBe("high");
  });
});
