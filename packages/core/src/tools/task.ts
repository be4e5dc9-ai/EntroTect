// =====================================================================
// task:把独立子任务委派给子代理
// 设计依据:ClaudeCode/09 §1——AgentTool 就是递归调用同一个 query()。
// v1 深度固定 1 层:子代理工具池里没有 task(由 subagent/run.ts 过滤)。
// 运行器经 setTaskRunner 以模块级变量注入,避免改动 ToolContext。
// =====================================================================

import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import type { SubagentRunner } from "../subagent/run.js";

/** 模块级运行器(由 registry 注入;全局唯一,与主会话一一对应) */
let runner: SubagentRunner | null = null;

/** 注入/清除子代理运行器 */
export function setTaskRunner(r: SubagentRunner | null): void {
  runner = r;
}

const inputSchema = z.strictObject({
  prompt: z.string().describe("委派给子代理的任务描述,包含足够上下文"),
});

type Input = z.infer<typeof inputSchema>;

export const taskTool: Tool = {
  name: "task",
  description:
    "把一个边界清楚的子问题交给独立子代理。适合代码探索、方案复核、独立文件修改或验证；多个互不依赖的子问题可在同一轮并行调用。prompt 必须写清目标、范围、约束、是否允许修改以及期望回报。不要委派琐碎工作，也不要与子代理重复执行同一任务。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => {
    const prompt = (args as Input).prompt;
    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  },
  async call(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    if (runner === null) {
      throw new Error("子代理运行器未配置");
    }
    // 活动日志挂在任务卡片上(subagentLog),对话片段实时上报(subagentEmit)
    return runner(args.prompt, ctx.subagentLog, ctx.subagentEmit);
  },
};
