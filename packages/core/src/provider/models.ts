// =====================================================================
// 模型列表:GET {baseUrl}/models(OpenAI 兼容)
// =====================================================================

import type { AppConfig } from "@entrotect/shared";

export async function listModels(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`模型列表接口返回 ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((model) => model.id).filter((id) => id.length > 0);
}
