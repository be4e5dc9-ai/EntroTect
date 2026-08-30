// =====================================================================
// grep:正则搜索文件内容(自带目录遍历,跳过二进制与依赖目录)
// =====================================================================

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { resolveInsideCwd } from "./paths.js";

const MAX_RESULTS = 500;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".venv", "__pycache__"]);
const MAX_FILE_BYTES = 512 * 1024;

const inputSchema = z.strictObject({
  pattern: z.string().describe("正则表达式(JS 语法)"),
  path: z.string().optional().describe("搜索根目录或文件(默认工作目录)"),
  include: z.string().optional().describe("文件名 glob 过滤,如 *.ts"),
  case_sensitive: z.boolean().optional().describe("默认 false"),
  max_results: z.number().int().min(1).optional().describe(`默认 ${MAX_RESULTS}`),
});

type Input = z.infer<typeof inputSchema>;

interface Match {
  file: string;
  line: number;
  text: string;
}

function matchesInclude(fileName: string, include?: string): boolean {
  if (!include) return true;
  const escaped = include.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(fileName);
}

async function walk(
  dir: string,
  regex: RegExp,
  include: string | undefined,
  max: number,
  out: Match[],
  signal?: AbortSignal,
): Promise<void> {
  if (out.length >= max) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限目录跳过
  }
  for (const entry of entries) {
    if (signal?.aborted) return;
    if (out.length >= max) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, regex, include, max, out, signal);
      continue;
    }
    if (!entry.isFile() || !matchesInclude(entry.name, include)) continue;

    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      const buffer = await readFile(full);
      if (buffer.subarray(0, 8192).includes(0)) continue; // 二进制嗅探
      content = buffer.toString("utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= max) return;
      const line = lines[i];
      if (line === undefined) continue;
      if (regex.test(line)) {
        out.push({ file: path.relative(process.cwd(), full), line: i + 1, text: line.trim().slice(0, 200) });
      }
    }
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "按正则搜索文件内容(默认忽略大小写),返回 文件:行号 与行内容。用于在代码库中定位符号与用法。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).pattern,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_sensitive ? "" : "i");
    } catch (error) {
      throw new Error(`无效正则: ${error instanceof Error ? error.message : String(error)}`);
    }

    const root = args.path ? resolveInsideCwd(ctx.cwd, args.path, ctx.protectedPaths) : ctx.cwd;
    const info = await stat(root).catch(() => null);
    if (!info) throw new Error(`路径不存在: ${args.path ?? "."}`);

    const matches: Match[] = [];
    const max = args.max_results ?? MAX_RESULTS;
    if (info.isDirectory()) {
      await walk(root, regex, args.include, max, matches, ctx.abortSignal);
    } else if (info.isFile()) {
      const content = await readFile(root, "utf8");
      content.split(/\r?\n/).forEach((line, i) => {
        if (matches.length < max && regex.test(line)) {
          matches.push({ file: args.path ?? root, line: i + 1, text: line.trim().slice(0, 200) });
        }
      });
    }

    if (matches.length === 0) return "无匹配";
    return matches
      .map((m) => `${m.file}:${m.line}: ${m.text}`)
      .join("\n");
  },
};
