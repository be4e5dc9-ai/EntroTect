// =====================================================================
// 工具调用卡片:可折叠,五态(等待审批/执行中/完成/失败/被拒)
// task(子代理)工具渲染为"子代理任务"卡:展开可见内部活动日志
// (subagent-activity 行),不进主对话流。
// =====================================================================

import { useState } from "react";
import type { UiToolBlock } from "../store";

const STATE_LABEL: Record<UiToolBlock["state"], string> = {
  "awaiting-approval": "等待审批",
  executing: "执行中",
  completed: "已完成",
  failed: "失败",
  denied: "已拒绝",
};

function SubagentIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4.6" cy="5" r="0.85" fill="currentColor" />
      <circle cx="8.4" cy="5" r="0.85" fill="currentColor" />
      <path d="M4.4 8.2c.6.55 1.3.85 2.1.85s1.5-.3 2.1-.85" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function ToolCard({ block }: { block: UiToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const isSubagent = block.name === "task";
  const hasLog = isSubagent && !!block.log;

  return (
    <div className={`tool-card tool-${block.state}${isSubagent ? " tool-task" : ""}`}>
      <button
        className="tool-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {isSubagent ? (
          <span className={`tool-subagent-icon state-${block.state}`}>
            <SubagentIcon />
          </span>
        ) : (
          <span className={`tool-state-dot dot-${block.state}`} aria-hidden="true" />
        )}
        <span className="tool-name">{isSubagent ? "子代理" : block.name}</span>
        <span className="tool-preview">{block.preview}</span>
        <span className={`tool-state-label state-${block.state}`}>
          {block.state === "executing" && <span className="spin" aria-hidden="true" />}
          {STATE_LABEL[block.state]}
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
      <div className={`tool-card-body${open ? " open" : ""}`}>
        <div className="tool-card-body-inner">
          {hasLog && (
            <pre className="tool-subagent-log">{block.log}</pre>
          )}
          <pre className="tool-summary">{block.summary ?? "(无摘要)"}</pre>
        </div>
      </div>
    </div>
  );
}
