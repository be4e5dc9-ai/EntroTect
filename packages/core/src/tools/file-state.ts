// =====================================================================
// 文件状态追踪:edit 的新鲜度校验依据
// 设计依据:ClaudeCode FileEdit 的 readFileState——read 记录文件状态,
// edit 前校验未被外部修改,防止覆盖他人的改动。
// =====================================================================

import { stat } from "node:fs/promises";

interface FileState {
  mtimeMs: number;
  size: number;
}

const states = new Map<string, FileState>();

export async function recordFileState(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    states.set(filePath, { mtimeMs: info.mtimeMs, size: info.size });
  } catch {
    states.delete(filePath);
  }
}

export async function isStale(filePath: string): Promise<boolean> {
  const state = states.get(filePath);
  if (!state) return false; // 从未 read 过,不拦截
  try {
    const info = await stat(filePath);
    return info.mtimeMs !== state.mtimeMs || info.size !== state.size;
  } catch {
    return true; // 文件消失视为被修改
  }
}

export function clearFileStates(): void {
  states.clear();
}
