// =====================================================================
// websearch: DuckDuckGo HTML 搜索，无需 API Key
// 设计:对标 Claude Code WebSearch — 返回标题/链接/摘要，超时 15s
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const inputSchema = z.strictObject({
  query: z.string().min(1).describe("搜索关键词"),
  count: z.number().int().min(1).max(10).optional().describe("返回条数(默认 5，上限 10)"),
});

type Input = z.infer<typeof inputSchema>;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export const websearchTool: Tool = {
  name: "websearch",
  description:
    "网络搜索（基于 DuckDuckGo，无需 API Key）。输入关键词，返回标题、URL 与摘要，用于查文档/库用法/issue 前先搜索再抓取。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).query,
  async call(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const count = args.count ?? 5;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          Accept: "text/html",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const html = await res.text();
      // 解析 DDG html 结果：a.result__a 为标题，a.result__url 为显示 URL，.result__snippet 为摘要
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      // 旧版 html.duckduckgo.com 结构
      const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__url[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      // 简化：先按 result 块切分
      const blocks = html.split(/class="result__title"/i);
      for (let i = 1; i < blocks.length && results.length < count; i++) {
        const block = blocks[i]!;
        const hrefMatch = block.match(/href="([^"]+)"/);
        const titleMatch = block.match(/>([^<]+)<\/a>/);
        const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/i);
        if (!hrefMatch || !titleMatch) continue;
        let href = decodeEntities(hrefMatch[1] ?? "");
        // DDG 重定向：/l/?uddg=https%3A... 需解码
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) {
          try {
            href = decodeURIComponent(uddg[1]!);
          } catch {}
        }
        // 过滤站内
        if (href.startsWith("/")) continue;
        let title = decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, "").trim());
        let snippet = "";
        if (snippetMatch) {
          snippet = decodeEntities(snippetMatch[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        }
        if (!title) continue;
        results.push({ title, url: href, snippet });
      }
      // 兜底：若未解析到，用更宽松的正则
      if (results.length === 0) {
        const altRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]{8,})<\/a>/g;
        let alt: RegExpExecArray | null;
        while ((alt = altRe.exec(html)) !== null && results.length < count) {
          const href = decodeEntities(alt[1] ?? "");
          if (href.includes("duckduckgo.com") || href === "#") continue;
          const title = decodeEntities(alt[2]!.trim());
          if (title.length < 8) continue;
          results.push({ title, url: href, snippet: "" });
        }
      }
      if (results.length === 0) return `搜索“${args.query}”无结果(或解析失败)，请换关键词或直接用 webfetch 访问已知 URL。`;
      const lines = results.slice(0, count).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
      return `搜索: "${args.query}"（${results.length} 条）\n\n${lines.join("\n\n")}\n\n提示：用 webfetch 抓取上述 URL 进一步阅读。`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("abort")) throw new Error(`搜索超时(15s): ${args.query}`);
      throw new Error(`搜索失败: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  },
};
