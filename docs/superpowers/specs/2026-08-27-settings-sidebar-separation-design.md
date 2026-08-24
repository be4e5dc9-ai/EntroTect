# Settings Sidebar Separation

**Date:** 2026-08-27

## Goal

When the user opens Settings, hide the app-level conversation sidebar and let the settings page own the left navigation area with primary and secondary settings lists.

## Behavior

- `view === "chat"`: keep the existing app sidebar, chat main area, and optional detail panel.
- `view === "settings"`: do not render the app-level `Sidebar`; render the settings page full-width beside the titlebar.
- Settings page layout remains `primary navigation | secondary navigation | detail`.
- Returning through `返回对话` restores the app-level conversation sidebar and the previous chat layout.
- Existing sidebar collapse state remains unchanged and is not overwritten by entering Settings.
- Settings navigation and provider selection remain locally persisted and existing provider/config merge behavior is preserved.

## Implementation

- `App.tsx` conditionally renders `Sidebar` only for the chat view.
- `SettingsPage.tsx` owns its internal two-level navigation and uses the available page width; no duplicate conversation list is shown.
- Add a settings-page layout modifier so the settings detail area can occupy the freed width without relying on the app sidebar width.
- Preserve titlebar drag/no-drag behavior and existing keyboard labels.

## Testing

- Add a renderer test that enters settings view and asserts the app sidebar is absent while settings primary navigation is present.
- Add a renderer test that switches back to chat and asserts the app sidebar returns.
- Run the full test suite and desktop build.

## Non-Goals

- No changes to provider models, permissions, context usage, or conversation storage.
