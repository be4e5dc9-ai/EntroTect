// =====================================================================
// bash_output:轮询后台任务输出（对标 Claude Code BashOutput）
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { getBgJob } from "./bg-manager.js";

const inputSchema = z.strictObject({
  jobId: z.string().min(1).describe("后台任务 id（bash background 返回的 id）"),
  tail: z.number().int().min(100).max(50000).optional().describe("返回尾部字符数(默认 12000)"),
});

type Input = z.infer<typeof inputSchema>;

export const bashOutputTool: Tool = {
  name: "bash_output",
  description: "读取后台 bash 任务的状态快照、退出码与尾部日志（非增量）。同批调用会等其他工具结束后采样；结果仅代表采样时刻，需要最新状态时再次查询。",
  inputSchema,
  isReadOnly: true,
  isConcurrencySafe: true,
  afterBatch: true,
  preview: (args) => `output ${(args as Input).jobId}`,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const job = getBgJob(args.jobId, ctx.artifactDir);
    if (!job) throw new Error(`未找到后台任务: ${args.jobId}`);
    const tail = args.tail ?? 12000;
    const stdoutTail = job.stdout.slice(-tail);
    const stderrTail = job.stderr.slice(-tail);
    const sampledAt = Date.now();
    const wall = (((job.endedAt ?? sampledAt) - job.startTime) / 1000).toFixed(1);
    const state = job.reason === "timeout" ? job.done ? `已超时 (exit ${job.code ?? "null"})` : "超时，正在终止"
      : job.reason === "killed" ? job.done ? `已终止 (exit ${job.code ?? "null"})` : "正在终止"
      : job.reason === "spawn_error" ? "启动失败"
      : job.done ? `已结束 (exit ${job.code ?? "null"})` : "运行中";
    const elapsed = job.done ? `总运行 ${wall}s` : `采样时已运行 ${wall}s`;
    const out = `${stdoutTail}${stderrTail ? `\n[stderr]\n${stderrTail}` : ""}`.trim() || "(暂无输出)";
    return `任务: ${job.id}\n命令: ${job.command}\n采样时间: ${new Date(sampledAt).toISOString()}\n状态: ${state} · ${elapsed}\n\n输出（尾部 ${tail} 字符，非增量快照）：\n${out}`;
  },
};
