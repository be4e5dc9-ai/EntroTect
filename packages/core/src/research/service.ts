import { mkdir, open, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { researchCommandSchema, researchSourceInputSchema, researchSourceSchema, type ResearchCommand, type ResearchReply, type ResearchSource } from "@entrotect/shared";
import { buildResearchPrompt, exportBibtex, exportMarkdown, exportTable } from "./export.js";

const librarySchema = z.object({ version: z.literal(1), sources: z.array(researchSourceSchema).max(500) }).strict();
const queues = new Map<string, Promise<unknown>>();
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Each session owns an independent source library. All read-modify-write operations are serialized. */
export class ResearchService {
  private readonly directory: string;

  constructor(appDataDir: string) {
    this.directory = path.resolve(appDataDir, "research");
  }

  /** Queue deletion after any in-flight save for this session, without touching other libraries. */
  async deleteSession(sessionId: string): Promise<void> {
    const validated = researchCommandSchema.parse({ action: "list", sessionId });
    const filename = path.join(this.directory, `${validated.sessionId}.json`);
    const previous = queues.get(filename) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      try { await unlink(filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
    queues.set(filename, operation);
    try { await operation; } finally { if (queues.get(filename) === operation) queues.delete(filename); }
  }

  async execute(rawCommand: ResearchCommand, abortSignal?: AbortSignal): Promise<ResearchReply> {
    const parsed = researchCommandSchema.safeParse(rawCommand);
    if (!parsed.success) return { error: `资料库参数无效：${parsed.error.issues[0]?.message ?? "未知错误"}` };
    const command = parsed.data;
    const filename = path.join(this.directory, `${command.sessionId}.json`);
    const previous = queues.get(filename) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async (): Promise<ResearchReply> => {
      try {
        abortSignal?.throwIfAborted();
        if (command.action === "export_table") {
          if (command.rows.reduce((size, row) => size + row.reduce((sum, cell) => sum + cell.length, 0), 0) > 5_000_000) return { error: "表格过大，请减少行数后导出" };
          return { export: exportTable(command.rows, command.title) };
        }
        const sources = await this.load(filename);
        abortSignal?.throwIfAborted();
        if (command.action === "list") return { sources };
        if (command.action === "save") {
          if (sources.length >= 500) return { error: "每个对话最多保存 500 条资料，请先整理资料库" };
          const now = new Date().toISOString();
          const source: ResearchSource = { ...command.source, tags: [...new Set(command.source.tags.filter(Boolean))], id: randomUUID(), createdAt: now, updatedAt: now, accessedAt: now };
          sources.unshift(source);
          await this.persist(filename, sources, abortSignal);
          return { source, sources };
        }
        if (command.action === "update" || command.action === "remove") {
          const index = sources.findIndex((source) => source.id === command.id);
          if (index < 0) return { error: "资料不存在，可能已被删除，请刷新资料库" };
          if (command.action === "remove") {
            sources.splice(index, 1);
            await this.persist(filename, sources, abortSignal);
            return { sources };
          }
          const existing = sources[index]!;
          const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, accessedAt: _accessedAt, ...existingInput } = existing;
          const patch = Object.fromEntries(Object.entries(command.patch).filter(([, value]) => value !== undefined));
          const input = researchSourceInputSchema.parse({ ...existingInput, ...patch });
          const source: ResearchSource = { ...existing, ...input, tags: [...new Set(input.tags.filter(Boolean))], updatedAt: new Date().toISOString() };
          sources[index] = source;
          await this.persist(filename, sources, abortSignal);
          return { source, sources };
        }
        const selected = command.sourceIds ? sources.filter((source) => command.sourceIds!.includes(source.id)) : sources;
        if (command.sourceIds?.some((id) => !sources.some((source) => source.id === id))) return { error: "部分选中的资料已不存在，请刷新后重新选择" };
        if (selected.length === 0) return { error: "请先保存并选择至少一条资料" };
        if (command.action === "export") return { export: command.format === "bibtex" ? exportBibtex(selected) : exportMarkdown(selected) };
        const prompt = buildResearchPrompt(selected, command.template);
        if (prompt.length > 200_000) return { error: "所选资料超过 20 万字符，请减少所选资料以免占满对话上下文" };
        return { prompt };
      } catch (error) {
        return { error: `资料库操作失败：${error instanceof Error ? error.message : String(error)}` };
      }
    });
    queues.set(filename, operation);
    try { return await operation; } finally { if (queues.get(filename) === operation) queues.delete(filename); }
  }

  private async load(filename: string): Promise<ResearchSource[]> {
    let file;
    try {
      file = await open(filename, "r");
      if ((await file.stat()).size > MAX_FILE_BYTES) throw new Error("资料库文件超过安全大小上限");
      const data = await file.readFile();
      if (data.byteLength > MAX_FILE_BYTES) throw new Error("资料库文件超过安全大小上限");
      return librarySchema.parse(JSON.parse(data.toString("utf8"))).sources;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // A corrupt file must not be silently replaced with an empty library.
      throw error;
    } finally { await file?.close(); }
  }

  private async persist(filename: string, sources: ResearchSource[], abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const data = JSON.stringify({ version: 1, sources }, null, 2);
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("资料库已达到容量上限");
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      abortSignal?.throwIfAborted();
      await writeFile(temp, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // The rename is the commit point. Canceled writes discard their staged file.
      abortSignal?.throwIfAborted();
      await rename(temp, filename);
    } finally { await unlink(temp).catch(() => undefined); }
  }
}
