import { describe, expect, it } from "vitest";
import { accentIconSvg } from "../../app-desktop/src/main/window-icon.js";

describe("runtime window icon", () => {
  it("uses the normalized accent and no untrusted SVG content", () => {
    const svg = accentIconSvg("#66c7a5");
    expect(svg).toContain('stop-color="#66C7A5"');
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("undefined");
  });

  it("falls back to lavender for invalid colors", () => {
    expect(accentIconSvg("url(javascript:bad)")).toContain('stop-color="#B8A2FF"');
  });
});
