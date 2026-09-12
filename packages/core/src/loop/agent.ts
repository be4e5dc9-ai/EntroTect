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
  ReasoningEffort,
  SubagentPart,
  TokenUsage,
} from "@entrotect/shared";
import path from "node:path";
import type { Provider } from "../provider/types.js";
import type { Tool, ToolContext } from "../tools/types.js";
import { truncateOutput } from "../tools/output.js";
import { zodToJsonSchema } from "../tools/zod-json.js";
import type { ApprovalOutcome } from "../permission/gate.js";
import type { PluginHooks } from "../plugins/types.js";
import { applyToolBefore, notifyToolAfter } from "../plugins/manager.js";
import type { SandboxMode } from "../sandbox/policy.js";
import { ULTRA_DISPATCH_PROMPT, ultraDirectTool } from "./ultra.js";
import type { FileStates } from "../tools/file-state.js";

export interface AgentDeps {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** 思考强度(off = 不发送该参数) */
  reasoningEffort?: ReasoningEffort;
  /** Ultra coordination belongs to the parent run, not to provider reasoning parameters. */
  orchestration?: "ultra";
  /** 事件汇:主循环对 UI/持久层的唯一输出通道 */
  emit: (event: AppEvent) => void;
  /** 审批回调:await 到用户决定(M3 实现真实闸门) */
  approve: (request: ApprovalRequest) => Promise<ApprovalOutcome>;
  cwd: string;
  artifactDir: string;
  /** 受保护路径(应用自身数据目录):注入工具上下文,文件工具拒绝对其读写 */
  protectedPaths?: readonly string[];
  /** 工具运行时的沙箱模式或动态 getter;旧调用方缺省时按完全访问处理 */
  sandboxMode?: SandboxMode | (() => SandboxMode);
  /** 图片生成供应商(随 activeProvider 注入) */
  imageProvider?: { baseUrl: string; apiKey: string; model?: string; apiFormat?: string };
  /** @deprecated 保留向后兼容,实际不再使用 */
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /** Optional continuation state; independent agents must use separate maps. */
  fileStates?: FileStates;
  /**
   * 消息落盘钩子:历史每追加一条消息即回调(边跑边持久化,
   * 崩溃后可 resume;append-only,JSONL 层由宿主实现)。
   */
  onMessage?: (message: Message) => Promise<void> | void;
  /** 插件 hooks(宿主注入):chat.message 改写 / tool.execute 换参与观察 */
  plugins?: PluginHooks[];
}

export interface AgentRunResult {
  messages: Message[];
  finalText: string | null;
  usage: TokenUsage | null;
  error: string | null;
  interrupted: boolean;
  /** Terminal provider reason, retained so a child cannot mistake truncation for completion. */
  finishReason?: string | null;
}

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

/** 用改写后的实参重算审批预览;write/edit/generate_image 显示解析后的绝对路径 */
function previewForArgs(tool: Tool | undefined, args: unknown, cwd: string): string {
  if (!tool) return "";
  let text = "";
  try {
    text = tool.preview(args);
  } catch {
    return "";
  }
  if (tool.name === "write" || tool.name === "edit" || tool.name === "generate_image") {
    const filePath = (args as { file_path?: unknown } | null)?.file_path;
    if (typeof filePath === "string" && filePath.length > 0) {
      const action =
        tool.name === "write" ? "写入" : tool.name === "edit" ? "编辑" : "生成图片";
      return `${action} ${path.resolve(cwd, filePath)}`;
    }
  }
  return text;
}

