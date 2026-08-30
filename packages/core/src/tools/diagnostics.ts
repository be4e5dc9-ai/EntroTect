// =====================================================================
// diagnostics:本地 tsc 类型检查诊断闭环（对标 Cursor 诊断）
// 安全边界(P2-2):只调用 <cwd>/node_modules/.bin/tsc 的绝对路径,
// 绝不 spawn pnpm/npx —— 那会免审批执行项目脚本或下载/执行任意包。
// isReadOnly 保持 true:只读语义成立(不运行任何用户脚本)。
// =====================================================================

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { resolveInsideCwd } from "./paths.js";

const inputSchema = z.strictObject({
  path: z.string().optional().describe("可选：聚焦到单个文件/目录（相对工作目录），不填则检查全项目"),
});

type Input = z.infer<typeof inputSchema>;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  useShell: boolean,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    "获取项目类型检查诊断，用于改完代码后闭环自检。仅调用本地 node_modules/.bin/tsc --noEmit（不运行 pnpm/npx 等项目脚本），返回结构化错误列表，不改文件。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => (args as Input).path ?? "全项目诊断",
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const cwd = ctx.cwd;
    const target = args.path ? ` (${args.path})` : "";

    // 仅本地 tsc:绝对路径定位,绝不 spawn pnpm/npx(免审批间接命令执行)。
    // Windows 下 .cmd 需 shell 包装;args 均为固定 flag + 已收容的绝对路径。
    const tsc = path.join(
      cwd,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsc.cmd" : "tsc",
    );
    if (!(await exists(tsc))) {
      return `未找到本地 tsc(${tsc})。请用 bash 运行项目自带检查命令（如 pnpm typecheck）。`;
    }

    const tscArgs = ["--noEmit", "--pretty", "false"];
    if (args.path) {
      tscArgs.push(resolveInsideCwd(cwd, args.path, ctx.protectedPaths));
    }
    const result = await run(tsc, tscArgs, cwd, 25000, process.platform === "win32");
    const out = `${result.stdout}\n${result.stderr}`.trim();
    if (out) {
      const clipped = out.slice(0, 8000);
      if (clipped.toLowerCase().includes("error") || result.code !== 0) {
        return `诊断${target}（tsc）：\n${clipped}`;
      }
    }
    if (result.code === 0) return `✓ 无诊断错误${target}（tsc 通过）`;
    return `诊断${target}：tsc 输出为空。请用 bash 运行项目自带检查命令（如 pnpm test / pnpm typecheck）。`;
  },
};
