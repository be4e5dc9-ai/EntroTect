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
import { bashOutputTool } from "../src/tools/bash-output.js";
import { getBgJob, stopAllBgJobs, stopBgJobsForOwner } from "../src/tools/bg-manager.js";
import { killShellTool } from "../src/tools/kill-shell.js";
import { once } from "node:events";
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
    expect(out).toBe("     2| l2\n     3| l3\n[文件共 5 行；继续读取请使用 offset=4，limit=2。]");
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
    await expect(bashTool.call({ command: "exit 3" }, ctx)).rejects.toThrow("Exit code: 3");
    await expect(bashTool.call({ command: 'node -e "process.exit(7)"' }, ctx)).rejects.toThrow("Exit code: 7");
    await expect(bashTool.call({ command: "Write-Error 'expected failure'" }, ctx)).rejects.toThrow("Exit code: 1");
  });

  it("顶层原生命令链不能用最后一个成功退出码掩盖前面的失败", async () => {
    const { ctx } = await makeCtx();
    await expect(bashTool.call({ command: 'node -e "process.exit(7)"; node -e "process.exit(0)"' }, ctx))
      .rejects.toThrow("Exit code: 7");
    await expect(bashTool.call({ command: '& { node -e "process.exit(9)"; node -e "process.exit(0)" }' }, ctx))
      .rejects.toThrow("Exit code: 9");
    const handled = await bashTool.call({
      command: 'node -e "process.exit(7)"; if (-not $?) { Write-Output handled }; node -e "process.exit(0)"',
    }, ctx);
    expect(handled).toContain("handled");
  });

  it("前台高输出有内存上限并告知截断", async () => {
    const { ctx } = await makeCtx();
    const out = await bashTool.call({ command: 'node -e "process.stdout.write(\'x\'.repeat(350000))"' }, ctx);
    expect(out).toContain("stdout 前部已省略");
    expect(out.length).toBeLessThan(310_000);
  });

  it("UTF-8 中文文件默认可读", async () => {
    const { ctx, root } = await makeCtx();
    await writeFile(path.join(root, "note.txt"), "中文内容", "utf8");
    const out = await bashTool.call({ command: "Get-Content -LiteralPath 'note.txt'" }, ctx);
    expect(out).toContain("中文内容");
  });

  it("目录在注释和 exit 后持久，同工作区的其他代理独立", async () => {
    const { ctx, root } = await makeCtx();
    await mkdir(path.join(root, "one"));
    await mkdir(path.join(root, "one", "two"));
    ctx.shellState = {};
    const other = { ...ctx, shellState: {} };
    await bashTool.call({ command: "Set-Location -LiteralPath 'one' # comment" }, ctx);
    expect(await bashTool.call({ command: "(Get-Location).Path" }, ctx)).toContain(path.join(root, "one"));
    expect(await bashTool.call({ command: "(Get-Location).Path" }, other)).toContain(root);
    await bashTool.call({ command: "Set-Location -LiteralPath 'two'; exit 0" }, ctx);
    expect(await bashTool.call({ command: "(Get-Location).Path" }, ctx)).toContain(path.join(root, "one", "two"));
    expect(await bashTool.call({ command: "(Get-Location).Path" }, other)).not.toContain(path.join(root, "one"));
  }, 12_000);

  it("同代理并发命令按列表顺序继承目录", async () => {
    const { ctx, root } = await makeCtx();
    await mkdir(path.join(root, "sub"));
    ctx.shellState = {};
    const [, next] = await Promise.all([
      bashTool.call({ command: "Set-Location -LiteralPath 'sub'" }, ctx),
      bashTool.call({ command: "(Get-Location).Path" }, { ...ctx }),
    ]);
    expect(next).toContain(path.join(root, "sub"));
  });

  it("后台输出不泄漏目录标记，结束时间固定且超时可见", async () => {
    const { ctx } = await makeCtx();
    const started = await bashTool.call({ command: "Write-Output background_ok", background: true }, ctx);
    const id = started.match(/id: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    const job = getBgJob(id!, ctx.artifactDir);
    expect(job).toBeDefined();
    if (!job!.done) await once(job!.child!, "close");
    const out = await bashOutputTool.call({ jobId: id }, ctx);
    expect(out).toContain("采样时间:");
    expect(out).toContain("总运行");
    expect(out).toContain("background_ok");
    expect(out).not.toContain("__ENTROTECT_CWD_");
    const endedAt = job!.endedAt;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(job!.endedAt).toBe(endedAt);
    const refreshed = await bashOutputTool.call({ jobId: id }, ctx);
    expect(refreshed.match(/状态: .*/)?.[0]).toBe(out.match(/状态: .*/)?.[0]);

    const timeoutStarted = await bashTool.call({ command: "Start-Sleep -Seconds 5", background: true, timeout: 1 }, ctx);
    expect(timeoutStarted).toContain("超时策略：1 秒后终止进程树");
    const timeoutId = timeoutStarted.match(/id: (\S+)/)?.[1];
    const timeoutJob = getBgJob(timeoutId!, ctx.artifactDir);
    if (!timeoutJob!.done) await once(timeoutJob!.child!, "close");
    expect(await bashOutputTool.call({ jobId: timeoutId }, ctx)).toContain("已超时");
  });

  it("后台任务按会话隔离，删除会话时终止并移除", async () => {
    const { ctx, root } = await makeCtx();
    const other = { ...ctx, artifactDir: path.join(root, "other-artifacts") };
    const started = await bashTool.call({ command: "Start-Sleep -Seconds 60", background: true }, ctx);
    expect(started).toContain("超时策略：无自动超时");
    const id = started.match(/id: (\S+)/)?.[1];
    expect(id).toBeTruthy();
    expect(getBgJob(id!, ctx.artifactDir)).toBeDefined();
    expect(getBgJob(id!, other.artifactDir)).toBeUndefined();
    await expect(bashOutputTool.call({ jobId: id }, other)).rejects.toThrow("未找到后台任务");
    await expect(killShellTool.call({ jobId: id }, other)).rejects.toThrow("未找到后台任务");
    await stopBgJobsForOwner(ctx.artifactDir);
    expect(getBgJob(id!, ctx.artifactDir)).toBeUndefined();
  }, 15000);

  it("退出应用时清理所有会话的后台任务", async () => {
    const { ctx, root } = await makeCtx();
    const other = { ...ctx, artifactDir: path.join(root, "other-artifacts") };
    const first = await bashTool.call({ command: "Start-Sleep -Seconds 60", background: true }, ctx);
    const second = await bashTool.call({ command: "Start-Sleep -Seconds 60", background: true }, other);
    const firstId = first.match(/id: (\S+)/)?.[1];
    const secondId = second.match(/id: (\S+)/)?.[1];
    expect(getBgJob(firstId!, ctx.artifactDir)).toBeDefined();
    expect(getBgJob(secondId!, other.artifactDir)).toBeDefined();
    await stopAllBgJobs();
    expect(getBgJob(firstId!, ctx.artifactDir)).toBeUndefined();
    expect(getBgJob(secondId!, other.artifactDir)).toBeUndefined();
  }, 15000);
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

  it("保留可选参数说明与数值边界", () => {
    expect(zodToJsonSchema(bashTool.inputSchema)).toMatchObject({
      properties: {
        timeout: { type: "integer", minimum: 1, maximum: 600, description: expect.stringContaining("默认 120") },
        background: { type: "boolean", description: expect.stringContaining("后台运行") },
      },
    });
    expect(zodToJsonSchema(bashOutputTool.inputSchema)).toMatchObject({
      properties: { tail: { type: "integer", minimum: 100, maximum: 50000, description: expect.stringContaining("默认 12000") } },
    });
  });
});
