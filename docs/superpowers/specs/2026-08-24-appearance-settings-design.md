# Appearance Settings

**Date:** 2026-08-24

## Goal

Add an Appearance settings page where users can switch between day and night mode and choose the UI accent color. Replace the current default purple accent with lavender purple and update the product artwork to match.

## Settings Structure

- The settings primary navigation order is `供应商` → `外观` → `通用`.
- On a first visit, `供应商` is selected so the existing settings entry point and provider workflow remain unchanged.
- An existing `entrotect-settings-primary` value continues to be honored. Only a missing value defaults to `供应商`.
- `外观` has no secondary navigation column and renders its detail content in the existing settings detail area.
- The Appearance detail contains:
  - Theme selection: `日间模式` and `夜间模式`.
  - Accent color selection: preset swatches and a custom color picker.
- Theme switching moves out of the chat `Sidebar`; the sidebar keeps only the `设置` entry in its footer.
- Appearance changes take effect immediately and do not require the provider/general `保存` action.

## Accent Color

- The default accent is lavender purple `#B8A2FF`.
- Presets include lavender purple `#B8A2FF`, sky blue `#7CA7FF`, mint green `#66C7A5`, peach orange `#F0A36A`, and rose pink `#E58BA8`.
- A custom color uses a native color picker and accepts any valid browser color value.
- The selected base color drives the existing accent token family:
  - `--accent`
  - `--accent-strong`
  - `--accent-dim`
  - `--accent-glow`
- An `--accent-foreground` token is derived from luminance and is used where accent backgrounds need readable text, so a bright custom color does not force white text with insufficient contrast.
- The token family controls accent-colored buttons, selected states, links, focus borders, accent card backgrounds/borders, progress indicators, and activity indicators.
- Semantic `--success`, `--warning`, and `--danger` colors remain independent of the selected accent.
- Strong, translucent, and glow variants are derived from the base color with theme-aware contrast handling. Missing or invalid stored values fall back to the lavender default.
- The selected accent is persisted in `localStorage` under `entrotect-accent-color`.
- Existing `entrotect-theme` persistence remains unchanged.

## Brand Artwork

- Regenerate the default product assets from `tools/assets/gen_icons.py` using the lavender palette:
  - `packages/app-desktop/build/icon-full.png`
  - `packages/app-desktop/build/icon.png`
  - `packages/app-desktop/build/icon.ico`
  - `packages/app-desktop/build/banner.png`
  - `packages/app-desktop/build/installerSidebarImage.bmp`
- In-app brand marks use a runtime SVG/CSS representation so they follow the selected accent color.
- The renderer sends the selected accent to the main process through the preload bridge; the main process updates the current Electron window icon at runtime.
- The initial renderer accent is applied before the first React render and is sent to the main process during startup.
- Desktop shortcut artwork, installer artwork, and other packaged static resources remain fixed at the default lavender purple. They do not change when a user selects a custom runtime accent.

## Data Flow

1. `main.tsx` reads the stored theme and accent before rendering and applies the document theme and accent tokens.
2. `App`/`SettingsPage` exposes the theme and accent state from the renderer store.
3. An Appearance control updates the renderer state, localStorage, document tokens, and runtime brand mark immediately.
4. The preload bridge forwards the accent to the main process, which updates the BrowserWindow icon.
5. Theme changes continue to use the existing theme IPC so the Electron title bar follows day/night mode.

## Compatibility and Error Handling

- Existing provider and general settings form behavior is unchanged.
- Existing theme values remain valid; absent theme values continue to default to night mode.
- Existing settings navigation values remain valid; absent navigation values default to `供应商`.
- Invalid accent values are ignored and replaced by lavender purple.
- A failure to update the native window icon must not prevent the renderer color change or settings interaction.
- Runtime custom coloring does not rewrite packaged files or desktop shortcut resources.

## Testing

- Settings navigation tests cover the final order and first-visit provider default.
- Renderer tests cover preset selection, custom color persistence, default fallback, CSS token updates, and theme switching from Appearance.
- Sidebar tests/DOM assertions verify the old standalone theme control is removed.
- Brand asset generation is run and its output files are checked.
- Main/preload typecheck verifies the runtime icon bridge.
- The full workspace test suite, desktop build, and packaged installer launch smoke test must pass.

## Non-Goals

- No system-theme or automatic sunrise/sunset mode.
- No color editing for success, warning, or danger semantic states.
- No regeneration of the installed shortcut or installer at runtime.
- No provider configuration changes for appearance preferences.
