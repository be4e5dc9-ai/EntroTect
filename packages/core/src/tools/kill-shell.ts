// =====================================================================
// kill_shell:终止后台任务（对标 Claude Code KillShell / taskkill）
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { getBgJob, terminateBgJob } from "./bg-manager.js";

const inputSchema = z.strictObject({
  jobId: z.string().min(1).describe("后台任务 id"),
});

type Input = z.infer<typeof inputSchema>;

export const killShellTool: Tool = {
  name: "kill_shell",
  description: "终止后台 bash 任务（按任务 id 强杀进程树）。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => `kill ${(args as Input).jobId}`,
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const job = getBgJob(args.jobId, ctx.artifactDir);
    if (!job) throw new Error(`未找到后台任务: ${args.jobId}`);
    if (job.done) return `任务 ${job.id} 已结束（exit ${job.code ?? "null"}），无需终止。`;
    await terminateBgJob(job);
    return job.done
      ? `已终止任务 ${job.id}（${job.command}）`
      : `已发送终止信号到任务 ${job.id}，但尚未确认进程退出。`;
  },
};
