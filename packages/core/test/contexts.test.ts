import { describe, expect, it } from "vitest";
import {
  knownContextWindow,
  mergeContextWindows,
  suffixContextWindow,
} from "../src/provider/contexts.js";

describe("known context windows", () => {
  it("recognizes common built-in model ids", () => {
    expect(knownContextWindow("deepseek-chat")).toBe(131072);
    expect(knownContextWindow("deepseek-reasoner")).toBe(131072);
    expect(knownContextWindow("gpt-4o")).toBe(128000);
    expect(knownContextWindow("kimi-k2-0711")).toBe(131072);
    expect(knownContextWindow("claude-sonnet-4-20250514")).toBe(200000);
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
        ["deepseek-chat", "custom-256k", "api-model"],
        { "api-model": 64000 },
      ),
    ).toEqual({
      "deepseek-chat": 131072,
      "custom-256k": 262144,
      "api-model": 64000,
    });
  });

  it("returns empty map when nothing is known", () => {
    expect(mergeContextWindows(["mystery-model"], {})).toEqual({});
  });
});
