// =====================================================================
// 推理强度档位工具（per-model reasoning levels）
// 参考 cc switch PR #6228/#6123/Qwen Code 设计
//  canonical 顺序 low(20) < medium(30) < high(40) < xhigh(60) < max(70)
//  off 单独秩 0，仅对支持 none/off 的模型展示
// =====================================================================

import type { AppConfig, ReasoningEffort } from "./protocol.js";

export type { ReasoningEffort };

export const CANONICAL_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const ALL_EFFORTS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];
export const LEGACY_EFFORTS: ReasoningEffort[] = ["low", "high", "xhigh", "max"];
export const GENERIC_FALLBACK_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_RANK: Record<ReasoningEffort, number> = {
  off: 0,
  low: 20,
  medium: 30,
  high: 40,
  xhigh: 60,
  max: 70,
};

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "关闭 · off",
  low: "低 · low",
  medium: "中 · medium",
  high: "高 · high",
  xhigh: "极高 · xhigh",
  max: "最大 · max",
};

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

// 已调研的真实档位（键为模型名 RegExp，值为档位；空数组=布尔 thinking，不支持 reasoning_effort 分档）
export const PRESET_MODEL_EFFORTS: Array<{
  pattern: RegExp;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
}> = [
  // Kimi K2.6/K2.7-code 高速版 — 布尔 thinking.* 常开，无分档
  { pattern: /kimi-k2\.6/i, efforts: [], defaultEffort: "high" },
  { pattern: /kimi-k2\.7-code/i, efforts: [], defaultEffort: "high" },
  // Kimi K3 — low/high/max 强制 thinking on（不可 off）
  { pattern: /kimi-k3/i, efforts: ["low", "high", "max"], defaultEffort: "max" },
  // Qwen 3.8-max 全档位透传
  { pattern: /qwen3\.8-max-preview/i, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { pattern: /qwen3\.8-max/i, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  // 其他 Qwen 混合模型仅 enable_thinking 布尔，无分档
  { pattern: /^qwen/i, efforts: [], defaultEffort: "high" },
  { pattern: /qwen/i, efforts: [], defaultEffort: "high" },
  // GLM-5.2/5.1 — high|max 强制 thinking on
  { pattern: /glm-5\.2/i, efforts: ["high", "max"], defaultEffort: "high" },
  { pattern: /glm-5/i, efforts: ["high", "max"], defaultEffort: "high" },
  // Claude Opus 4.7/4.8/5.x — 全档位
  { pattern: /claude-opus-4\.[78]/i, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { pattern: /claude-opus-5/i, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { pattern: /claude-opus/i, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  // Claude Sonnet/Haiku — 低中高三档（xhigh/max 需 clamp）
  { pattern: /claude-sonnet/i, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { pattern: /claude-haiku/i, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { pattern: /claude/i, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  // DeepSeek V4-Pro/V4-Flash/V3.2 等 — low/high/max
  { pattern: /deepseek/i, efforts: ["low", "high", "max"], defaultEffort: "high" },
  // Mimo v2.5 / v2 — Xiaomi MiMo，官方仅 thinking enabled/disabled（默认 enabled），无分档
  { pattern: /mimo/i, efforts: [], defaultEffort: "high" },
  // OpenAI GPT-5.6 / GPT-5* / o3 / o4-mini — 支持 none/off 全档位
  { pattern: /gpt-5\.6/i, efforts: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { pattern: /gpt-5/i, efforts: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { pattern: /\bo3\b/i, efforts: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { pattern: /o4-mini/i, efforts: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  // Gemini 3.x Flash — low/medium/high
  { pattern: /gemini-3/i, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { pattern: /gemini/i, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  // Grok — 全档位强制 thinking on
  { pattern: /grok/i, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (ALL_EFFORTS as string[]).includes(value);
}

export function normalizeEffort(value: string | undefined | null): ReasoningEffort | null {
  if (!value) return null;
  return isReasoningEffort(value) ? value : null;
}

export function filterValidEfforts(efforts: string[]): ReasoningEffort[] {
  return efforts.filter(isReasoningEffort);
}

export function sortEfforts(efforts: ReasoningEffort[]): ReasoningEffort[] {
  return [...efforts].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
}

export function getPresetEfforts(model: string): ReasoningEffort[] | undefined {
  for (const entry of PRESET_MODEL_EFFORTS) {
    if (entry.pattern.test(model)) return [...entry.efforts];
  }
  return undefined;
}

export function getPresetDefault(model: string): ReasoningEffort | undefined {
  for (const entry of PRESET_MODEL_EFFORTS) {
    if (entry.pattern.test(model)) return entry.defaultEffort;
  }
  return undefined;
}

export function getSupportedEffortsForModel(
  config: AppConfig | null | undefined,
  providerId: string | undefined,
  model: string | undefined,
): ReasoningEffort[] {
  if (!model) return [...GENERIC_FALLBACK_EFFORTS];
  const provider =
    config?.providers?.find((p) => p.id === providerId) ??
    config?.providers?.[0];
  const declared = provider?.modelReasoningLevels?.[model];
  if (declared !== undefined) {
    const filtered = filterValidEfforts(declared);
    return sortEfforts(filtered);
  }
  const preset = getPresetEfforts(model);
  if (preset !== undefined) return sortEfforts(preset);
  return [...GENERIC_FALLBACK_EFFORTS];
}

export function defaultForModel(
  config: AppConfig | null | undefined,
  providerId: string | undefined,
  model: string | undefined,
): ReasoningEffort {
  const supported = getSupportedEffortsForModel(config, providerId, model);
  if (supported.length === 0) return DEFAULT_REASONING_EFFORT;
  const provider =
    config?.providers?.find((p) => p.id === providerId) ??
    config?.providers?.[0];
  const declaredDefault = model ? provider?.modelReasoningDefaults?.[model] : undefined;
  if (declaredDefault && isReasoningEffort(declaredDefault) && supported.includes(declaredDefault)) {
    return declaredDefault;
  }
  const presetDefault = model ? getPresetDefault(model) : undefined;
  if (presetDefault && supported.includes(presetDefault)) return presetDefault;
  const withoutOff = supported.filter((e) => e !== "off");
  const pool = withoutOff.length > 0 ? withoutOff : supported;
  const sorted = sortEfforts(pool);
  return sorted[sorted.length - 1] as ReasoningEffort;
}

export function clampEffort(
  requested: ReasoningEffort,
  supported: ReasoningEffort[],
): ReasoningEffort {
  if (supported.length === 0) return requested;
  if (!isReasoningEffort(requested)) return supported[0] ?? DEFAULT_REASONING_EFFORT;
  if (supported.includes(requested)) return requested;
  if (requested === "off") {
    if (supported.includes("off")) return "off";
    const withoutOff = supported.filter((e) => e !== "off");
    const sorted = sortEfforts(withoutOff.length > 0 ? withoutOff : supported);
    return sorted[0] as ReasoningEffort;
  }
  const withoutOff = supported.filter((e) => e !== "off");
  const pool = withoutOff.length > 0 ? withoutOff : supported;
  const sorted = sortEfforts(pool);
  // DeepSeek 三档兼容：medium/xhigh -> high
  const isThreeTier = sorted.length === 3 && sorted[0] === "low" && sorted[1] === "high" && sorted[2] === "max";
  if (isThreeTier && (requested === "medium" || requested === "xhigh")) return "high";
  const rank = EFFORT_RANK[requested];
  let floor: ReasoningEffort | undefined;
  for (const eff of sorted) {
    if (EFFORT_RANK[eff] <= rank) floor = eff;
  }
  if (floor) return floor;
  return sorted[0] as ReasoningEffort;
}

/** 是否为布尔 thinking 模型（无分档） */
export function isBooleanThinkingModel(model: string): boolean {
  const preset = getPresetEfforts(model);
  return preset !== undefined && preset.length === 0;
}

/** 为回退/错误提示：是否来自 preset */
export function isPresetModel(model: string): boolean {
  return getPresetEfforts(model) !== undefined;
}
