import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/tools/types.js";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import { editTool } from "../src/tools/edit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { bashTool } from "../src/tools/bash.js";
import { diagnosticsTool } from "../src/tools/diagnostics.js";
import { truncateOutput, MAX_TOOL_OUTPUT_BYTES } from "../src/tools/output.js";
import { zodToJsonSchema } from "../src/tools/zod-json.js";
import { z } from "zod";

async function makeCtx(): Promise<{ ctx: ToolContext; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "entrotect-tools-"));
  return {
    root,
    ctx: { cwd: root, artifactDir: path.join(root, ".artifacts"), sandboxMode: "full" },
  };
}

describe("read 工具", () => {
  it("行号 + offset/limit 窗口", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "a.txt"), "l1\nl2\nl3\nl4\nl5", "utf8");
    const out = await readTool.call({ file_path: "a.txt", offset: 2, limit: 2 }, ctx);
    expect(out).toBe("     2| l2\n     3| l3");
  });

  it("文件不存在报错", async () => {
    const { ctx } = await makeCtx();
    await expect(readTool.call({ file_path: "nope.txt" }, ctx)).rejects.toThrow("文件不存在");
  });

  it("越界路径 ../ 被拦截(P0-1)", async () => {
    const { ctx } = await makeCtx();
    await expect(readTool.call({ file_path: "../escape.txt" }, ctx)).rejects.toThrow("已拦截");
  });

  it("超大文件引导窗口读", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "big.txt"), "x".repeat(300 * 1024), "utf8");
    await expect(readTool.call({ file_path: "big.txt" }, ctx)).rejects.toThrow("过大");
  });
});

describe("write 工具", () => {
  it("自动创建父目录", async () => {
    const { ctx, root } = await makeCtx();
    const out = await writeTool.call(
      { file_path: "deep/nested/file.txt", content: "data" },
      ctx,
    );
    expect(out).toContain("已写入");
    expect(await readFile(path.join(root, "deep/nested/file.txt"), "utf8")).toBe("data");
  });
});

describe("edit 工具", () => {
  it("唯一匹配替换", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "e.txt"), "const a = 1;\nconst b = 2;", "utf8");
    await readTool.call({ file_path: "e.txt" }, ctx); // 记录状态
    const out = await editTool.call(
      { file_path: "e.txt", old_string: "const a = 1;", new_string: "let a = 42;" },
      ctx,
    );
    expect(out).toContain("已替换 1 处");
    expect(await readFile(path.join(root, "e.txt"), "utf8")).toBe("let a = 42;\nconst b = 2;");
  });

  it("多处匹配且未 replace_all 报错", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "e.txt"), "x\nx", "utf8");
    await readTool.call({ file_path: "e.txt" }, ctx);
    await expect(
      editTool.call({ file_path: "e.txt", old_string: "x", new_string: "y" }, ctx),
    ).rejects.toThrow("不唯一");
  });

  it("replace_all 全量替换", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "e.txt"), "x\nx", "utf8");
    await readTool.call({ file_path: "e.txt" }, ctx);
    await editTool.call({ file_path: "e.txt", old_string: "x", new_string: "y", replace_all: true }, ctx);
    expect(await readFile(path.join(root, "e.txt"), "utf8")).toBe("y\ny");
  });

  it("新鲜度闸门:read 后被外部修改则拒绝编辑", async () => {
    const { ctx, root } = await makeCtx();
    const file = path.join(root, "e.txt");
    await writeFile(file, "original", "utf8");
    await readTool.call({ file_path: "e.txt" }, ctx);
    await writeFile(file, "externally changed", "utf8"); // 外部修改
    await expect(
      editTool.call({ file_path: "e.txt", old_string: "original", new_string: "new" }, ctx),
    ).rejects.toThrow("重新 read");
  });

  it("未找到 old_string 报错", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "e.txt"), "abc", "utf8");
    await readTool.call({ file_path: "e.txt" }, ctx);
    await expect(
      editTool.call({ file_path: "e.txt", old_string: "zzz", new_string: "y" }, ctx),
    ).rejects.toThrow("未找到");
  });
});

describe("glob 工具", () => {
  it("匹配文件并忽略依赖目录", async () => {
    const { ctx, root } = await makeCtx();
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "", "utf8");
    await writeFile(path.join(root, "node_modules", "pkg", "b.ts"), "", "utf8");
    const out = await globTool.call({ pattern: "**/*.ts" }, ctx);
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.ts");
  });
});

