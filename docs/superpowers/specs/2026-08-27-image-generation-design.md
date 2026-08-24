# Image Generation Design

**Date:** 2026-08-27

## Goal
Let agent generate images via configured provider's OpenAI-compatible `/v1/images/generations` without breaking chat loop.

## Scope
- New tool `generate_image` (non-readonly, needs approval per write/ask mode)
- Uses current active provider's `baseUrl/apiKey` (from `AppConfig` at run accept time), optional per-call `model/size/n` override
- Supports OpenAI-compatible response (`data:[{url,b64_json}]`), base64 or URL, saves to `cwd/file_path` (relative, auto mkdir)
- No UI button in this iteration; image preview via existing file-detail `file://` panel; future Composer button can reuse output path

## Architecture
- `core/src/tools/image.ts` — Zod schema, fetch to `{baseUrl}/images/generations`, handles 15s timeout, writes file(s), returns model-visible summary
- `ToolContext` extended with `imageProvider: {baseUrl,apiKey}` injected at `host.ts:acceptRun` (like `sandboxMode` getter)
- `registry.ts` extends `buildBuiltinTools({taskRunner,imageProvider})` to include `imageTool`
- Provider catalog adds `imageModels` hint list per provider (optional, for model validation only)

## Data Flow
1. `host acceptRun` clones config, resolves active `ProviderConfig`, creates `getImageProvider=()=>({baseUrl,apiKey,model: imageModel})`
2. `runAgent` passes it into `ToolContext.imageProvider`
3. `imageTool.call` POSTs JSON `{prompt, model: args.model ?? providerModel, size: args.size ?? "1024x1024", n: args.n ?? 1}` with `Authorization: Bearer` or `x-api-key`
4. On success decode `b64_json` or fetch `url` → write file → return `已生成 image.png (1024x1024)`

## Error Handling
- Missing prompt/file_path → Zod error; empty baseUrl/apiKey → "未配置图片供应商"; HTTP non-200 → ProviderError with truncated body; b64 decode failure → error; unknown context stays unknown (no fallback model).

## Testing
- `core/test/image.test.ts`: success b64 write, URL fetch, validation errors, HTTP error handling, abort signal.

## Non-Goals
- No edit/inpaint, no async queue, no credit display, no Composer preview button.
