import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchService } from "../src/research/service.js";
import { researchCommandSchema, researchSourcePatchSchema, type ResearchCommand } from "@entrotect/shared";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

let directory: string;
let service: ResearchService;
const source = { title: "课程资料", url: "https://example.org/course", authors: ["Alice"], publishedAt: "2026-09-30", doi: "10.1/test", excerpt: "原文", note: "笔记", tags: ["学习", "学习", ""] };

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "entrotect-research-"));
  service = new ResearchService(directory);
});
afterEach(async () => { vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("ResearchService 持久化与隔离", () => {
  it("保存后重启仍保留完整元数据，并隔离不同任务", async () => {
    const saved = await service.execute({ action: "save", sessionId: "s1", source });
    expect(saved.error).toBeUndefined();
    expect(saved.source).toMatchObject({ ...source, tags: ["学习"] });
    expect(Number.isFinite(Date.parse(saved.source!.accessedAt))).toBe(true);
    const restarted = new ResearchService(directory);
    expect((await restarted.execute({ action: "list", sessionId: "s1" })).sources).toEqual([saved.source]);
    expect((await restarted.execute({ action: "list", sessionId: "s2" })).sources).toEqual([]);
  });

  it("跨服务实例的并发写入均保留，并保持文件完整", async () => {
    const other = new ResearchService(directory);
    const replies = await Promise.all(Array.from({ length: 15 }, (_, index) => (index % 2 ? service : other).execute({ action: "save", sessionId: "s1", source: { ...source, title: `资料${index}` } })));
    expect(replies.every((reply) => !reply.error)).toBe(true);
    const listed = await service.execute({ action: "list", sessionId: "s1" });
    expect(listed.sources).toHaveLength(15);
    expect(new Set(listed.sources?.map((item) => item.id)).size).toBe(15);
    expect(new Set(listed.sources?.map((item) => item.title))).toEqual(new Set(Array.from({ length: 15 }, (_, index) => `资料${index}`)));
  });

  it("局部更新保留未提供字段、创建日期与访问日期，允许明确清空", async () => {
    const created = (await service.execute({ action: "save", sessionId: "s1", source })).source!;
    const updated = await service.execute({ action: "update", sessionId: "s1", id: created.id, patch: { note: "新笔记", authors: undefined } });
    expect(updated.error).toBeUndefined();
    expect(updated.source).toMatchObject({ ...created, note: "新笔记", updatedAt: expect.any(String) });
    expect(researchSourcePatchSchema.parse({ note: "仅更新笔记" })).toEqual({ note: "仅更新笔记" });
    const cleared = await service.execute({ action: "update", sessionId: "s1", id: created.id, patch: { authors: [], excerpt: "" } });
    expect(cleared.source).toMatchObject({ authors: [], excerpt: "", note: "新笔记", doi: source.doi });
  });

  it("删除任务排在其写入之后，保留其他任务并允许重复清理", async () => {
    const save = service.execute({ action: "save", sessionId: "s1", source });
    await Promise.all([save, service.deleteSession("s1"), service.execute({ action: "save", sessionId: "s2", source })]);
    expect((await service.execute({ action: "list", sessionId: "s1" })).sources).toEqual([]);
    expect((await service.execute({ action: "list", sessionId: "s2" })).sources).toHaveLength(1);
    await expect(service.deleteSession("s1")).resolves.toBeUndefined();
    await expect(service.deleteSession("../escape")).rejects.toThrow();
  });

  it("排队等待期间已停止的保存不修改资料库，后续正常操作仍能完成", async () => {
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const staging = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await original.writeFile(...args);
      started();
      await blocked;
    });
    const first = service.execute({ action: "save", sessionId: "s1", source: { ...source, title: "正常来源" } });
    await staging;
    const controller = new AbortController();
    const canceled = service.execute({ action: "save", sessionId: "s1", source: { ...source, title: "已停止的来源" } }, controller.signal);
    controller.abort();
    release();
    expect((await first).error).toBeUndefined();
    expect((await canceled).error).toBeTruthy();
    expect((await service.execute({ action: "list", sessionId: "s1" })).sources?.map((item) => item.title)).toEqual(["正常来源"]);
    expect((await service.execute({ action: "save", sessionId: "s1", source: { ...source, title: "后续来源" } })).error).toBeUndefined();
    expect((await service.execute({ action: "list", sessionId: "s1" })).sources).toHaveLength(2);
  });

  it("暂存写入期间停止更新，保留原文件并删除暂存文件", async () => {
    const saved = (await service.execute({ action: "save", sessionId: "s1", source })).source!;
    const filename = path.join(directory, "research", "s1.json");
    const before = await readFile(filename, "utf8");
    const controller = new AbortController();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await original.writeFile(...args);
      controller.abort();
    });
    expect((await service.execute({ action: "update", sessionId: "s1", id: saved.id, patch: { note: "不能落盘" } }, controller.signal)).error).toBeTruthy();
    expect(await readFile(filename, "utf8")).toBe(before);
    expect(await readdir(path.join(directory, "research"))).toEqual(["s1.json"]);
  });
});

