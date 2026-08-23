// =====================================================================
// SSE 行读取器:把 ReadableStream 增量切成 "data:" 行
// 设计依据:ClaudeCode/02 §4——手写 SSE switch,流式累积、逐行解析。
// 只处理字节切分,JSON 解析交给上层,便于单测。
// =====================================================================

/** 把 fetch 响应的 ReadableStream 迭代为完整 SSE data 行 */
export async function* readSseLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 只按 \n 切,残留半个行留在 buffer 里
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload.length > 0) yield payload;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
