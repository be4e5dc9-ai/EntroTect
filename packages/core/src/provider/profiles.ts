// =====================================================================
// 供应商 profile：协议相同不代表请求字段相同
//
// 这里集中维护 OpenAI Chat Completions 兼容供应商的已知差异。
// profile 只负责“确定请求怎么发”，不负责在收到 400 后猜测下一种格式。
// =====================================================================

import type { ApiFormat, ApiProfile, ReasoningEffort } from "@entrotect/shared";

export type AuthScheme = "bearer" | "api-key" | "x-api-key" | "x-goog-api-key" | "none";
export type TokenField = "max_tokens" | "max_completion_tokens";
export type ReasoningStrategy = "none" | "reasoning_effort" | "enable_thinking" | "thinking";

export interface ResolvedProviderProfile {
  /** 实际采用的 profile 名称，便于日志/诊断而不暴露密钥 */
  id: ApiProfile;
  auth: AuthScheme;
  tokenField: TokenField;
  /** 是否请求流末尾的 usage-only chunk */
  includeStreamUsage: boolean;
  /** 是否把历史 assistant.reasoningContent 原样放回请求 */
  preserveReasoningContent: boolean;
  /** 该模型/供应商不能接受显式 temperature 时设为 true */
  omitTemperature: boolean;
  reasoning: ReasoningStrategy;
  /** reasoning_effort 的真实可接受值；仅 reasoning 策略使用 */
  reasoningValues: readonly ("low" | "high" | "max")[];
  /** 供应商扩展字段是否应在未指定 effort 时保持省略 */
  supportsExplicitThinkingToggle: boolean;
}

const THREE_TIERS = ["low", "high", "max"] as const;

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** 由显式 profile、供应商 id、URL 和模型名确定 profile。 */
export function resolveProviderProfile(input: {
  apiProfile?: ApiProfile;
  providerId?: string;
  baseUrl?: string;
  model?: string;
}): ResolvedProviderProfile {
  const providerId = normalize(input.providerId);
  const baseUrl = normalize(input.baseUrl);
  const model = normalize(input.model);
  const explicit = input.apiProfile;

  // 模型名识别:聚合网关/自定义供应商常用真实模型名托管它家模型,
  // 只能靠模型名确定请求字段(优先级低于显式 profile / id / URL)。
  const modelProfile = (): ApiProfile | undefined => {
    if (/mimo/i.test(model)) return "mimo";
    if (/deepseek/i.test(model)) return "deepseek";
    if (/kimi|moonshot/i.test(model)) return "moonshot";
    if (/qwen/i.test(model)) return "qwen";
    if (/glm/i.test(model)) return "zhipu";
    if (/gpt-|gpt5|gpt-5|\bo[1-4]\b/i.test(model)) return "openai";
    if (/minimax/i.test(model)) return "minimax";
    return undefined;
  };

  let id: ApiProfile;
  if (explicit && explicit !== "generic") {
    id = explicit;
  } else if (explicit === "generic") {
    id = "generic";
  } else if (providerId === "mimo" || providerId.includes("mimo") || baseUrl.includes("xiaomimo")) {
    id = "mimo";
  } else if (
    providerId === "qwen" ||
    providerId.includes("qwen") ||
    baseUrl.includes("dashscope") ||
    baseUrl.includes("aliyuncs")
  ) {
    id = "qwen";
  } else if (
    providerId === "deepseek" ||
    providerId.includes("deepseek") ||
    baseUrl.includes("deepseek")
  ) {
    id = "deepseek";
  } else if (
    providerId === "moonshot" ||
    providerId.includes("moonshot") ||
    providerId.includes("kimi") ||
    baseUrl.includes("moonshot")
  ) {
    id = "moonshot";
  } else if (
    providerId === "zhipu" ||
    providerId.includes("zai") ||
    providerId.includes("glm") ||
    baseUrl.includes("bigmodel")
  ) {
    id = "zhipu";
  } else if (
    providerId === "minimax" ||
    providerId.includes("minimax") ||
    baseUrl.includes("minimax")
  ) {
    id = "minimax";
  } else if (providerId === "ollama" || baseUrl.includes("localhost:11434") || baseUrl.includes("127.0.0.1:11434")) {
    id = "ollama";
  } else if (providerId === "openrouter" || baseUrl.includes("openrouter")) {
    id = "openrouter";
  } else if (providerId === "openai" || baseUrl.includes("api.openai.com")) {
    id = "openai";
  } else {
    id = modelProfile() ?? "generic";
  }

  switch (id) {
    case "mimo":
      return {
        id,
        auth: "api-key",
        tokenField: "max_completion_tokens",
        includeStreamUsage: false,
        preserveReasoningContent: true,
        omitTemperature: true,
        reasoning: "thinking",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: true,
      };
    case "qwen":
      return {
        id,
        auth: "bearer",
        tokenField: "max_tokens",
        includeStreamUsage: true,
        preserveReasoningContent: true,
        omitTemperature: false,
        reasoning: "enable_thinking",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: true,
      };
    case "deepseek":
      return {
        id,
        auth: "bearer",
        tokenField: "max_tokens",
        includeStreamUsage: true,
        preserveReasoningContent: true,
        omitTemperature: false,
        reasoning: "reasoning_effort",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: false,
      };
    case "moonshot": {
      const isK3 = model.includes("kimi-k3");
      return {
        id,
        auth: "bearer",
        tokenField: "max_completion_tokens",
        includeStreamUsage: true,
        preserveReasoningContent: true,
        omitTemperature: true,
        reasoning: isK3 ? "reasoning_effort" : "thinking",
        reasoningValues: THREE_TIERS,
        // K3 cannot be disabled; K2.x can be toggled with thinking.type.
        supportsExplicitThinkingToggle: !isK3,
      };
    }
    case "zhipu": {
      const supportsReasoning = /glm-5(?:\.1|\.2|\.3)?|glm-4\.[567]/i.test(model);
      return {
        id,
        auth: "bearer",
        tokenField: "max_tokens",
        includeStreamUsage: false,
        preserveReasoningContent: true,
        omitTemperature: false,
        reasoning: supportsReasoning ? "reasoning_effort" : "none",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: supportsReasoning,
      };
    }
    case "openai": {
      const isReasoningModel = /^(o[1-4](?:-|$)|gpt-5(?:\.|-|$))/i.test(model);
      return {
        id,
        auth: "bearer",
        tokenField: isReasoningModel ? "max_completion_tokens" : "max_tokens",
        includeStreamUsage: true,
        preserveReasoningContent: true,
        omitTemperature: isReasoningModel,
        reasoning: isReasoningModel ? "reasoning_effort" : "none",
        reasoningValues: ["low", "high", "max"],
        supportsExplicitThinkingToggle: false,
      };
    }
    case "openrouter":
      return {
        id,
        auth: "bearer",
        tokenField: "max_tokens",
        includeStreamUsage: true,
        preserveReasoningContent: false,
        omitTemperature: false,
        reasoning: "none",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: false,
      };
    case "ollama":
      return {
        id,
        auth: "none",
        tokenField: "max_tokens",
        includeStreamUsage: false,
        preserveReasoningContent: false,
        omitTemperature: false,
        reasoning: "none",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: false,
      };
    case "minimax":
      return {
        id,
        auth: "bearer",
        tokenField: "max_tokens",
        includeStreamUsage: false,
        preserveReasoningContent: false,
        omitTemperature: false,
        reasoning: "none",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: false,
      };
    case "generic":
    default:
      // 未知供应商:按 OpenAI 事实标准发 reasoning_effort,不发明扩展字段。
      // reasoning_content 回传保留:主流思考模型都用同一个字段名,多传会被忽略,
      // 少传会被(Kimi/Mimo/GLM 等)以 400 拒绝。
      return {
        id,
        auth: "bearer",
        tokenField: "max_tokens",
        includeStreamUsage: false,
        preserveReasoningContent: true,
        omitTemperature: false,
        reasoning: "reasoning_effort",
        reasoningValues: THREE_TIERS,
        supportsExplicitThinkingToggle: false,
      };
  }
}

