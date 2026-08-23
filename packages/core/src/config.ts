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
    const raw = await readFile(configFilePath(appDataDir), "utf8");
    fromFile = appConfigSchema.partial().parse(JSON.parse(raw));
  } catch {
    // 文件缺失或损坏 → 回退默认
  }

  const merged: AppConfig = {
    baseUrl: process.env.ENTROTECT_BASE_URL ?? fromFile.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    apiKey: process.env.ENTROTECT_API_KEY ?? fromFile.apiKey ?? DEFAULT_CONFIG.apiKey,
    model: process.env.ENTROTECT_MODEL ?? fromFile.model ?? DEFAULT_CONFIG.model,
    maxTokens: fromFile.maxTokens,
    temperature: fromFile.temperature,
  };
  return appConfigSchema.parse(merged);
}

export async function saveConfig(appDataDir: string, config: AppConfig): Promise<void> {
  await mkdir(appDataDir, { recursive: true });
  await writeFile(configFilePath(appDataDir), JSON.stringify(config, null, 2), "utf8");
}
