# Appearance Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted Appearance settings page for theme and accent color, make runtime brand artwork follow the selected accent, and replace packaged purple artwork with lavender purple.

**Architecture:** Keep appearance preferences in renderer localStorage, with a pure color-token module shared by renderer and Electron main code. The renderer applies CSS variables and SVG brand marks immediately; a typed preload IPC forwards the validated accent to the main process for the current window icon. Packaged artwork remains a generated lavender-purple default.

**Tech Stack:** React 19, TypeScript 5.9, Zustand 5, Vitest/jsdom, Electron 37, Vite, esbuild, Pillow.

## Global Constraints

- The settings primary navigation order is `供应商` → `外观` → `通用`.
- On a first visit, `供应商` is selected; an existing `entrotect-settings-primary` value continues to be honored.
- The default accent is lavender purple `#B8A2FF`.
- Presets are lavender purple `#B8A2FF`, sky blue `#7CA7FF`, mint green `#66C7A5`, peach orange `#F0A36A`, and rose pink `#E58BA8`.
- Only accent-colored UI follows the selected color; success, warning, and danger semantic colors remain independent.
- Theme and accent changes apply immediately and persist in `localStorage` without the provider/general `保存` action.
- Runtime in-app and current-window artwork follows the custom accent; desktop shortcut and installer artwork remain fixed at the default lavender purple.
- Existing theme persistence remains under `entrotect-theme`; accent persistence uses `entrotect-accent-color`.
- No system theme, semantic-color editing, runtime shortcut rewriting, or provider configuration changes.
- Do not add a dependency for color parsing or icon generation.

---

## File Map

- Create `packages/app-desktop/src/appearance.ts` for pure theme/accent types, presets, validation, and derived accent token values shared by renderer and main process.
- Create `packages/app-desktop/src/renderer/appearance.ts` for safe localStorage reads and DOM CSS-token application.
- Create `packages/app-desktop/src/renderer/components/BrandMark.tsx` for the runtime SVG brand mark.
- Create `packages/app-desktop/src/main/window-icon.ts` for validated runtime Electron icon SVG/native-image creation.
- Create `packages/core/test/appearance.test.ts` for pure color behavior and DOM token application tests.
- Modify `packages/app-desktop/src/renderer/store.ts` to hold `accentColor` and re-export the existing `Theme` type.
- Modify `packages/app-desktop/src/renderer/main.tsx` to apply stored theme/accent before React renders and synchronize the main process.
- Modify `packages/app-desktop/src/renderer/components/SettingsPage.tsx` to add the Appearance primary item and controls.
- Modify `packages/app-desktop/src/renderer/components/Sidebar.tsx` to remove the standalone theme control.
- Modify `packages/app-desktop/src/renderer/components/MessageList.tsx` to use `BrandMark` instead of the static renderer PNG.
- Modify `packages/app-desktop/src/renderer/styles/base.css` and `packages/app-desktop/src/renderer/styles/app.css` for lavender defaults and Appearance controls.
- Modify `packages/app-desktop/src/renderer/bridge.ts`, `packages/app-desktop/src/preload/preload.ts`, and `packages/app-desktop/src/main/main.ts` for the runtime icon IPC.
- Modify `tools/assets/gen_icons.py` and regenerate the five tracked files in `packages/app-desktop/build/`.
- Modify `packages/core/test/settings-nav.test.tsx` for navigation, theme, accent, and Sidebar behavior.
- Modify `packages/app-desktop/package.json` only during the final release task to set version `0.2.11`.

---

### Task 1: Add Pure Appearance Tokens and Persistence Helpers

**Files:**
- Create: `packages/app-desktop/src/appearance.ts`
- Create: `packages/app-desktop/src/renderer/appearance.ts`
- Modify: `packages/app-desktop/src/renderer/store.ts:69,154,183`
- Test: `packages/core/test/appearance.test.ts`

**Interfaces:**
- Produces `Theme = "dark" | "light"` from `src/appearance.ts`.
- Produces `DEFAULT_ACCENT_COLOR`, `ACCENT_PRESETS`, `normalizeAccentColor(value)`, and `deriveAccentTokens(color, theme)` from `src/appearance.ts`.
- Produces `readStoredTheme()`, `readStoredAccentColor()`, `applyAccentColor(color, theme)`, and `applyTheme(theme, accentColor)` from `src/renderer/appearance.ts`.
- `deriveAccentTokens` returns `{ accent, accentStrong, accentDim, accentGlow, accentForeground }` as strings.
- `applyAccentColor` returns the normalized color it applied and sets exactly `--accent`, `--accent-strong`, `--accent-dim`, `--accent-glow`, and `--accent-foreground` on `document.documentElement.style`.

