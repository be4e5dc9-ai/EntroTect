// =====================================================================
// Skills 发现:扫描本机已安装的技能描述,以 SKILL.md 或目录为判据
// 至少扫描: ~/.agents/skills, ~/.claude/skills, 项目本地 tools/
// 并通过 ipcMain.handle("entrotect:list-skills") 暴露给渲染进程
// =====================================================================

import { homedir } from "node:os";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: string;
}

const IGNORED_DIRS = new Set([
  ".venv",
  "__pycache__",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

async function existsDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function existsFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function parseSkillMd(content: string): { name?: string; description?: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fm = lines.slice(1, end).join("\n");
  // 支持带引号或不带引号, description may contain colon
  const nameMatch = fm.match(/^\s*name\s*:\s*(.+)\s*$/m);
  const descMatch = fm.match(/^\s*description\s*:\s*(.+)\s*$/m);
  const clean = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  return {
    name: nameMatch ? clean(nameMatch[1]!) : undefined,
    description: descMatch ? clean(descMatch[1]!) : undefined,
  };
}

function extractDescription(content: string): string {
  const lines = content.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) if (lines[i]?.trim() === "---") { end = i; break; }
    if (end !== -1) start = end + 1;
  }
  // 取第一个非空非标题的段落
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line || line.startsWith("#") || line.startsWith("---")) continue;
    // 去掉 markdown 符号
    return line.slice(0, 200);
  }
  return "";
}

async function readSkillInfo(skillPath: string, sourceRoot: string): Promise<SkillInfo> {
  const base = path.basename(skillPath);
  let name = base;
  let description = "";
  const mdPath = path.join(skillPath, "SKILL.md");
  if (await existsFile(mdPath)) {
    try {
      const content = await readFile(mdPath, "utf8");
      const parsed = parseSkillMd(content);
      if (parsed.name) name = parsed.name;
      if (parsed.description) description = parsed.description;
      if (!description) description = extractDescription(content);
    } catch {
      // ignore
    }
  }
  // source display: 用 ~ 简写 homedir
  const home = homedir();
  let displaySource = sourceRoot;
  if (home && sourceRoot.startsWith(home)) {
    displaySource = `~${sourceRoot.slice(home.length).replace(/\\/g, "/")}`;
  } else {
    displaySource = sourceRoot.replace(/\\/g, "/");
  }
  return {
    name: name.replace(/^["']|["']$/g, ""),
    description,
    path: skillPath,
    source: displaySource,
  };
}

async function scanRoot(root: string): Promise<SkillInfo[]> {
  if (!(await existsDir(root))) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: SkillInfo[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") && entry.name !== ".claude" && entry.name !== ".agents") {
        continue;
      }
      // 项目 tools 场景: 仅当目录包含 SKILL.md 时视为 skill, 避免把 assets/motion 等当作 skill
      const isProjectTools = root.endsWith(`${path.sep}tools`) || root.endsWith("/tools");
      if (isProjectTools && IGNORED_DIRS.has(entry.name)) continue;

      const hasMd = await existsFile(path.join(full, "SKILL.md"));
      if (isProjectTools) {
        // tools/ 下: 只有包含 SKILL.md 的目录才算 skill; 否则仅探测下一层是否包含 SKILL.md
        if (hasMd) {
          const info = await readSkillInfo(full, root);
          results.push(info);
        } else {
          let subEntries: import("node:fs").Dirent[] = [];
          try {
            subEntries = await readdir(full, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            if (sub.name.startsWith(".") || IGNORED_DIRS.has(sub.name)) continue;
            const subFull = path.join(full, sub.name);
            const subHasMd = await existsFile(path.join(subFull, "SKILL.md"));
            if (subHasMd) {
              const subInfo = await readSkillInfo(subFull, root);
              results.push(subInfo);
            }
          }
        }
      } else {
        // 全局 skills 根: 每个子目录即视为一个 skill(符合“目录即视为一个 skill”)
        const info = await readSkillInfo(full, root);
        results.push(info);
        // 若该目录本身没有 SKILL.md, 尝试在其下一层查找真实 skill(处理 skills/<group>/<skill> 结构)
        if (!hasMd) {
          let subEntries: import("node:fs").Dirent[] = [];
          try {
            subEntries = await readdir(full, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            if (sub.name.startsWith(".") || IGNORED_DIRS.has(sub.name)) continue;
            const subFull = path.join(full, sub.name);
            const subHasMd = await existsFile(path.join(subFull, "SKILL.md"));
            if (subHasMd) {
              const subInfo = await readSkillInfo(subFull, root);
              results.push(subInfo);
            }
          }
        }
      }
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      // 根目录自身就是一个 skill(极少见)
      const info = await readSkillInfo(root, path.dirname(root));
      results.push(info);
      break;
    }
  }
  return results;
}

function findWorkspaceRootCandidates(start: string): string[] {
  const candidates: string[] = [];
  let cur = start;
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(cur, "package.json");
    if (existsSync(pkg)) {
      try {
        const raw = readFileSync(pkg, "utf8");
        if (raw.includes('"entrotect"') || raw.includes("entrotect")) {
          candidates.push(path.join(cur, "tools"));
          break;
        }
      } catch {}
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return candidates;
}

export function getDefaultSkillRoots(projectToolsHint?: string): string[] {
  const home = homedir();
  const roots: string[] = [];
  roots.push(path.join(home, ".agents", "skills"));
  roots.push(path.join(home, ".claude", "skills"));
  roots.push(path.join(home, ".config", "opencode", "skills"));
  roots.push(path.join(home, ".opencode", "skills"));

  // 项目本地 tools/
  if (projectToolsHint) {
    roots.push(projectToolsHint);
  }
  // 基于 cwd 与 __dirname 的推断
  try {
    roots.push(path.join(process.cwd(), "tools"));
  } catch {}
  // __dirname 推断: 从 main 所在位置向上找 workspace
  try {
    const here =
      typeof __dirname !== "undefined" && __dirname ? __dirname : process.cwd();
    const ws = findWorkspaceRootCandidates(here);
    roots.push(...ws);
    // 兜底: 向上 4 层拼接 tools
    let cur = here;
    for (let i = 0; i < 4; i++) {
      cur = path.dirname(cur);
      roots.push(path.join(cur, "tools"));
    }
  } catch {}
  // 去重且保持顺序
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const r of roots) {
    const normalized = path.resolve(r);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniq.push(r);
    }
  }
  return uniq;
}

export async function discoverSkills(projectToolsHint?: string): Promise<SkillInfo[]> {
  const roots = getDefaultSkillRoots(projectToolsHint);
  const byPath = new Map<string, SkillInfo>();
  for (const root of roots) {
    const list = await scanRoot(root);
    for (const item of list) {
      const key = path.resolve(item.path);
      if (!byPath.has(key)) byPath.set(key, item);
    }
  }
  const all = Array.from(byPath.values());
  all.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return all;
}
