// =====================================================================
// read:读取文件(行号 + offset/limit 窗口)
// 设计依据:ClaudeCode FileRead 自限——超大文件拒绝全文,引导模型窗口读。
// =====================================================================

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { recordFileDigest } from "./file-state.js";
import { withFileLock } from "./file-access.js";
import { resolveInsideCwd } from "./paths.js";

/** 单次可读上限 256KB,超出引导用 offset/limit 窗口读 */
const MAX_READ_BYTES = 256 * 1024;
const MAX_WINDOW_BYTES = 40_000;

const inputSchema = z.strictObject({
  file_path: z.string().describe("文件路径(相对路径基于工作目录)"),
  offset: z.number().int().min(1).optional().describe("起始行号(1-based,默认 1)"),
  limit: z.number().int().min(1).optional().describe("最多读取行数(默认全文)"),
});

type Input = z.infer<typeof inputSchema>;

function resolveReadablePath(ctx: ToolContext, requested: string): string | Promise<string> {
  const absolute = path.resolve(ctx.cwd, requested);
  const artifacts = path.resolve(ctx.artifactDir);
  // The only exception to workspace confinement is a generated text output in
  // this session's artifact directory. Never expose config, other sessions, or links.
  if (path.relative(artifacts, path.dirname(absolute)) === "" && /^tool-output-\d+-[a-f0-9]{8}\.txt$/i.test(path.basename(absolute))) {
    return (async () => {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || path.relative(await realpath(artifacts), path.dirname(await realpath(absolute))) !== "") {
        throw new Error("工具输出路径无效");
      }
      return absolute;
    })();
  }
  return resolveInsideCwd(ctx.cwd, requested, ctx.protectedPaths);
}

/** Hash the complete decoded file for freshness checks; retain only a bounded
 * line window in memory, including for very large files or a single huge line. */
async function readWindow(filePath: string, args: Input, ctx: ToolContext): Promise<string> {
  const first = args.offset ?? 1;
  const last = first + (args.limit ?? Number.MAX_SAFE_INTEGER) - 1;
  const hash = createHash("sha256");
  const output: string[] = [];
  let line = 1;
  let pending = "";
  let hasPending = false;
  let longLine = false;
  let bytes = 0;
  let nextOffset: number | undefined;
  let clippedLine: number | undefined;
  const flush = () => {
    if (line >= first && line <= last && nextOffset === undefined) {
      let formatted = `${String(line).padStart(6, " ")}| ${pending.replace(/\r$/, "")}`;
      const size = Buffer.byteLength(formatted) + 1;
      if (bytes + size > MAX_WINDOW_BYTES && output.length) {
        nextOffset = line;
      } else {
        if (size > MAX_WINDOW_BYTES || longLine) {
          const buffer = Buffer.from(formatted);
          let end = Math.min(buffer.length, MAX_WINDOW_BYTES - 80);
          while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
          formatted = buffer.subarray(0, end).toString("utf8") + " …[本行过长，后部省略]";
          clippedLine = line;
          nextOffset = line + 1;
        }
        output.push(formatted);
        bytes += Buffer.byteLength(formatted) + 1;
      }
    }
    line++;
    pending = "";
    hasPending = false;
    longLine = false;
  };
  for await (const chunk of createReadStream(filePath, { encoding: "utf8", signal: ctx.abortSignal })) {
    const text = String(chunk);
    hash.update(text);
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      const segment = text.slice(start, end < 0 ? undefined : end);
      hasPending ||= segment.length > 0;
      if (line >= first && line <= last && nextOffset === undefined) {
        const room = MAX_WINDOW_BYTES - pending.length;
        pending += segment.slice(0, room);
        longLine ||= segment.length > room;
      }
      if (end < 0) break;
      flush();
      start = end + 1;
    }
  }
  if (hasPending) flush();
  const totalLines = line - 1;
  ctx.abortSignal?.throwIfAborted();
  recordFileDigest(ctx, filePath, hash.digest("hex"));
  if (first > totalLines) return `[文件共 ${totalLines} 行，offset ${first} 已超出末尾]`;
  const next = nextOffset ?? (last < totalLines ? last + 1 : undefined);
  if (clippedLine !== undefined) output.push(`[第 ${clippedLine} 行过长，仅显示开头；需要其余内容时请用 grep 或定向查询。]`);
  if (next !== undefined && next <= totalLines) output.push(`[文件共 ${totalLines} 行；继续读取请使用 offset=${next}，limit=${args.limit ?? 200}。]`);
  return output.join("\n");
}

export const readTool: Tool = {
  name: "read",
  description:
    "读取工作区文本文件或当前会话保存的完整工具输出，带行号。大文件须指定 offset/limit；每次最多约 40KB，返回后续行号。",
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  preview: (args) => (args as Input).file_path,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const resolved = resolveReadablePath(ctx, args.file_path);
    const absolute = typeof resolved === "string" ? resolved : await resolved;
    return withFileLock(absolute, ctx.abortSignal, async (filePath) => {
      let info;
      try {
        info = await stat(filePath);
      } catch {
        throw new Error(`文件不存在: ${args.file_path}`);
      }
      if (!info.isFile()) throw new Error(`不是文件: ${args.file_path}`);
      if (info.size > MAX_READ_BYTES && args.offset === undefined && args.limit === undefined) {
        throw new Error(
          `文件过大(${info.size} 字节,上限 ${MAX_READ_BYTES})。请用 offset/limit 分窗口读取。`,
        );
      }

      return readWindow(filePath, args, ctx);
    });
  },
};
