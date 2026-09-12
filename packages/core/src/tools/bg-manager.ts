// =====================================================================
// 后台任务管理器：供 bash --background 及相关工具共享
// =====================================================================

import { spawn } from "node:child_process";

export interface BgJob {
  id: string;
  owner: string;
  command: string;
  cwd: string;
  startTime: number;
  endedAt?: number;
  reason?: "completed" | "failed" | "timeout" | "killed" | "spawn_error";
  stdout: string;
  stderr: string;
  child: ReturnType<typeof spawn> | null;
  code: number | null;
  done: boolean;
  killed: boolean;
}

const jobs = new Map<string, BgJob>();
let seq = 0;
const MAX_FINISHED_JOBS = 100;

function pruneFinishedJobs(): void {
  const finished = [...jobs.values()].filter((job) => job.done);
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
    jobs.delete(job.id);
  }
}

export function createBgJob(command: string, cwd: string, owner: string): BgJob {
  pruneFinishedJobs();
  const id = `bg_${Date.now()}_${++seq}`;
  const job: BgJob = { id, owner, command, cwd, startTime: Date.now(), stdout: "", stderr: "", child: null, code: null, done: false, killed: false };
  jobs.set(id, job);
  return job;
}

export function getBgJob(id: string, owner: string): BgJob | undefined {
  const job = jobs.get(id);
  return job?.owner === owner ? job : undefined;
}

export function listBgJobs(owner: string): BgJob[] {
  return [...jobs.values()].filter((job) => job.owner === owner);
}

export async function terminateBgJob(job: BgJob): Promise<void> {
  if (job.done) return;
  job.killed = true;
  job.reason = "killed";
  const child = job.child;
  if (!child?.pid) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    killer.once("error", () => { child.kill(); });
    killer.once("close", (code) => { if (code !== 0 && !job.done) child.kill(); });
  });
}

export async function stopBgJobsForOwner(owner: string): Promise<void> {
  const owned = listBgJobs(owner);
  await Promise.all(owned.map((job) => terminateBgJob(job)));
  for (const job of owned) if (job.done) jobs.delete(job.id);
  const stillRunning = owned.filter((job) => !job.done);
  if (stillRunning.length) {
    throw new Error(`后台任务尚未确认终止: ${stillRunning.map((job) => job.id).join(", ")}`);
  }
}

export async function stopAllBgJobs(): Promise<void> {
  const all = [...jobs.values()];
  await Promise.all(all.map((job) => terminateBgJob(job)));
  jobs.clear();
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