describe("grep 工具", () => {
  it("递归匹配,返回 文件:行号", async () => {
    const { ctx, root } = await makeCtx();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "const foo = 1;\nbar();", "utf8");
    const out = await grepTool.call({ pattern: "foo" }, ctx);
    expect(out).toMatch(/src[\\/]a\.ts:1: const foo = 1/);
  });

  it("无效正则报错", async () => {
    const { ctx } = await makeCtx();
    await expect(grepTool.call({ pattern: "(" }, ctx)).rejects.toThrow("无效正则");
  });
});

describe("bash 工具", () => {
  it("执行 PowerShell 命令,三段式输出", async () => {
    const { ctx } = await makeCtx();
    const out = await bashTool.call({ command: "Write-Output 'hello-世界'" }, ctx);
    expect(out).toMatch(/Exit code: 0/);
    expect(out).toMatch(/Wall time: \d+\.\d+s/);
    expect(out).toContain("hello-世界");
  });

  it("目录跨调用持久:Set-Location 后下一次调用仍在目标目录", async () => {
    const { ctx, root } = await makeCtx();
    await mkdir(path.join(root, "sub", "deep"), { recursive: true });

    // 第一次:切换目录(修复"Set-Location 不生效"缺陷)
    await bashTool.call({ command: "Set-Location 'sub\\deep'" }, ctx);
    // 第二次:未显式切换,应仍在 sub\deep(marker 回读 + 恢复)
    const out = await bashTool.call({ command: "(Get-Location).Path" }, ctx);
    expect(out).toContain("Exit code: 0");
    expect(out.toLowerCase()).toContain("deep");
    // 且 marker 不泄漏进模型可见输出
    expect(out).not.toContain("__ENTROTECT_CWD__");
  });

  it("超时强杀", async () => {
    const { ctx } = await makeCtx();
    await expect(
      bashTool.call({ command: "Start-Sleep -Seconds 60", timeout: 1 }, ctx),
    ).rejects.toThrow("超时");
  }, 15000);

  it("非零退出码保留输出", async () => {
    const { ctx } = await makeCtx();
    const out = await bashTool.call({ command: "exit 3" }, ctx);
    expect(out).toContain("Exit code: 3");
  });
});

describe("diagnostics 工具", () => {
  it("无本地 tsc 时返回引导文案(不 spawn pnpm/npx)", async () => {
    const { ctx } = await makeCtx();
    const out = await diagnosticsTool.call({}, ctx);
    expect(out).toContain("未找到本地 tsc");
    expect(out).toContain("pnpm typecheck");
  });

  it("path 越界被拦截(P2-2)", async () => {
    const { ctx, root } = await makeCtx();
    const tscName = process.platform === "win32" ? "tsc.cmd" : "tsc";
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(root, "node_modules", ".bin", tscName), "", "utf8");
    await expect(diagnosticsTool.call({ path: "../outside" }, ctx)).rejects.toThrow("已拦截");
  });
});

describe("truncateOutput 截断", () => {
  it("超限落盘换预览", async () => {
    const { ctx, root } = await makeCtx();
    const big = "A".repeat(MAX_TOOL_OUTPUT_BYTES + 1000);
    const { content, spilledTo } = await truncateOutput(big, ctx.artifactDir);
    expect(spilledTo).not.toBeNull();
    expect(content.length).toBeLessThan(MAX_TOOL_OUTPUT_BYTES);
    expect(content).toContain("已截断");
    expect(await readFile(spilledTo!, "utf8")).toBe(big);
    expect(spilledTo).toContain(path.join(root, ".artifacts"));
  });

  it("未超限原样返回", async () => {
    const { ctx } = await makeCtx();
    const { content, spilledTo } = await truncateOutput("short", ctx.artifactDir);
    expect(content).toBe("short");
    expect(spilledTo).toBeNull();
  });
});

describe("zodToJsonSchema", () => {
  it("strictObject 语义:required + additionalProperties:false + describe", () => {
    const schema = z.strictObject({
      name: z.string().describe("名字"),
      count: z.number().optional(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "名字" },
        count: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("同一 schema 对象缓存(字节级稳定)", () => {
    const schema = z.strictObject({ a: z.string() });
    expect(zodToJsonSchema(schema)).toBe(zodToJsonSchema(schema));
  });
});