describe("ResearchService 损坏保护及参数验证", () => {
  it.each(["not json", JSON.stringify({ version: 2, sources: [] }), JSON.stringify({ version: 1, sources: [], unknown: "metadata" })])("无法读取的库不能被新的保存覆盖：%s", async (original) => {
    await mkdir(path.join(directory, "research"));
    const filename = path.join(directory, "research", "s1.json");
    await writeFile(filename, original);
    const listed = await service.execute({ action: "list", sessionId: "s1" });
    const saved = await service.execute({ action: "save", sessionId: "s1", source });
    expect(listed.error).toContain("资料库操作失败");
    expect(saved.error).toContain("资料库操作失败");
    expect(await readFile(filename, "utf8")).toBe(original);
  });

  it("在读取超大库之前拒绝，且不覆盖原文件", async () => {
    await mkdir(path.join(directory, "research"));
    const filename = path.join(directory, "research", "s1.json");
    const file = await open(filename, "w");
    await file.truncate(32 * 1024 * 1024 + 1);
    await file.close();
    expect((await service.execute({ action: "save", sessionId: "s1", source })).error).toContain("安全大小上限");
  });

  it.each(["../outside", "..\\outside", "E:\\outside", "nul", "CON", "COM1", "a/b", "a.b"])("拒绝路径或Windows保留名称 %s", async (sessionId) => {
    expect(researchCommandSchema.safeParse({ action: "list", sessionId }).success).toBe(false);
    expect((await service.execute({ action: "save", sessionId, source })).error).toContain("参数无效");
  });

  it("拒绝非法协议和来自客户端的id/时间字段", async () => {
    expect(researchCommandSchema.safeParse({ action: "save", sessionId: "s1", source: { ...source, url: "file:///E:/private" } }).success).toBe(false);
    expect(researchCommandSchema.safeParse({ action: "update", sessionId: "s1", id: "b42cda07-132c-4a0e-8f52-a0e6fbc328f3", patch: { id: "replacement" } }).success).toBe(false);
    expect((await service.execute({ action: "save", sessionId: "s1", source: { ...source, accessedAt: new Date().toISOString() } } as unknown as ResearchCommand)).error).toContain("参数无效");
  });

  it("失效选择明确报错，且不产生空导出或编造模板来源", async () => {
    const saved = (await service.execute({ action: "save", sessionId: "s1", source })).source!;
    expect((await service.execute({ action: "export", sessionId: "s1", format: "bibtex", sourceIds: [] })).error).toContain("至少一条");
    await service.execute({ action: "remove", sessionId: "s1", id: saved.id });
    expect((await service.execute({ action: "prompt", sessionId: "s1", template: "study", sourceIds: [saved.id] })).error).toContain("已不存在");
  });

  it("模板预算包含标题和作者等元数据，避免只算摘录的遗漏", async () => {
    await service.execute({ action: "save", sessionId: "s1", source: { ...source, authors: Array.from({ length: 100 }, () => "a".repeat(2_000)) } });
    expect((await service.execute({ action: "prompt", sessionId: "s1", template: "report" })).error).toContain("20 万字符");
  });
});
