// =====================================================================
// Agent 主循环:while(true) 翻译器
// 设计依据:ClaudeCode/01 §7 最小循环五步语义。
// 铁律:
//   1. tool_result 必须与 tool_use 配对(中断/拒绝也合成回填);
//   2. 一切工具异常包成 is_error 回喂,让模型自纠;
//   3. 出口看 tool_use 数量,不看 stop_reason。
// =====================================================================

import type {
  AppEvent,
  ApprovalRequest,
  ContentBlock,
  Message,
  TokenUsage,
} from "@entrotect/shared";
import type { Provider } from "../provider/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { truncateOutput } from "../tools/output.js";
import { zodToJsonSchema } from "../tools/zod-json.js";
import type { ApprovalOutcome } from "../permission/gate.js";

export interface AgentDeps {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  maxTokens: number;
  temperature?: number;
  /** 思考强度(off = 不发送该参数) */
  reasoningEffort?: "off" | "low" | "medium" | "high";
  /** 事件汇:主循环对 UI/持久层的唯一输出通道 */
  emit: (event: AppEvent) => void;
  /** 审批回调:await 到用户决定(M3 实现真实闸门) */
  approve: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  cwd: string;
  artifactDir: string;
  /** 轮次上限,防无限循环烧钱(照抄 ClaudeCode maxTurns) */
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /**
   * 消息落盘钩子:历史每追加一条消息即回调(边跑边持久化,
   * 崩溃后可 resume;append-only,JSONL 层由宿主实现)。
   */
  onMessage?: (message: Message) => Promise<void> | void;
}

export interface AgentRunResult {
  messages: Message[];
  finalText: string | null;
  usage: TokenUsage | null;
  error: string | null;
  interrupted: boolean;
}

const DEFAULT_MAX_TURNS = 25;
const ABORT_RESULT = "[工具调用被取消] 用户中断了操作";

type ToolCallBlock = Extract<ContentBlock, { type: "tool-call" }>;

function previewFor(tool: Tool | undefined, call: ToolCallBlock): string {
  if (!tool) return call.name;
  try {
    return tool.preview(JSON.parse(call.arguments));
  } catch {
    return call.name;
  }
}

export async function runAgent(
  initialMessages: Message[],
  deps: AgentDeps,
): Promise<AgentRunResult> {
  const history: Message[] = [...initialMessages];
  const toolsByName = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  let lastUsage: TokenUsage | null = null;
  let lastText: string | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (deps.abortSignal?.aborted) {
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: "已中断",
        interrupted: true,
      };
    }

    deps.emit({ type: "turn-started" });

    // 1. 流式调模型,收集内容块
    const assistantBlocks: ContentBlock[] = [];
    let providerError: string | null = null;
    const stream = deps.provider.streamBlocks(
      history,
      {
        systemPrompt: deps.systemPrompt,
        tools: deps.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: zodToJsonSchema(tool.inputSchema),
        })),
        maxTokens: deps.maxTokens,
        temperature: deps.temperature,
        reasoningEffort: deps.reasoningEffort,
      },
      deps.abortSignal,
    );

    for await (const event of stream) {
      switch (event.type) {
        case "text-delta":
          deps.emit({ type: "assistant-delta", text: event.text });
          break;
        case "reasoning-delta":
          deps.emit({ type: "assistant-reasoning-delta", text: event.text });
          break;
        case "block":
          assistantBlocks.push(event.block);
          deps.emit({ type: "assistant-block", block: event.block });
          break;
        case "turn-complete":
          lastUsage = event.usage;
          break;
        case "error":
          providerError = event.message;
          break;
      }
    }

    // 中断处理:丢弃半截块(未追加历史,无配对义务),结束
    if (deps.abortSignal?.aborted) {
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: "已中断",
        interrupted: true,
      };
    }
    if (providerError) {
      deps.emit({ type: "error", message: providerError });
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: providerError,
        interrupted: false,
      };
    }

    // 2. 追加 assistant 消息(含本轮全部块)
    if (assistantBlocks.length === 0) {
      // 空响应防御:直接结束,不产生空消息
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: null,
        interrupted: false,
      };
    }
    const assistantMessage: Message = { role: "assistant", content: assistantBlocks };
    history.push(assistantMessage);
    deps.emit({ type: "message-appended", message: assistantMessage });
    await deps.onMessage?.(assistantMessage);

    const toolCalls = assistantBlocks.filter(
      (block): block is ToolCallBlock => block.type === "tool-call",
    );

    // 3. 出口 = tool_use 数量
    if (toolCalls.length === 0) {
      lastText = assistantBlocks
        .filter((block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text")
        .map((block) => block.text)
        .join("") || null;
      deps.emit({ type: "turn-completed", usage: lastUsage });
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: null,
        interrupted: false,
      };
    }

    // 4. 串行执行(v1 不做并行;权限闸门 = approve 回调)
    const results: ContentBlock[] = [];
    const toolContext: ToolContext = {
      cwd: deps.cwd,
      artifactDir: deps.artifactDir,
      abortSignal: deps.abortSignal,
    };

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.name);
      const preview = previewFor(tool, call);

      if (deps.abortSignal?.aborted) {
        results.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: ABORT_RESULT,
        });
        deps.emit({
          type: "tool-state",
          toolCallId: call.id,
          state: "denied",
          preview,
        });
        continue;
      }

      // fail-closed:未知工具报错回喂
      if (!tool) {
        results.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: `未知工具: ${call.name}`,
        });
        deps.emit({
          type: "tool-state",
          toolCallId: call.id,
          state: "failed",
          preview,
          summary: "未知工具",
        });
        continue;
      }

      // 审批闸门
      const outcome = await deps.approve({
        toolCallId: call.id,
        toolName: call.name,
        preview,
        description: tool.description,
      });
      if (outcome.decision === "deny") {
        const reason =
          outcome.reason ??
          "工具调用被用户拒绝。请改用其他方式完成任务,或向用户说明为什么需要此操作。";
        results.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: reason,
        });
        deps.emit({
          type: "tool-state",
          toolCallId: call.id,
          state: "denied",
          preview,
        });
        continue;
      }

      deps.emit({
        type: "tool-state",
        toolCallId: call.id,
        state: "executing",
        preview,
      });

      // 执行 + 截断 + 错误回喂
      try {
        const output = await tool.call(JSON.parse(call.arguments), toolContext);
        const truncated = await truncateOutput(output, deps.artifactDir);
        results.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: false,
          content: truncated.content,
        });
        deps.emit({
          type: "tool-state",
          toolCallId: call.id,
          state: "completed",
          preview,
          summary: truncated.spilledTo ?? undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: `<tool_use_error>${message}</tool_use_error>`,
        });
        deps.emit({
          type: "tool-state",
          toolCallId: call.id,
          state: "failed",
          preview,
          summary: message.slice(0, 200),
        });
      }
    }

    // 5. tool_result 回填(紧跟 tool_use,配对铁律)
    const toolResultMessage: Message = { role: "user", content: results };
    history.push(toolResultMessage);
    await deps.onMessage?.(toolResultMessage);
    deps.emit({ type: "turn-completed", usage: lastUsage });
  }

  // 轮次耗尽
  deps.emit({ type: "error", message: `达到轮次上限(${maxTurns}),已停止` });
  return {
    messages: history,
    finalText: lastText,
    usage: lastUsage,
    error: `达到轮次上限(${maxTurns})`,
    interrupted: false,
  };
}
