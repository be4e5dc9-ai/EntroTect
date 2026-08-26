// =====================================================================
// kill_shell:终止后台任务（对标 Claude Code KillShell / taskkill）
// =====================================================================

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import { getBgJob } from "./bg-manager.js";

const inputSchema = z.strictObject({
  jobId: z.string().min(1).describe("后台任务 id"),
});

type Input = z.infer<typeof inputSchema>;

function killTree(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
}

export const killShellTool: Tool = {
  name: "kill_shell",
  description: "终止后台 bash 任务（按任务 id 强杀进程树）。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => `kill ${(args as Input).jobId}`,
  async call(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    const job = getBgJob(args.jobId);
    if (!job) throw new Error(`未找到后台任务: ${args.jobId}`);
    if (job.done) return `任务 ${job.id} 已结束（exit ${job.code ?? "null"}），无需终止。`;
    if (job.child?.pid) killTree(job.child.pid);
    job.killed = true;
    // 给 3s 宽限
    await new Promise((r) => setTimeout(r, 800));
    if (!job.done && job.child?.pid) {
      try {
        killTree(job.child.pid);
      } catch {}
    }
    return `已发送终止信号到任务 ${job.id}（${job.command}）`;
  },
};
