// =====================================================================
// Provider 错误与 HTTP 响应解析
// 所有供应商都走同一套错误格式：状态码、上游 code、脱敏 URL 和正文。
// =====================================================================

export interface ProviderErrorDetails {
  code?: string | number | null;
  url?: string;
  body?: string;
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly code: string | number | null;
  readonly url: string | null;
  readonly body: string | null;

  constructor(message: string, status: number | null = null, details: ProviderErrorDetails = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = details.code ?? null;
    this.url = details.url ?? null;
    this.body = details.body ?? null;
  }
}

/** 将错误正文和 URL 中可能出现的凭据替换掉。 */
export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  try {
    const url = new URL(result);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|signature|password/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return result;
  }
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractError(raw: string): { message: string; code: string | number | null } {
  const text = oneLine(raw);
  if (!text) return { message: "上游未提供错误正文", code: null };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>;
      const nested = root.error && typeof root.error === "object"
        ? root.error as Record<string, unknown>
        : undefined;
      const message =
        nested && typeof nested.message === "string"
          ? nested.message
          : typeof root.message === "string"
            ? root.message
            : typeof root.detail === "string"
              ? root.detail
              : typeof root.error === "string"
                ? root.error
                : text;
      const code = nested?.code ?? root.code ?? root.type ?? null;
      return { message: oneLine(message), code: typeof code === "string" || typeof code === "number" ? code : null };
    }
  } catch {
    // Plain text response; use it as-is below.
  }
  return { message: text.slice(0, 2_000), code: null };
}

export async function providerErrorFromResponse(
  response: Response,
  url: string,
  label: string,
  secrets: readonly string[] = [],
): Promise<ProviderError> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }
  const extracted = extractError(raw);
  const safeUrl = redactSecrets(url, secrets);
  const safeMessage = redactSecrets(extracted.message, secrets);
  const statusText = oneLine(response.statusText || "");
  const detail = safeMessage || statusText || "未知错误";
  const code = extracted.code === null ? "" : ` [${String(extracted.code)}]`;
  return new ProviderError(
    `${label}接口返回 ${response.status}${code}: ${detail} (${safeUrl})`,
    response.status,
    { code: extracted.code, url: safeUrl, body: safeMessage },
  );
}

