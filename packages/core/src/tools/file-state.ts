import { createHash } from "node:crypto";
import type { ToolContext } from "./types.js";

/** Each agent owns its observations; a child's read must not refresh its parent's snapshot. */
export type FileStates = Map<string, string>;
const contextStates = new WeakMap<ToolContext, FileStates>();

function statesFor(ctx: ToolContext): FileStates {
  if (ctx.fileStates) return ctx.fileStates;
  let states = contextStates.get(ctx);
  if (!states) contextStates.set(ctx, states = new Map());
  return states;
}

function key(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Record the content actually read/written, not a later stat of a possibly different file. */
export function recordFileState(ctx: ToolContext, filePath: string, content: string): void {
  statesFor(ctx).set(key(filePath), digest(content));
}

export function assertFileFresh(ctx: ToolContext, filePath: string, content: string | null): void {
  const expected = statesFor(ctx).get(key(filePath));
  if (expected !== undefined && (content === null || expected !== digest(content))) {
    throw new Error(`文件 ${filePath} 自上次 read 后被修改,请重新 read 后再编辑或覆盖。`);
  }
}
