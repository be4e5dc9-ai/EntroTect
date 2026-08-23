// =====================================================================
// bash:PowerShell 命令执行
// 设计依据:ClaudeCode BashTool(120s 超时 + tree-kill)+ opencode/05
// (强杀进程树)。输出格式照抄 codex exec_command 的
// "Exit code / Wall time / Output" 三段式。
// =====================================================================

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 120;

const inputSchema = z.strictObject({
  command: z.string().describe("要执行的 PowerShell 命令"),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(`超时秒数(默认 ${DEFAULT_TIMEOUT_SECONDS},上限 600)`),
});

type Input = z.infer<typeof inputSchema>;

/** taskkill 杀整棵进程树(Windows) */
function killTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在当前工作目录执行 PowerShell 命令。优先用只读命令探查环境;" +
    "涉及破坏性操作(删除、强制覆盖、全局安装)前先说明并等待确认。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => (args as Input).command,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

    return await new Promise<string>((resolve, reject) => {
      const startedAt = Date.now();
      // 强制 UTF-8 输出,避免中文乱码
      const wrapped = `[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; ${args.command}`;
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", wrapped],
        { cwd: ctx.cwd, windowsHide: true },
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        const wallMs = Date.now() - startedAt;
        const wall = (wallMs / 1000).toFixed(2);
        const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
        const result =
          `Exit code: ${code ?? "null"}\nWall time: ${wall}s\n\nOutput:\n${output.trim()}`;
        if (timedOut) {
          reject(
            new Error(
              `命令超时(${args.timeout ?? DEFAULT_TIMEOUT_SECONDS}s),进程树已强杀。已捕获输出:\n${result}`,
            ),
          );
        } else {
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
        // 强杀兜底:3s 内进程未退则强制收口
        setTimeout(() => finish(null), 3000);
      }, timeoutMs);

      const onAbort = () => {
        if (child.pid) killTree(child.pid);
      };
      ctx.abortSignal?.addEventListener("abort", onAbort);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        reject(new Error(`无法启动 PowerShell: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        finish(code);
      });
    });
  },
};
