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

export function buildBuiltinTools(): Tool[] {
  return [readTool, writeTool, editTool, globTool, grepTool, bashTool];
}
