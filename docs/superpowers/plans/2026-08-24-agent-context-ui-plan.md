# Agent Permissions, Context Usage, and Panel Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize subagent permissions with the main agent, fetch available model context-window metadata, show practical context usage in Composer, and provide consistent collapsible side panels.

**Architecture:** Preserve the existing shared approval gate and string model lists, adding only updateable permission state, explicit sandbox context, and a model-ID-to-context-window map. The renderer keeps the latest provider-reported input usage and joins it with the active model metadata for a small Composer popover. Side-panel collapse is independent from tab closing and is persisted locally.

**Tech Stack:** Electron, TypeScript, React, Zustand, Zod, Vitest, existing CSS and OpenAI-compatible provider transport.

## Global Constraints

- Keep `ProviderConfig.models` as `string[]`; add optional metadata without a destructive configuration migration.
- Unknown context windows stay unknown; never use the output-token default `8192` as a context-window fallback.
- The main agent and subagents share the same approval gate and approval routing.
- Write tests before production code for every behavior change.
- Use existing project visual language and ASCII source edits unless existing Chinese copy requires otherwise.
- Do not add fake Skills/MCP/Memory breakdowns or tokenizer-based live estimation in this iteration.

---

### Task 1: Synchronize Permission and Sandbox Runtime State

**Files:**
- Modify: `packages/core/src/permission/gate.ts`
- Modify: `packages/core/src/tools/types.ts`
- Modify: `packages/core/src/tools/bash.ts`
- Modify: `packages/core/src/loop/agent.ts`
- Modify: `packages/core/src/subagent/run.ts`
- Modify: `packages/app-desktop/src/main/host.ts`
- Test: `packages/core/test/permission.test.ts`
- Test: `packages/core/test/subagent.test.ts`
- Test: `packages/core/test/sandbox.test.ts`

**Interfaces:**
- Produce `SessionPermissionGate.setMode(mode: PermissionMode): void`.
- Produce an explicit `sandboxMode` value in the tool runtime context used by `bash`.
- Preserve the existing `approve(toolName, preview, description, signal)` behavior and the existing host approval event route.

- [ ] **Step 1: Write failing permission-mode update tests**

Add tests to `packages/core/test/permission.test.ts` that construct one gate, verify a write tool is allowed/blocked under `write`, call `setMode("full")`, and verify the next write is allowed; add the inverse `setMode("ask")` check for a read tool. The assertions must exercise the real gate method rather than a mocked approval callback:

```ts
const gate = new SessionPermissionGate("write", async () => "allow-once");
expect(await gate.check("read", "file.txt", "read", signal)).toBe("allow");
expect(await gate.check("write", "file.txt", "write", signal)).toBe("allow");
gate.setMode("ask");
expect(await gate.check("read", "file.txt", "read", signal)).toBe("allow");
```

Use the repository's actual gate constructor and check signature; keep existing test setup unchanged except for the new mode-transition assertions. Add a separate assertion that `full` bypasses an approval callback and `ask` calls it for a read tool.

- [ ] **Step 2: Run the focused tests and verify they fail for the missing update API**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/permission.test.ts
```

Expected: FAIL because `SessionPermissionGate` has no update operation or retains the original mode.

- [ ] **Step 3: Make gate mode updateable and wire current config updates**

Change the gate's frozen mode to a private mutable field, add `setMode(mode)`, and make each permission check read that field at check time. In `SessionHost.handleOp`, after accepting `SetConfig`, update the active gate with the new `permissionMode` while retaining the existing shared gate reference used by the parent and child runners. Do not create a second child gate and do not auto-resolve an already pending approval.

Pass `sandboxMode` through `AgentDeps`/`ToolContext` and the subagent runner's dependency object. Update `bash` to use `ctx.sandboxMode` for its dangerous-command decision. Keep a compatibility default of `"full"` only at the existing top-level host/agent construction boundary so every actual tool call receives an explicit value.

- [ ] **Step 4: Add subagent and sandbox regression tests**

In `packages/core/test/subagent.test.ts`, use a real gate with `full`, `write`, and `ask` modes and a real tool runner to assert that read/write calls follow the same mode as the parent. Add an `allow-always` case proving the remembered approval is shared across a parent tool check and a subagent tool check. In `packages/core/test/sandbox.test.ts`, assert that a child bash call with `sandboxMode: "restricted"` rejects a dangerous command even when its approval callback allows it.

- [ ] **Step 5: Run the permission regression set**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/permission.test.ts test/subagent.test.ts test/sandbox.test.ts
```

Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Commit the permission change**

