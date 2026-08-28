// =====================================================================
// Provider HTTP 传输层
// HTTP 4xx/5xx 是确定的业务/协议错误，绝不换请求体盲重试；只有网络层
// 失败才做有限退避重试。这样 UI 能看到真正的上游错误，而不会重复执行请求。
// =====================================================================

import { ProviderError, providerErrorFromResponse } from "./errors.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const RETRY_DELAY_BASE_MS = 1_000;
export const RETRY_MAX = 2;

function waitWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function requestWithNetworkRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  label: string,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt >= RETRY_MAX) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError(
          `请求${label}失败(网络错误,已重试 ${RETRY_MAX} 次): ${message}`,
          null,
          { url, body: message },
        );
      }
      await waitWithAbort(RETRY_DELAY_BASE_MS * 2 ** attempt, signal);
      attempt += 1;
      continue;
    }

    if (!response.ok) {
      // 读取并保留供应商原始正文；绝不在这里改变 body/header 再发一次。
      throw await providerErrorFromResponse(response, url, label, secrets);
    }
    return response;
  }
}

