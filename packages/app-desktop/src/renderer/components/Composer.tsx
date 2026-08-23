// =====================================================================
// 输入区:Enter 发送 / Shift+Enter 换行;忙碌态显示停止按钮
// =====================================================================

import { useRef, useState } from "react";
import { useStore } from "../store";
import { bridge } from "../bridge";

export function Composer(): React.JSX.Element {
  const busy = useStore((s) => s.busy);
  const hasSession = useStore((s) => s.currentSession !== null);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    bridge().send({ kind: "SendMessage", text: value });
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  };

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={hasSession ? "输入任务,Enter 发送" : "先新建一个会话…"}
          value={text}
          disabled={!hasSession}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button
            className="btn btn-danger composer-stop"
            onClick={() => bridge().send({ kind: "Interrupt" })}
            aria-label="停止"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" rx="1.5" />
            </svg>
            停止
          </button>
        ) : (
          <button
            className="btn btn-primary composer-send"
            onClick={send}
            disabled={!text.trim()}
            aria-label="发送"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 13V2M2.5 6.5 7 2l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