```powershell
git add packages/core/src/permission/gate.ts packages/core/src/tools/types.ts packages/core/src/tools/bash.ts packages/core/src/loop/agent.ts packages/core/src/subagent/run.ts packages/app-desktop/src/main/host.ts packages/core/test/permission.test.ts packages/core/test/subagent.test.ts packages/core/test/sandbox.test.ts
git commit -m "fix: synchronize subagent permission and sandbox state"
```

### Task 2: Fetch and Persist Model Context Windows

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/core/src/provider/models.ts`
- Modify: `packages/core/src/provider/index.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/app-desktop/src/main/host.ts`
- Modify: `packages/app-desktop/src/renderer/components/SettingsPage.tsx`
- Test: `packages/core/test/models.test.ts`

**Interfaces:**
- Produce `listModels(...): Promise<{ models: string[]; contextWindows: Record<string, number> }>`.
- Emit `models-listed` with `models: string[]` and optional `contextWindows: Record<string, number>`.
- Persist `ProviderConfig.contextWindows?: Record<string, number>`.

- [ ] **Step 1: Write failing model metadata parser tests**

Create `packages/core/test/models.test.ts` with a fetch stub and tests for these exact cases:

```ts
it("keeps ids and reads OpenRouter context_length", async () => {
  const result = await listModels(config, async () => response({
    data: [{ id: "deepseek/deepseek-chat", context_length: 1000000 }],
  }));
  expect(result).toEqual({
    models: ["deepseek/deepseek-chat"],
    contextWindows: { "deepseek/deepseek-chat": 1000000 },
  });
});

it("ignores missing and invalid context values", async () => {
  const result = await listModels(config, async () => response({
    data: [
      { id: "plain-model" },
      { id: "bad-model", context_length: 0 },
      { id: "negative-model", context_window: -1 },
      { id: "valid-model", max_context_length: 131072 },
    ],
  }));
  expect(result.contextWindows).toEqual({ "valid-model": 131072 });
});
```

Also test URL trailing slash, authorization header, non-2xx response, and a standard ID-only response. The helper `response` should implement only the `ok`, `status`, and `json()` members used by production code.

- [ ] **Step 2: Run the model tests and verify they fail on the old string-array result**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/models.test.ts
```

Expected: FAIL because the current function returns only `string[]` and discards metadata.

- [ ] **Step 3: Extend protocol and config metadata without changing model IDs**

Add to `ProviderConfig`:

```ts
contextWindows?: Record<string, number>;
```

Extend the `models-listed` event with:

```ts
contextWindows?: Record<string, number>;
```

Update the corresponding Zod schemas and config migration/normalization so missing maps become `undefined` or `{}` without changing existing saved `models: string[]`.

- [ ] **Step 4: Normalize provider model responses**

In `packages/core/src/provider/models.ts`, read `data` records, keep non-empty string IDs, and select the first positive finite numeric value from `context_length`, `context_window`, or `max_context_length`. Return the IDs plus a map. Do not infer a context window from `maxTokens`. Update `listModelsForProvider` and the host `ListModels` branch to forward the object and emit `contextWindows`.

- [ ] **Step 5: Merge metadata in SettingsPage**

When a successful `models-listed` event arrives, update the matching provider with both `models: event.models` and `contextWindows: event.contextWindows ?? {}`. On an empty/error result, retain the existing model list and context map. Preserve the current explicit Save behavior.