/** 按协议/profile 生成最小鉴权头；不会发送无关的备用鉴权头。 */
export function buildProviderHeaders(input: {
  apiFormat?: ApiFormat;
  apiProfile?: ApiProfile;
  providerId?: string;
  baseUrl?: string;
  model?: string;
  apiKey: string;
  includeContentType?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input.includeContentType) headers["Content-Type"] = "application/json";

  if (input.apiFormat === "anthropic") {
    if (input.apiKey) headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  if (input.apiFormat === "google") {
    if (input.apiKey) headers["x-goog-api-key"] = input.apiKey;
    return headers;
  }

  const profile = resolveProviderProfile(input);
  if (!input.apiKey || profile.auth === "none") return headers;
  switch (profile.auth) {
    case "api-key":
      headers["api-key"] = input.apiKey;
      break;
    case "x-api-key":
      headers["x-api-key"] = input.apiKey;
      break;
    case "x-goog-api-key":
      headers["x-goog-api-key"] = input.apiKey;
      break;
    case "bearer":
      headers.Authorization = `Bearer ${input.apiKey}`;
      break;
  }
  return headers;
}

/** 把应用的 canonical effort 映射到 profile 实际接受的三档值。 */
export function mapReasoningEffort(
  requested: ReasoningEffort | undefined,
  supported: ReasoningEffort[] | undefined,
  accepted: readonly ("low" | "high" | "max")[],
): "low" | "high" | "max" | undefined {
  if (!requested || requested === "off" || accepted.length === 0) return undefined;
  const candidates = accepted as readonly string[];
  if (candidates.includes(requested)) return requested as "low" | "high" | "max";

  // 优先使用配置声明的集合，再按 profile 的真实值做保守降级。
  const declared = (supported ?? []).filter((value): value is "low" | "high" | "max" =>
    value === "low" || value === "high" || value === "max",
  );
  if (declared.includes(requested as "low" | "high" | "max")) {
    return requested as "low" | "high" | "max";
  }
  if ((requested === "medium" || requested === "xhigh") && candidates.includes("high")) {
    return "high";
  }
  if (requested === "max" && candidates.includes("max")) return "max";
  if (requested === "high" && candidates.includes("high")) return "high";
  if (requested === "low" && candidates.includes("low")) return "low";
  return candidates[candidates.length - 1] as "low" | "high" | "max" | undefined;
}

/** 拼接 endpoint，同时避免 base URL 已经包含完整路径时重复追加。 */
export function appendEndpoint(baseUrl: string, endpoint: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (base.toLowerCase().endsWith(normalizedEndpoint.toLowerCase())) return base;
  return `${base}${normalizedEndpoint}`;
}

