// =====================================================================
// websearch: 多引擎 HTML 搜索，无需 API Key
// 主引擎: Bing(国内可直连,不依赖代理); 回退: DuckDuckGo
// 返回标题/链接/摘要,单引擎 12s 超时。
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const inputSchema = z.strictObject({
  query: z.string().min(1).describe("搜索关键词"),
  count: z.number().int().min(1).max(10).optional().describe("返回条数(默认 5，上限 10)"),
});

type Input = z.infer<typeof inputSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8250;/g, "›")
    .replace(/&#x203a;/g, "›")
    .replace(/&#8250;/g, "›");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

/* ---------------- Bing ----------------
 * 结构: <li class="b_algo">...<h2><a href="bing ck/a redirect">title</a>
 *       ...<cite>domain › path</cite> ... <p>snippet</p>
 * cite 的 "›" 分隔还原为真实 URL(direct link 是 ck/a 重定向,不可直接使用)。
 */
function parseBing(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < count) {
    const block = m[1] ?? "";
    const titleLink = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const cite = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!titleLink) continue;
    const title = stripTags(titleLink[1] ?? "");
    if (!title) continue;
    let url = "";
    if (cite) {
      // "https://example.com › blog › post" → "https://example.com/blog/post"
      const decoded = stripTags(cite[1] ?? "");
      const schemeMatch = decoded.match(/^(https?:\/\/)/i);
      if (schemeMatch) {
        const rest = decoded
          .slice(schemeMatch[0].length)
          .replace(/\s*›\s*/g, "/")
          .replace(/\/+/g, "/");
        url = `${schemeMatch[0]}${rest}`;
      }
    } else {
      const direct = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"/);
      if (direct && !direct[1]!.includes("bing.com")) url = decodeEntities(direct[1]!);
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet: snippet ? stripTags(snippet[1] ?? "") : "" });
  }
  return results;
}

/* ---------------- DuckDuckGo (fallback) ---------------- */
function parseDdg(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/class="result__title"/i);
  for (let i = 1; i < blocks.length && results.length < count; i++) {
    const block = blocks[i]!;
    const hrefMatch = block.match(/href="([^"]+)"/);
    const titleMatch = block.match(/>([^<]+)<\/a>/);
    const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/i);
    if (!hrefMatch || !titleMatch) continue;
    let href = decodeEntities(hrefMatch[1] ?? "");
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]!);
      } catch {}
    }
    if (href.startsWith("/")) continue;
    const title = stripTags(titleMatch[1] ?? "");
    if (!title) continue;
    const snippet = snippetMatch ? stripTags(snippetMatch[1] ?? "") : "";
    results.push({ title, url: href, snippet });
  }
  // 兜底宽松正则
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
  return results;
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const websearchTool: Tool = {
  name: "websearch",
  description:
    "网络搜索（Bing 优先、DuckDuckGo 备用，无需 API Key）。输入关键词，返回标题、URL 与摘要，用于查文档/库用法/issue 前先搜索再抓取。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).query,
  async call(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const count = args.count ?? 5;
    const errors: string[] = [];

    // 引擎顺序: Bing(国内直连) → DuckDuckGo
    const engines: Array<{ name: string; url: string; parse: (html: string, n: number) => SearchResult[] }> = [
      {
        name: "Bing",
        url: `https://www.bing.com/search?q=${encodeURIComponent(args.query)}`,
        parse: parseBing,
      },
      {
        name: "DuckDuckGo",
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`,
        parse: parseDdg,
      },
    ];

    for (const engine of engines) {
      try {
        const html = await fetchHtml(engine.url);
        const results = engine.parse(html, count);
        if (results.length === 0) {
          errors.push(`${engine.name}: 解析失败`);
          continue;
        }
        const lines = results.slice(0, count).map(
          (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
        );
        return `搜索: "${args.query}"（${engine.name}，${results.length} 条）\n\n${lines.join("\n\n")}\n\n提示：用 webfetch 抓取上述 URL 进一步阅读。`;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${engine.name}: ${msg.includes("abort") ? "超时" : msg}`);
      }
    }

    return `搜索失败(各引擎均未返回): ${errors.join("; ")}。请换关键词,或直接用 webfetch 访问已知 URL。`;
  },
};
