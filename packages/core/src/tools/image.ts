// =====================================================================
// generate_image: OpenAI 兼容图片生成 (/v1/images/generations)
// 供应商 baseUrl/apiKey 来自 ToolContext.imageProvider(由 host 注入),
// 未配置时抛错引导;支持 b64_json 与 url 两种回包,落盘到 cwd 相对路径。
// =====================================================================

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const inputSchema = z.strictObject({
  prompt: z.string().min(1).describe("图像描述(必填)"),
  file_path: z
    .string()
    .min(1)
    .describe("保存路径(相对工作目录,如 images/out.png)"),
  model: z.string().optional().describe("图片模型(可选,覆盖当前供应商的默认模型)"),
  size: z
    .enum(["1024x1024", "1024x1792", "1792x1024", "512x512", "1024x768", "768x1024"])
    .optional()
    .describe("输出尺寸"),
  n: z.number().int().min(1).max(4).optional().describe("生成张数(1-4)"),
});

type Input = z.infer<typeof inputSchema>;

// host 注入的全局回落(无 run 上下文时,便于测试)
let globalImageProvider: { baseUrl: string; apiKey: string; model?: string; apiFormat?: string } | null =
  null;

export function setImageProvider(
  provider: { baseUrl: string; apiKey: string; model?: string; apiFormat?: string } | null,
): void {
  globalImageProvider = provider;
}

function resolveProvider(ctx: ToolContext): {
  baseUrl: string;
  apiKey: string;
  model?: string;
  apiFormat?: string;
} | null {
  const fromCtx = (ctx as unknown as { imageProvider?: { baseUrl: string; apiKey: string; model?: string; apiFormat?: string } })
    .imageProvider;
  return fromCtx ?? globalImageProvider;
}

export const imageTool: Tool = {
  name: "generate_image",
  description:
    "调用图片生成模型生成图片并保存到文件。prompt 为图像描述,file_path 为保存路径(相对工作目录)。需要已配置支持图片生成的供应商(baseUrl/apiKey);" +
    "绝不生成 CSAM、非自愿性色情、或用于大规模伤害/非法权力攫取的图像，遇此类请求应拒绝。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => (args as Input).prompt.slice(0, 40),
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const provider = resolveProvider(ctx);
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      throw new Error("未配置图片生成供应商:请在设置中配置支持图片生成的供应商(baseUrl/apiKey)");
    }
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const model = args.model ?? provider.model;
    const url = `${baseUrl}/images/generations`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const fmt = provider.apiFormat;
    if (fmt === "anthropic") headers["x-api-key"] = provider.apiKey;
    else if (fmt === "google") headers["x-goog-api-key"] = provider.apiKey;
    else headers["Authorization"] = `Bearer ${provider.apiKey}`;

    const body: Record<string, unknown> = {
      prompt: args.prompt,
      n: args.n ?? 1,
      size: args.size ?? "1024x1024",
    };
    if (model) body["model"] = model;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        const j = (await response.json()) as { error?: { message?: string }; message?: string };
        detail = j.error?.message ?? j.message ?? "";
      } catch {}
      const msg = detail ? `${response.status}: ${detail}` : `${response.status} ${response.statusText}`;
      throw new Error(`图片生成失败(${msg})`);
    }

    const data = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const items = data.data ?? [];
    if (items.length === 0) throw new Error("图片生成返回为空");

    const n = args.n ?? 1;
    const written: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      let buffer: Buffer;
      if (item.b64_json) {
        buffer = Buffer.from(item.b64_json, "base64");
      } else if (item.url) {
        const r = await fetch(item.url, { signal: ctx.abortSignal });
        if (!r.ok) throw new Error(`下载图片失败: ${r.status}`);
        const ab = await r.arrayBuffer();
        buffer = Buffer.from(ab);
      } else {
        throw new Error("图片数据缺失(b64_json/url)");
      }
      // 多张时在文件名后加 -1,-2
      let filePath = args.file_path;
      if (items.length > 1) {
        const ext = path.extname(filePath);
        const base = filePath.slice(0, filePath.length - ext.length);
        filePath = `${base}-${i + 1}${ext}`;
      }
      const absolute = path.resolve(ctx.cwd, filePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, buffer);
      written.push(`${filePath}(${buffer.length} 字节)`);
      // 单张 n>1 但只返回 1 张也按实际
      if (written.length >= n) break;
    }

    return `已生成 ${written.length} 张图片: ${written.join(", ")}`;
  },
};
