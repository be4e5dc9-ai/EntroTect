import type { ContentBlock, Message } from "@entrotect/shared";

type ToolCall = Extract<ContentBlock, { type: "tool-call" }>;
type ToolResult = Extract<ContentBlock, { type: "tool-result" }>;

/** Repair legacy or interrupted histories for model requests without rewriting the saved transcript. */
export function normalizeToolHistory(messages: Message[]): Message[] {
  const normalized: Message[] = [];
  const pending = new Map<string, ToolCall>();
  let changed = false;

  const finishPending = () => {
    if (pending.size === 0) return;
    normalized.push({
      role: "user",
      content: [...pending.values()].map((call): ToolResult => ({
        type: "tool-result",
        toolCallId: call.id,
        name: call.name,
        isError: true,
        content: "历史工具调用的结果未保存；请检查实际状态后再决定是否重试。",
      })),
    });
    pending.clear();
    changed = true;
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      finishPending();
      const seen = new Set<string>();
      const content = message.content.filter((block) => {
        if (block.type === "tool-result") { changed = true; return false; }
        if (block.type !== "tool-call") return true;
        if (seen.has(block.id)) { changed = true; return false; }
        seen.add(block.id);
        pending.set(block.id, block);
        return true;
      });
      normalized.push(content.length === message.content.length ? message : { ...message, content });
      continue;
    }

    const results = message.content.filter((block): block is ToolResult => block.type === "tool-result");
    if (results.length === 0) {
      finishPending();
      normalized.push(message);
      continue;
    }

    const matched = results.filter((result) => {
      if (!pending.has(result.toolCallId)) return false;
      pending.delete(result.toolCallId);
      return true;
    });
    const ordinary = message.content.filter((block) => block.type !== "tool-result");
    if (matched.length !== results.length || ordinary.length > 0 || message.role !== "user") changed = true;
    if (matched.length > 0) {
      normalized.push(matched.length === message.content.length && message.role === "user"
        ? message : { role: "user", content: matched });
    }
    if (ordinary.length > 0) {
      finishPending();
      normalized.push({ ...message, content: ordinary });
    }
  }

  finishPending();
  return changed ? normalized : messages;
}
