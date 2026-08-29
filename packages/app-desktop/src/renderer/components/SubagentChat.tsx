// =====================================================================
// 子代理对话页:右侧详情栏标签内容(opencode 风格)
// 顶部 = 代理名 + 状态徽章(运行中/完成/失败);下方 = 对话流:
// 首条 = 主代理委派的任务(prompt),随后 = 子代理消息流/工具卡/最终答复。
// 实时流式展示,只读:无输入框、无停止按钮。
// =====================================================================

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import { Message } from "./MessageList";

function StatusBadge({ running, failed }: { running: boolean; failed: boolean }): React.JSX.Element {
  if (failed) {
    return (
      <span className="subagent-status subagent-status-failed" role="status">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        失败
      </span>
    );
  }
  if (running) {
    return (
      <span className="subagent-status subagent-status-running" role="status">
        <span className="subagent-pulse" aria-hidden="true" />
        运行中
      </span>
    );
  }
  return (
    <span className="subagent-status subagent-status-done" role="status">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 5.3 4.2 7.5 8 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      已完成
    </span>
  );
}

export function SubagentChat({ toolCallId }: { toolCallId: string }): React.JSX.Element {
  const messages = useStore((s) => s.subagentChats[toolCallId] ?? []);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 运行状态:任一助手消息仍在流式
  const running = useMemo(() => messages.some((m) => m.role === "assistant" && m.streaming), [messages]);
  const failed = useMemo(
    () =>
      messages.some((m) =>
        m.blocks.some((b) => b.kind === "tool-call" && b.state === "failed"),
      ),
    [messages],
  );

  // 贴底时自动跟随滚动(参照 MessageList 的 bottomRef 逻辑)
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div className="subagent-chat">
      <div className="subagent-head">
        <span className="subagent-avatar" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none">
            <rect x="1.5" y="1.5" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.1" />
            <circle cx="4.6" cy="5" r="0.85" fill="currentColor" />
            <circle cx="8.4" cy="5" r="0.85" fill="currentColor" />
            <path d="M4.4 8.2c.6.55 1.3.85 2.1.85s1.5-.3 2.1-.85" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
        </span>
        <span className="subagent-title">子代理</span>
        <StatusBadge running={running} failed={failed} />
      </div>
      <div className="subagent-divider" />
      <div className="subagent-flow">
        {messages.map((message, index) => (
          <div className="subagent-msg" key={message.key}>
            {index === 0 && message.role === "user" && (
              <div className="subagent-delegate">
                <span>主代理委派</span>
              </div>
            )}
            <Message message={message} />
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
