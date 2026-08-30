// =====================================================================
// write:创建/覆盖文件(自动创建父目录)
// =====================================================================

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { recordFileState } from "./file-state.js";
import { resolveInsideCwd } from "./paths.js";

const inputSchema = z.strictObject({
  file_path: z.string().describe("文件路径(相对路径基于工作目录)"),
  content: z.string().describe("完整文件内容"),
});

type Input = z.infer<typeof inputSchema>;

export const writeTool: Tool = {
  name: "write",
  description:
    "创建或覆盖文件。写入前请先用 read 确认现状,避免覆盖已有内容;" +
    "绝不写入用于硬约束有害行为的内容（大规模杀伤、关键基础设施攻击、重大恶意代码、非法权力攫取、CSAM等），遇此类请求应拒绝。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => (args as Input).file_path,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const absolute = resolveInsideCwd(ctx.cwd, args.file_path, ctx.protectedPaths);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, args.content, "utf8");
    await recordFileState(absolute);
    return `已写入 ${args.file_path}(${Buffer.byteLength(args.content, "utf8")} 字节)`;
  },
};
