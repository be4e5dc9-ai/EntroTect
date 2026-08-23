// =====================================================================
// 子代理对话页:右侧详情栏标签内容,像主聊天窗口一样的
// "主代理 ↔ 子代理"对话(委派消息 + 子代理消息流/工具卡片/最终答复)。
// 实时流式展示,只读:无输入框、无停止按钮。
// =====================================================================

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { Message } from "./MessageList";

export function SubagentChat({ toolCallId }: { toolCallId: string }): React.JSX.Element {
  const messages = useStore((s) => s.subagentChats[toolCallId] ?? []);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 贴底时自动跟随滚动(参照 MessageList 的 bottomRef 逻辑)
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <div className="subagent-chat">
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
  );
}
