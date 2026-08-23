// =====================================================================
// read:读取文件(行号 + offset/limit 窗口)
// 设计依据:ClaudeCode FileRead 自限——超大文件拒绝全文,引导模型窗口读。
// =====================================================================

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { recordFileState } from "./file-state.js";

/** 单次可读上限 256KB,超出引导用 offset/limit 窗口读 */
const MAX_READ_BYTES = 256 * 1024;

const inputSchema = z.strictObject({
  file_path: z.string().describe("文件路径(相对路径基于工作目录)"),
  offset: z.number().int().min(1).optional().describe("起始行号(1-based,默认 1)"),
  limit: z.number().int().min(1).optional().describe("最多读取行数(默认全文)"),
});

type Input = z.infer<typeof inputSchema>;

export const readTool: Tool = {
  name: "read",
  description:
    "读取文本文件内容,带行号。大文件请用 offset/limit 分窗口读取,不要一次读全。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).file_path,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const absolute = path.resolve(ctx.cwd, args.file_path);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new Error(`文件不存在: ${args.file_path}`);
    }
    if (!info.isFile()) throw new Error(`不是文件: ${args.file_path}`);
    if (info.size > MAX_READ_BYTES) {
      throw new Error(
        `文件过大(${info.size} 字节,上限 ${MAX_READ_BYTES})。请用 offset/limit 分窗口读取。`,
      );
    }

    const text = await readFile(absolute, "utf8");
    let lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const offset = (args.offset ?? 1) - 1;
    const limit = args.limit ?? lines.length - offset;
    const window = lines.slice(offset, offset + limit);

    // 记录状态供 edit 新鲜度校验
    await recordFileState(absolute);

    return window
      .map((line, i) => `${String(offset + i + 1).padStart(6, " ")}| ${line}`)
      .join("\n");
  },
};
