export * from "./types.js";
export * from "./sse.js";
export * from "./models.js";
export * from "./contexts.js";
export * from "./catalog.js";
export * from "./presets.js";
export {
  OpenAiCompatibleProvider,
  ProviderError,
  toOpenAiMessages,
} from "./openai-compatible.js";

import type { AppConfig } from "@entrotect/shared";
import { getPresetEfforts, getSupportedEffortsForModel } from "@entrotect/shared";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";
import { listModels } from "./models.js";

/** 按配置创建 provider。目前仅 OpenAI 兼容协议,缝已留好。 */
export function createProvider(config: AppConfig): Provider {
  const activeId = config.activeProviderId ?? config.providers?.[0]?.id;
  const supported = getSupportedEffortsForModel(config, activeId, config.model);
  const providerEntry = config.providers?.find((p) => p.id === activeId);
  const hasDeclared = providerEntry?.modelReasoningLevels?.[config.model] !== undefined;
  const hasPreset = getPresetEfforts(config.model) !== undefined;
  // 仅在已声明或命中 preset 时传递 supported；未知通用回退不传递以保持“无声明不强制 clamp”
  const passSupported =
    hasDeclared || hasPreset ? supported : undefined;
  return new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    supportedEfforts: passSupported,
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
