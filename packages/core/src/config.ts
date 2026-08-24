// =====================================================================
// 配置加载与保存
// 优先级:环境变量 > 配置文件 > 内置默认
// 设计依据:opencode/13 配置加载思路的极简版——文件 + env 两级即可。
// 多供应商:旧配置(无 providers)在加载时迁移为预设供应商,
// 旧 baseUrl/apiKey/model 注入 deepseek 条目;之后每次加载做预设合并
// (文件缺某个预设时补默认,自定义条目原样保留)。
// =====================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appConfigSchema,
  DEFAULT_CONFIG,
  type AppConfig,
  type ProviderConfig,
} from "@entrotect/shared";

export function configFilePath(appDataDir: string): string {
  return path.join(appDataDir, "config.json");
}

/** 预设供应商 id 集合(迁移与合并都以 id 对齐) — 保留 modelsUrl/apiFormat/category/icon */
function presetProviders(): ProviderConfig[] {
  return (DEFAULT_CONFIG.providers ?? []).map((p) => ({
    ...p,
    models: [...p.models],
    ...(p.contextWindows === undefined ? {} : { contextWindows: { ...p.contextWindows } }),
    ...(p.modelsUrl === undefined ? {} : { modelsUrl: p.modelsUrl }),
    ...(p.apiFormat === undefined ? {} : { apiFormat: p.apiFormat }),
    ...(p.category === undefined ? {} : { category: p.category }),
    ...(p.icon === undefined ? {} : { icon: p.icon }),
  }));
}

/** 把合并后的供应商列表确定 activeProviderId:缺省 deepseek,失效回退第一个 */
function resolveActiveId(
  wanted: string | undefined,
  providers: ProviderConfig[],
): string {
  const fallback = providers.find((p) => p.id === "deepseek") ?? providers[0];
  if (!wanted) return fallback?.id ?? "deepseek";
  return providers.some((p) => p.id === wanted) ? wanted : (fallback?.id ?? "deepseek");
}

/** 加载配置:env 覆盖文件,文件覆盖默认;无 providers 时迁移旧字段 */
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
    sandboxMode: fromFile.sandboxMode ?? DEFAULT_CONFIG.sandboxMode,
    showReasoning: fromFile.showReasoning ?? DEFAULT_CONFIG.showReasoning,
    maxTokens: fromFile.maxTokens,
    temperature: fromFile.temperature,
  };

  // 供应商列表:文件里缺某个预设时补默认,自定义条目原样保留
  const presets = presetProviders();
  let providers: ProviderConfig[];
  if (!fromFile.providers || fromFile.providers.length === 0) {
    // 旧配置迁移:预设全量生成,旧 baseUrl/apiKey/model 注入 deepseek 条目
    providers = presets.map((p) =>
      p.id === "deepseek"
        ? {
            ...p,
            baseUrl: merged.baseUrl,
            apiKey: merged.apiKey,
            models: merged.model ? [merged.model] : [],
          }
        : p,
    );
  } else {
    providers = [...fromFile.providers];
    for (const preset of presets) {
      if (!providers.some((p) => p.id === preset.id)) providers.push(preset);
    }
  }
  merged.providers = providers;
  merged.activeProviderId = resolveActiveId(fromFile.activeProviderId, providers);

  return appConfigSchema.parse(merged);
}

export async function saveConfig(appDataDir: string, config: AppConfig): Promise<void> {
  await mkdir(appDataDir, { recursive: true });
  await writeFile(configFilePath(appDataDir), JSON.stringify(config, null, 2), "utf8");
}
