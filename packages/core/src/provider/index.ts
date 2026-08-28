export * from "./types.js";
export * from "./sse.js";
export * from "./models.js";
export * from "./contexts.js";
export * from "./catalog.js";
export * from "./presets.js";
export * from "./errors.js";
export {
  resolveProviderProfile,
  buildProviderHeaders,
  mapReasoningEffort,
  appendEndpoint,
} from "./profiles.js";
export type { ResolvedProviderProfile, AuthScheme, TokenField, ReasoningStrategy } from "./profiles.js";
export {
  OpenAiCompatibleProvider,
  toOpenAiMessages,
} from "./openai-compatible.js";
export type { OpenAiCompatibleOptions, ToOpenAiMessagesOptions } from "./openai-compatible.js";
export { AnthropicProvider } from "./anthropic.js";
export { GoogleProvider } from "./google.js";

import type { AppConfig } from "@entrotect/shared";
import { getPresetEfforts, getSupportedEffortsForModel } from "@entrotect/shared";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import type { Provider } from "./types.js";
import { listModels } from "./models.js";

/** 按配置创建 provider，根据 apiFormat 分发到不同协议实现。 */
export function createProvider(config: AppConfig): Provider {
  const activeId = config.activeProviderId ?? config.providers?.[0]?.id;
  const supported = getSupportedEffortsForModel(config, activeId, config.model);
  const providerEntry = config.providers?.find((p) => p.id === activeId);
  const hasDeclared = providerEntry?.modelReasoningLevels?.[config.model] !== undefined;
  const hasPreset = getPresetEfforts(config.model) !== undefined;
  const passSupported =
    hasDeclared || hasPreset ? supported : undefined;

  const apiFormat = providerEntry?.apiFormat ?? "openai";

  if (apiFormat === "anthropic") {
    return new AnthropicProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }
  if (apiFormat === "google") {
    return new GoogleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }
  // 默认: OpenAI 兼容(DeepSeek / OpenAI / Moonshot / Mimo / Qwen 等)
  return new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    supportedEfforts: passSupported,
    apiProfile: providerEntry?.apiProfile,
    providerId: activeId,
  });
}

/** 按单条供应商配置拉模型列表(薄封装:透传 modelsUrl/apiFormat) */
export function listModelsForProvider(
  provider: {
    baseUrl: string;
    apiKey: string;
    modelsUrl?: string;
    apiFormat?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: string[]; contextWindows: Record<string, number> }> {
  return listModels(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      modelsUrl: provider.modelsUrl,
      apiFormat: provider.apiFormat,
    } as unknown as AppConfig,
    fetchImpl,
  );
}
