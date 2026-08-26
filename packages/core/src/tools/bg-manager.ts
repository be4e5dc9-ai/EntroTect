// =====================================================================
// 后台任务管理器：供 bash --background 及相关工具共享
// =====================================================================

import { spawn } from "node:child_process";

export interface BgJob {
  id: string;
  command: string;
  cwd: string;
  startTime: number;
  stdout: string;
  stderr: string;
  child: ReturnType<typeof spawn> | null;
  code: number | null;
  done: boolean;
  killed: boolean;
}

const jobs = new Map<string, BgJob>();
let seq = 0;

export function createBgJob(command: string, cwd: string): BgJob {
  const id = `bg_${Date.now()}_${++seq}`;
  const job: BgJob = { id, command, cwd, startTime: Date.now(), stdout: "", stderr: "", child: null, code: null, done: false, killed: false };
  jobs.set(id, job);
  return job;
}

export function getBgJob(id: string): BgJob | undefined {
  return jobs.get(id);
}

export function listBgJobs(): BgJob[] {
  return [...jobs.values()];
}

export function appendOutput(job: BgJob, chunk: string, isErr: boolean): void {
  if (isErr) {
    job.stderr += chunk;
    if (job.stderr.length > 300_000) job.stderr = job.stderr.slice(-300_000);
  } else {
    job.stdout += chunk;
    if (job.stdout.length > 300_000) job.stdout = job.stdout.slice(-300_000);
  }
}
