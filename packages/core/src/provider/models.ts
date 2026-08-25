// =====================================================================
// 模型列表:GET {baseUrl}/models(OpenAI 兼容) + candidate URL + header 映射
// 移植 cc-switch model_fetch.rs:150 候选逻辑
// =====================================================================

import type { AppConfig } from "@entrotect/shared";

export const KNOWN_COMPAT_SUFFIXES: readonly string[] = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
] as const;

function endsWithVersionSegment(url: string): boolean {
  const last = url.split("/").pop() ?? "";
  if (!last.startsWith("v")) return false;
  const digits = last.slice(1);
  return digits.length > 0 && [...digits].every((c) => c >= "0" && c <= "9");
}

function stripCompatSuffix(baseUrl: string): string | undefined {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) {
      return baseUrl.slice(0, baseUrl.length - suffix.length);
    }
  }
  return undefined;
}

export function buildModelsUrlCandidates(baseUrl: string, modelsUrl?: string): string[] {
  const override = modelsUrl?.trim();
  if (override && override.length > 0) {
    return [override];
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new Error("Base URL is empty");
  }

  const candidates: string[] = [];

  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith("/v1")) {
      candidates.push(`${trimmed}/v1/models`);
    }
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped !== undefined) {
    const root = stripped.replace(/\/+$/, "");
    if (root.length > 0 && root.includes("://")) {
      candidates.push(`${root}/v1/models`);
      candidates.push(`${root}/models`);
    }
  }

  const unique: string[] = [];
  for (const url of candidates) {
    if (!unique.includes(url)) unique.push(url);
  }
  return unique;
}

type ExtendedConfig = AppConfig & {
  modelsUrl?: string;
  apiFormat?: string;
};

function buildHeaders(apiKey: string, apiFormat: string | undefined): Record<string, string> {
  if (apiFormat === "anthropic") return { "x-api-key": apiKey, "api-key": apiKey, Authorization: `Bearer ${apiKey}` };
  if (apiFormat === "google") return { "x-goog-api-key": apiKey };
  // OpenAI 兼容（含 Mimo api-key 头）：全部附带，兼容 Bearer / api-key 双鉴权
  return { Authorization: `Bearer ${apiKey}`, "api-key": apiKey, "x-api-key": apiKey };
}

export async function listModels(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: string[]; contextWindows: Record<string, number> }> {
  const extended = config as ExtendedConfig;
  const apiFormat = extended.apiFormat as string | undefined;
  const modelsUrl = extended.modelsUrl as string | undefined;

  const baseUrl = (config.baseUrl ?? "").trim();
  const candidates = buildModelsUrlCandidates(baseUrl, modelsUrl);

  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (const url of candidates) {
    const headers = buildHeaders(config.apiKey, apiFormat);
    let signal: AbortSignal | undefined;
    try {
      // Node 18+ / modern browsers support AbortSignal.timeout
      if (typeof AbortSignal !== "undefined" && typeof (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout === "function") {
        signal = (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(15_000);
      }
    } catch {
      signal = undefined;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        ...(signal ? { signal } : {}),
      } as RequestInit);
    } catch (e) {
      // Network/timeout -> fail fast (not continue to next candidate; only 404/405 continues)
      throw e instanceof Error ? e : new Error(String(e));
    }

    if (response.ok) {
      const body = (await response.json()) as unknown;
      const data =
        body && typeof body === "object" && "data" in body && Array.isArray((body as { data: unknown }).data)
          ? ((body as { data: unknown[] }).data as unknown[])
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
      models.sort((a, b) => a.localeCompare(b));
      return { models, contextWindows };
    }

    if (response.status === 404 || response.status === 405) {
      lastStatus = response.status;
      try {
        const text = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${text.slice(0, 512)}`;
      } catch {
        lastError = `HTTP ${response.status}`;
      }
      continue;
    }

    throw new Error(`模型列表接口返回 ${response.status}`);
  }

  if (lastStatus !== null) {
    throw new Error(`模型列表接口返回 ${lastStatus}`);
  }
  throw new Error(lastError ?? "All candidates failed");
}
