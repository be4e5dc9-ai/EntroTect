// =====================================================================
// SSE 读取器
//
// readSseLines 保留给 data-only 供应商和旧调用方；readSseEvents 按 SSE
// 事件边界保留 event/data/id，Anthropic 等协议不能丢掉 event 行。
// =====================================================================

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** 把 fetch 响应切成物理 data 行(兼容旧 API)。 */
export async function* readSseLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const consume = function* (line: string): Generator<string> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload.length > 0) yield payload;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        for (const payload of consume(line)) yield payload;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const payload of consume(buffer.replace(/\r$/, ""))) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 按 SSE 空行分组装配完整事件,保留 event 行和多行 data。 */
export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let id: string | undefined;
  let data: string[] = [];

  const flush = function* (): Generator<SseEvent> {
    if (data.length > 0) {
      yield { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
    }
    event = "";
    id = undefined;
    data = [];
  };

  const consume = function* (line: string): Generator<SseEvent> {
    if (line.length === 0) {
      yield* flush();
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) id = value;
        break;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        for (const item of consume(line)) yield item;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const item of consume(buffer.replace(/\r$/, ""))) yield item;
    }
    for (const item of flush()) yield item;
  } finally {
    reader.releaseLock();
  }
}
