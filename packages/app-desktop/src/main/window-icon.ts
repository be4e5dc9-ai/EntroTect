import { nativeImage } from "electron";
import {
  DEFAULT_ACCENT_COLOR,
  deriveAccentTokens,
  normalizeAccentColor,
} from "../appearance.js";

export function accentIconSvg(color: string): string {
  const accent = normalizeAccentColor(color) ?? DEFAULT_ACCENT_COLOR;
  const { accentStrong } = deriveAccentTokens(accent, "dark");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="accent-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" />
      <stop offset="100%" stop-color="${accentStrong}" />
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#accent-gradient)" />
  <path
    d="M307 307H717 M307 512H676 M307 717H717 M307 251V773"
    fill="none"
    stroke="#FFFFFF"
    stroke-width="112"
    stroke-linecap="butt"
    stroke-linejoin="miter"
  />
  <path d="M717 190L818 408L717 475Z" fill="${accent}" />
</svg>`;
}

export function createAccentWindowIcon(color: string): Electron.NativeImage {
  const svg = accentIconSvg(color);
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
}
