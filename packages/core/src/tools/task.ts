// =====================================================================
// task:把独立子任务委派给子代理
// 设计依据:ClaudeCode/09 §1——AgentTool 就是递归调用同一个 query()。
// v1 深度固定 1 层:子代理工具池里没有 task(由 subagent/run.ts 过滤)。
// 运行器经 setTaskRunner 以模块级变量注入,避免改动 ToolContext。
// =====================================================================

import { z } from "zod";
import type { Tool } from "./types.js";
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
    "把独立子任务委派给子代理执行,适合互不依赖的独立工作,例如调研某段代码、独立文件的修改。一次只委派一个任务,在 prompt 里写清目标与必要上下文;子代理完成后会返回一段汇报文本。",
  inputSchema,
  isReadOnly: false,
  preview: (args) => {
    const prompt = (args as Input).prompt;
    return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  },
  async call(rawArgs: unknown): Promise<string> {
    const args = inputSchema.parse(rawArgs);
    if (runner === null) {
      throw new Error("子代理运行器未配置");
    }
    return runner(args.prompt);
  },
};
