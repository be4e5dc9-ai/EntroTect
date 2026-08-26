// =====================================================================
// 上下文压缩(autocompact):超阈值自动压缩 + /compact 手动压缩
// 设计依据:ClaudeCode compaction —— 模型把历史总结成摘要,
// 历史替换为 [摘要消息 + 最近 N 条],摘要作为 user 消息回填。
// =====================================================================

import type { Message, ProviderConfig } from "@entrotect/shared";
import type { Provider } from "./provider/types.js";
import { knownContextWindow, suffixContextWindow } from "./provider/contexts.js";

/** 保留的最近消息数(压缩后) */
export const COMPACT_KEEP_RECENT = 6;
/** 触发自动压缩的上下文占用阈值 */
export const COMPACT_RATIO = 0.7;
/** 低于此消息数不压缩(小会话无意义) */
export const COMPACT_MIN_MESSAGES = 8;

export const COMPACT_SYSTEM_PROMPT = `你是上下文压缩器。把下面的对话历史压缩成一份简洁的中文摘要，只保留：
1) 任务目标与用户关键要求；
2) 已完成事项与最终产物（文件路径、改动结论）；
3) 关键决策、约束与未决问题；
4) 尚未完成的事项与明确的下一步。
不要展开细节，不要编造历史中没有的内容。直接输出摘要正文。`;

/** 粗估 tokens:中文约 1.5 字符/token,英文约 4 字符/token,取 2.5 折中 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool-call") chars += block.name.length + block.arguments.length;
      else if (block.type === "tool-result") chars += block.content.length;
    }
  }
  return Math.ceil(chars / 2.5);
}

/** 解析模型上下文窗口:内置表 > id 后缀 > 默认 128k */
export function resolveContextWindow(
  model: string,
  providers?: ProviderConfig[],
): number {
  // 供应商配置里的 contextWindows(键为模型 id)
  for (const provider of providers ?? []) {
    const windows = provider.contextWindows as Record<string, number> | undefined;
    if (windows && typeof windows[model] === "number" && windows[model] > 0) {
      return windows[model];
    }
  }
  return knownContextWindow(model) ?? suffixContextWindow(model) ?? 128_000;
}

/** 是否需要自动压缩 */
export function shouldAutoCompact(
  messages: Message[],
  model: string,
  providers?: ProviderConfig[],
): boolean {
  if (messages.length < COMPACT_MIN_MESSAGES) return false;
  const window = resolveContextWindow(model, providers);
  return estimateTokens(messages) >= window * COMPACT_RATIO;
}

/** 压缩历史:返回替换后的消息数组(摘要 user 消息 + 最近 N 条) */
export async function compactMessages(
  provider: Provider,
  messages: Message[],
  signal?: AbortSignal,
): Promise<{ compacted: Message[]; summary: string }> {
  if (messages.length === 0) return { compacted: messages, summary: "" };
  const body = messages
    .map((message, index) => {
      const role = message.role === "assistant" ? "助手" : "用户";
      const text = message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool-call") return `[工具调用 ${block.name}] ${block.arguments}`;
          if (block.type === "tool-result") return `[工具结果] ${block.content.slice(0, 500)}`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `#${index + 1} ${role}:\n${text.slice(0, 4000)}`;
    })
    .join("\n\n");

  const summaryParts: string[] = [];
  const stream = provider.streamBlocks(
    [{ role: "user", content: [{ type: "text", text: body }] }],
    {
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      tools: [],
      maxTokens: 2000,
      temperature: 0,
    },
    signal,
  );
  for await (const event of stream) {
    if (event.type === "text-delta") summaryParts.push(event.text);
    if (event.type === "error") throw new Error(`压缩失败: ${event.message}`);
  }
  const summary = summaryParts.join("").trim();
  if (!summary) throw new Error("压缩失败: 模型未返回摘要");

  const keep = messages.slice(-COMPACT_KEEP_RECENT);
  const summaryMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `【对话压缩摘要】以下为本次会话早期历史的压缩总结，请以此为上下文继续，不要重复已完成的工作：\n\n${summary}`,
      },
    ],
  };
  return { compacted: [summaryMessage, ...keep], summary };
}
