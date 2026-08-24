# Agent Permissions, Context Usage, and Panel Controls

**Date:** 2026-08-24

## Goal

Synchronize the main agent's permission behavior with subagents, fetch model context-window metadata when the provider exposes it, show practical context usage in the composer, and give both side panels consistent collapse controls.

## Scope

### Permission synchronization

- The main agent and each subagent continue to share the same approval gate. This preserves one approval surface, the existing `allow-always` memory, and the existing approval decision routing.
- The gate's permission mode becomes updateable. A `SetConfig` operation updates the active gate so subsequent checks in the current run observe the new `full`, `write`, or `ask` mode.
- Sandbox mode is passed through the agent/tool runtime context instead of being read only from module-global state, so subagents cannot silently diverge from the main agent.
- Existing pending approval requests remain explicit requests; changing the mode affects subsequent permission checks rather than silently resolving an already displayed prompt.

### Model context metadata

- Keep `ProviderConfig.models` as `string[]` to avoid an unnecessary configuration migration.
- Add optional `ProviderConfig.contextWindows: Record<string, number>` keyed by model ID.
- Extend the model-list response with the same optional mapping.
- Parse positive numeric `context_length`, `context_window`, and `max_context_length` values from model records. OpenRouter's `context_length` is covered by this rule.
- Unknown metadata remains unknown. The implementation must not use the output-token default (`8192`) as a context-window fallback.
- The settings form updates the fetched context map together with the fetched model list. Saving the form persists the cache for later startup use.

### Composer context display

- Add a context status trigger immediately to the right of the reasoning-effort selector.
- Calculate practical usage as the most recent provider-reported `inputTokens` divided by the selected model's known context window.
- Show a compact circular progress indicator in the trigger.
- On click, show a popover containing used tokens, total window, percentage, and remaining tokens with a horizontal progress bar.
- Before a request, after switching to a model without metadata, or when no metadata exists, show an explicit unknown state rather than fabricated numbers.
- Do not display unsupported Skills/MCP/Memory breakdowns and do not add tokenizer-based live estimates in this iteration.

### Side-panel controls

- Keep the left sidebar's existing persisted collapsed state, but replace its collapse control with the shared panel icon treatment.
- Add an independent persisted collapsed state for the right detail panel.
- Collapsing the right panel hides it without closing tabs or changing the active detail ID. Reopening restores the current detail page.
- The detail tab/address-bar close control remains a tab close action and is not reused as the panel collapse action.
- Both collapse/reopen controls receive explicit labels, titles, keyboard focus behavior, and non-drag regions.

## Data Flow

1. The host requests model discovery through the existing `ListModels` operation.
2. Core normalizes model IDs and supported context-window metadata from the provider response.
3. The host emits `models-listed` with model IDs and the optional context map.
4. The renderer stores the map and the settings form merges it into the selected provider configuration.
5. A non-null `turn-completed` usage event updates the latest context usage. A later null usage event must not erase the last known usage.
6. The Composer joins the active provider/model, cached context window, and latest input-token count to render the context trigger/popover.

## Error Handling

- Provider HTTP failures retain the existing model cache and expose the existing failed fetch state.
- Malformed, missing, zero, negative, or non-finite context values are ignored and treated as unknown.
- If a context window is unknown, the UI remains usable and shows the unknown state; no request behavior is changed.
- Permission and sandbox changes must not bypass the approval gate or sandbox policy.

## Testing

- Core model-discovery tests cover standard ID-only responses, OpenRouter context metadata, supported aliases, malformed values, and HTTP failures.
- Core permission tests cover subagent behavior for `full`, `write`, and `ask`, shared approval memory, dynamic mode updates, and restricted sandbox behavior.
- Renderer store tests cover model metadata event storage, latest usage retention, session/model reset behavior, and unknown metadata.
- The desktop package must typecheck/build, and the full workspace test suite must pass.

## Non-Goals

- Exact tokenizer accounting before the first request.
- Provider-specific metadata APIs that are not present in the current generic `/models` response.
- Fake context breakdown categories.
- Automatic context compaction.
