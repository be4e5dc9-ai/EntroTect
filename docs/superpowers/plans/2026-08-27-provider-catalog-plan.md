# Provider Catalog & Model Fetch Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align EntroTect provider/context handling with cc-switch: central catalog + candidate model URL generation + per-provider modelsUrl/apiFormat.

**Architecture:** Add `core/src/provider/catalog.ts` as single source (mirrors `piModelCatalog.ts:8`), make `contexts.ts` a thin adapter deriving `KNOWN_MODEL_CONTEXTS`; extend `ProviderConfig` with optional `modelsUrl/apiFormat/category/icon`; port `model_fetch.rs:150` candidate logic into `models.ts` with sequential fetch + header mapping; keep `models:string[]` migration-free.

**Tech Stack:** TypeScript, Vitest, pnpm, Electron (host), Zod protocol, existing store/Composer wiring.

## Global Constraints
- Keep `ProviderConfig.models: string[]`; new catalog fields optional, no destructive migration.
- Unknown context stays unknown; never use output-token default as context fallback.
- Write tests before production code for every behavior.
- Shared `models-listed` remains `models: string[]` + optional `contextWindows`.

---

### Task 1: Central Catalog + Context Adapter

**Files:**
- Create: `packages/core/src/provider/catalog.ts`
- Modify: `packages/core/src/provider/contexts.ts`
- Modify: `packages/core/src/provider/index.ts`
- Test: `packages/core/test/catalog.test.ts`
- Test: `packages/core/test/contexts.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `export const catalog: Record<string, {capabilities:{name,reasoning,input,contextWindow,maxTokens}}>`; `export function getCatalogEntry(key:string)`; `KNOWN_MODEL_CONTEXTS` derived from catalog; `mergeContextWindows(models, apiWindows): Record<string,number>` unchanged signature but backed by catalog.

- [ ] **Step 1: Write failing catalog tests**

```ts
// packages/core/test/catalog.test.ts
import { describe, expect, it } from "vitest";
import { catalog, getCatalogEntry } from "../src/provider/catalog.js";
describe("catalog", () => {
  it("contains canonical deepseek and anthropic entries", () => {
    expect(catalog["deepseek/deepseek-v4-pro"].capabilities.contextWindow).toBe(1_000_000);
    expect(catalog["anthropic/claude-opus-5"].capabilities.contextWindow).toBe(1_000_000);
  });
  it("getCatalogEntry returns undefined for unknown", () => {
    expect(getCatalogEntry("unknown/foo")).toBeUndefined();
  });
});
```

Run: `pnpm --filter @entrotect/core exec vitest run test/catalog.test.ts`
Expected: FAIL — file not found.

- [ ] **Step 2: Create catalog from cc-switch piModelCatalog subset (≈60 entries)**

Create `packages/core/src/provider/catalog.ts` copying `piModelCatalog.ts:8` values verbatim (amazon/nova-pro 300_000/8_192, anthropic/claude-fable-5 1_000_000/128_000 ... zai/glm-5.2 1_000_000/131_072) as `as const satisfies Record<string, {capabilities:{name,reasoning,input,contextWindow,maxTokens}}>`, export `getCatalogEntry(key)` and `catalog`.

- [ ] **Step 3: Adapt contexts.ts to derive from catalog**

Replace hard-coded `KNOWN_MODEL_CONTEXTS` with:

```ts
import { catalog } from "./catalog.js";
export const KNOWN_MODEL_CONTEXTS: Record<string, number> = Object.fromEntries(
  Object.entries(catalog).map(([k, v]) => [k.split("/").pop()!, v.capabilities.contextWindow])
);
```

Keep `knownContextWindow/suffixContextWindow/mergeContextWindows` signatures; ensure `mergeContextWindows` still API > catalog > suffix.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @entrotect/core exec vitest run test/catalog.test.ts test/contexts.test.ts`
Expected: PASS (4 catalog + 4 contexts = 8)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provider/catalog.ts packages/core/src/provider/contexts.ts packages/core/src/provider/index.ts packages/core/test/catalog.test.ts packages/core/test/contexts.test.ts
git commit -m "feat: add central provider catalog derived from cc-switch"
```

### Task 2: Candidate Model URL + Header Fetch

**Files:**
- Modify: `packages/core/src/provider/models.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/app-desktop/src/main/host.ts`
- Test: `packages/core/test/models.test.ts` (new)

**Interfaces:**
- Produces: `export function buildModelsUrlCandidates(baseUrl:string, modelsUrl?:string): string[]`; `listModels(config, fetchImpl)` now iterates candidates with 15s timeout; `ProviderConfig.modelsUrl?, apiFormat?`.

- [ ] **Step 1: Write failing candidate tests**

```ts
// packages/core/test/models.test.ts
import { buildModelsUrlCandidates } from "../src/provider/models.js";
expect(buildModelsUrlCandidates("https://api.deepseek.com/anthropic")).toEqual([
  "https://api.deepseek.com/anthropic/v1/models","https://api.deepseek.com/v1/models","https://api.deepseek.com/models"
]);
expect(buildModelsUrlCandidates("https://open.bigmodel.cn/api/coding/paas/v4")).toEqual([
  "https://open.bigmodel.cn/api/coding/paas/v4/models","https://open.bigmodel.cn/api/coding/paas/v4/v1/models"
]);
expect(buildModelsUrlCandidates("https://x.com", "https://override/models")).toEqual(["https://override/models"]);
```

Run: `pnpm --filter @entrotect/core exec vitest run test/models.test.ts`
Expected: FAIL — function not exported.

- [ ] **Step 2: Extend protocol + config**

`shared/src/protocol.ts:52` add to `ProviderConfig`:

```ts
modelsUrl?: string;
apiFormat?: "openai" | "anthropic" | "google";
category?: "official"|"cn_official"|"cloud"|"aggregator";
icon?: string;
```

Update Zod `providerConfigSchema` and `config.ts` merge to preserve these keys.

- [ ] **Step 3: Implement candidates + sequential fetch in models.ts**

Port `model_fetch.rs:150` logic: `KNOWN_COMPAT_SUFFIXES = ["/api/anthropic","/anthropic",...9 items]`, `endsWithVersionSegment`, `stripCompatSuffix`, dedup. `listModels` iterates `candidates`, each `fetchImpl(url,{headers: apiFormat==="anthropic"?"x-api-key":apiFormat==="google"?"x-goog-api-key":"Bearer", signal: AbortSignal.timeout(15_000)})`, on 404/405 continue else throw; parse `data:[{id}]` + `context_length` fields, sort ids.

- [ ] **Step 4: Wire host**

`host.ts:171` `ListModels` now calls `listModelsForProvider(provider)` which internally already uses candidates + headers via `provider.apiFormat/modelsUrl`; no extra host arg needed.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @entrotect/core exec vitest run test/models.test.ts test/catalog.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/provider/models.ts packages/shared/src/protocol.ts packages/core/src/config.ts packages/app-desktop/src/main/host.ts packages/core/test/models.test.ts
git commit -m "feat: add candidate model URL generation with cc-switch compat"
```

### Task 3: Expanded Presets

**Files:**
- Create: `packages/core/src/provider/presets.ts`
- Modify: `packages/shared/src/protocol.ts` (DEFAULT_CONFIG)
- Modify: `packages/core/src/config.ts` (migrate)
- Modify: `packages/app-desktop/src/renderer/components/SettingsPage.tsx` (optional filter)

**Interfaces:**
- Produces: `export const PROVIDER_PRESETS: ProviderConfig[]` (8-12 entries with modelsUrl/category/apiFormat/icon).

- [ ] **Step 1: Write preset test**

```ts
expect(PROVIDER_PRESETS.find(p=>p.id==="deepseek")!.modelsUrl).toBe("https://api.deepseek.com/models");
```

- [ ] **Step 2: Implement presets + DEFAULT_CONFIG hydration**

Move current `DEFAULT_CONFIG.providers` (4 builtins) into `presets.ts` with added fields, re-export for `protocol.ts`.

- [ ] **Step 3: Verify + commit**

Run `pnpm --filter @entrotect/core exec vitest run test/presets.test.ts` + full `pnpm test`
Commit.