- [ ] **Step 1: Write failing pure-token and DOM tests**

Create `packages/core/test/appearance.test.ts` with the jsdom environment and these behaviors:

```tsx
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
    expect(dark.accentStrong).not.toBe(light.accentStrong);
    expect(dark.accentForeground).toBe("#241D34");
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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @entrotect/core exec vitest run test/appearance.test.ts`

Expected: FAIL because the appearance modules and exports do not exist.

- [ ] **Step 3: Implement the pure module and renderer adapter**

In `src/appearance.ts`, validate only `#rgb`/`#rrggbb`, normalize to uppercase, and derive values without a dependency. Use these exact derivation rules:

```ts
export type Theme = "dark" | "light";
export const DEFAULT_ACCENT_COLOR = "#B8A2FF";
export const ACCENT_PRESETS = [
  { id: "lavender", label: "薰衣草紫", color: "#B8A2FF" },
  { id: "sky", label: "天空蓝", color: "#7CA7FF" },
  { id: "mint", label: "薄荷绿", color: "#66C7A5" },
  { id: "peach", label: "蜜桃橙", color: "#F0A36A" },
  { id: "rose", label: "玫瑰粉", color: "#E58BA8" },
] as const;

export interface AccentTokens {
  accent: string;
  accentStrong: string;
  accentDim: string;
  accentGlow: string;
  accentForeground: string;
}
```

`deriveAccentTokens(color, "dark")` mixes the base 18% toward white for `accentStrong`, uses alpha `.14` for `accentDim`, and `.35` for `accentGlow`. The light variant mixes 18% toward black and uses alpha `.10` and `.25`. Use relative luminance; return `#241D34` for a luminance above `0.55`, otherwise `#FFFFFF` for `accentForeground`.

In `src/renderer/appearance.ts`, wrap localStorage access in `try/catch`, use keys `entrotect-theme` and `entrotect-accent-color`, and make `applyTheme` set `data-theme` before calling `applyAccentColor`. `applyAccentColor` must apply all five returned values as inline custom properties.

