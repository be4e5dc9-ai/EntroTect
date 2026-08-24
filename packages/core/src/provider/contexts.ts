// =====================================================================
// 常见模型上下文窗口兜底:供应商 /models 不一定返回 context_length,
// 用内置表 + 模型 id 后缀(k/m)识别,未知仍保持未知。
// 薄适配:KNOWN_MODEL_CONTEXTS 由 catalog 派生。
// =====================================================================

import { catalog } from "./catalog.js";

/** 由 catalog 派生的已知上下文窗口(tokens),键为模型 id(去前缀) */
export const KNOWN_MODEL_CONTEXTS: Record<string, number> = Object.fromEntries(
  Object.entries(catalog).map(([k, v]) => [k.split("/").pop()!, v.capabilities.contextWindow]),
);

/** 内置表查上下文窗口 */
export function knownContextWindow(model: string): number | undefined {
  return KNOWN_MODEL_CONTEXTS[model];
}

/** 从模型 id 尾部解析 k/m 后缀(如 "xxx-128k" → 131072、"yyy-1m" → 1000000) */
export function suffixContextWindow(model: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)([km])$/i.exec(model);
  if (!match) return undefined;
  const valueText = match[1];
  const unitText = match[2];
  if (!valueText || !unitText) return undefined;
  const value = Number.parseFloat(valueText);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = unitText.toLowerCase();
  const tokens = unit === "k" ? value * 1024 : value * 1_000_000;
  if (!Number.isFinite(tokens) || tokens < 1) return undefined;
  return Math.floor(tokens);
}

/**
 * 合并上下文窗口:API 元数据优先,其次内置表,再其次 id 后缀识别。
 * 任一来源都未知时保持未知(不含任何默认值兜底)。
 */
export function mergeContextWindows(
  models: string[],
  apiWindows: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const model of models) {
    const fromApi = apiWindows[model];
    const known = fromApi ?? knownContextWindow(model) ?? suffixContextWindow(model);
    if (known !== undefined) result[model] = known;
  }
  return result;
}
