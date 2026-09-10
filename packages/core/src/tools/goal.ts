import { z } from "zod";
import type { Tool } from "./types.js";

const schema = z.strictObject({
  status: z.enum(["completed", "blocked"]),
  summary: z.string().trim().min(1).max(2000).describe("完成的验证证据，或继续推进所缺少的信息/授权"),
});

/** Bound to one accepted session; never share a global goal setter across runs. */
export function createGoalTool(update: (status: "completed" | "blocked", summary: string) => Promise<void>): Tool {
  return {
    name: "update_goal",
    description: "更新用户通过 /goal 设置的目标状态。仅在目标已实现且验证后标记 completed；确实需要用户输入或外部条件时标记 blocked。不能创建或改写目标。",
    inputSchema: schema,
    isReadOnly: true,
    preview: (args) => `目标状态：${(args as { status?: string })?.status ?? ""}`,
    async call(raw, ctx) {
      const args = schema.parse(raw);
      if (ctx.abortSignal?.aborted) throw new Error("操作已取消");
      await update(args.status, args.summary);
      return `目标已${args.status === "completed" ? "完成" : "标记为受阻"}：${args.summary}`;
    },
  };
}
