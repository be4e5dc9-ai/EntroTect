import { describe, expect, it } from "vitest";
import { catalog, getCatalogEntry } from "../src/provider/catalog.js";
describe("catalog", () => {
  it("contains canonical deepseek and anthropic entries", () => {
    expect(catalog["deepseek/deepseek-v4-pro"].capabilities.contextWindow).toBe(1_000_000);
    expect(catalog["anthropic/claude-opus-5"].capabilities.contextWindow).toBe(1_000_000);
  });
  it("contains boundary entries amazon and zai with correct windows", () => {
    expect(catalog["amazon/nova-pro"].capabilities.contextWindow).toBe(300_000);
    expect(catalog["amazon/nova-pro"].capabilities.maxTokens).toBe(8_192);
    expect(catalog["zai/glm-5.2"].capabilities.contextWindow).toBe(1_000_000);
    expect(catalog["zai/glm-5.2"].capabilities.maxTokens).toBe(131_072);
  });
  it("getCatalogEntry returns same reference as catalog", () => {
    expect(getCatalogEntry("deepseek/deepseek-v4-pro")).toBe(catalog["deepseek/deepseek-v4-pro"]);
    expect(getCatalogEntry("moonshotai/kimi-k3")?.capabilities.contextWindow).toBe(1_048_576);
  });
  it("getCatalogEntry returns undefined for unknown", () => {
    expect(getCatalogEntry("unknown/foo")).toBeUndefined();
  });
});
