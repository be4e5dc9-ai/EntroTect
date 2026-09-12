// PowerShell command runner. Shell location belongs to an agent and foreground
// calls are serialized so a later command observes the preceding location.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ShellState, Tool, ToolContext } from "./types.js";
import { analyzeCommand } from "../sandbox/index.js";
import { appendOutput, createBgJob } from "./bg-manager.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_CAPTURE_CHARS = 300_000;
const fallbackStates = new WeakMap<ToolContext, ShellState>();

const inputSchema = z.strictObject({
  command: z.string().describe("要执行的 PowerShell 命令"),
  timeout: z.number().int().min(1).max(600).optional()
    .describe(`超时秒数(默认 ${DEFAULT_TIMEOUT_SECONDS},上限 600)`),
  background: z.boolean().optional()
    .describe("true 时后台运行（长任务/dev server），立即返回任务 id，用 bash_output 轮询；默认 false"),
});

type Input = z.infer<typeof inputSchema>;

function stateFor(ctx: ToolContext): ShellState {
  if (ctx.shellState) return ctx.shellState;
  let state = fallbackStates.get(ctx);
  if (!state) fallbackStates.set(ctx, state = {});
  return state;
}

async function withShellLock<T>(state: ShellState, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const previous = state.pending ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  state.pending = current;
  await previous;
  try {
    signal?.throwIfAborted();
    return await run();
  } finally {
    release();
    if (state.pending === current) state.pending = undefined;
  }
}

function killTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function wrappedCommand(command: string, cwd: string | undefined, marker?: string): string {
  const restore = cwd ? `Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction SilentlyContinue` : "";
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8",
    "$OutputEncoding = [Text.UTF8Encoding]::UTF8",
    "$PSDefaultParameterValues['*:Encoding'] = 'UTF8'",
    restore,
    "$global:LASTEXITCODE = $null",
    "$global:__etro_first_failure = 0",
    `$__etro_source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$__etro_tokens = $null",
    "$__etro_parse_errors = $null",
    "$__etro_ast = [System.Management.Automation.Language.Parser]::ParseInput($__etro_source, [ref]$__etro_tokens, [ref]$__etro_parse_errors)",
    "if ($__etro_parse_errors.Count -gt 0) { throw $__etro_parse_errors[0].Message }",
    "$__etro_code = $__etro_source",
    "if (-not $__etro_source.Contains('$?')) {",
    "  $__etro_guard = [Environment]::NewLine + 'if ($global:LASTEXITCODE -is [int] -and $global:LASTEXITCODE -ne 0 -and $global:__etro_first_failure -eq 0) { $global:__etro_first_failure = $global:LASTEXITCODE }' + [Environment]::NewLine",
    "  $__etro_blocks = $__etro_ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.StatementBlockAst] -or $node -is [System.Management.Automation.Language.NamedBlockAst] }, $true)",
    "  $__etro_offsets = @($__etro_blocks | ForEach-Object { $_.Statements | ForEach-Object { $_.Extent.EndOffset } } | Sort-Object -Unique -Descending)",
    "  foreach ($__etro_offset in $__etro_offsets) {",
    "    $__etro_code = $__etro_code.Insert($__etro_offset, $__etro_guard)",
    "  }",
    "}",
    "try {",
    "  & ([ScriptBlock]::Create($__etro_code))",
    "  $__etro_ok = $?",
    "  $__etro_native = $global:LASTEXITCODE",
    "  $__etro_exit = if ($global:__etro_first_failure -ne 0) { $global:__etro_first_failure } elseif ($__etro_native -is [int] -and $__etro_native -ne 0) { $__etro_native } elseif (-not $__etro_ok) { 1 } else { 0 }",
    "} finally {",
    ...(marker ? ["  Write-Output ''", `  Write-Output "${marker}$((Get-Location).Path)"`] : []),
    "}",
    "if ($__etro_exit -ne 0) { exit $__etro_exit }",
  ].filter(Boolean).join("\n");
}

function appendCapture(current: string, chunk: string): { text: string; dropped: number } {
  const combined = current + chunk;
  const dropped = Math.max(0, combined.length - MAX_CAPTURE_CHARS);
  return { text: dropped ? combined.slice(-MAX_CAPTURE_CHARS) : combined, dropped };
}

function stripCwdMarker(output: string, marker: string): { output: string; cwd?: string } {
  const index = output.lastIndexOf(marker);
  if (index < 0) return { output: output.trimEnd() };
  const lineStart = output.lastIndexOf("\n", index - 1);
  const lineEnd = output.indexOf("\n", index);
  const markerLine = output.slice(index, lineEnd < 0 ? undefined : lineEnd).trim();
  const cwd = markerLine.slice(marker.length).trim();
  return {
    output: output.slice(0, lineStart < 0 ? index : lineStart).trimEnd(),
    ...(cwd ? { cwd } : {}),
  };
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在当前工作目录执行 PowerShell 命令；目录在当前代理的后续调用中持久。" +
    "非零退出码或 PowerShell 错误会返回工具失败；多条命令需要时请显式检查每步结果。" +
    "后台长任务用 background=true 启动、bash_output 轮询、kill_shell 终止。" +
    "优先用只读命令探查环境；涉及破坏性操作前先说明并等待确认。" +
    "绝不用于硬约束所列行为（大规模杀伤、关键基础设施攻击、重大恶意代码/网络武器、非法权力攫取、CSAM等），遇到此类请求应拒绝。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => (args as Input).command,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    if (ctx.sandboxMode === "restricted") {
      const verdict = analyzeCommand(args.command);
      if (verdict.blocked) {
        throw new Error(`[沙箱] 已拦截危险命令(${verdict.reason})。如确需执行,请切换权限模式为"完全访问权限"后重试。`);
      }
    }

    const state = stateFor(ctx);
    return withShellLock(state, ctx.abortSignal, async () => {
      const timeoutMs = (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      const marker = args.background ? undefined : `__ENTROTECT_CWD_${randomUUID().replace(/-/g, "")}__:`;
      const wrapped = wrappedCommand(args.command, state.cwd, marker);
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
        cwd: ctx.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (args.background) {
        const job = createBgJob(args.command, state.cwd ?? ctx.cwd, ctx.artifactDir);
        job.child = child;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => appendOutput(job, chunk, false));
        child.stderr.on("data", (chunk: string) => appendOutput(job, chunk, true));
        const timer = args.timeout ? setTimeout(() => {
          if (job.done) return;
          job.reason = "timeout";
          if (child.pid) killTree(child.pid);
        }, timeoutMs) : undefined;
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          job.done = true;
          job.endedAt = Date.now();
          job.code = code;
          job.reason ??= job.killed ? "killed" : code === 0 ? "completed" : "failed";
          // Background jobs have their own process lifetime and do not change
          // the foreground agent's working directory after returning.
        });
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          job.done = true;
          job.endedAt = Date.now();
          job.reason = "spawn_error";
          appendOutput(job, error.message, true);
        });
        return `后台任务已启动\nid: ${job.id}\ncommand: ${args.command}\n提示：用 bash_output 轮询输出，用 kill_shell 终止。`;
      }

      return await new Promise<string>((resolve, reject) => {
        const startedAt = Date.now();
        let stdout = "";
        let stderr = "";
        let stdoutDropped = 0;
        let stderrDropped = 0;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let fallback: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
          fallback = setTimeout(() => finish(null), 3000);
        }, timeoutMs);
        const onAbort = () => {
          aborted = true;
          if (child.pid) killTree(child.pid);
          fallback = setTimeout(() => finish(null), 3000);
        };
        const finish = (code: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (fallback) clearTimeout(fallback);
          ctx.abortSignal?.removeEventListener("abort", onAbort);
          const visible = stripCwdMarker(stdout, marker!);
          if (visible.cwd) state.cwd = visible.cwd;
          const wall = ((Date.now() - startedAt) / 1000).toFixed(2);
          const output = `${stdoutDropped ? `[stdout 前部已省略 ${stdoutDropped} 字符]\n` : ""}${visible.output}`;
          const errorOutput = `${stderrDropped ? `[stderr 前部已省略 ${stderrDropped} 字符]\n` : ""}${stderr}`;
          const merged = `${output}${errorOutput ? `\n[stderr]\n${errorOutput}` : ""}`;
          const result = `Exit code: ${code ?? "null"}\nWall time: ${wall}s\n\nOutput:\n${merged.trim()}`;
          if (timedOut) reject(new Error(`命令超时(${args.timeout ?? DEFAULT_TIMEOUT_SECONDS}s),进程树已强杀。已捕获输出:\n${result}`));
          else if (aborted) reject(new Error(`命令已取消。已捕获输出:\n${result}`));
          else if (code !== 0) reject(new Error(`命令失败。${result}`));
          else resolve(result);
        };
        ctx.abortSignal?.addEventListener("abort", onAbort);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          const next = appendCapture(stdout, chunk);
          stdout = next.text;
          stdoutDropped += next.dropped;
        });
        child.stderr.on("data", (chunk: string) => {
          const next = appendCapture(stderr, chunk);
          stderr = next.text;
          stderrDropped += next.dropped;
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (fallback) clearTimeout(fallback);
          ctx.abortSignal?.removeEventListener("abort", onAbort);
          reject(new Error(`无法启动 PowerShell: ${error.message}`));
        });
        child.on("close", finish);
      });
    });
  },
};