- [ ] **Step 6: Run all model/config tests and commit**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/models.test.ts test/config.test.ts
```

Expected: PASS.

Commit:

```powershell
git add packages/shared/src/protocol.ts packages/core/src/provider/models.ts packages/core/src/provider/index.ts packages/core/src/config.ts packages/app-desktop/src/main/host.ts packages/app-desktop/src/renderer/components/SettingsPage.tsx packages/core/test/models.test.ts
git commit -m "feat: fetch model context window metadata"
```

### Task 3: Store Latest Context Usage for the Renderer

**Files:**
- Modify: `packages/app-desktop/src/renderer/store.ts`
- Test: `packages/core/test/renderer-store.test.ts`

**Interfaces:**
- Store `contextWindowsByProvider: Record<string, Record<string, number>>`.
- Keep latest non-null `usage` so the host's final null completion event cannot erase it.
- Expose a small pure formatter/calculation helper for Composer tests if the existing store structure makes direct testing awkward.

- [ ] **Step 1: Write failing renderer state tests**

Extend `renderer-store.test.ts` with these behaviors:

```ts
feedOne({
  type: "models-listed",
  providerId: "deepseek",
  models: ["deepseek-chat"],
  contextWindows: { "deepseek-chat": 64000 },
});
expect(useStore.getState().contextWindowsByProvider.deepseek["deepseek-chat"]).toBe(64000);

feedOne({ type: "turn-completed", usage: { inputTokens: 2048, outputTokens: 128 } });
feedOne({ type: "turn-completed", usage: null });
expect(useStore.getState().usage?.inputTokens).toBe(2048);
```

Add a session reset/model-switch assertion proving old usage does not appear for a different session/model, and an unknown-context assertion that returns no percentage rather than zero. The calculation helper introduced in Step 4 must be exported from `store.ts` so the Composer component can consume the tested behavior without duplicating arithmetic.

- [ ] **Step 2: Run the focused renderer tests and verify the new assertions fail**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/renderer-store.test.ts
```

Expected: FAIL because the store has no context-window map and currently clears usage on null completion.

- [ ] **Step 3: Add metadata and usage state reduction**

Initialize `contextWindowsByProvider` in the store. In `applyEvent("models-listed")`, merge the event map. In `applyEvent("config")`, hydrate maps from `config.providers`. On non-null `turn-completed`, set usage; on null, leave the current usage untouched. Clear usage when `session-meta` starts a different session or when the active provider/model changes.

Keep the existing `modelsByProvider` behavior and existing subagent/session reset behavior intact.

- [ ] **Step 4: Add context calculation helpers**

Implement a small pure calculation used by Composer:

```ts
type ContextSnapshot = {
  inputTokens: number;
  contextWindow: number;
  usedRatio: number;
  remainingTokens: number;
};

function getContextSnapshot(
  inputTokens: number | undefined,
  contextWindow: number | undefined,
): ContextSnapshot | null;
```

Return `null` for missing/non-positive inputs, clamp the ratio to `[0, 1]`, and calculate remaining as `Math.max(0, contextWindow - inputTokens)`. Format token counts with `k`/`M` units in the UI rather than in the state layer.

