// =====================================================================
// 常见模型上下文窗口兜底:供应商 /models 不一定返回 context_length,
// 用内置表 + 模型 id 后缀(k/m)识别,未知仍保持未知。
// =====================================================================

/** 常见公开模型的已知上下文窗口(tokens),键为模型 id */
export const KNOWN_MODEL_CONTEXTS: Record<string, number> = {
  // DeepSeek
  "deepseek-chat": 131072,
  "deepseek-reasoner": 131072,
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4.1": 1047576,
  "gpt-4.1-mini": 1047576,
  "gpt-4.1-nano": 1047576,
  o1: 200000,
  "o1-mini": 128000,
  o3: 200000,
  "o3-mini": 200000,
  "o4-mini": 200000,
  "gpt-5": 400000,
  "gpt-5-mini": 400000,
  "gpt-5-nano": 400000,
  // Moonshot
  "moonshot-v1-8k": 8192,
  "moonshot-v1-32k": 32768,
  "moonshot-v1-128k": 131072,
  "moonshot-v1-auto": 131072,
  "kimi-k2-0711": 131072,
  "kimi-k2": 131072,
  // Anthropic(经 OpenAI 兼容代理接入的常用模型)
  "claude-opus-4-20250514": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-3-7-sonnet-20250219": 200000,
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-5-haiku-20241022": 200000,
  // Gemini(OpenAI 兼容接口)
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash": 1048576,
  "gemini-2.0-flash": 1048576,
};

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
