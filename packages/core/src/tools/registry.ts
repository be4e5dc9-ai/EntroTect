// =====================================================================
// 内置工具注册表
// 设计依据:ClaudeCode/03 §2——built-in 工具保持连续前缀,稳定
// prompt cache 断点;被 deny 的工具不进池(v1.1 规则过滤)。
// =====================================================================

import type { Tool } from "./types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { taskTool, setTaskRunner } from "./task.js";
import type { SubagentRunner } from "../subagent/run.js";

export interface BuildBuiltinToolsOptions {
  /** 注入子代理运行器后,追加 task 工具到列表末尾 */
  taskRunner?: SubagentRunner;
}

export function buildBuiltinTools(options?: BuildBuiltinToolsOptions): Tool[] {
  if (options?.taskRunner) {
    setTaskRunner(options.taskRunner);
    return [readTool, writeTool, editTool, globTool, grepTool, bashTool, taskTool];
  }
  // 无参调用:清掉陈旧 runner,防止上一会话的运行器泄漏
  setTaskRunner(null);
  return [readTool, writeTool, editTool, globTool, grepTool, bashTool];
}
