// =====================================================================
// 工具调用卡片:可折叠,五态(等待审批/执行中/完成/失败/被拒)
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

export function ToolCard({ block }: { block: UiToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className={`tool-card tool-${block.state}`}>
      <button
        className="tool-card-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`tool-state-dot dot-${block.state}`} aria-hidden="true" />
        <span className="tool-name">{block.name}</span>
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
          <pre className="tool-summary">{block.summary ?? "(无摘要)"}</pre>
        </div>
      </div>
    </div>
  );
}
