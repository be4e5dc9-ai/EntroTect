// =====================================================================
// 用量存储:append-only JSONL(usage/jsonl),每回合一条。
// 行格式与 core 的 UsageRecord 一致;被 SessionHost 在 turn-completed 时追加。
// =====================================================================

import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { UsageRecord } from "@entrotect/core";

export class UsageStore {
  private readonly filePath: string;

  constructor(appDataDir: string) {
    this.filePath = path.join(appDataDir, "usage.jsonl");
  }

  async append(record: UsageRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  }

  /** 读取全部记录(损坏行跳过) */
  async loadAll(): Promise<UsageRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const records: UsageRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as UsageRecord;
        if (
          typeof parsed.ts === "string" &&
          typeof parsed.inputTokens === "number" &&
          typeof parsed.outputTokens === "number" &&
          typeof parsed.sessionId === "string" &&
          typeof parsed.model === "string"
        ) {
          records.push(parsed);
        }
      } catch {
        // 跳过损坏行
      }
    }
    return records;
  }
}
