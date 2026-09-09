// =====================================================================
// todowrite:任务清单计划板（对标 opencode TodoWrite / Codex update_plan）
// 整表快照 last-write-wins，由输入区上方的独立 TodoDock 渲染。
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
    "维护当前任务的结构化计划（整表快照）。仅在工作包含至少 3 个独立步骤、多个工作流，或用户明确要求计划时使用；单一修改、普通问答和少量工具调用不要使用。保持 3–7 个以结果为导向的条目，同时最多一个 in_progress，完成验证后再标 completed。界面会在对话外独立展示计划，无需在回复中重复。",
  inputSchema,
  // 只改会话内计划状态，不读写用户文件，无需弹出写入审批。
  isReadOnly: true,
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
    const settled = args.todos.filter(
      (todo) => todo.status === "completed" || todo.status === "cancelled",
    ).length;
    const active = args.todos.find((todo) => todo.status === "in_progress")?.content;
    return `计划已同步：${settled}/${args.todos.length} 已处理${active ? `，当前：${active}` : ""}。`;
  },
};
