export * from "./types.js";
export * from "./sse.js";
export * from "./models.js";
export {
  OpenAiCompatibleProvider,
  ProviderError,
  toOpenAiMessages,
} from "./openai-compatible.js";

import type { AppConfig } from "@entrotect/shared";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

/** 按配置创建 provider。目前仅 OpenAI 兼容协议,缝已留好。 */
export function createProvider(config: AppConfig): Provider {
  return new OpenAiCompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}
