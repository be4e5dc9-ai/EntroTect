import {
  DEFAULT_ACCENT_COLOR,
  deriveAccentTokens,
  normalizeAccentColor,
} from "../appearance";
import type { Theme } from "../appearance";

const THEME_STORAGE_KEY = "entrotect-theme";
const ACCENT_STORAGE_KEY = "entrotect-accent-color";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private or restricted renderer contexts.
  }
}

export function readStoredTheme(): Theme {
  return readStorage(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

export function readStoredAccentColor(): string {
  return normalizeAccentColor(readStorage(ACCENT_STORAGE_KEY) ?? "") ?? DEFAULT_ACCENT_COLOR;
}

export function applyAccentColor(color: string, theme: Theme): string {
  const normalized = normalizeAccentColor(color) ?? DEFAULT_ACCENT_COLOR;
  const tokens = deriveAccentTokens(normalized, theme);
  const style = document.documentElement.style;
  style.setProperty("--accent", tokens.accent);
  style.setProperty("--accent-strong", tokens.accentStrong);
  style.setProperty("--accent-dim", tokens.accentDim);
  style.setProperty("--accent-glow", tokens.accentGlow);
  style.setProperty("--accent-foreground", tokens.accentForeground);
  writeStorage(ACCENT_STORAGE_KEY, normalized);
  return normalized;
}

export function applyTheme(theme: Theme, accentColor: string): void {
  document.documentElement.dataset.theme = theme;
  writeStorage(THEME_STORAGE_KEY, theme);
  applyAccentColor(accentColor, theme);
}
