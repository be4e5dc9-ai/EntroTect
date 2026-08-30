// =====================================================================
// websearch: 三引擎搜索，无需 API Key
// StackOverflow(Stack Exchange API,技术/自然语言查询相关度最高,JSON)
// + DuckDuckGo(技术相关度高;国内可能被墙/限流,短超时)
// + Bing(国内可直连,稳定兜底,完整超时)。并行抓取、按规范化 URL 去重、相关度优先。
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
  const fromCodePointSafe = (cp: number): string =>
    cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePointSafe(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&ensp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

/* ---------------- Bing ----------------
 * 新版结构: <li class="b_algo">...<h2><a href="直链">title</a></h2>
 *       ...<cite>截断展示 URL</cite> ... <p>snippet</p>
 * h2 锚点 href 已是直链(不再走 ck/a 跳转),优先采用;
 * cite 现为截断展示串(含 "…"),仅在 href 是 Bing 跳转/缺失时回退还原。
 */
function parseBing(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < count) {
    const block = m[1] ?? "";
    const titleAnchor = block.match(
      /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!titleAnchor) continue;
    const title = stripTags(titleAnchor[2] ?? "");
    if (!title) continue;
    const href = decodeEntities(titleAnchor[1] ?? "");
    const cite = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

    let url = "";
    if (/^https?:\/\//i.test(href) && !href.includes("bing.com")) {
      url = href;
    } else if (cite) {
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

/** 规范化 URL 用于去重:剥 www、去 query/hash/末尾斜杠、host 小写 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url.toLowerCase();
  }
}

/* ---------------- StackOverflow(Stack Exchange API) ----------------
 * JSON 接口,无需 key(300 次/天/IP)。sort=relevance 对技术/自然语言查询
 * 相关度远高于通用搜索引擎,是编码 Agent 的首选来源。
 */
interface StackExchangeItem {
  title?: string;
  link?: string;
  tags?: string[];
  answer_count?: number;
}

async function searchStackExchange(query: string, count: number): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url =
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance` +
      `&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${count}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "EntroTect/1.0 (+https://github.com/be4e5dc9-ai/EntroTect)" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let json: { items?: StackExchangeItem[] };
    try {
      json = (await res.json()) as { items?: StackExchangeItem[] };
    } catch {
      return []; // 非 JSON 响应(限流/错误页),视为无结果
    }
    const results: SearchResult[] = [];
    for (const item of json.items ?? []) {
      if (!item.title || !item.link) continue;
      const tags = item.tags?.length ? item.tags.map((t) => `[${t}]`).join(" ") : "";
      const meta = item.answer_count != null ? `${item.answer_count} 个回答` : "";
      results.push({ title: item.title, url: item.link, snippet: [tags, meta].filter(Boolean).join(" · ") });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    "网络搜索（Stack Overflow + DuckDuckGo + Bing 多引擎合并去重，无需 API Key）。输入关键词，返回标题、URL 与摘要，用于查文档/库用法/issue 前先搜索再抓取。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).query,
  async call(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const count = args.count ?? 5;
    const query = encodeURIComponent(args.query);

    // 三引擎并行抓取。StackOverflow 技术相关度最高;DDG 次之(国内可能被墙/限流,短超时);
    // Bing 稳定兜底,完整超时。任一引擎失败/无结果都不致命,合并时按相关度优先。
    const engines: Array<{ name: string; run: () => Promise<SearchResult[]> }> = [
      { name: "StackOverflow", run: () => searchStackExchange(args.query, count) },
      {
        name: "DuckDuckGo",
        run: () => fetchHtml(`https://html.duckduckgo.com/html/?q=${query}`, 4000).then((h) => parseDdg(h, count)),
      },
      {
        name: "Bing",
        run: () => fetchHtml(`https://www.bing.com/search?q=${query}`, 12000).then((h) => parseBing(h, count)),
      },
    ];

    const settled = await Promise.allSettled(engines.map((engine) => engine.run()));

    // 合并:按引擎顺序(StackOverflow → DDG → Bing)优先,按规范化 URL 去重。
    const merged: SearchResult[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    settled.forEach((result, i) => {
      const name = engines[i]!.name;
      if (result.status === "fulfilled") {
        if (result.value.length === 0) {
          errors.push(`${name}: 解析失败`);
          return;
        }
        for (const r of result.value) {
          const key = normalizeUrl(r.url);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(r);
        }
      } else {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`${name}: ${msg.includes("abort") ? "超时" : msg}`);
      }
    });

    if (merged.length === 0) {
      return `搜索失败(各引擎均未返回): ${errors.join("; ")}。请换关键词,或直接用 webfetch 访问已知 URL。`;
    }

    const shown = merged.slice(0, count);
    const lines = shown.map(
      (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
    );
    return `搜索: "${args.query}"（${shown.length} 条，多引擎合并去重）\n\n${lines.join("\n\n")}\n\n提示：用 webfetch 抓取上述 URL 进一步阅读。`;
  },
};
