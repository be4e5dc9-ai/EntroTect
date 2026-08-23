import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import type { AppConfig } from "@entrotect/shared";

describe("config 持久化回环", () => {
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
