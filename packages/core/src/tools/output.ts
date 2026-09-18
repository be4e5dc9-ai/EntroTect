// =====================================================================
// 工具输出治理:截断第一道闸
// 设计依据:ClaudeCode/04 截断三道闸——超限落盘换预览,掐住上下文爆炸
// 的最大源头。50KB 阈值照抄 ClaudeCode 常量。
// =====================================================================

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContentBlock } from "@entrotect/shared";

/** 单次工具输出上限(字节),超过即落盘换预览 */
export const MAX_TOOL_OUTPUT_BYTES = 50_000;
export const MAX_BATCH_OUTPUT_BYTES = 200_000;
/** 预览 = 头尾各一半 */
const PREVIEW_BYTES = 8_000;

export interface Truncated {
  content: string;
  spilledTo: string | null;
}

/** Slice without splitting a UTF-8 code point. */
function bytePreview(output: string, budget: number): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= budget) return output;
  const marker = "\n... [中间内容省略] ...\n";
  const edge = Math.max(0, Math.floor((budget - Buffer.byteLength(marker)) / 2));
  let head = edge;
  let tail = bytes.length - edge;
  while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--;
  while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++;
  return bytes.subarray(0, head).toString("utf8") + marker + bytes.subarray(tail).toString("utf8");
}

/**
 * 超限输出落盘,返回 "头+尾" 预览与落盘路径提示。
 * 落盘目录由主循环注入(会话 artifacts 目录)。
 */
export async function truncateOutput(
  output: string,
  artifactDir: string,
  maxBytes = MAX_TOOL_OUTPUT_BYTES,
): Promise<Truncated> {
  const size = Buffer.byteLength(output, "utf8");
  if (size <= maxBytes) {
    return { content: output, spilledTo: null };
  }

  const fileName = `tool-output-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
  const fullPath = path.join(artifactDir, fileName);
  let spilledTo: string | null = null;
  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(fullPath, output, "utf8");
    spilledTo = fullPath;
  } catch {
    // Output storage must never turn an already-completed edit/command into a
    // tool failure: the model might otherwise repeat the side effect.
  }
  const header = spilledTo
    ? `[输出 ${size} 字节,已截断。完整内容保存在: ${spilledTo}\n可用 read 的 file_path 配合 offset/limit 分段读取。]\n`
    : `[输出 ${size} 字节,已截断且无法保存完整日志。原工具已执行；请缩小查询范围，不要仅因此重复修改操作。]\n`;
  const content = header + bytePreview(output, Math.max(64, Math.min(PREVIEW_BYTES, maxBytes - Buffer.byteLength(header))));
  return { content, spilledTo };
}

/** Bound a whole tool-result message as well as individual results. */
export async function budgetToolResults(results: ContentBlock[], artifactDir: string): Promise<ContentBlock[]> {
  let total = results.reduce((sum, block) => sum + (block.type === "tool-result" ? Buffer.byteLength(block.content) : 0), 0);
  if (total <= MAX_BATCH_OUTPUT_BYTES) return results;
  const budgeted = [...results];
  const largestFirst = results.flatMap((block, index) => block.type === "tool-result"
    ? [{ block, index, size: Buffer.byteLength(block.content) }] : []).sort((a, b) => b.size - a.size);
  const perResult = Math.max(1024, Math.floor(MAX_BATCH_OUTPUT_BYTES / largestFirst.length));
  for (const { block, index, size } of largestFirst) {
    if (total <= MAX_BATCH_OUTPUT_BYTES) break;
    const reduced = await truncateOutput(block.content, artifactDir, Math.min(PREVIEW_BYTES, perResult));
    budgeted[index] = { ...block, content: reduced.content };
    total += Buffer.byteLength(reduced.content) - size;
  }
  return budgeted;
}
