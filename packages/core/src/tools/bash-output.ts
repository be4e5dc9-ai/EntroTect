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
  description: "读取后台 bash 任务的当前输出。用于轮询 dev server、长任务日志。返回状态、退出码与尾部输出。",
  inputSchema,
  isReadOnly: true,
  preview: (args) => `output ${(args as Input).jobId}`,
  async call(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const job = getBgJob(args.jobId);
    if (!job) throw new Error(`未找到后台任务: ${args.jobId}`);
    const tail = args.tail ?? 12000;
    const stdoutTail = job.stdout.slice(-tail);
    const stderrTail = job.stderr.slice(-tail);
    const wall = ((Date.now() - job.startTime) / 1000).toFixed(1);
    const state = job.done ? `已结束 (exit ${job.code ?? "null"})` : "运行中";
    const elapsed = `已运行 ${wall}s`;
    const out = `${stdoutTail}${stderrTail ? `\n[stderr]\n${stderrTail}` : ""}`.trim() || "(暂无输出)";
    return `任务: ${job.id}\n命令: ${job.command}\n状态: ${state} · ${elapsed}\n\n输出（尾部 ${tail} 字符）：\n${out}`;
  },
};
