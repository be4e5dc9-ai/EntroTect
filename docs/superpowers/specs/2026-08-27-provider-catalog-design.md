# Provider Catalog & Model Fetch Alignment (B)

**Date:** 2026-08-27
**Basis:** cc-switch `piModelCatalog.ts:8`, `claudeProviderPresets.ts:14`, `model_fetch.rs:60` vs EntroTect `contexts.ts:7`, `models.ts:7`, `shared/src/protocol.ts:52`

## Goal
Bring EntroTect provider management and context window handling to cc-switch structure: central capability catalog, candidate model URL generation, per-provider `modelsUrl/apiFormat` — without migrating to SQLite or 50+ preset UI.

## Architecture
- New `packages/core/src/provider/catalog.ts` — `catalog: Record<"provider/model", {name,reasoning,input,contextWindow,maxTokens}>` 60 entries, `as const` (deepseek/deepseek-v4-pro 1_000_000/384_000, moonshotai/kimi-k3 1_048_576/131_072, openai/gpt-5.6-sol 272_000/128_000, anthropic/claude-opus-5 1_000_000/128_000 etc.), helpers `getCatalogEntry`, `piModel`.
- `core/src/provider/contexts.ts` becomes thin adapter: derives `KNOWN_MODEL_CONTEXTS` from catalog (key suffix = model id), keeps `suffixContextWindow` (`-128k/-1m`) and `mergeContextWindows(models, apiWindows)` (API > catalog > suffix). No default 8192 fallback.
- `shared/src/protocol.ts:52` `ProviderConfig` adds optional `category?`, `apiFormat?:"openai"|"anthropic"|"google"`, `modelsUrl?:string`, `icon?:string`. `models:string[]`, `contextWindows?` unchanged, no `templateValues`.
- New `core/src/provider/presets.ts` — expanded builtins (deepseek with `modelsUrl:"https://api.deepseek.com/models"`, moonshot/kimi, openai, ollama + 8 aggregator stubs), each `{id,name,baseUrl,category,apiFormat,modelsUrl,icon,models:[]}` for `DEFAULT_CONFIG` hydration.

## Data Flow
1. `app-desktop/src/main/host.ts:171` `ListModels` builds `candidates = buildModelsUrlCandidates(baseUrl, modelsUrl)` (port of `model_fetch.rs:150`: ends_with `/v{N}` → `{base}/models`, else `{base}/v1/models`, if hit `KNOWN_COMPAT_SUFFIXES` strip → `{root}/v1/models` + `{root}/models`, dedup, order preserved).
2. Sequential fetch with 15s timeout, headers by `apiFormat` (anthropic→`x-api-key`, google→`x-goog-api-key`, else `Bearer`), `404/405` → next candidate, other HTTP → fail. Parse `ModelsResponse{data:[{id,owned_by}]}` sorted by id.
3. `contextWindows = mergeContextWindows(models, apiWindows)` (api `context_length/context_window/max_context_length` > catalog > suffix). Emit `models-listed{providerId,models,contextWindows}`.
4. Renderer: `Composer` via `contextWindowForModel` (explicit `provider.contextWindows[model]` > fetched cache `contextWindowsByProvider` > catalog-derived) drives `getContextSnapshot`; `SettingsPage` chip input manual override persists via `provider.contextWindows`.

## Error Handling
- `modelsUrl` non-empty returns single candidate; empty baseUrl → error; trimmed trailing `/`; empty data → sorted `[]`; unknown context stays unknown; timeout per candidate 15s; no secret leakage in logs.

## Testing
- `contexts.test.ts`: catalog key coverage, suffix parsing, merge priority (api > catalog > suffix).
- New `models.test.ts`: candidate generation (`deepseek/anthropic`, `open.bigmodel.cn/paas/v4`, override, plain), header mapping, 404 fallback, sorting.
- `renderer-store.test.ts`: `contextWindowForModel` precedence already covered, extend with catalog-derived entry.
- Full `pnpm test` 158 pass + `pnpm --filter @entrotect/app-desktop build` intact.

## Non-Goals
- No SQLite/tray/DirectLink/templateValues/50+ full presets, no cost field, no token counting beyond display.
