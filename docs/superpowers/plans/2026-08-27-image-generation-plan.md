# Image Generation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `generate_image` tool usable by main agent and sub-agents via OpenAI-compatible images API.

**Architecture:** Tool file calling `{baseUrl}/images/generations`, context-injected provider, registered in builtin tools.

**Tech Stack:** TypeScript, Vitest, Zod, Node fetch/fs.

## Global Constraints
- Tool non-readonly (write mode requires approval).
- No destructive config migration.

---

### Task 1: Image Tool + Registry + Types

**Files:**
- Create: `packages/core/src/tools/image.ts`
- Modify: `packages/core/src/tools/types.ts`
- Modify: `packages/core/src/tools/registry.ts`
- Modify: `packages/app-desktop/src/main/host.ts`
- Test: `packages/core/test/image.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/core/test/image.test.ts
import { describe, it, expect } from "vitest";
import { imageTool } from "../src/tools/image.js";
it("validates prompt and file_path required", async () => {
  await expect(imageTool.call({}, {cwd:"/tmp",artifactDir:"/tmp",sandboxMode:"full"} as any)).rejects.toThrow();
});
it("writes b64 image to file", async () => {
  // stub fetch returning {data:[{b64_json: "iVBOR..."}]}
});
```

Run: `pnpm --filter @entrotect/core exec vitest run test/image.test.ts` Expect FAIL file not found.

- [ ] **Step 2: Implement ToolContext.imageProvider and image.ts**

`types.ts` add `imageProvider?: {baseUrl:string,apiKey:string,model?:string}` to `ToolContext`.

`image.ts`:

```ts
const inputSchema = z.strictObject({
  prompt: z.string().min(1).describe("图像描述"),
  file_path: z.string().min(1).describe("保存路径(相对cwd,如 images/out.png)"),
  model: z.string().optional().describe("覆盖图像模型"),
  size: z.enum(["1024x1024","1024x1792","1792x1024","512x512"]).optional(),
  n: z.number().int().min(1).max(4).optional(),
});
export const imageTool: Tool = {
  name:"generate_image", description:"调用图片生成模型生成图片并保存到文件",
  inputSchema, isReadOnly:false, preview:(a)=>(a as any).prompt.slice(0,40),
  async call(rawArgs, ctx){ /* POST {baseUrl}/images/generations with Bearer/x-api-key, handle b64_json/url, write file, return summary */ }
}
```

Support `apiFormat` header mapping, 15s timeout via AbortSignal, write via `mkdir+writeFile` base64 buffer.

- [ ] **Step 3: Register**

`registry.ts`: `buildBuiltinTools({taskRunner,imageProvider})` includes `imageTool` when `imageProvider` or always; set global via `setImageProvider`.

`host.ts`: `acceptRun` creates `getImageProvider=()=>({baseUrl: activeProvider.baseUrl, apiKey:activeProvider.apiKey})` and passes to `buildBuiltinTools` and subagent runner.

- [ ] **Step 4: Verify**

`pnpm --filter @entrotect/core exec vitest run test/image.test.ts` PASS, `pnpm test` 174+ pass, `pnpm --filter @entrotect/app-desktop build` intact.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/image.ts packages/core/src/tools/types.ts packages/core/src/tools/registry.ts packages/app-desktop/src/main/host.ts packages/core/test/image.test.ts
git commit -m "feat: add generate_image tool for OpenAI-compatible image models"
```
