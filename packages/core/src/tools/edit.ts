// =====================================================================
// edit:精确字符串替换(old_string 必须唯一匹配)
// 设计依据:ClaudeCode FileEdit——精确替换 + readFileState 新鲜度校验,
// 防止覆盖他人改动;唯一匹配失败报错并给出上下文。
// =====================================================================

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { isStale, recordFileState } from "./file-state.js";

const inputSchema = z.strictObject({
  file_path: z.string().describe("文件路径(相对路径基于工作目录)"),
  old_string: z.string().describe("待替换的原文片段,必须在文件中唯一匹配"),
  new_string: z.string().describe("替换后的新片段"),
  replace_all: z
    .boolean()
    .optional()
    .describe("true 时替换所有匹配(默认 false,要求唯一匹配)"),
});

type Input = z.infer<typeof inputSchema>;

function findOccurrences(content: string, needle: string): number[] {
  const positions: number[] = [];
  let index = content.indexOf(needle);
  while (index !== -1) {
    positions.push(index);
    index = content.indexOf(needle, index + 1);
  }
  return positions;
}

export const editTool: Tool = {
  name: "edit",
  description:
    "对文件做精确字符串替换。old_string 必须与文件内容逐字符一致(含缩进)。" +
    "修改前请先 read;若唯一匹配失败,重新 read 后再试。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => {
    const input = args as Input;
    return `${input.file_path}: 替换 "${input.old_string.slice(0, 60)}"`;
  },
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const absolute = path.resolve(ctx.cwd, args.file_path);

    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      throw new Error(`文件不存在: ${args.file_path}`);
    }

    // 新鲜度闸门:上次 read 之后被外部改动则拒绝编辑
    if (await isStale(absolute)) {
      throw new Error(
        `文件 ${args.file_path} 自上次 read 后被修改,请重新 read 后再编辑。`,
      );
    }

    const occurrences = findOccurrences(content, args.old_string);
    if (occurrences.length === 0) {
      throw new Error(
        `未找到 old_string。请用 read 确认当前内容(注意缩进与换行符)。`,
      );
    }
    if (!args.replace_all && occurrences.length > 1) {
      throw new Error(
        `old_string 匹配到 ${occurrences.length} 处,不唯一。请扩大上下文使其唯一,或设置 replace_all。`,
      );
    }

    const next = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);
    await writeFile(absolute, next, "utf8");
    await recordFileState(absolute);

    const count = args.replace_all ? occurrences.length : 1;
    return `已替换 ${count} 处于 ${args.file_path}`;
  },
};
