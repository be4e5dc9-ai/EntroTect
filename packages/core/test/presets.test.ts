import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../src/provider/presets.js";

describe("presets", () => {
  it("contains deepseek with correct modelsUrl", () => {
    expect(PROVIDER_PRESETS.find((p) => p.id === "deepseek")!.modelsUrl).toBe(
      "https://api.deepseek.com/models",
    );
  });

  it("has 8-12 entries with required fields", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(PROVIDER_PRESETS.length).toBeLessThanOrEqual(12);
    for (const p of PROVIDER_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.baseUrl).toBeTruthy();
      expect(p.category).toBeDefined();
      expect(["official", "cn_official", "cloud", "aggregator"]).toContain(p.category);
      if (p.apiFormat !== undefined) {
        expect(["openai", "anthropic", "google"]).toContain(p.apiFormat);
      }
      expect(p.icon).toBeDefined();
      expect(typeof p.icon).toBe("string");
      expect(p.modelsUrl).toBeDefined();
      expect(p.builtin).toBe(true);
    }
  });

  it("all ids are unique", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
