// =====================================================================
// task:把独立子任务委派给子代理
// 设计依据:ClaudeCode/09 §1——AgentTool 就是递归调用同一个 query()。
// v1 深度固定 1 层:子代理工具池里没有 task(由 subagent/run.ts 过滤)。
// 正式工具通过工厂绑定当前 run，避免不同会话覆盖彼此的运行器。
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import type { SubagentRunner } from "../subagent/run.js";

/** 仅保留给旧调用方的模块级运行器；正式会话使用 createTaskTool。 */
let runner: SubagentRunner | null = null;

/** 注入/清除子代理运行器 */
export function setTaskRunner(r: SubagentRunner | null): void {
  runner = r;
}

const inputSchema = z.strictObject({
  prompt: z.string().trim().min(1).describe("委派给子代理的任务描述,包含足够上下文"),
});

type Input = z.infer<typeof inputSchema>;

export function createTaskTool(taskRunner: SubagentRunner): Tool {
  return {
    name: "task",
    description:
      "把一个边界清楚的子问题交给独立子代理。适合网页/论文调研、产品和开源项目比较、代码探索、方案复核、独立修改或验证；多个互不依赖的子问题可在同一轮并行调用。本工具会等待子代理完成并直接返回回报，无需另外查询或等待消息；工具错误表示未完成，不能当作成功结果。prompt 必须写清目标、范围、已有上下文、是否允许修改以及期望的证据和回报。不要委派琐碎工作，也不要与子代理重复执行同一任务。",
    inputSchema,
    isReadOnly: false,
    isConcurrencySafe: true,
    concurrencyGroup: "delegates",
    preview: (args) => {
      const prompt = (args as Input).prompt;
      return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
    },
    async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
      const args = inputSchema.parse(rawArgs);
      return taskRunner(args.prompt, ctx.subagentLog, ctx.subagentEmit);
    },
  };
}

/** Legacy injection API; registry-created tools do not depend on this global. */
export const taskTool = createTaskTool((...args) => {
  if (!runner) throw new Error("子代理运行器未配置");
  return runner(...args);
});