- [ ] **Step 5: Run renderer tests and commit**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/renderer-store.test.ts
```

Expected: PASS.

Commit:

```powershell
git add packages/app-desktop/src/renderer/store.ts packages/app-desktop/src/renderer/components/Composer.tsx packages/core/test/renderer-store.test.ts
git commit -m "feat: track latest context usage in renderer"
```

### Task 4: Add Composer Context Popover and Unified Panel Collapse Controls

**Files:**
- Create: `packages/app-desktop/src/renderer/components/ContextUsagePopover.tsx`
- Modify: `packages/app-desktop/src/renderer/components/Composer.tsx`
- Modify: `packages/app-desktop/src/renderer/components/Sidebar.tsx`
- Modify: `packages/app-desktop/src/renderer/components/DetailPanel.tsx`
- Modify: `packages/app-desktop/src/renderer/App.tsx`
- Modify: `packages/app-desktop/src/renderer/styles/app.css`
- Modify: `packages/app-desktop/src/renderer/styles/base.css`

**Interfaces:**
- `ContextUsagePopover` consumes `{ inputTokens?: number; contextWindow?: number }` and renders a trigger plus popover.
- `DetailPanel` consumes `onCollapse` and renders a panel-only collapse button.
- `App` owns persisted `sidebarCollapsed` and `detailCollapsed` state; tab close remains separate.

- [ ] **Step 1: Add UI-level testable behavior before implementation**

If no component test harness exists, add pure tests alongside the existing renderer-store test for token formatting and ratio states. The required cases are `204100/1000000 -> "204.1k / 1M"`, a clamped over-limit value, and unknown metadata. Do not add a browser-only test dependency solely for this feature.

- [ ] **Step 2: Run the new UI helper tests and verify they fail**

Run:

```powershell
pnpm --filter @entrotect/core exec vitest run test/renderer-store.test.ts
```

Expected: FAIL until the shared calculation/formatting helpers exist.

- [ ] **Step 3: Implement the context trigger and popover**

Place the trigger immediately after the reasoning-effort control in Composer. For known values, render a compact circular `conic-gradient` progress indicator, accessible label, and click target. The popover must contain:

```text
Context window                 204.1k / 1M (20%)
[blue used segment / gray free segment]
Remaining                      795.9k
```

For unknown values, render `Context unknown` and no numeric percentage. Close on Escape and outside click, return focus to the trigger, and use `aria-expanded`/`aria-haspopup="dialog"`. Add `prefers-reduced-motion` handling for the popover transition.

- [ ] **Step 4: Implement shared panel icon controls**

Use one inline SVG/icon style representing two vertical panels. Replace the left sidebar collapse glyph with it and add `aria-label="Collapse sidebar"` plus a title. Add the right detail panel collapse control near its panel edge with `aria-label="Collapse details"`. When collapsed, render a reopen control with the opposite direction and `aria-label="Open details"`; set `-webkit-app-region: no-drag` on titlebar controls.

- [ ] **Step 5: Separate right collapse from tab close**

Add `detailCollapsed` state in `App`, persist it under a new local-storage key, and pass it to the layout. Do not clear `activeDetailId` or call `closeDetailTab` while collapsing. Reopening must render the existing active tab. Keep the right panel hidden when there are no tabs, regardless of the collapsed flag.

- [ ] **Step 6: Add responsive and visual CSS**

Anchor the popover to the Composer right controls, constrain it to the viewport, and preserve the existing panel/menu shadow, radius, border, and dark/light theme variables. At narrow widths, allow the Composer controls to shrink without horizontal overflow and prioritize the input/main area. Ensure collapsed controls remain at least `32px` hit targets and visible under keyboard focus.

- [ ] **Step 7: Build the desktop package and commit UI changes**

Run:

```powershell
pnpm --filter @entrotect/app-desktop build
```

Expected: the renderer and preload bundles build without TypeScript errors.

Commit:

```powershell
git add packages/app-desktop/src/renderer/components/ContextUsagePopover.tsx packages/app-desktop/src/renderer/components/Composer.tsx packages/app-desktop/src/renderer/components/Sidebar.tsx packages/app-desktop/src/renderer/components/DetailPanel.tsx packages/app-desktop/src/renderer/App.tsx packages/app-desktop/src/renderer/styles/app.css packages/app-desktop/src/renderer/styles/base.css
git commit -m "feat: add context usage popover and panel collapse controls"
```

### Task 5: Full Integration Verification

**Files:**
- Modify only if verification discovers a defect in the task changes.

- [ ] **Step 1: Inspect the complete worktree and commit range**

Run:

```powershell
git status --short
```

Confirm no temporary probe, debug artifact, or unrelated file is present.

- [ ] **Step 2: Run all workspace tests**

Run the repository test command exactly as defined by the workspace:

```powershell
pnpm test
```

Expected: all existing tests plus new permission, model, renderer, and UI-helper tests pass.

- [ ] **Step 3: Build the desktop app**

```powershell
pnpm --filter @entrotect/app-desktop build
```

Expected: renderer/preload output is generated without TypeScript or bundler errors.

- [ ] **Step 4: Smoke-test the app**

Launch the desktop app and verify these paths manually:

1. Fetch a provider with context metadata: model IDs and context map populate the settings form; Save persists them.
2. Select a model with known metadata, send a message, and verify the Composer context trigger shows used/total/percentage and remaining tokens.
3. Select an unknown model or before the first request and verify the trigger says context is unknown.
4. Change permission mode and run a subagent tool; verify the subagent follows the main mode and shares approvals.
5. Collapse/reopen both side panels; verify the right panel keeps its active tab and the tab `×` still closes only the tab.

- [ ] **Step 5: Apply verification-before-completion**

Record the exact test/build commands and observed results in the final response. Do not claim completion if a test, build, or required smoke path fails.
