# Settings Navigation Redesign

**Date:** 2026-08-27

## Goal
Replace stacked supplier cards with two-level left navigation: primary list → secondary list → detail form, resolving density and hierarchy issues in screenshot.

## Structure
- Settings page layout: `nav-primary (160px) | nav-secondary (220px) | detail (flex)` inside `.settings-page`, independent from app sidebar (对话列表).
- Primary: `通用` / `供应商` (extensible to 外观/关于). Active primary persisted in localStorage `entrotect-settings-primary`.
- Secondary:
  - `通用` → no secondary column, detail shows workspaceDir/maxTokens/showReasoning/sandboxMode.
  - `供应商` → secondary = scrollable provider list (DeepSeek/OpenAI/Moonshot... + 添加供应商). Active provider id persisted `entrotect-settings-provider`. Selecting provider shows its detail form on right.
- Detail:
  - Provider detail: 名称/Base URL/API Key/modelsUrl/apiFormat + model table (columns: 模型 ID | 上下文窗口(tokens,留空=自动) | 移除) + 拉取/设为当前/删除 actions. Table replaces chip+inline input.
  - General detail: existing 4 fields + 保存.

## Behavior
- Click primary → secondary updates or hides; detail switches accordingly. Deep-link via state only, no route.
- Provider add/remove/select syncs `form.providers` and `activeProviderId`; 保存 remains explicit (no auto save on nav).
- Existing `form/providers/contextWindows` merge logic (`mergeCachedProviderDataIntoConfig`) and fetch cache (`contextWindowsByProvider/modelsByProvider`) unchanged.
- Backward compatible: old config without nav state defaults to `通用`.

## Visual
- Primary/nav-secondary with `surface-active` separators, active row `accent-dim` + border; detail card `surface` with `border-strong`. Keep existing theme tokens, focus-visible, 32px hit targets, no-drag for titlebar-adjacent controls.

## Non-Goals
- No 50+ preset import UI, no search/filter, no drag reorder in this iteration.
