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
  type ReasoningEffort,
} from "@entrotect/shared";
import {
  DEFAULT_REASONING_EFFORT,
  EFFORT_RANK,
  getPresetDefault,
  getPresetEfforts,
  isReasoningEffort,
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
    ...(p.modelReasoningLevels === undefined
      ? {}
      : { modelReasoningLevels: { ...p.modelReasoningLevels } }),
    ...(p.modelReasoningDefaults === undefined
      ? {}
      : { modelReasoningDefaults: { ...p.modelReasoningDefaults } }),
    ...(p.modelsUrl === undefined ? {} : { modelsUrl: p.modelsUrl }),
    ...(p.apiFormat === undefined ? {} : { apiFormat: p.apiFormat }),
    ...(p.category === undefined ? {} : { category: p.category }),
    ...(p.icon === undefined ? {} : { icon: p.icon }),
  }));
}

function sanitizeAndFillReasoningLevels(providers: ProviderConfig[]): void {
  for (const provider of providers) {
    // 初始化容器
    if (provider.modelReasoningLevels === undefined) provider.modelReasoningLevels = {};
    if (provider.modelReasoningDefaults === undefined) provider.modelReasoningDefaults = {};
    const levels = provider.modelReasoningLevels;
    const defaults = provider.modelReasoningDefaults;
    // 已声明的 levels：过滤未知值并按 canonical 排序
    for (const model of Object.keys(levels)) {
      const raw = levels[model] ?? [];
      const filtered = raw.filter(isReasoningEffort);
      // 过滤后可能为空（布尔 thinking 模型）
      const sorted = filtered.slice().sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
      levels[model] = sorted;
    }
    // 为 provider.models 中未声明但有 preset 的模型自动填充
    for (const model of provider.models) {
      if (levels[model] !== undefined) continue;
      const preset = getPresetEfforts(model);
      if (preset !== undefined) {
        levels[model] = [...preset].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
      }
    }
    // 清理无效 default：不在 levels 子集则回退到 preset default 或最高档
    for (const model of Object.keys({ ...defaults })) {
      const def = defaults[model];
      const supported = levels[model];
      if (!def || !isReasoningEffort(def)) {
        delete defaults[model];
        continue;
      }
      if (supported && supported.length > 0 && !supported.includes(def)) {
        // 未知 effort 丢弃，回退
        delete defaults[model];
      } else if (supported && supported.length === 0) {
        // 布尔 thinking 无分档，删除 default
        delete defaults[model];
      }
    }
    // 为仍缺 default 但已有 levels 的模型补默认
    for (const model of Object.keys(levels)) {
      const supported = levels[model];
      if (!supported || supported.length === 0) continue;
      if (defaults[model] !== undefined) continue;
      const presetDef = getPresetDefault(model);
      if (presetDef && supported.includes(presetDef)) {
        defaults[model] = presetDef;
      } else {
        const withoutOff = supported.filter((e) => e !== "off");
        const pool = withoutOff.length > 0 ? withoutOff : supported;
        const sorted = pool.slice().sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
        defaults[model] = sorted[sorted.length - 1] as ReasoningEffort;
      }
    }
    // 清理空对象保持旧配置兼容（缺省时不写入空对象，避免大 JSON）
    if (Object.keys(levels).length === 0) delete provider.modelReasoningLevels;
    if (Object.keys(defaults).length === 0) delete provider.modelReasoningDefaults;
  }
}

function sanitizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value === "string" && isReasoningEffort(value)) return value;
  return undefined;
}

/** 自动压缩阈值清洗:收敛到 [0.1, 1],非法值回退默认 0.7 */
function clampRatio(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  return Math.min(1, Math.max(0.1, value));
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
    fromFile = appConfigSchema.partial().parse(normalized) as unknown as Partial<AppConfig>;
  } catch {
    // 文件缺失或损坏 → 回退默认
  }

  const merged: AppConfig = {
    baseUrl: process.env.ENTROTECT_BASE_URL ?? fromFile.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    apiKey: process.env.ENTROTECT_API_KEY ?? fromFile.apiKey ?? DEFAULT_CONFIG.apiKey,
    model: process.env.ENTROTECT_MODEL ?? fromFile.model ?? DEFAULT_CONFIG.model,
    workspaceDir: fromFile.workspaceDir ?? DEFAULT_CONFIG.workspaceDir,
    reasoningEffort:
      sanitizeReasoningEffort(fromFile.reasoningEffort) ??
      sanitizeReasoningEffort(DEFAULT_CONFIG.reasoningEffort) ??
      DEFAULT_REASONING_EFFORT,
    permissionMode: fromFile.permissionMode ?? DEFAULT_CONFIG.permissionMode,
    sandboxMode: fromFile.sandboxMode ?? DEFAULT_CONFIG.sandboxMode,
    showReasoning: fromFile.showReasoning ?? DEFAULT_CONFIG.showReasoning,
    temperature: fromFile.temperature,
    skillOverrides: fromFile.skillOverrides,
    autoCompact: fromFile.autoCompact ?? DEFAULT_CONFIG.autoCompact,
    autoCompactRatio: clampRatio(fromFile.autoCompactRatio ?? DEFAULT_CONFIG.autoCompactRatio),
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

  // 按真实档位预填与清洗：未声明的已知模型补 preset，未知 effort 丢弃
  sanitizeAndFillReasoningLevels(merged.providers);

  return appConfigSchema.parse(merged as unknown as Record<string, unknown>) as AppConfig;
}

export async function saveConfig(appDataDir: string, config: AppConfig): Promise<void> {
  await mkdir(appDataDir, { recursive: true });
  await writeFile(configFilePath(appDataDir), JSON.stringify(config, null, 2), "utf8");
}
