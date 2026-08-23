// =====================================================================
// 子代理:递归复用主循环 runAgent 的最小封装
// 设计依据:ClaudeCode/09 §1——子代理不是新循环,而是过滤工具池后的
// 又一次 runAgent 调用,复用主循环全部能力(审批、截断、事件、轮次)。
// v1 深度固定 1 层:子代理工具池里没有 task,防无限递归派生。
// =====================================================================

import type { AppEvent, ApprovalRequest, Message } from "@entrotect/shared";
import type { Provider } from "../provider/types.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalOutcome } from "../permission/gate.js";
import { runAgent } from "../loop/agent.js";

/** 子代理运行器:入参任务描述,返回最终答复文本;异常抛给主循环包成 is_error */
export type SubagentRunner = (prompt: string) => Promise<string>;

export interface SubagentRunnerDeps {
  provider: Provider;
  /** 父级工具池(工厂内自动过滤 task,防递归) */
  tools: Tool[];
  /** 父级系统提示词(子代理 persona 追加其后) */
  systemPrompt: string;
  /** 审批回调:透传父级,审批仍然弹给用户 */
  approve: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  /** 事件汇:透传父级,子代理的工具卡片照常上屏 */
  emit: (event: AppEvent) => void;
  cwd: string;
  artifactDir: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "off" | "low" | "high" | "xhigh" | "max";
  abortSignal?: AbortSignal;
}

/** 子代理 persona:只干活、不追问、一段话汇报 */
const SUBAGENT_SYSTEM_PROMPT =
  "你是 EntroTect 的子代理。专注完成主代理委派的子任务,只做必要的文件读取与修改,完成后用一段话简明汇报结果与关键发现,不要追问。";

/** 子代理轮次上限(v1 固定,防子任务无限烧钱) */
const SUBAGENT_MAX_TURNS = 12;
/** 子代理单轮 token 上限(未显式传入时的默认值) */
const SUBAGENT_MAX_TOKENS = 2048;

/**
 * 创建子代理运行器。每次调用 runner 都递归跑一轮 runAgent:
 * 独立历史(只有任务 prompt)、过滤后的工具池、固定轮次上限。
 */
export function createSubagentRunner(deps: SubagentRunnerDeps): SubagentRunner {
  // 过滤工具池:去掉 task 自身,子代理不能再派生子代理(v1 深度 1 层)
  const tools = deps.tools.filter((tool) => tool.name !== "task");
  // 父提示词提供环境上下文,persona 追加在后(后文角色约束优先级更高)
  const systemPrompt = `${deps.systemPrompt}\n\n${SUBAGENT_SYSTEM_PROMPT}`;

  return async (prompt: string): Promise<string> => {
    const initialMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];

    const result = await runAgent(initialMessages, {
      provider: deps.provider,
      tools,
      systemPrompt,
      maxTokens: deps.maxTokens ?? SUBAGENT_MAX_TOKENS,
      temperature: deps.temperature,
      reasoningEffort: deps.reasoningEffort,
      maxTurns: SUBAGENT_MAX_TURNS,
      abortSignal: deps.abortSignal,
      emit: deps.emit,
      approve: deps.approve,
      cwd: deps.cwd,
      artifactDir: deps.artifactDir,
    });

    return result.finalText ?? result.error ?? "(子代理无输出)";
  };
}
