// =====================================================================
// webfetch:抓取网页内容并转为可读文本
// 设计:对标 Claude Code WebFetch — 15s 超时、200KB 上限、HTML 清洗
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const inputSchema = z.strictObject({
  url: z.string().url().describe("要抓取的完整 URL(https://…)"),
  maxChars: z.number().int().min(1000).max(50000).optional().describe("返回文本上限(默认 12000 字符)"),
});

type Input = z.infer<typeof inputSchema>;

function stripHtml(html: string): string {
  // 移除 script/style/nav/footer
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // 提取正文常用标签内容，剩余标签剥离
  text = text.replace(/<[^>]+>/g, " ");
  // 解码常见实体
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
  // 合并空白
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/ *\n */g, "\n").trim();
  // 过长空白清理
  text = text.replace(/\n{2,}/g, "\n\n");
  return text;
}

export const webfetchTool: Tool = {
  name: "webfetch",
  description:
    "抓取网页内容并转为可读文本。用于查文档、读博客/issue。输入 URL，返回清洗后的正文（默认 12k 字符，超时 15s，200KB 上限）。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).url,
  async call(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const maxChars = args.maxChars ?? 12000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(args.url, {
        headers: {
          "User-Agent": "EntroTect/1.0 (+https://github.com/be4e5dc9-ai/EntroTect)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const contentType = res.headers.get("content-type") ?? "";
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 200 * 1024) {
        // 超限截断后仍继续处理，避免超大页面
      }
      let text: string;
      if (contentType.includes("application/json")) {
        text = new TextDecoder().decode(buf);
        // JSON 原样返回（截断）
        if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(已截断)`;
        return `URL: ${args.url}\nContent-Type: ${contentType}\n\n${text}`;
      }
      const html = new TextDecoder().decode(buf.slice(0, 200 * 1024));
      text = stripHtml(html);
      if (!text) text = "(页面无可读文本)";
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(已截断，原文更长)`;
      return `URL: ${args.url}\n\n${text}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("abort")) throw new Error(`抓取超时(15s): ${args.url}`);
      throw new Error(`抓取失败: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  },
};
