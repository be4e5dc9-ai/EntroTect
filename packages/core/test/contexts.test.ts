import { describe, expect, it } from "vitest";
import {
  knownContextWindow,
  mergeContextWindows,
  suffixContextWindow,
} from "../src/provider/contexts.js";

describe("known context windows", () => {
  it("recognizes catalog-derived model ids", () => {
    expect(knownContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(knownContextWindow("claude-opus-5")).toBe(1_000_000);
    expect(knownContextWindow("kimi-k3")).toBe(1_048_576);
    expect(knownContextWindow("gpt-5")).toBe(400_000);
    expect(knownContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(knownContextWindow("definitely-unknown-hardware-model")).toBeUndefined();
  });
});

describe("suffix context windows", () => {
  it("parses k/m suffixes from model ids", () => {
    expect(suffixContextWindow("my-proxy-v3-128k")).toBe(131072);
    expect(suffixContextWindow("deepseek-v4-pro-1m")).toBe(1000000);
    expect(suffixContextWindow("local-32k")).toBe(32768);
    expect(suffixContextWindow("plain-model")).toBeUndefined();
    expect(suffixContextWindow("text-model-75b")).toBeUndefined();
    expect(suffixContextWindow("")).toBeUndefined();
  });
});

describe("mergeContextWindows", () => {
  it("keeps api metadata and fills known/suffix fallbacks", () => {
    expect(
      mergeContextWindows(
        ["deepseek-v4-pro", "custom-256k", "api-model"],
        { "api-model": 64000 },
      ),
    ).toEqual({
      "deepseek-v4-pro": 1_000_000,
      "custom-256k": 262144,
      "api-model": 64000,
    });
  });

  it("returns empty map when nothing is known", () => {
    expect(mergeContextWindows(["mystery-model"], {})).toEqual({});
  });
});
