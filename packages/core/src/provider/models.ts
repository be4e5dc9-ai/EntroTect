// =====================================================================
// 模型列表:GET {baseUrl}/models(OpenAI 兼容)
// =====================================================================

import type { AppConfig } from "@entrotect/shared";

export async function listModels(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: string[]; contextWindows: Record<string, number> }> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`模型列表接口返回 ${response.status}`);
  }
  const body = await response.json();
  const data =
    body && typeof body === "object" && "data" in body && Array.isArray(body.data)
      ? body.data
      : [];
  const models: string[] = [];
  const contextWindows: Record<string, number> = {};
  const contextFields = ["context_length", "context_window", "max_context_length"] as const;

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0) continue;

    models.push(id);
    for (const field of contextFields) {
      const value = record[field];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        contextWindows[id] = value;
        break;
      }
    }
  }

  return { models, contextWindows };
}
