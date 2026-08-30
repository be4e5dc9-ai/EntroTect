// =====================================================================
// webfetch:抓取网页内容并转为可读文本
// 设计:对标 Claude Code WebFetch — 15s 超时、200KB 上限、HTML 清洗
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { assertSafeUrl } from "./ssrf.js";

const inputSchema = z.strictObject({
  url: z.string().url().describe("要抓取的完整 URL(https://…)"),
  maxChars: z.number().int().min(1000).max(50000).optional().describe("返回文本上限(默认 12000 字符)"),
});

type Input = z.infer<typeof inputSchema>;

/** 重定向上限:超过即拦截,防跳板循环 */
const MAX_REDIRECTS = 5;

function classifyNetworkError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  // 超时(含我们主动 abort)单独归类
  if (msg.includes("abort") || msg.includes("timeout") || msg.includes("timed out")) {
    return "抓取超时(15s):连接或响应过慢,可能是网络或目标主机问题,非请求格式错误";
  }
  // 沿 cause 链取底层错误码,区分 TLS/DNS/连接类
  let cause: unknown = error;
  let code = "";
  let causeMsg = "";
  while (cause && typeof cause === "object") {
    const c = cause as { code?: string; message?: string };
    if (c.code) code = c.code;
    if (c.message) causeMsg = c.message;
    cause = (cause as { cause?: unknown }).cause;
  }
  const tlsCodes = [
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_TLS_HANDSHAKE_TIMEOUT",
    "CERT_HAS_EXPIRED",
    "ERR_SSL",
    "SSL",
  ];
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || causeMsg.includes("getaddrinfo")) {
    return `域名无法解析(DNS):${code || causeMsg} — 目标主机不可达,非请求格式错误`;
  }
  if (code === "ECONNREFUSED") {
    return `连接被拒绝(ECONNREFUSED):目标主机未监听该端口,非请求格式错误`;
  }
  if (code === "ECONNRESET" || code === "ENETRESET" || code === "ETIMEDOUT") {
    return `连接中断/超时(${code}):目标主机或中间网络不稳定,非请求格式错误`;
  }
  if (tlsCodes.some((t) => code.includes(t) || causeMsg.toUpperCase().includes(t))) {
    return `TLS 握手失败(${code || causeMsg}):目标站点证书/加密协商异常,非请求格式或代码问题,可换其他来源或重试`;
  }
  return `抓取失败:${msg || causeMsg} — 多为网络/主机问题,非请求格式错误`;
}

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
      // SSRF 防护:首跳 + 每一跳重定向都必须通过私网/元数据校验。
      // redirect: "manual" 由我们手写跳转循环,逐跳 assertSafeUrl。
      let currentUrl = await assertSafeUrl(new URL(args.url));
      let res: Response;
      for (let hop = 0; ; hop++) {
        res = await fetch(currentUrl.toString(), {
          headers: {
            "User-Agent": "EntroTect/1.0 (+https://github.com/be4e5dc9-ai/EntroTect)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "manual",
          signal: controller.signal,
        });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        if (!location) break;
        if (hop >= MAX_REDIRECTS) throw new Error("重定向次数过多,已拦截");
        currentUrl = await assertSafeUrl(new URL(location, currentUrl));
      }
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
      const message = error instanceof Error ? error.message : String(error);
      // SSRF 拦截/重定向超限:原样抛出,不套网络错误分类文案
      if (message.startsWith("目标地址不可访问") || message.startsWith("重定向次数过多")) {
        throw new Error(message);
      }
      throw new Error(`${classifyNetworkError(error)} — URL: ${args.url}`);
    } finally {
      clearTimeout(timer);
    }
  },
};
