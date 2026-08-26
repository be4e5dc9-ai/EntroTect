// =====================================================================
// diagnostics:LSP/类型检查诊断闭环（对标 Cursor 诊断）
// 优先尝试: tsc --noEmit → eslint → 兜底全局 grep 错误模式
// =====================================================================

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const inputSchema = z.strictObject({
  path: z.string().optional().describe("可选：聚焦到单个文件/目录（相对工作目录），不填则检查全项目"),
});

type Input = z.infer<typeof inputSchema>;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        // taskkill tree
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
      setTimeout(() => finish(null), 3000);
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

export const diagnosticsTool: Tool = {
  name: "diagnostics",
  description:
    "获取项目诊断（类型检查/语法错误），用于改完代码后闭环自检。优先运行 `pnpm typecheck` / `tsc --noEmit`，失败回退 eslint。返回结构化错误列表，不改文件。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).path ?? "全项目诊断",
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const cwd = ctx.cwd;
    const target = args.path ? ` (${args.path})` : "";
    // 1) pnpm typecheck（若存在）
    const pnpm = await run("pnpm", ["--filter", "@entrotect/app-desktop", "typecheck"], cwd, 25000);
    const pnpmOut = `${pnpm.stdout}\n${pnpm.stderr}`.trim();
    if (pnpm.code === 0 && !pnpmOut.toLowerCase().includes("error")) {
      // 成功无错
      if (!pnpmOut || pnpmOut.length < 20) return `✓ 无诊断错误${target}（typecheck 通过）`;
    }
    if (pnpmOut && pnpmOut.length > 30 && !pnpmOut.includes("ERR_PNPM_NO_IMPLICITLY_INSTALLED_PEERS")) {
      const clipped = pnpmOut.slice(0, 8000);
      if (clipped.toLowerCase().includes("error")) return `诊断${target}（pnpm typecheck）：\n${clipped}`;
    }
    // 2) tsc --noEmit
    const tsc = await run("npx", ["tsc", "--noEmit", "--pretty", "false", ...(args.path ? [args.path] : [])], cwd, 25000);
    const tscOut = `${tsc.stdout}\n${tsc.stderr}`.trim();
    if (tscOut) {
      const clipped = tscOut.slice(0, 8000);
      if (clipped.toLowerCase().includes("error") || tsc.code !== 0) return `诊断${target}（tsc）：\n${clipped}`;
    }
    if (tsc.code === 0) return `✓ 无诊断错误${target}（tsc 通过）`;
    // 3) 兜底
    return `诊断${target}：未发现配置化的 typecheck，tsc 输出为空。请用 bash 运行项目自带检查命令（如 pnpm test / pnpm typecheck）。`;
  },
};
