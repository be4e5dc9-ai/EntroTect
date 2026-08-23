// =====================================================================
// Tool 接口(最小集)与执行上下文
// 设计依据:ClaudeCode/03 §6 启示 1——name + inputSchema + call + 描述
// 即最小集;fail-closed 三默认在权限层实现(M3)。
// =====================================================================

import type { z } from "zod";
import type { SubagentPart } from "@entrotect/shared";

/** 工具执行上下文:由主循环注入 */
export interface ToolContext {
  /** 会话工作目录(所有相对路径的基准) */
  cwd: string;
  /** 输出截断落盘目录 */
  artifactDir: string;
  abortSignal?: AbortSignal;
  /** 子代理活动日志通道:task 工具内部活动以行进日志(挂在对应工具卡片) */
  subagentLog?: (line: string) => void;
  /** 子代理对话页通道:内部事件翻译成 part 实时上报(task 工具专用) */
  subagentEmit?: (part: SubagentPart) => void;
}

export interface Tool {
  name: string;
  /** 模型可见描述(写给模型看,等价微型文档) */
  description: string;
  /** 参数 schema 唯一事实来源 */
  inputSchema: z.ZodType;
  /** 只读工具免审批(M3 权限闸门按此分流) */
  isReadOnly: boolean;
  /** 审批 UI 的一行预览(命令文本/路径) */
  preview(args: unknown): string;
  /** 执行并返回模型可见的结果文本;抛错由主循环包成 is_error */
  call(args: unknown, ctx: ToolContext): Promise<string>;
}
