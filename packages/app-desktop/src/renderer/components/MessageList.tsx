// =====================================================================
// 消息与消息列表
// =====================================================================

import { useEffect, useRef, useState } from "react";
import { useStore, openSubagentTab, type UiMessage } from "../store";
import { renderMarkdown } from "../markdown";
import { bridge } from "../bridge";
import { ToolCard } from "./ToolCard";
import { FileCard } from "./FileCard";

/** 思考过程区:流式时自动展开,结束后可手动折叠 */
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
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M2.5 7.5 6 10l3.5-2.5M2.5 4.5 6 7l3.5-2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="reasoning-title">
          思考过程{streaming ? " · 思考中…" : `(${text.length} 字)`}
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
        <div className="msg-user-bubble">{text}</div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <div className="msg-assistant-mark" aria-hidden="true">
        <img src="./icon.png" alt="" draggable={false} />
      </div>
      <div className="msg-assistant-content">
        {showReasoning && <ReasoningSection text={message.reasoning} streaming={message.streaming} />}
        {message.blocks.map((block, index) =>
          block.kind === "text" ? (
            <div
              key={`t${index}`}
              className="markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
            />
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
        <img src="./icon.png" alt="" className="empty-mark" draggable={false} />
        <h2>让 EntroTect 帮你写代码</h2>
        <p className="empty-hint">点击侧栏 New 新建任务(选择工作目录),然后在下方输入任务,例如:</p>
        <div className="empty-suggestions">
          <Suggestion text="看看当前目录有什么文件,总结一下这个项目的结构" />
          <Suggestion text="写一个 Python 脚本,列出磁盘占用最大的 10 个文件" />
          <Suggestion text="找到项目里的 TODO 注释,整理成清单" />
        </div>
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

function Suggestion({ text }: { text: string }): React.JSX.Element {
  return (
    <button className="suggestion" onClick={() => bridge().send({ kind: "SendMessage", text })}>
      {text}
    </button>
  );
}
