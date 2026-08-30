// =====================================================================
// 文件工具路径收容:词法 + 保护路径双重校验
// 设计依据:审查 P0-1——read/write/edit/glob/grep/generate_image 的
// file_path/path 必须在工作目录内,且不得落入应用自身数据目录
// (config.json / plugins / usage.jsonl),防模型零审批读取/篡改配置与插件。
// 已知限制:词法收容不防符号链接逃逸(cwd 内 symlink 指向外部),
// 如需强化可对已存在文件做 fs.realpath 二次校验(列为后续)。
// =====================================================================

import path from "node:path";

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
  const lower = absolute.toLowerCase();
  for (const p of protectedPaths) {
    const pl = p.toLowerCase();
    if (lower === pl || lower.startsWith(pl.endsWith(path.sep) ? pl : `${pl}${path.sep}`)) {
      throw new Error(`该路径属于应用受保护目录,已拦截: ${filePath}`);
    }
  }
  return absolute;
}
