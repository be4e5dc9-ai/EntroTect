# Settings Sidebar Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Remove the app conversation sidebar from Settings view while preserving the settings page's two-level navigation.

**Architecture:** Make `App.tsx` choose one shell: chat shell with `Sidebar`, or settings shell without it. Add only the settings-page width/layout CSS required after the app sidebar is removed, and cover the view switch with renderer tests.

**Tech Stack:** React, TypeScript, Zustand, existing renderer test setup, existing CSS.

## Global Constraints

- `view === "chat"` retains the current conversation sidebar behavior.
- `view === "settings"` never renders the app-level conversation `Sidebar`.
- Existing settings provider/config behavior remains unchanged.
- No unrelated core/provider/permission changes.

---

### Task 1: Separate App Sidebar from Settings Shell

**Files:**
- Modify: `packages/app-desktop/src/renderer/App.tsx`
- Modify: `packages/app-desktop/src/renderer/components/SettingsPage.tsx`
- Modify: `packages/app-desktop/src/renderer/styles/app.css`
- Test: `packages/core/test/settings-nav.test.tsx`

**Interfaces:**
- `App` conditionally renders `Sidebar` only when `view === "chat"`.
- Settings page keeps its existing `settings-layout` primary/secondary/detail navigation.

- [ ] **Step 1: Write failing view-shell tests**

Extend `settings-nav.test.tsx` with a test that renders `App`, sets the store view to `settings`, and asserts the conversation sidebar title `对话列表` is absent while settings primary item `通用` is present. Add a second test that sets `view` to `chat` and asserts `对话列表` returns. Use the existing jsdom setup and reset store/localStorage in `beforeEach`.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
pnpm --filter @entrotect/core exec vitest run test/settings-nav.test.tsx
```

Expected: FAIL because `App` currently renders `Sidebar` for both views.

- [ ] **Step 3: Implement the conditional shell**

Change the app-body branch so the app-level sidebar is rendered only in chat mode:

```tsx
<div className="app-body">
  {view === "chat" && !sidebarCollapsed && (
    <Sidebar width={sidebarWidth} onWidthChange={persistWidth} onCollapse={collapse} />
  )}
  {view === "settings" ? <SettingsPage /> : <main className="main">...</main>}
  {view === "chat" && hasDetail && !detailCollapsed && <DetailPanel ... />}
</div>
```

Keep the collapsed-sidebar peek button chat-only; Settings must not display `对话列表` or its `New` action. Keep `SettingsPage`'s existing `返回对话` action.

- [ ] **Step 4: Adjust settings width only if needed**

Ensure `.settings-page` and `.settings-layout` use the full remaining app width and keep the existing `160px + 220px + detail` columns. Do not change provider form data handlers or navigation state. Preserve `min-width: 0`, scrolling, theme tokens, focus-visible styles, and narrow-window behavior.

- [ ] **Step 5: Run focused tests and build**

```powershell
pnpm --filter @entrotect/core exec vitest run test/settings-nav.test.tsx
pnpm --filter @entrotect/app-desktop build
```

Expected: focused settings tests pass and the desktop renderer/typecheck/build completes.

- [ ] **Step 6: Commit**

```powershell
git add packages/app-desktop/src/renderer/App.tsx packages/app-desktop/src/renderer/components/SettingsPage.tsx packages/app-desktop/src/renderer/styles/app.css packages/core/test/settings-nav.test.tsx
git commit -m "fix: hide conversation sidebar in settings view"
```
