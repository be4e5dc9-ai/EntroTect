# Settings Nav Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Implement two-level settings navigation without breaking provider data.

**Architecture:** Split `SettingsPage.tsx` into `SettingsNav` (primary/secondary columns) + detail panes; lift `form` state; keep data merge.

**Tech Stack:** React, Zustand, existing CSS tokens.

## Global Constraints
- Keep `ProviderConfig.models:string[]` + `contextWindows?`; explicit save only.

---

### Task 1: Nav Shell + State

**Files:** Modify `SettingsPage.tsx`, `styles/app.css`

**Interfaces:** `primary: "general"|"providers"`, `activeProviderId: string| null` persisted.

- [ ] Write failing test: render SettingsPage, click 供应商 → secondary list appears
- [ ] Implement nav-primary + nav-secondary columns, localStorage persist, default general
- [ ] Commit

### Task 2: Provider Detail Table

**Files:** Modify `SettingsPage.tsx`, `styles/app.css`

- [ ] Replace chip list with table rows (model | context input | ×), wire setModelContext/add/remove, test add+context edit+remove
- [ ] Commit

### Task 3: General Pane + Actions

**Files:** Modify `SettingsPage.tsx`

- [ ] Move general fields to detail when primary=general, keep fetchState/modelsUrl/apiFormat in provider detail, test save persists
- [ ] Commit

