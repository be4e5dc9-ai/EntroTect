// =====================================================================
// 消息与消息列表(opencode / Claude Code 风格)
// - 用户消息:右对齐,无气泡,顶部小字 "You" 标签
// - 助手消息:无头像,文本平铺;思考过程折叠;工具调用为紧凑行
// =====================================================================

import { useEffect, useRef, useState } from "react";
import { useStore, openSubagentTab, type UiMessage } from "../store";
import { renderMarkdown } from "../markdown";
import { ToolCard } from "./ToolCard";
import { FileCard } from "./FileCard";
import { ClarificationCard } from "./ClarificationCard";
import { UsageOverview } from "./UsageOverview";

/** 按当前时刻打招呼 */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 思考过程区:流式时自动展开,结束后可手动折叠(Claude Code 风格"Thinking") */
function ReasoningSection({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  if (!text) return <></>;

  return (
    <div className={`reasoning${open ? " open" : ""}`}>
      <button
        className="reasoning-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg className="reasoning-head-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M2.5 7.5 6 10l3.5-2.5M2.5 4.5 6 7l3.5-2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="reasoning-title">
          {streaming ? "Thinking…" : `思考过程(${text.length} 字)`}
        </span>
        <svg
          className={`tool-chevron${open ? " open" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="reasoning-body">
          <p className="reasoning-text">{text}</p>
        </div>
      )}
    </div>
  );
}

/** 单条消息渲染(导出供子代理对话页复用) */
export function Message({ message }: { message: UiMessage }): React.JSX.Element {
  const showReasoning = useStore((s) => s.config?.showReasoning ?? false);

  if (message.role === "user") {
    const text = message.blocks
      .filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("\n");
    return (
      <div className="msg msg-user">
        <div className="msg-user-label">You</div>
        <div className="msg-user-text">{text}</div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <div className="msg-assistant-content">
        {showReasoning && <ReasoningSection text={message.reasoning} streaming={message.streaming} />}
        {message.blocks.map((block, index) =>
          block.kind === "text" ? (
            <div key={`t${index}`} className="msg-text-block">
              <div
                className="markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
              />
              <ClarificationCard text={block.text} />
            </div>
          ) : block.kind === "file" ? (
            <FileCard key={`f${index}`} block={block} />
          ) : (
            <ToolCard
              key={block.id}
              block={block}
              onOpenDetail={
                block.name === "task"
                  ? () => openSubagentTab(block.id)
                  : undefined
              }
            />
          ),
        )}
        {message.blocks.length === 0 && message.streaming && (
          <div className="thinking" aria-label="思考中">
            <span /><span /><span />
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageList(): React.JSX.Element {
  const messages = useStore((s) => s.messages);
  const busy = useStore((s) => s.busy);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 贴底时自动跟随滚动(用户上翻则尊重其位置)
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-greeting">
          <h2>{greeting()}</h2>
          <p className="empty-hint">告诉我接下来想做什么</p>
        </div>
        <UsageOverview />
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((message) => (
        <Message key={message.key} message={message} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
