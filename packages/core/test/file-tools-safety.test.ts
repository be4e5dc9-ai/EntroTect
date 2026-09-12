import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteText, withFileLock } from "../src/tools/file-access.js";
import { editTool } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import type { ToolContext } from "../src/tools/types.js";

const roots: string[] = [];
async function setup(content = "alpha beta gamma") {
  const root = await mkdtemp(path.join(tmpdir(), "entrotect-file-safety-"));
  roots.push(root);
  const file = path.join(root, "code.js");
  await writeFile(file, content, "utf8");
  const ctx: ToolContext = { cwd: root, artifactDir: root, sandboxMode: "full", fileStates: new Map() };
  return { root, file, ctx };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file tool write integrity", () => {
  it.each([false, true])("replacement is literal, including dollar tokens (replace_all=%s)", async (replace_all) => {
    const original = replace_all ? "\uFEFFprefix\r\nTARGET\r\nTARGET\r\nsuffix\r\n" : "\uFEFFprefix\r\nTARGET\r\nsuffix\r\n";
    const { file, ctx } = await setup(original);
    const replacement = "const tokens = [\"$&\", \"$`\", \"$'\", \"$$\", \"$1\"];\r\nconst text = `${value}`;";
    await editTool.call({ file_path: "code.js", old_string: "TARGET", new_string: replacement, replace_all }, ctx);
    expect(await readFile(file, "utf8")).toBe(original.split("TARGET").join(replacement));
  });

  it("rejects an empty old_string without changing the file or looping", async () => {
    const { file, ctx } = await setup();
    await expect(editTool.call({ file_path: "code.js", old_string: "", new_string: "oops" }, ctx)).rejects.toThrow("不能为空");
    expect(await readFile(file, "utf8")).toBe("alpha beta gamma");
  });

  it("serializes a batch of same-file edits without dropping any patch", async () => {
    const lines = Array.from({ length: 16 }, (_, i) => `const field_${i} = 0;`);
    const { file, ctx } = await setup(lines.join("\n"));
    await readTool.call({ file_path: "code.js" }, ctx);
    await Promise.all(lines.map((line) => editTool.call({
      file_path: "code.js", old_string: line, new_string: line.replace("= 0", "= 1"),
    }, { ...ctx })));
    expect(await readFile(file, "utf8")).toBe(lines.map((line) => line.replace("= 0", "= 1")).join("\n"));
  });

  it("mixed write/edit/read calls share the same FIFO transaction lock", async () => {
    const { file, ctx } = await setup();
    const results = await Promise.all([
      writeTool.call({ file_path: "code.js", content: "new whole file" }, ctx),
      editTool.call({ file_path: "./code.js", old_string: "whole", new_string: "edited" }, ctx),
      readTool.call({ file_path: file }, ctx),
      editTool.call({ file_path: "code.js", old_string: "edited", new_string: "final" }, ctx),
    ]);
    expect(results[2]).toContain("new edited file");
    expect(await readFile(file, "utf8")).toBe("new final file");
  });

  it("another agent's read or edit cannot refresh the parent's snapshot", async () => {
    const { file, ctx } = await setup();
    const child = { ...ctx, fileStates: new Map<string, string>() };
    await readTool.call({ file_path: file }, ctx);
    await readTool.call({ file_path: file }, child);
    await editTool.call({ file_path: file, old_string: "alpha", new_string: "child" }, child);
    await readTool.call({ file_path: file }, child);
    await expect(editTool.call({ file_path: file, old_string: "beta", new_string: "parent" }, ctx)).rejects.toThrow("重新 read");
    await expect(writeTool.call({ file_path: file, content: "stale whole file" }, ctx)).rejects.toThrow("重新 read");
    expect(await readFile(file, "utf8")).toBe("child beta gamma");
    await readTool.call({ file_path: file }, ctx);
    await editTool.call({ file_path: file, old_string: "beta", new_string: "parent" }, ctx);
    expect(await readFile(file, "utf8")).toBe("child parent gamma");
  });

  it("concurrent agents cannot overwrite the same observed version", async () => {
    const { file, ctx } = await setup();
    const child = { ...ctx, fileStates: new Map<string, string>() };
    await Promise.all([readTool.call({ file_path: file }, ctx), readTool.call({ file_path: file }, child)]);
    const results = await Promise.allSettled([
      editTool.call({ file_path: file, old_string: "alpha", new_string: "parent" }, ctx),
      writeTool.call({ file_path: file, content: "child overwrites everything" }, child),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(file, "utf8")).toBe("parent beta gamma");
  });

  it("detects external changes even when size and mtime are identical", async () => {
    const { file, ctx } = await setup();
    const stamp = new Date("2025-01-01T00:00:00Z");
    await utimes(file, stamp, stamp);
    await readTool.call({ file_path: file }, ctx);
    const before = await stat(file);
    await writeFile(file, "alpha beta delta", "utf8");
    await utimes(file, stamp, stamp);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(file)).size).toBe(before.size);
    await expect(editTool.call({ file_path: file, old_string: "alpha", new_string: "lost change" }, ctx)).rejects.toThrow("重新 read");
  });

  it("a failed commit leaves original content intact and removes only its staging file", async () => {
    const { root, file } = await setup("external change");
    await expect(atomicWriteText(file, "bad overwrite", "old version")).rejects.toThrow("写入期间被修改");
    expect(await readFile(file, "utf8")).toBe("external change");
    expect(await readdir(root)).toEqual(["code.js"]);
  });

  it("a queued cancellation skips writing and releases the queue for the next operation", async () => {
    const { file, ctx } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = withFileLock(file, undefined, () => gate);
    const controller = new AbortController();
    const cancelled = writeTool.call({ file_path: file, content: "cancelled" }, { ...ctx, abortSignal: controller.signal });
    const rejection = expect(cancelled).rejects.toThrow();
    controller.abort();
    release();
    await Promise.all([holding, rejection]);
    expect(await readFile(file, "utf8")).toBe("alpha beta gamma");
    await editTool.call({ file_path: file, old_string: "alpha", new_string: "next" }, ctx);
    expect(await readFile(file, "utf8")).toBe("next beta gamma");
  });

  it("different files remain parallel while a file is locked", async () => {
    const { root, file, ctx } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = withFileLock(file, undefined, () => gate);
    try {
      await writeTool.call({ file_path: "other.js", content: "parallel" }, ctx);
      expect(await readFile(path.join(root, "other.js"), "utf8")).toBe("parallel");
    } finally {
      release();
      await holding;
    }
  });

  it("directory aliases use the same lock and observations", async () => {
    const { root, ctx } = await setup();
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "test.js"), "alpha beta", "utf8");
    await symlink(path.join(root, "real"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await readTool.call({ file_path: "real/test.js" }, ctx);
    await Promise.all([
      editTool.call({ file_path: "real/test.js", old_string: "alpha", new_string: "one" }, ctx),
      editTool.call({ file_path: "alias/test.js", old_string: "beta", new_string: "two" }, ctx),
    ]);
    expect(await readFile(path.join(root, "real", "test.js"), "utf8")).toBe("one two");
  });
});
