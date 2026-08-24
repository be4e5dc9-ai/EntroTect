// =====================================================================
// 子代理:递归复用主循环 runAgent 的最小封装
// 设计依据:ClaudeCode/09 §1——子代理不是新循环,而是过滤工具池后的
// 又一次 runAgent 调用,复用主循环全部能力(审批、截断、事件、轮次)。
// v1 深度固定 1 层:子代理工具池里没有 task,防无限递归派生。
//
// 展示规约(v0.2.1):内部事件不进入主对话流——工具执行被折叠成
// "活动日志行"经 log 回调挂在对应 task 工具卡片上;
// 审批仍透传父级(弹用户),最终答复作为 tool-result 回喂。
// =====================================================================

import type {
  AppEvent,
  ApprovalRequest,
  Message,
  SubagentPart,
} from "@entrotect/shared";
import type { Provider } from "../provider/types.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalOutcome } from "../permission/gate.js";
import { runAgent } from "../loop/agent.js";
import type { SandboxMode } from "../sandbox/policy.js";

type LogLine = (line: string) => void;

/**
 * 子代理运行器:入参任务描述,返回最终答复文本;异常抛给主循环包成 is_error。
 * log = 活动日志行通道(任务卡片);emitPart = 对话页片段通道(右侧详情栏)。
 */
export type SubagentRunner = (
  prompt: string,
  log?: LogLine,
  emitPart?: (part: SubagentPart) => void,
) => Promise<string>;

export interface SubagentRunnerDeps {
  provider: Provider;
  /** 父级工具池(工厂内自动过滤 task,防递归) */
  tools: Tool[];
  /** 父级系统提示词(子代理 persona 追加其后) */
  systemPrompt: string;
  /** 审批回调:透传父级,审批仍然弹给用户 */
  approve: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  cwd: string;
  artifactDir: string;
  /** 沿父级传入的沙箱模式 */
  sandboxMode?: SandboxMode;
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

/** 内部事件 → 活动日志行(只挑"可读步进",丢弃文本增量) */
function logForEvent(event: AppEvent): string | null {
  if (event.type !== "tool-state") return null;
  const symbol =
    event.state === "completed" ? "✓"
    : event.state === "failed" ? "✗"
    : event.state === "denied" ? "⊘"
    : "⚡";
  return `${symbol} ${event.preview}`;
}

/** 内部事件 → 对话页片段(只翻译对话语义;error 等不进入) */
function partForEvent(event: AppEvent): SubagentPart | null {
  switch (event.type) {
    case "turn-started":
      return { kind: "turn-start" };
    case "assistant-delta":
      return { kind: "delta", text: event.text };
    case "assistant-block":
      return { kind: "block", block: event.block };
    case "turn-completed":
      return { kind: "turn-end" };
    case "tool-state":
      return {
        kind: "tool-state",
        toolCallId: event.toolCallId,
        state: event.state,
        preview: event.preview,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
    default:
      return null;
  }
}

/**
 * 创建子代理运行器。每次调用 runner 都递归跑一轮 runAgent:
 * 独立历史(只有任务 prompt)、过滤后的工具池、固定轮次上限。
 * 内部事件被折叠成活动日志经 log(即工具卡片的 subagentLog)上报,
 * 同时翻译成 part 经 emitPart 实时流给右侧详情栏对话页。
 */
export function createSubagentRunner(deps: SubagentRunnerDeps): SubagentRunner {
  // 过滤工具池:去掉 task 自身,子代理不能再派生子代理(v1 深度 1 层)
  const tools = deps.tools.filter((tool) => tool.name !== "task");
  // 父提示词提供环境上下文,persona 追加在后(后文角色约束优先级更高)
  const systemPrompt = `${deps.systemPrompt}\n\n${SUBAGENT_SYSTEM_PROMPT}`;

  return async (
    prompt: string,
    log?: LogLine,
    emitPart?: (part: SubagentPart) => void,
  ): Promise<string> => {
    const initialMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];

    // 内部事件在此收口:可读步进换成日志行;对话语义翻译成 part;
    // 其余(文本增量原样/回合事件)要么进 part 要么丢弃,不入主对话
    const emitInner = (event: AppEvent) => {
      const line = logForEvent(event);
      if (line) log?.(line);
      const part = partForEvent(event);
      if (part) emitPart?.(part);
    };

    log?.("子代理启动");
    const result = await runAgent(initialMessages, {
      provider: deps.provider,
      tools,
      systemPrompt,
      maxTokens: deps.maxTokens ?? SUBAGENT_MAX_TOKENS,
      temperature: deps.temperature,
      reasoningEffort: deps.reasoningEffort,
      maxTurns: SUBAGENT_MAX_TURNS,
      abortSignal: deps.abortSignal,
      emit: emitInner,
      approve: deps.approve,
      cwd: deps.cwd,
      artifactDir: deps.artifactDir,
      sandboxMode: deps.sandboxMode,
    });
    log?.("子代理完成");

    return result.finalText ?? result.error ?? "(子代理无输出)";
  };
}
