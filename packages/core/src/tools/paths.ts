// =====================================================================
// 文件工具路径收容:词法 + 保护路径双重校验
// 设计依据:审查 P0-1——read/write/edit/glob/grep/generate_image 的
// file_path/path 必须在工作目录内,且不得落入应用自身数据目录
// (config.json / plugins / usage.jsonl),防模型零审批读取/篡改配置与插件。
// 执行前再通过 realpath/最近存在父目录校验符号链接与 Windows 联接点，
// 防止“词法位于 cwd 内、真实目标位于 cwd 外”的路径逃逸。
// =====================================================================

import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { PermissionTarget } from "@entrotect/shared";

function assertNotProtected(absolute: string, filePath: string, protectedPaths: readonly string[]): void {
  const lower = absolute.toLowerCase();
  for (const protectedPath of protectedPaths) {
    const resolved = path.resolve(protectedPath).toLowerCase();
    if (lower === resolved || lower.startsWith(resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`)) {
      throw new Error(`该路径属于应用受保护目录,已拦截: ${filePath}`);
    }
  }
}

/**
 * 解析相对 cwd 的路径,并做双重收容:
 * 1) 必须在 cwd 内(词法,Windows 大小写不敏感);
 * 2) 不得落入保护路径(应用自身数据目录,防模型篡改 config/插件/用量)。
 * 越界抛错,错误信息不含敏感内容。
 */
export function resolveInsideCwd(
  cwd: string,
  filePath: string,
  protectedPaths: readonly string[] = [],
): string {
  const absolute = path.resolve(cwd, filePath);
  const rel = path.relative(cwd, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`路径越出工作目录,已拦截: ${filePath}`);
  }
  assertNotProtected(absolute, filePath, protectedPaths);
  return absolute;
}

/**
 * Resolve a tool path. Workspace paths are always accepted; an external path
 * requires an exact, per-call `external` grant from the permission gate.
 * Application data remains unconditionally protected.
 */
export function resolvePermittedPath(
  cwd: string,
  filePath: string,
  protectedPaths: readonly string[] = [],
  approvedResources: readonly PermissionTarget[] = [],
): string {
  const absolute = path.resolve(cwd, filePath);
  assertNotProtected(absolute, filePath, protectedPaths);
  const relative = path.relative(path.resolve(cwd), absolute);
  const inside = relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (inside) return absolute;
  const normalized = absolute.replace(/\\/g, "/").toLowerCase();
  const approved = approvedResources.some((target) =>
    target.action === "external" && target.resource.replace(/\\/g, "/").toLowerCase() === normalized,
  );
  if (!approved) throw new Error(`路径越出工作目录且未获批准,已拦截: ${filePath}`);
  return absolute;
}

async function nearestExistingPath(absolute: string): Promise<{ existing: string; suffix: string[] }> {
  let cursor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      await lstat(cursor);
      return { existing: cursor, suffix };
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`无法解析路径: ${absolute}`);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Filesystem-aware variant that rejects workspace symlink/junction escapes.
 * Non-existent outputs are checked through their nearest existing ancestor.
 */
export async function resolvePermittedPathReal(
  cwd: string,
  filePath: string,
  protectedPaths: readonly string[] = [],
  approvedResources: readonly PermissionTarget[] = [],
): Promise<string> {
  const lexical = resolvePermittedPath(cwd, filePath, protectedPaths, approvedResources);
  const { existing, suffix } = await nearestExistingPath(lexical);
  const resolvedExisting = await realpath(existing);
  const resolved = path.resolve(resolvedExisting, ...suffix);
  assertNotProtected(resolved, filePath, protectedPaths);

  const lexicalRelative = path.relative(path.resolve(cwd), lexical);
  const lexicalInside = lexicalRelative === "" || (!lexicalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(lexicalRelative));
  if (lexicalInside) {
    const realCwd = await realpath(path.resolve(cwd));
    const realRelative = path.relative(realCwd, resolved);
    const realInside = realRelative === "" || (!realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative));
    if (!realInside) throw new Error(`工作区内路径通过符号链接或联接点越界,已拦截: ${filePath}`);
  }
  return lexical;
}
