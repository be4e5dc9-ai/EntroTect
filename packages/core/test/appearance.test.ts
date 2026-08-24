/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_COLOR,
  deriveAccentTokens,
  normalizeAccentColor,
} from "../../app-desktop/src/appearance.js";
import {
  applyAccentColor,
  readStoredAccentColor,
  readStoredTheme,
} from "../../app-desktop/src/renderer/appearance.js";

describe("appearance tokens", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    document.documentElement.dataset.theme = "dark";
  });

  it("uses lavender as the default and exposes the five presets", () => {
    expect(DEFAULT_ACCENT_COLOR).toBe("#B8A2FF");
    expect(ACCENT_PRESETS.map((preset) => preset.color)).toEqual([
      "#B8A2FF",
      "#7CA7FF",
      "#66C7A5",
      "#F0A36A",
      "#E58BA8",
    ]);
    expect(readStoredAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
  });

  it("normalizes six-digit and three-digit hex colors and rejects invalid values", () => {
    expect(normalizeAccentColor("#b8a2ff")).toBe("#B8A2FF");
    expect(normalizeAccentColor("#abc")).toBe("#AABBCC");
    expect(normalizeAccentColor("purple")).toBeNull();
    expect(normalizeAccentColor("#12345")).toBeNull();
  });

  it("derives theme-aware tokens and readable accent foreground", () => {
    const dark = deriveAccentTokens("#B8A2FF", "dark");
    const light = deriveAccentTokens("#B8A2FF", "light");
    expect(dark.accent).toBe("#B8A2FF");
    expect(dark.accentDim).toMatch(/^rgba\(184, 162, 255, /);
    expect(dark.accentStrong).toBe("#C5B3FF");
    expect(dark.accentStrong).not.toBe(light.accentStrong);
    expect(dark.accentForeground).toBe("#000000");
  });

  it("chooses a WCAG-readable foreground for mid-tone and bright colors", () => {
    expect(deriveAccentTokens("#808080", "dark").accentForeground).toBe("#000000");
    expect(deriveAccentTokens("#808080", "light").accentForeground).toBe("#000000");
    expect(deriveAccentTokens(DEFAULT_ACCENT_COLOR, "dark").accentForeground).toBe("#000000");
  });

  it("applies and persists a valid custom color while invalid storage falls back", () => {
    localStorage.setItem("entrotect-accent-color", "#66c7a5");
    expect(readStoredAccentColor()).toBe("#66C7A5");
    expect(applyAccentColor("#66c7a5", "dark")).toBe("#66C7A5");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#66C7A5");
    expect(document.documentElement.style.getPropertyValue("--accent-foreground")).toBeTruthy();
    localStorage.setItem("entrotect-accent-color", "not-a-color");
    expect(readStoredAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
  });

  it("accepts only light as light theme and defaults all other values to dark", () => {
    localStorage.setItem("entrotect-theme", "light");
    expect(readStoredTheme()).toBe("light");
    localStorage.setItem("entrotect-theme", "contrast");
    expect(readStoredTheme()).toBe("dark");
  });
});
