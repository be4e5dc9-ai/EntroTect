import { describe, expect, it } from "vitest";
import {
  clampEffort,
  defaultForModel,
  getPresetEfforts,
  getSupportedEffortsForModel,
  isReasoningEffort,
} from "@entrotect/shared";
import type { AppConfig } from "@entrotect/shared";

describe("reasoning canonical 校验与预设", () => {
  it("isReasoningEffort 过滤未知值", () => {
    expect(isReasoningEffort("low")).toBe(true);
    expect(isReasoningEffort("medium")).toBe(true);
    expect(isReasoningEffort("off")).toBe(true);
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(isReasoningEffort("")).toBe(false);
  });

  it("deepseek-v4-* preset 为 low|high|max", () => {
    expect(getPresetEfforts("deepseek-v4-pro")).toEqual(["low", "high", "max"]);
    expect(getPresetEfforts("deepseek-chat")).toEqual(["low", "high", "max"]);
    expect(getPresetEfforts("deepseek-reasoner")).toEqual(["low", "high", "max"]);
  });

  it("kimi-k3 preset 为 low|high|max 且 kimi-k2.6 为空", () => {
    expect(getPresetEfforts("moonshotai/kimi-k3")).toEqual(["low", "high", "max"]);
    expect(getPresetEfforts("kimi-k2.6")).toEqual([]);
    expect(getPresetEfforts("kimi-k2.7-code")).toEqual([]);
  });

  it("qwen3.8-max 全档位，其他 qwen 为空", () => {
    expect(getPresetEfforts("qwen3.8-max")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getPresetEfforts("qwen/qwen3.8-max-preview")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getPresetEfforts("qwen3-coder-plus")).toEqual([]);
    expect(getPresetEfforts("qwen/qwen3-coder-480b")).toEqual([]);
  });

  it("glm-5.2 为 high|max", () => {
    expect(getPresetEfforts("zai/glm-5.2")).toEqual(["high", "max"]);
    expect(getPresetEfforts("glm-5.1")).toEqual(["high", "max"]);
  });

  it("claude-opus 全档位，sonnet/haiku 三档", () => {
    expect(getPresetEfforts("anthropic/claude-opus-4.7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getPresetEfforts("claude-sonnet-4.6")).toEqual(["low", "medium", "high"]);
    expect(getPresetEfforts("claude-haiku-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("gpt-5 含 off 全档位", () => {
    expect(getPresetEfforts("openai/gpt-5.6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getPresetEfforts("gpt-5-mini")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("getSupportedEffortsForModel", () => {
  it("声明集优先于 preset", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-chat",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          models: ["deepseek-chat"],
          modelReasoningLevels: { "deepseek-chat": ["low", "max"] },
          modelReasoningDefaults: { "deepseek-chat": "max" },
        },
      ],
      activeProviderId: "deepseek",
    };
    const supported = getSupportedEffortsForModel(config, "deepseek", "deepseek-chat");
    expect(supported).toEqual(["low", "max"]);
  });

  it("无声明时回退到 preset", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-chat",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          models: ["deepseek-chat"],
        },
      ],
      activeProviderId: "deepseek",
    };
    expect(getSupportedEffortsForModel(config, "deepseek", "deepseek-chat")).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("未知 effort 已在 sanization 丢弃（模拟 declared 含非法值）", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "my-model",
      providers: [
        {
          id: "custom",
          name: "Custom",
          baseUrl: "https://example.test/v1",
          apiKey: "",
          models: ["my-model"],
          // @ts-expect-error 故意插入非法值测试过滤
          modelReasoningLevels: { "my-model": ["low", "ultra", "high"] },
        },
      ],
      activeProviderId: "custom",
    };
    // getSupported 会过滤掉 ultra
    const supported = getSupportedEffortsForModel(config, "custom", "my-model");
    expect(supported).toEqual(["low", "high"]);
  });

  it("未知模型回退到通用五档", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "unknown-model-xyz",
      providers: [
        {
          id: "custom",
          name: "Custom",
          baseUrl: "https://example.test/v1",
          apiKey: "",
          models: ["unknown-model-xyz"],
        },
      ],
      activeProviderId: "custom",
    };
    expect(getSupportedEffortsForModel(config, "custom", "unknown-model-xyz")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("布尔 thinking 模型返回空数组", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "kimi-k2.6",
      providers: [
        {
          id: "moonshot",
          name: "Moonshot",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKey: "",
          models: ["kimi-k2.6"],
        },
      ],
      activeProviderId: "moonshot",
    };
    expect(getSupportedEffortsForModel(config, "moonshot", "kimi-k2.6")).toEqual([]);
  });
});

describe("clampEffort rank-based", () => {
  it("命中直接返回", () => {
    expect(clampEffort("high", ["low", "high", "max"])).toBe("high");
  });

  it("deepseek 三档：medium/xhigh -> high", () => {
    const supported = ["low", "high", "max"] as const;
    expect(clampEffort("medium", [...supported])).toBe("high");
    expect(clampEffort("xhigh", [...supported])).toBe("high");
  });

  it("有硬上限时向下走", () => {
    // supported max 为 xhigh，请求 max 应 clamp 到 xhigh
    expect(clampEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
  });

  it("取 ≤ 请求的最近档", () => {
    // supported low/medium/high，请求 xhigh(60) -> high(40)
    expect(clampEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    // 请求 high(40) -> high
    expect(clampEffort("high", ["low", "medium", "high"])).toBe("high");
    // 请求 low(20) -> low
    expect(clampEffort("low", ["medium", "high", "max"])).toBe("medium"); // 无 floor，回退最小
  });

  it("off 仅在支持时保留，否则回退到最低", () => {
    expect(clampEffort("off", ["off", "low", "high"])).toBe("off");
    expect(clampEffort("off", ["low", "high", "max"])).toBe("low");
  });

  it("空 supported 返回原请求", () => {
    expect(clampEffort("high", [])).toBe("high");
  });
});

describe("defaultForModel", () => {
  it("声明 default 命中则使用", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-chat",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          models: ["deepseek-chat"],
          modelReasoningLevels: { "deepseek-chat": ["low", "high", "max"] },
          modelReasoningDefaults: { "deepseek-chat": "max" },
        },
      ],
      activeProviderId: "deepseek",
    };
    expect(defaultForModel(config, "deepseek", "deepseek-chat")).toBe("max");
  });

  it("声明 default 不在子集时回退到最高档", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "deepseek-chat",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          models: ["deepseek-chat"],
          modelReasoningLevels: { "deepseek-chat": ["low", "high"] },
          // @ts-expect-error 非法 default
          modelReasoningDefaults: { "deepseek-chat": "max" },
        },
      ],
      activeProviderId: "deepseek",
    };
    // max 不在 [low,high]，回退到 high（最高）
    expect(defaultForModel(config, "deepseek", "deepseek-chat")).toBe("high");
  });

  it("无声明 default 回退到 preset 默认", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "kimi-k3",
      providers: [
        {
          id: "moonshot",
          name: "Moonshot",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKey: "",
          models: ["kimi-k3"],
        },
      ],
      activeProviderId: "moonshot",
    };
    expect(defaultForModel(config, "moonshot", "kimi-k3")).toBe("max");
  });

  it("未知模型回退到通用最高档", () => {
    const config: AppConfig = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "unknown-model",
      providers: [
        {
          id: "custom",
          name: "Custom",
          baseUrl: "https://example.test/v1",
          apiKey: "",
          models: ["unknown-model"],
        },
      ],
      activeProviderId: "custom",
    };
    expect(defaultForModel(config, "custom", "unknown-model")).toBe("max");
  });
});
