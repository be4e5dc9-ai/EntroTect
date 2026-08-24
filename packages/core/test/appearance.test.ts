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

function parseHexColor(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const toLinear = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
}

function contrastAgainstWhite(color: string): number {
  const luminance = relativeLuminance(...parseHexColor(color));
  return (1.05 + 0.05) / (luminance + 0.05);
}

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
    expect(dark.accentGlow).toMatch(/^rgba\(184, 162, 255, 0.35\)$/);
    expect(dark.accentStrong).not.toBe(light.accentStrong);
    expect(dark.accentForeground).toBe("#000000");
    expect(light.accent).toBe("#8D6FEA");
    expect(light.accentStrong).toBe("#745BC0");
    expect(light.accentDim).toMatch(/^rgba\(141, 111, 234, 0.1\)$/);
    expect(contrastAgainstWhite(light.accent)).toBeGreaterThanOrEqual(3);
    expect(contrastAgainstWhite(light.accentStrong)).toBeGreaterThanOrEqual(4.5);
    expect(light.accentForeground).toBe("#000000");
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
    const lightTokens = deriveAccentTokens("#66C7A5", "light");
    expect(applyAccentColor("#66c7a5", "light")).toBe("#66C7A5");
    expect(localStorage.getItem("entrotect-accent-color")).toBe("#66C7A5");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(lightTokens.accent);
    expect(document.documentElement.style.getPropertyValue("--accent-dim")).toBe(lightTokens.accentDim);
    expect(document.documentElement.style.getPropertyValue("--accent")).not.toBe("#66C7A5");
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
