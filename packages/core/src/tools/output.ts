// =====================================================================
// 工具输出治理:截断第一道闸
// 设计依据:ClaudeCode/04 截断三道闸——超限落盘换预览,掐住上下文爆炸
// 的最大源头。50KB 阈值照抄 ClaudeCode 常量。
// =====================================================================

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 单次工具输出上限(字节),超过即落盘换预览 */
export const MAX_TOOL_OUTPUT_BYTES = 50_000;
/** 预览 = 头尾各一半 */
const PREVIEW_BYTES = 8_000;

export interface Truncated {
  content: string;
  spilledTo: string | null;
}

/**
 * 超限输出落盘,返回 "头+尾" 预览与落盘路径提示。
 * 落盘目录由主循环注入(会话 artifacts 目录)。
 */
export async function truncateOutput(
  output: string,
  artifactDir: string,
): Promise<Truncated> {
  if (Buffer.byteLength(output, "utf8") <= MAX_TOOL_OUTPUT_BYTES) {
    return { content: output, spilledTo: null };
  }

  await mkdir(artifactDir, { recursive: true });
  const fileName = `tool-output-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
  const fullPath = path.join(artifactDir, fileName);
  await writeFile(fullPath, output, "utf8");

  const head = output.slice(0, Math.floor(PREVIEW_BYTES / 2));
  const tail = output.slice(-Math.ceil(PREVIEW_BYTES / 2));
  const content =
    `[输出 ${Buffer.byteLength(output, "utf8")} 字节,已截断。` +
    `完整内容保存在: ${fullPath}]\n` +
    `${head}\n...\n[中间省略 ${output.length - head.length - tail.length} 字符]\n...\n${tail}`;
  return { content, spilledTo: fullPath };
}
