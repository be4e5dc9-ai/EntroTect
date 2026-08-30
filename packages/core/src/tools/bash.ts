// =====================================================================
// bash:PowerShell 命令执行(会话目录跨调用持久)
// 设计依据:ClaudeCode BashTool(120s 超时 + tree-kill)+ opencode/05
// (强杀进程树)。输出格式照抄 codex exec_command 的三段式。
//
// 目录持久:每次调用在子进程内完成命令后,用 marker 回读最终 $PWD,
// 下次调用先 Set-Location 过去——Set-Location 不再"丢状态"
// (修复模型反馈的"目录切换不生效"问题)。
//
// 路径收容边界:bash 不做 P0-1 的工作目录收容——命令本就任意,仅受
// restricted 沙箱黑名单(P3-5)约束。因此 bash 是"需审批的任意命令"
// 通道,不要为它加 resolveInsideCwd(那既无效也会误拦合法跨目录操作)。
// =====================================================================

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { analyzeCommand } from "../sandbox/index.js";
import { appendOutput, createBgJob } from "./bg-manager.js";

const DEFAULT_TIMEOUT_SECONDS = 120;

/** 输出里的目录回读标记(从 stdout 剥离,不进模型上下文) */
const CWD_MARKER = "__ENTROTECT_CWD__:";

/** 以会话基准目录为 key 记住上次 bash 调用结束后的工作目录 */
const cwdMemory = new Map<string, string>();

const inputSchema = z.strictObject({
  command: z.string().describe("要执行的 PowerShell 命令"),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(`超时秒数(默认 ${DEFAULT_TIMEOUT_SECONDS},上限 600)`),
  background: z.boolean().optional().describe("true 时后台运行（长任务/dev server），立即返回任务 id，用 bash_output 轮询；默认 false"),
});

type Input = z.infer<typeof inputSchema>;

/** taskkill 杀整棵进程树(Windows) */
function killTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
}

/** PowerShell 字符串字面量转义 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在当前工作目录执行 PowerShell 命令。Set-Location 切换目录会持久到后续调用;" +
    "优先用只读命令探查环境;涉及破坏性操作(删除、强制覆盖、全局安装)前先说明并等待确认;" +
    "支持 background=true 后台运行（长任务/dev server）用 bash_output 轮询;" +
    "绝不用于硬约束所列行为（大规模杀伤、关键基础设施攻击、重大恶意代码/网络武器、非法权力攫取、CSAM等），遇到此类请求应拒绝。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => (args as Input).command,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);

    // 沙箱:受限模式下先拦危险命令,再决定是否真正 spawn
    if (ctx.sandboxMode === "restricted") {
      const verdict = analyzeCommand(args.command);
      if (verdict.blocked) {
        throw new Error(
          `[沙箱] 已拦截危险命令(${verdict.reason})。如确需执行,请切换权限模式为"完全访问权限"后重试。`,
        );
      }
    }

    const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

    // 目录持久:命令前恢复上次目录,命令后回读最终目录
    const savedCwd = cwdMemory.get(ctx.cwd);
    const restore = savedCwd
      ? `Set-Location -LiteralPath ${psQuote(savedCwd)} -ErrorAction SilentlyContinue; `
      : "";
    const readBack = `; Write-Output ""; Write-Output "${CWD_MARKER}$((Get-Location).Path)"`;
    const wrapped =
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; ${restore}${args.command}${readBack}`;

    // 后台模式：立即返回任务 id，输出通过 bash_output 轮询
    if (args.background) {
      const job = createBgJob(args.command, ctx.cwd);
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
        cwd: ctx.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      child.stdout.on("data", (chunk: Buffer) => appendOutput(job, chunk.toString("utf8"), false));
      child.stderr.on("data", (chunk: Buffer) => appendOutput(job, chunk.toString("utf8"), true));
      child.on("close", (code) => {
        job.done = true;
        job.code = code;
        // 回读最终目录
        const full = job.stdout;
        const markerIndex = full.lastIndexOf(CWD_MARKER);
        if (markerIndex !== -1) {
          const lineStart = full.lastIndexOf("\n", markerIndex - 1);
          const markerLine = full.slice(lineStart + 1).trim();
          const finalCwd = markerLine.slice(CWD_MARKER.length).trim();
          if (finalCwd) cwdMemory.set(ctx.cwd, finalCwd);
        }
      });
      child.on("error", () => {
        job.done = true;
      });
      // 定时清理：超时时强杀
      if (args.timeout) {
        setTimeout(() => {
          if (!job.done && child.pid) killTree(child.pid);
        }, timeoutMs);
      }
      return `后台任务已启动\nid: ${job.id}\ncommand: ${args.command}\n提示：用 bash_output 轮询输出，用 kill_shell 终止。`;
    }

    return await new Promise<string>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", wrapped],
        {
          cwd: ctx.cwd,
          windowsHide: true,
          // stdin 置 ignore:PS 5.1 命令结束后若 stdin pipe 仍开放会挂起不退出
          // (这是任务管理器残留 powershell/conhost 的根因之一)
          stdio: ["ignore", "pipe", "pipe"],
        },
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

        // 剥离目录回读 marker 行,并更新持久目录
        let output = stdout;
        const markerIndex = stdout.lastIndexOf(CWD_MARKER);
        if (markerIndex !== -1) {
          const lineStart = stdout.lastIndexOf("\n", markerIndex - 1);
          const markerLine = stdout.slice(lineStart + 1).trim();
          output = stdout.slice(0, lineStart > 0 ? lineStart : markerIndex).trimEnd();
          const finalCwd = markerLine.slice(CWD_MARKER.length).trim();
          if (finalCwd) cwdMemory.set(ctx.cwd, finalCwd);
        }

        const merged = `${output}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
        const result =
          `Exit code: ${code ?? "null"}\nWall time: ${wall}s\n\nOutput:\n${merged.trim()}`;
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
        // abort 也加强势收口:3s 内进程未退则强制 resolve,避免僵尸常驻
        setTimeout(() => finish(null), 3000);
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
