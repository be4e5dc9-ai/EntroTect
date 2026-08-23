// =====================================================================
// 会话存储:JSONL append-only 事件流
// 设计依据:codex/08 rollout + ClaudeCode/08 JSONL。行格式:
//   { ordinal, ts, kind, ... }
// kind ∈ meta | title | message
//  - meta:   首行,会话元信息(id/createdAt/model/cwd)
//  - title:  标题可追加(最后一次生效),保持 append-only 不重写首行
//  - message: 完整 Message(含 tool_result),按序重建历史
// 加载容忍 torn tail:最后一行损坏则忽略之。
// =====================================================================

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  messageSchema,
  sessionMetaSchema,
  type Message,
  type SessionMeta,
} from "@entrotect/shared";

export interface LoadedSession {
  meta: SessionMeta;
  messages: Message[];
}

interface Line {
  ordinal: number;
  ts: string;
  kind: "meta" | "title" | "message";
  meta?: SessionMeta;
  title?: string;
  message?: Message;
}

export class SessionStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.rootDir, sessionId);
  }

  transcriptPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "transcript.jsonl");
  }

  artifactDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "artifacts");
  }

  /** 创建会话:写 meta 首行 */
  async create(meta: Omit<SessionMeta, "id" | "createdAt">): Promise<SessionMeta> {
    const full: SessionMeta = {
      ...meta,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.appendLines(full.id, [
      { ordinal: 0, ts: full.createdAt, kind: "meta", meta: full },
    ]);
    return full;
  }

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    await this.appendLines(sessionId, [
      { ordinal: this.nextOrdinal(), ts: new Date().toISOString(), kind: "message", message },
    ]);
  }

  async appendTitle(sessionId: string, title: string): Promise<void> {
    await this.appendLines(sessionId, [
      { ordinal: this.nextOrdinal(), ts: new Date().toISOString(), kind: "title", title },
    ]);
  }

  /** 重建会话:meta + 全部 message + 最后一条 title */
  async load(sessionId: string): Promise<LoadedSession> {
    const lines = await this.readLines(sessionId);
    let meta: SessionMeta | null = null;
    let title: string | undefined;
    const messages: Message[] = [];
    for (const line of lines) {
      if (line.kind === "meta" && line.meta) meta = line.meta;
      if (line.kind === "title" && line.title) title = line.title;
      if (line.kind === "message" && line.message) messages.push(line.message);
    }
    if (!meta) throw new Error(`会话 ${sessionId} 无 meta 行,可能已损坏`);
    return { meta: { ...meta, title: title ?? meta.title }, messages };
  }

  /** 删除会话(对话)及其产物 */
  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  /** 列出全部会话,按创建时间倒序 */
  async list(): Promise<SessionMeta[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { meta, messages } = await this.load(entry.name);
        metas.push(meta);
        void messages;
      } catch {
        // 损坏会话跳过
      }
    }
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return metas;
  }

  private nextOrdinal(): number {
    return Math.floor(Date.now() * 1000) + Math.floor(Math.random() * 1000);
  }

  private async appendLines(sessionId: string, lines: Line[]): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    await writeFile(this.transcriptPath(sessionId), text, { encoding: "utf8", flag: "a" });
  }

  private async readLines(sessionId: string): Promise<Line[]> {
    const file = this.transcriptPath(sessionId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    const lines: Line[] = [];
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      try {
        const line = JSON.parse(text) as Line;
        if (line.kind === "message" && line.message) {
          line.message = messageSchema.parse(line.message);
        }
        if (line.kind === "meta" && line.meta) {
          line.meta = sessionMetaSchema.parse(line.meta);
        }
        lines.push(line);
      } catch {
        // torn tail:容忍损坏行(最后一行截断等),跳过
      }
    }
    return lines;
  }
}
