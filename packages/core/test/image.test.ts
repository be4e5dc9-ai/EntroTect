import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { imageTool, setImageProvider } from "../src/tools/image.js";
import type { ToolContext } from "../src/tools/types.js";

async function makeCtx(root: string, provider?: any): Promise<ToolContext> {
  await mkdir(root, { recursive: true });
  return {
    cwd: root,
    artifactDir: root,
    sandboxMode: "full",
    imageProvider: provider,
  } as unknown as ToolContext;
}

describe("generate_image", () => {
  let tmp: string;
  let origFetch: any;
  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `entrotect-img-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmp, { recursive: true });
    origFetch = globalThis.fetch;
    setImageProvider(null);
  });
  afterEach(async () => {
    globalThis.fetch = origFetch;
    await rm(tmp, { recursive: true, force: true });
  });

  it("validates required fields", async () => {
    const ctx = await makeCtx(tmp, { baseUrl: "https://api.example.com/v1", apiKey: "sk" });
    await expect(imageTool.call({}, ctx)).rejects.toThrow();
    await expect(imageTool.call({ prompt: "hi" } as any, ctx)).rejects.toThrow();
  });

  it("writes b64_json to file", async () => {
    const b64 = Buffer.from("fake-png").toString("base64");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as any;
    const ctx = await makeCtx(tmp, { baseUrl: "https://api.example.com/v1", apiKey: "sk", model: "dall-e-3" });
    const res = await imageTool.call({ prompt: "a cat", file_path: "out.png" }, ctx);
    expect(res).toContain("out.png");
    const content = await readFile(path.join(tmp, "out.png"), "utf8");
    expect(content).toBe("fake-png");
  });

  it("fetches url when b64 missing", async () => {
    const png = Buffer.from("url-png");
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/img.png" }] }), { status: 200 }) as any;
      }
      return new Response(png as any, { status: 200 }) as any;
    }) as any;
    const ctx = await makeCtx(tmp, { baseUrl: "https://api.example.com/v1", apiKey: "sk" });
    await imageTool.call({ prompt: "a cat", file_path: "out2.png", model: "img-model" }, ctx);
    const content = await readFile(path.join(tmp, "out2.png"));
    expect(content.equals(png)).toBe(true);
    globalThis.fetch = orig;
  });

  it("throws on http error", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 })) as any;
    const ctx = await makeCtx(tmp, { baseUrl: "https://api.example.com/v1", apiKey: "sk" });
    await expect(imageTool.call({ prompt: "hi", file_path: "x.png", model: "m" }, ctx)).rejects.toThrow(/400/);
  });

  it("requires provider config", async () => {
    const ctx = await makeCtx(tmp, undefined);
    await expect(imageTool.call({ prompt: "hi", file_path: "x.png" }, ctx)).rejects.toThrow(/未配置/);
  });
});
