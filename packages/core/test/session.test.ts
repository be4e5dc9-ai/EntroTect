import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session/store.js";
import type { Message } from "@entrotect/shared";

async function makeStore(): Promise<SessionStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "entrotect-session-"));
  return new SessionStore(dir);
}

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "你好" }],
};

describe("SessionStore", () => {
  it("create → append → load 回环", async () => {
    const store = await makeStore();
    const meta = await store.create({ title: "测试", model: "m", cwd: "C:\\proj" });

    await store.appendMessage(meta.id, userMessage);
    const assistant: Message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    await store.appendMessage(meta.id, assistant);

    const loaded = await store.load(meta.id);
    expect(loaded.meta.id).toBe(meta.id);
    expect(loaded.meta.model).toBe("m");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0]).toEqual(userMessage);
    expect(loaded.messages[1]).toEqual(assistant);
  });

  it("append-only:追加标题不重写历史,load 取最后标题", async () => {
    const store = await makeStore();
    const meta = await store.create({ title: "", model: "m", cwd: "." });
    await store.appendMessage(meta.id, userMessage);
    await store.appendTitle(meta.id, "第一个会话");

    const loaded = await store.load(meta.id);
    expect(loaded.meta.title).toBe("第一个会话");
    expect(loaded.messages).toHaveLength(1);
  });

  it("torn tail 容忍:损坏行被跳过", async () => {
    const store = await makeStore();
    const meta = await store.create({ title: "", model: "m", cwd: "." });
    await store.appendMessage(meta.id, userMessage);
    // 模拟崩溃截断:追加半行 JSON
    await appendFile(store.transcriptPath(meta.id), '{"ordinal":123,"ts":"x","kind":"mess');

    const loaded = await store.load(meta.id);
    expect(loaded.messages).toHaveLength(1);
  });

  it("list 按创建时间倒序", async () => {
    const store = await makeStore();
    const first = await store.create({ title: "旧", model: "m", cwd: "." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await store.create({ title: "新", model: "m", cwd: "." });

    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual([second.id, first.id]);
  });

  it("load 不存在的会话抛错", async () => {
    const store = await makeStore();
    await expect(store.load("nonexistent")).rejects.toThrow("会话不存在");
  });

  it("落盘文件为合法 JSONL", async () => {
    const store = await makeStore();
    const meta = await store.create({ title: "", model: "m", cwd: "." });
    await store.appendMessage(meta.id, userMessage);
    const raw = await readFile(store.transcriptPath(meta.id), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