Add `accentColor: string` with value `DEFAULT_ACCENT_COLOR` to the Zustand state. Import the pure `Theme` type and keep `export type Theme = AppearanceTheme` in `store.ts` so current imports remain valid.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter @entrotect/core exec vitest run test/appearance.test.ts`

Expected: PASS for all appearance tests.

- [ ] **Step 5: Commit the token foundation**

```powershell
git add packages/app-desktop/src/appearance.ts packages/app-desktop/src/renderer/appearance.ts packages/app-desktop/src/renderer/store.ts packages/core/test/appearance.test.ts
git commit -m "feat: add persisted appearance color tokens"
```

---

### Task 2: Add Typed Runtime Window-Icon IPC

**Files:**
- Create: `packages/app-desktop/src/main/window-icon.ts`
- Modify: `packages/app-desktop/src/renderer/bridge.ts:7-12`
- Modify: `packages/app-desktop/src/preload/preload.ts:8-13,15-30`
- Modify: `packages/app-desktop/src/main/main.ts:5,13-35,64-73`
- Test: `packages/core/test/window-icon.test.ts`

**Interfaces:**
- `EntroTectBridge.setAccentColor(color: string): void` is exposed in both renderer and preload bridge declarations.
- `createAccentWindowIcon(color: string): Electron.NativeImage` is exported from `src/main/window-icon.ts`.
- Invalid colors are ignored by the IPC handler and never interpolated into the SVG.

- [ ] **Step 1: Write a failing icon SVG test**

Create `packages/core/test/window-icon.test.ts` as a Node test:

```ts
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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @entrotect/core exec vitest run test/window-icon.test.ts`

Expected: FAIL because `window-icon.ts` and `accentIconSvg` do not exist.

- [ ] **Step 3: Implement the IPC and icon factory**

In `window-icon.ts`, import `nativeImage` from Electron and `normalizeAccentColor`, `DEFAULT_ACCENT_COLOR`, and `deriveAccentTokens` from `src/appearance.ts`. Export `accentIconSvg(color)` that normalizes invalid input to the default, uses the normalized `accent` and dark `accentStrong` in a 1024x1024 rounded-square SVG, and draws the existing white EntroTect E mark. Export `createAccentWindowIcon(color)` as:

```ts
export function createAccentWindowIcon(color: string): Electron.NativeImage {
  const svg = accentIconSvg(color);
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
}
```

Add `setAccentColor` to both bridge interfaces and implement it in preload with `void ipcRenderer.invoke("entrotect:set-accent-color", color)`.

In `main.ts`, import `nativeImage` only through the new helper, register:

```ts
ipcMain.handle("entrotect:set-accent-color", (_event, raw: unknown) => {
  if (typeof raw !== "string" || !mainWindow) return;
  try {
    mainWindow.setIcon(createAccentWindowIcon(raw));
  } catch {
    // A native icon failure must not affect renderer appearance state.
  }
});
```

Keep the BrowserWindow `icon` option pointed at the generated static `build/icon.png`, so the first native icon is always available before renderer IPC arrives. Do not write files in this handler.

- [ ] **Step 4: Run the focused test and desktop typecheck**

Run: `pnpm --filter @entrotect/core exec vitest run test/window-icon.test.ts`

Expected: PASS.

Run: `pnpm --filter @entrotect/app-desktop typecheck`

Expected: PASS with the new bridge and main-process types.

- [ ] **Step 5: Commit the runtime icon bridge**

```powershell
git add packages/app-desktop/src/main/window-icon.ts packages/app-desktop/src/renderer/bridge.ts packages/app-desktop/src/preload/preload.ts packages/app-desktop/src/main/main.ts packages/core/test/window-icon.test.ts
git commit -m "feat: update runtime window icon from accent color"
```

---

### Task 3: Integrate Appearance Bootstrapping and Settings Navigation

**Files:**
- Modify: `packages/app-desktop/src/renderer/main.tsx:14-22`
- Modify: `packages/app-desktop/src/renderer/components/SettingsPage.tsx:14-16,49-56,125-156,302-480`
- Modify: `packages/app-desktop/src/renderer/components/Sidebar.tsx:26-31,67,192-240`
- Modify: `packages/core/test/settings-nav.test.tsx:23-31,71-94,125-142,144-169,244-265`

**Interfaces:**
- `SettingsPage` recognizes `Primary = "providers" | "appearance" | "general"`.
- Appearance controls call `applyTheme`/`applyAccentColor`, update `useStore` state, persist localStorage, and call `bridge().setTheme`/`bridge().setAccentColor`.
- The existing provider/general form save flow remains unchanged.

- [ ] **Step 1: Update tests for the new mock bridge and navigation contract**

In `settings-nav.test.tsx`, add `const setAccentColor = vi.fn()` to `mockBridge`, expose it on `window.entrotect`, and reset `accentColor: "#B8A2FF"` in the store state. Replace the old default-general test with these assertions:

```tsx
it("renders 供应商 first and defaults to provider detail", async () => {
  const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
  render(<SettingsPage />);
  const items = [...document.querySelectorAll(".settings-nav-item")].map((item) => item.textContent);
  expect(items).toEqual(["供应商", "外观", "通用"]);
  expect(document.querySelector(".settings-nav-item.active")?.textContent).toContain("供应商");
  expect(screen.getByText("Base URL")).toBeDefined();
  expect(document.querySelector(".settings-nav-secondary")).not.toBeNull();
});

it("opens Appearance with theme and accent controls", async () => {
  const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
  render(<SettingsPage />);
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  expect(screen.getByRole("radiogroup", { name: "主题" })).toBeDefined();
  expect(screen.getByRole("radio", { name: "日间模式" })).toBeDefined();
  expect(screen.getByRole("radio", { name: "夜间模式" })).toBeDefined();
  expect(screen.getByRole("radiogroup", { name: "强调色" })).toBeDefined();
  expect(screen.getByLabelText("自定义颜色")).toBeDefined();
  expect(document.querySelector(".settings-nav-secondary")).toBeNull();
});

