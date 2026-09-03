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

export interface AgentDeps {
  provider: Provider;
  tools: Tool[];
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** 思考强度(off = 不发送该参数) */
  reasoningEffort?: ReasoningEffort;
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
  const toolsByName = new Map(deps.tools.map((tool) => [tool.name, tool]));
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

    deps.emit({ type: "turn-started" });

    // 1. 流式调模型,收集内容块
    const assistantBlocks: ContentBlock[] = [];
    let providerError: string | null = null;
    // 模型原始思考内容(Mimo/Kimi 工具调用回合需随历史回传,缺失会被 400)
    let turnReasoningContent: string | undefined;
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
      // 空响应防御:直接结束,不产生空消息
      return {
        messages: history,
        finalText: lastText,
        usage: lastUsage,
        error: null,
        interrupted: false,
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

    // 4. 两阶段执行:审批串行(逐个弹窗),执行并行(互不依赖的调用并发跑),
    //    结果按原始 tool_use 顺序回填,保证与请求块配对。
    const toolContextBase = {
      cwd: deps.cwd,
      artifactDir: deps.artifactDir,
      protectedPaths: deps.protectedPaths,
      abortSignal: deps.abortSignal,
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

    // 4b. 审批串行(保持弹窗顺序与交互稳定)
    for (const item of pending) {
      if (deps.abortSignal?.aborted) break;
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
      }
    }

    // 4c. 执行并行:仅剩已批准的调用;结果按索引占位,顺序不变
    await Promise.all(
      pending.map(async (item) => {
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
