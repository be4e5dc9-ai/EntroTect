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
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";
import { listModels } from "./models.js";

/** 按配置创建 provider。目前仅 OpenAI 兼容协议,缝已留好。 */
export function createProvider(config: AppConfig): Provider {
  return new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
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