it("switches theme and persists a preset/custom accent immediately", async () => {
  const { SettingsPage } = await import("../../app-desktop/src/renderer/components/SettingsPage.js");
  render(<SettingsPage />);
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  fireEvent.click(screen.getByRole("radio", { name: "日间模式" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("entrotect-theme")).toBe("light");
  fireEvent.click(screen.getByRole("radio", { name: "天空蓝" }));
  expect(localStorage.getItem("entrotect-accent-color")).toBe("#7CA7FF");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#7CA7FF");
  fireEvent.change(screen.getByLabelText("自定义颜色"), { target: { value: "#66c7a5" } });
  expect(localStorage.getItem("entrotect-accent-color")).toBe("#66C7A5");
});

it("removes the standalone theme button from chat Sidebar", async () => {
  const { App } = await import("../../app-desktop/src/renderer/App.js");
  useStore.setState({ view: "chat" });
  render(<App />);
  expect(screen.queryByRole("button", { name: /日间模式|夜间模式/ })).toBeNull();
  expect(screen.getByRole("button", { name: "设置" })).toBeDefined();
});
```

Keep the existing tests that explicitly persist `general` and `providers`; they must prove a saved old `general` value is still honored.

- [ ] **Step 2: Run the focused tests to verify the new assertions fail**

Run: `pnpm --filter @entrotect/core exec vitest run test/settings-nav.test.tsx`

Expected: FAIL because the current nav order/default and Sidebar theme button do not match the new contract.

- [ ] **Step 3: Bootstrap the stored appearance before React renders**

In `main.tsx`, replace the direct theme cast with:

```ts
const savedTheme = readStoredTheme();
const savedAccentColor = readStoredAccentColor();
applyTheme(savedTheme, savedAccentColor);
useStore.setState({ theme: savedTheme, accentColor: savedAccentColor });
bridge().setTheme(savedTheme);
bridge().setAccentColor(savedAccentColor);
```

Import the four renderer appearance helpers listed in the preceding code block. This must remain before `createRoot(...).render(<App />)`.

- [ ] **Step 4: Add Appearance navigation and immediate controls**

In `SettingsPage.tsx`, initialize `primary` to `"providers"` only when `entrotect-settings-primary` is missing or invalid. Accept saved `"providers"`, `"appearance"`, and `"general"` values. Render buttons in this exact order: `供应商`, `外观`, `通用`.

Subscribe to `theme` and `accentColor`. Add handlers with these behaviors:

```ts
const selectTheme = (next: Theme) => {
  const accent = useStore.getState().accentColor;
  applyTheme(next, accent);
  localStorage.setItem("entrotect-theme", next);
  bridge().setTheme(next);
  useStore.setState({ theme: next });
};

const selectAccent = (next: string) => {
  const normalized = applyAccentColor(next, theme);
  localStorage.setItem("entrotect-accent-color", normalized);
  bridge().setAccentColor(normalized);
  useStore.setState({ accentColor: normalized });
};
```

Render Appearance detail when `primary === "appearance"`. Use two `role="radio"` buttons in `role="radiogroup" aria-label="主题"`; set `aria-checked`, a visible label, and a short description. Render the five preset buttons in `role="radiogroup" aria-label="强调色"`, each with `aria-label` equal to its Chinese label and a color swatch. Render `<input type="color" aria-label="自定义颜色" value={accentColor} onChange={...} />` for arbitrary colors. Do not add a save button.

- [ ] **Step 5: Remove the Sidebar theme control**

Delete `toggleTheme`, the Sidebar `theme` selector, and the first footer button that rendered `日间模式`/`夜间模式`. Keep the footer `设置` button and its existing icon/behavior unchanged.

- [ ] **Step 6: Run the focused tests to verify they pass**

Run: `pnpm --filter @entrotect/core exec vitest run test/settings-nav.test.tsx`

Expected: PASS, including the existing provider/general behavior tests.

- [ ] **Step 7: Commit navigation and preference integration**

```powershell
git add packages/app-desktop/src/renderer/main.tsx packages/app-desktop/src/renderer/components/SettingsPage.tsx packages/app-desktop/src/renderer/components/Sidebar.tsx packages/core/test/settings-nav.test.tsx
git commit -m "feat: add appearance settings and move theme controls"
```

---

### Task 4: Apply Lavender CSS Defaults and Runtime Brand Marks

**Files:**
- Create: `packages/app-desktop/src/renderer/components/BrandMark.tsx`
- Modify: `packages/app-desktop/src/renderer/styles/base.css:18-21,65-68,175-180`
- Modify: `packages/app-desktop/src/renderer/styles/app.css:1908-2031`
- Modify: `packages/app-desktop/src/renderer/components/MessageList.tsx:5-10,77-80,126-130`
- Test: `packages/core/test/settings-nav.test.tsx` and `packages/core/test/appearance.test.ts`

**Interfaces:**
- `BrandMark({ className?: string }): React.JSX.Element` renders an inline SVG with CSS-variable gradient stops and the existing white E mark.
- No renderer component reads `./icon.png` for a runtime brand mark after this task.

- [ ] **Step 1: Add failing brand-mark DOM assertions**

Extend `settings-nav.test.tsx` with:

```tsx
it("uses an accent-aware inline brand mark instead of the static renderer PNG", async () => {
  const { App } = await import("../../app-desktop/src/renderer/App.js");
  useStore.setState({ view: "chat", messages: [] });
  render(<App />);
  expect(document.querySelector(".brand-mark")).not.toBeNull();
  expect(document.querySelector('.empty-state img[src="./icon.png"]')).toBeNull();
});
```

- [ ] **Step 2: Run the focused assertion to verify it fails**

Run: `pnpm --filter @entrotect/core exec vitest run test/settings-nav.test.tsx -t "accent-aware inline brand mark"`

Expected: FAIL because the empty state still uses the static PNG.

- [ ] **Step 3: Implement BrandMark and replace renderer PNG usage**

Create `BrandMark.tsx` with a 1:1 square SVG. Use a `<linearGradient>` whose stops use `var(--accent)` and `var(--accent-strong)`, a rounded rectangle fill, and the existing three horizontal E bars plus vertical stroke. Pass `className` through to the root SVG and set `aria-hidden="true"`.

Replace both `MessageList.tsx` `<img src="./icon.png">` instances with:

```tsx
<BrandMark className="brand-mark" />
```

Keep the surrounding `.msg-assistant-mark` and `.empty-mark` classes so existing layout remains stable. Remove the now-unused static-image assumption from any affected import list.

- [ ] **Step 4: Set lavender CSS fallbacks and Appearance control styles**

In `base.css`, set both default theme token families to lavender fallbacks:

```css
--accent: #b8a2ff;
--accent-strong: #cfbeff;
--accent-dim: rgba(184, 162, 255, 0.14);
--accent-glow: rgba(184, 162, 255, 0.35);
--accent-foreground: #241d34;
```

Use the light-theme strong/dim/glow fallback values `#9B82E8`, `rgba(184, 162, 255, 0.10)`, and `rgba(184, 162, 255, 0.25)`. Change `.btn-primary { color: #fff; }` to `.btn-primary { color: var(--accent-foreground); }` so bright custom colors remain readable.

In `app.css`, add styles after the existing settings controls for `.appearance-section`, `.appearance-theme-options`, `.appearance-theme-option`, `.appearance-theme-option.active`, `.appearance-color-grid`, `.appearance-color-option`, `.appearance-color-swatch`, `.appearance-custom-color`, and `.appearance-custom-color input`. Keep minimum 32px hit targets, existing radius/border tokens, `accent-dim` active backgrounds, and responsive wrapping at narrow widths. Do not style semantic status colors through the accent token.

- [ ] **Step 5: Run renderer tests and build**

Run: `pnpm --filter @entrotect/core exec vitest run test/appearance.test.ts test/settings-nav.test.tsx`

Expected: PASS, including the inline brand mark assertion.

Run: `pnpm --filter @entrotect/app-desktop build`

Expected: Vite, renderer typecheck, and main/preload esbuild all pass.

- [ ] **Step 6: Commit CSS and runtime brand marks**

```powershell
git add packages/app-desktop/src/renderer/components/BrandMark.tsx packages/app-desktop/src/renderer/components/MessageList.tsx packages/app-desktop/src/renderer/styles/base.css packages/app-desktop/src/renderer/styles/app.css packages/core/test/settings-nav.test.tsx packages/core/test/appearance.test.ts
git commit -m "feat: apply lavender accent to runtime brand UI"
```

---

### Task 5: Regenerate Packaged Lavender Artwork

**Files:**
- Modify: `tools/assets/gen_icons.py:18-19`
- Regenerate: `packages/app-desktop/build/icon-full.png`
- Regenerate: `packages/app-desktop/build/icon.png`
- Regenerate: `packages/app-desktop/build/icon.ico`
- Regenerate: `packages/app-desktop/build/banner.png`
- Regenerate: `packages/app-desktop/build/installerSidebarImage.bmp`

**Interfaces:**
- The generator keeps the existing dimensions, rounded mark geometry, white E glyph, and output filenames.
- `BRAND_TOP` is `(184, 162, 255, 255)` and `BRAND_BOTTOM` is `(142, 120, 216, 255)`.

- [ ] **Step 1: Update the generator palette**

Change only the two brand constants in `tools/assets/gen_icons.py`:

```py
BRAND_TOP = (184, 162, 255, 255)   # lavender purple #B8A2FF
BRAND_BOTTOM = (142, 120, 216, 255) # lavender shadow
```

Keep `DARK_BG`, `WHITE`, geometry, font handling, and output names unchanged.

- [ ] **Step 2: Regenerate the assets**

Run: `python tools\assets\gen_icons.py`

Expected: the script prints `assets -> ...\packages\app-desktop\build` and updates exactly the five listed artwork files.

- [ ] **Step 3: Verify dimensions and image validity**

Run:

```powershell
python -c "from PIL import Image; from pathlib import Path; d=Path('packages/app-desktop/build'); expected={'icon-full.png':(1024,1024),'icon.png':(256,256),'icon.ico':None,'banner.png':(600,300),'installerSidebarImage.bmp':(164,314)}; [print(name, Image.open(d/name).size) for name in expected]; assert all(Image.open(d/name).size == size for name,size in expected.items() if size)"
```

Expected: all PNG/BMP dimensions match and `icon.ico` opens successfully through Pillow.

- [ ] **Step 4: Commit generated artwork**

```powershell
git add tools/assets/gen_icons.py packages/app-desktop/build/icon-full.png packages/app-desktop/build/icon.png packages/app-desktop/build/icon.ico packages/app-desktop/build/banner.png packages/app-desktop/build/installerSidebarImage.bmp
git commit -m "brand: replace packaged purple artwork with lavender"
```

---

### Task 6: Full Verification and v0.2.11 Package

**Files:**
- Modify: `packages/app-desktop/package.json:3`
- Generate: `release/EntroTect-Setup-0.2.11.exe`, `release/SHA256SUMS.txt`

- [ ] **Step 1: Run the full workspace test suite**

Run: `pnpm test`

Expected: all existing and new tests pass, with no failed test files.

- [ ] **Step 2: Run the complete desktop build**

Run: `pnpm --filter @entrotect/app-desktop build`

Expected: renderer, typecheck, and main/preload bundles complete successfully.

- [ ] **Step 3: Build v0.2.11 and remove stale installer artifacts**

Run: `python tools\release\release.py --version 0.2.11`

Expected: the release script builds the NSIS installer and writes `release/EntroTect-Setup-0.2.11.exe`.

Remove only stale prior-version artifacts from `release/` before checksum verification:

```powershell
Remove-Item -LiteralPath "release\EntroTect-Setup-0.2.10.exe" -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "release\EntroTect-Setup-0.2.10.exe.blockmap" -ErrorAction SilentlyContinue
```

Recompute the checksum with the same release script logic:

```powershell
python -c "from pathlib import Path; import hashlib; d=Path('release'); exes=sorted(d.glob('*.exe')); (d/'SHA256SUMS.txt').write_text('\n'.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in exes)+'\n', encoding='utf-8'); print([p.name for p in exes])"
```

Expected: only `EntroTect-Setup-0.2.11.exe` is listed.

- [ ] **Step 4: Run installed startup smoke test**

Run the installer silently, start the installed executable, wait 10 seconds, confirm an `EntroTect.exe` process exists, then terminate only that process. The expected result is `v0.2.11 install smoke: running`; no startup stderr is expected.

- [ ] **Step 5: Inspect the final diff and commit the version**

Run:

```powershell
git status --short
git diff --stat
git log --oneline -10
```

Verify only appearance implementation, tests, generated artwork, release metadata, and the approved design/plan documents are included. Then commit the package version if the release script has not already committed it:

```powershell
git add packages/app-desktop/package.json
git commit -m "v0.2.11: add appearance settings and lavender branding"
```

---

## Plan Self-Review

- Spec settings structure is covered by Task 3: provider-first order, saved navigation compatibility, Appearance page, and removal of the Sidebar theme control.
- Spec accent behavior is covered by Tasks 1, 3, and 4: exact default/presets, custom color persistence, derived token family, semantic color isolation, and readable foreground.
- Spec brand behavior is covered by Tasks 2, 4, and 5: runtime SVG/window icon updates, static lavender packaged assets, and no runtime file rewriting.
- Spec data flow and startup ordering are covered by Tasks 1-3: localStorage read, pre-render DOM application, store update, renderer-to-main IPC, and title-bar theme IPC.
- Spec error handling is covered by Task 1 normalization and Task 2 IPC validation/catch behavior.
- Spec testing and build requirements are covered by every task's focused tests plus Task 6's full suite, build, asset, package, and startup smoke checks.
- Type names and storage keys are consistent across all tasks: `Theme`, `accentColor`, `entrotect-theme`, and `entrotect-accent-color`.
- Every task specifies files, commands, expected outcomes, and commit boundaries.
