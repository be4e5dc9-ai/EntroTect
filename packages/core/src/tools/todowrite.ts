// =====================================================================
// todowrite:任务清单计划板（对标 opencode TodoWrite / Codex update_plan）
// 整表快照 last-write-wins，渲染到 ToolCard 的 Plan 视图
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";

const todoSchema = z.object({
  content: z.string().min(1).describe("1 句任务描述（5-7 词为佳）"),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("pending=待办, in_progress=进行中(同时仅一个), completed=完成, cancelled=取消"),
  priority: z.enum(["high", "medium", "low"]).describe("优先级"),
});

const inputSchema = z.strictObject({
  todos: z.array(todoSchema).min(1).max(20).describe("整份待办清单快照（按执行顺序）"),
});

type Input = z.infer<typeof inputSchema>;

// 会话级内存：以 cwd 为 key，跨轮次持久（直到进程重启；持久化由 JSONL 历史兜底）
const store = new Map<string, z.infer<typeof todoSchema>[]>();

export function getTodos(cwd: string): z.infer<typeof todoSchema>[] {
  return store.get(cwd) ?? [];
}

export const todowriteTool: Tool = {
  name: "todowrite",
  description:
    "维护任务清单计划板（整表快照）。用于拆解复杂/多阶段任务为 3-7 步可见计划：首次调用写入 pending 列表；每完成一步再次调用将对应项标 completed、下一步标 in_progress（同时仅一个 in_progress）。替代口头复述计划，UI 会直接渲染清单。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => {
    const { todos } = args as Input;
    const doing = todos.find((t) => t.status === "in_progress")?.content ?? todos[0]?.content ?? "";
    const done = todos.filter((t) => t.status === "completed").length;
    return `计划 ${done}/${todos.length} · ${doing}`;
  },
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    // 校验：同时仅一个 in_progress
    const inProgress = args.todos.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) throw new Error("同时只能有一个 in_progress 任务，请将其他标为 pending/completed");
    store.set(ctx.cwd, args.todos);
    const lines = args.todos
      .map((t, i) => {
        const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : t.status === "cancelled" ? "✗" : "○";
        const prio = t.priority === "high" ? "!" : t.priority === "low" ? "·" : " ";
        return `${i + 1}. [${icon}]${prio} ${t.content} (${t.status})`;
      })
      .join("\n");
    return `计划已更新（${args.todos.length} 项）：\n${lines}`;
  },
};