export async function runAgent(
  initialMessages: Message[],
  deps: AgentDeps,
): Promise<AgentRunResult> {
  const history: Message[] = [...initialMessages];
  const fileStates = deps.fileStates ?? new Map<string, string>();
  let dispatchPending = deps.orchestration === "ultra";
  let dispatchAttempts = 0;
  const pluginHooks = deps.plugins ?? [];
  const getSandboxMode = (): SandboxMode => {
    const source = deps.sandboxMode;
    return typeof source === "function" ? source() : source ?? "full";
  };
  let lastUsage: TokenUsage | null = null;
  let lastText: string | null = null;

  // 无轮次上限:自动压缩(context compaction)负责控制上下文增长,不需要额外的轮次硬顶
  while (true) {
    if (deps.abortSignal?.aborted) {
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: "已中断",
        interrupted: true,
      };
    }

    if (dispatchPending && (!deps.tools.some((tool) => tool.name === "task") || dispatchAttempts >= 2)) {
      const error = "Ultra 子代理编排未完成：模型未作出有效委派决定或子代理启动失败。请重试或切换思考模式。";
      deps.emit({ type: "error", message: error });
      return { messages: history, finalText: null, usage: lastUsage, error, interrupted: false };
    }
    const dispatching = dispatchPending;
    const turnTools = dispatching
      ? [...deps.tools.filter((tool) => tool.name === "task"), ultraDirectTool]
      : deps.tools;
    // The provider only sees coordination tools at this stage, but some models
    // still emit a known ordinary tool in the same batch as task. Recognize it
    // so it can run *after* the delegation has completed.
    const toolsByName = new Map(
      [...deps.tools, ...(dispatching ? [ultraDirectTool] : [])].map((tool) => [tool.name, tool]),
    );
    if (dispatching) dispatchAttempts++;
    const dispatchPrompt = dispatching
      ? ULTRA_DISPATCH_PROMPT + (dispatchAttempts > 1 ? "\n上次未完成有效委派决定，请纠正工具调用；不要重复直接作答。" : "")
      : "";

    deps.emit({ type: "turn-started" });

    // 1. 流式调模型,收集内容块
    const assistantBlocks: ContentBlock[] = [];
    let providerError: string | null = null;
    // 模型原始思考内容(Mimo/Kimi 工具调用回合需随历史回传,缺失会被 400)
    let turnReasoningContent: string | undefined;
    let finishReason: string | null = null;
    const stream = deps.provider.streamBlocks(
      history,
      {
        systemPrompt: deps.systemPrompt + dispatchPrompt,
        tools: turnTools.map((tool) => ({
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
          finishReason = event.finishReason;
          if (event.reasoningContent) turnReasoningContent = event.reasoningContent;
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
      deps.emit({ type: "turn-completed", usage: lastUsage });
      if (dispatching) {
        continue;
      }
      // Do not fabricate an empty assistant message; callers can resume from history.
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: null,
        interrupted: false,
        finishReason,
      };
    }
    const assistantMessage: Message = {
      role: "assistant",
      content: assistantBlocks,
      ...(turnReasoningContent ? { reasoningContent: turnReasoningContent } : {}),
    };
    history.push(assistantMessage);
    deps.emit({ type: "message-appended", message: assistantMessage });
    await deps.onMessage?.(assistantMessage);

    const toolCalls = assistantBlocks.filter(
      (block): block is ToolCallBlock => block.type === "tool-call",
    );

    // 3. 出口 = tool_use 数量
    if (toolCalls.length === 0) {
      if (dispatching) {
        deps.emit({ type: "turn-completed", usage: lastUsage });
        continue;
      }
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
        finishReason,
      };
    }

    // 4. 同阶段审批串行、执行并行；Ultra 首轮先完成协作调用，
    //    再处理同批的普通工具。结果按原始 tool_use 顺序回填。
    const toolContextBase = {
      cwd: deps.cwd,
      artifactDir: deps.artifactDir,
      protectedPaths: deps.protectedPaths,
      abortSignal: deps.abortSignal,
      fileStates,
    };
    const ordered = new Array<ContentBlock | null>(toolCalls.length).fill(null);

    interface Planned {
      call: ToolCallBlock;
      tool: Tool;
      preview: string;
      args: unknown;
      index: number;
      denied?: boolean;
    }

    const isDispatchCall = (call: ToolCallBlock): boolean =>
      call.name === "task" || call.name === "ultra_direct";
    const hasDispatchCall = dispatching && toolCalls.some(isDispatchCall);

    // 4a. 预处理:abort/未知工具直接占位,其余进审批队列
    const pending: Planned[] = [];
    toolCalls.forEach((call, index) => {
      const tool = toolsByName.get(call.name);
      let preview = previewFor(tool, call);
      if (deps.abortSignal?.aborted) {
        ordered[index] = {
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: ABORT_RESULT,
        };
        deps.emit({ type: "tool-state", toolCallId: call.id, state: "denied", preview });
        return;
      }
      if (!tool) {
        ordered[index] = {
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: `未知工具: ${call.name}`,
        };
        deps.emit({
          type: "tool-state",
          toolCallId: call.id,
          state: "failed",
          preview,
          summary: "未知工具",
        });
        return;
      }
      if (dispatching && !hasDispatchCall) {
        const reason = "本轮尚未作出 Ultra 协作决定，此工具未执行。请先调用 task；仅简单请求、用户禁止委派或需澄清时使用 ultra_direct。";
        ordered[index] = {
          type: "tool-result",
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: reason,
        };
        deps.emit({ type: "tool-state", toolCallId: call.id, state: "failed", preview, summary: reason });
        return;
      }
      // 插件 before 钩子:审批前改写 args
      let args: unknown;
      try {
        const originalArgs = JSON.parse(call.arguments);
        const rewritten = applyToolBefore(pluginHooks, call.name, originalArgs);
        if (typeof rewritten === "string") {
          try {
            args = JSON.parse(rewritten);
          } catch {
            args = originalArgs;
          }
        } else {
          args = rewritten;
        }
      } catch {
        args = null;
      }
      // 审批前用改写后的实参重算预览,保证"看到什么就执行什么"(P1-2);
      // write/edit 同时把 file_path 解析为绝对路径展示(P2-3)。
      preview = previewForArgs(tool, args, deps.cwd) || preview;
      pending.push({ call, tool, preview, args, index });
    });

    let dispatchSucceeded = false;
    // 4b. 同一阶段审批串行(保持弹窗顺序与交互稳定)
    const executeItems = async (items: Planned[]): Promise<void> => {
      for (const item of items) {
        if (deps.abortSignal?.aborted) break;
        // Internal decisions have no external effects and grant no tool permissions.
        if (item.tool === ultraDirectTool) continue;
        const outcome = await deps.approve({
          toolCallId: item.call.id,
          toolName: item.call.name,
          preview: item.preview,
          description: item.tool.description,
        });
        if (outcome.decision === "deny") {
          const reason =
            outcome.reason ??
            "工具调用被用户拒绝。请改用其他方式完成任务,或向用户说明为什么需要此操作。";
          ordered[item.index] = {
            type: "tool-result",
            toolCallId: item.call.id,
            name: item.call.name,
            isError: true,
            content: reason,
          };
          deps.emit({
            type: "tool-state",
            toolCallId: item.call.id,
            state: "denied",
            preview: item.preview,
          });
          item.denied = true;
          // Respect denied delegation instead of repeatedly asking for the same approval.
          if (dispatching && item.call.name === "task") dispatchPending = false;
        }
      }

      // 4c. 同一阶段执行并行:仅剩已批准的调用;结果按索引占位,顺序不变
      await Promise.all(
        items.map(async (item) => {
          if (item.denied) return;
          const index = item.index;
          if (deps.abortSignal?.aborted) {
            ordered[index] = {
              type: "tool-result",
              toolCallId: item.call.id,
              name: item.call.name,
              isError: true,
              content: ABORT_RESULT,
            };
            deps.emit({
              type: "tool-state",
              toolCallId: item.call.id,
              state: "denied",
              preview: item.preview,
            });
            return;
          }
          deps.emit({
            type: "tool-state",
            toolCallId: item.call.id,
            state: "executing",
            preview: item.preview,
          });
          try {
            // 审批可能跨越 SetConfig;在真正调用工具前读取最新模式。
            const toolContext: ToolContext = {
              ...toolContextBase,
              sandboxMode: getSandboxMode(),
              imageProvider: deps.imageProvider,
              subagentLog: (line: string) => {
                deps.emit({ type: "subagent-activity", toolCallId: item.call.id, text: line });
              },
              subagentEmit: (part: SubagentPart) => {
                deps.emit({ type: "subagent-part", toolCallId: item.call.id, part });
              },
            };
            const output = await item.tool.call(item.args, toolContext);
            const truncated = await truncateOutput(output, deps.artifactDir);
            if (dispatching && isDispatchCall(item.call)) {
              dispatchPending = false;
              dispatchSucceeded = true;
            }
            notifyToolAfter(pluginHooks, item.call.name, truncated.content, false);
            if (
              item.call.name === "write" ||
              item.call.name === "edit" ||
              item.call.name === "generate_image"
            ) {
              const filePath = (item.args as { file_path?: unknown } | null)?.file_path;
              if (typeof filePath === "string" && filePath.length > 0) {
                const absolute = path.resolve(deps.cwd, filePath);
                const insideCwd =
                  absolute === deps.cwd || absolute.startsWith(deps.cwd + path.sep);
                const display = insideCwd
                  ? path.relative(deps.cwd, absolute)
                  : absolute;
                deps.emit({
                  type: "file-changed",
                  toolCallId: item.call.id,
                  path: display,
                  action: item.call.name === "edit" ? "edited" : "written",
                });
              }
            }
            ordered[index] = {
              type: "tool-result",
              toolCallId: item.call.id,
              name: item.call.name,
              isError: false,
              content: truncated.content,
            };
            deps.emit({
              type: "tool-state",
              toolCallId: item.call.id,
              state: "completed",
              preview: item.preview,
              // 工具卡片的展开区需要完整结果。truncateOutput 已负责将超大输出
              // 换成安全的截断预览并落盘，因此这里可以统一交给 UI 展示。
              summary: truncated.content,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const content = `<tool_use_error>${message}</tool_use_error>`;
            notifyToolAfter(pluginHooks, item.call.name, content, true);
            ordered[index] = {
              type: "tool-result",
              toolCallId: item.call.id,
              name: item.call.name,
              isError: true,
              content,
            };
            deps.emit({
              type: "tool-state",
              toolCallId: item.call.id,
              state: "failed",
              preview: item.preview,
              summary: message.slice(0, 200),
            });
          }
        }),
      );
    };

    if (dispatching) {
      await executeItems(pending.filter((item) => isDispatchCall(item.call)));
      const ordinaryItems = pending.filter((item) => !isDispatchCall(item.call));
      if (dispatchSucceeded) {
        // Same-turn ordinary calls must not race the child or be approved before
        // we know delegation succeeded. Their result slots retain model order.
        await executeItems(ordinaryItems);
      } else {
        for (const item of ordinaryItems) {
          const reason = "Ultra 协作决定未成功，当前回合的后续工具未执行。请先查看 task 或 ultra_direct 的结果，再重新调用所需工具。";
          ordered[item.index] = {
            type: "tool-result", toolCallId: item.call.id, name: item.call.name,
            isError: true, content: reason,
          };
          deps.emit({ type: "tool-state", toolCallId: item.call.id, state: "failed", preview: item.preview, summary: reason });
        }
      }
    } else {
      await executeItems(pending);
    }

    const results: ContentBlock[] = ordered.filter(
      (block): block is ContentBlock => block !== null,
    );

    // 5. tool_result 回填(紧跟 tool_use,配对铁律)
    const toolResultMessage: Message = { role: "user", content: results };
    history.push(toolResultMessage);
    await deps.onMessage?.(toolResultMessage);
    deps.emit({ type: "turn-completed", usage: lastUsage });
  }
}
