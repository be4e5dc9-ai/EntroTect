// =====================================================================
// 配置加载与保存
// 优先级:环境变量 > 配置文件 > 内置默认
// 设计依据:opencode/13 配置加载思路的极简版——文件 + env 两级即可。
// =====================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfigSchema, DEFAULT_CONFIG, type AppConfig } from "@entrotect/shared";

export function configFilePath(appDataDir: string): string {
  return path.join(appDataDir, "config.json");
}

/** 加载配置:env 覆盖文件,文件覆盖默认 */
export async function loadConfig(appDataDir: string): Promise<AppConfig> {
  let fromFile: Partial<AppConfig> = {};
  try {
    // 剥 BOM:兼容其他工具写出的带 BOM 的 config.json
    const raw = (await readFile(configFilePath(appDataDir), "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 兼容旧字段命名:workspace → workspaceDir
    const normalized = { ...parsed };
    if (normalized.workspaceDir === undefined && typeof normalized.workspace === "string") {
      normalized.workspaceDir = normalized.workspace;
    }
    fromFile = appConfigSchema.partial().parse(normalized);
  } catch {
    // 文件缺失或损坏 → 回退默认
  }

  const merged: AppConfig = {
    baseUrl: process.env.ENTROTECT_BASE_URL ?? fromFile.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    apiKey: process.env.ENTROTECT_API_KEY ?? fromFile.apiKey ?? DEFAULT_CONFIG.apiKey,
    model: process.env.ENTROTECT_MODEL ?? fromFile.model ?? DEFAULT_CONFIG.model,
    workspaceDir: fromFile.workspaceDir ?? DEFAULT_CONFIG.workspaceDir,
    reasoningEffort: fromFile.reasoningEffort ?? DEFAULT_CONFIG.reasoningEffort,
    permissionMode: fromFile.permissionMode ?? DEFAULT_CONFIG.permissionMode,
    showReasoning: fromFile.showReasoning ?? DEFAULT_CONFIG.showReasoning,
    maxTokens: fromFile.maxTokens,
    temperature: fromFile.temperature,
  };
  return appConfigSchema.parse(merged);
}

export async function saveConfig(appDataDir: string, config: AppConfig): Promise<void> {
  await mkdir(appDataDir, { recursive: true });
  await writeFile(configFilePath(appDataDir), JSON.stringify(config, null, 2), "utf8");
}
