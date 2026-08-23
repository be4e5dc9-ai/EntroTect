import { describe, expect, it } from "vitest";
import { readSseLines } from "../src/provider/sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readSseLines(streamOf(chunks))) {
    lines.push(line);
  }
  return lines;
}

describe("readSseLines", () => {
  it("解析单块多行", async () => {
    const lines = await collect(['data: a\ndata: b\ndata: c\n\n']);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("跨块半行缓冲(任意字节切分点)", async () => {
    const lines = await collect([
      'data: {"hel',
      'lo":1}\n',
      "da",
      "ta: x",
      "\n\n",
    ]);
    expect(lines).toEqual(['{"hello":1}', "x"]);
  });

  it("忽略非 data 行与空行", async () => {
    const lines = await collect(["event: ping\ndata: keep\n: comment\n\n"]);
    expect(lines).toEqual(["keep"]);
  });

  it("忽略空 data 载荷", async () => {
    const lines = await collect(["data:\ndata: real\n"]);
    expect(lines).toEqual(["real"]);
  });
});
