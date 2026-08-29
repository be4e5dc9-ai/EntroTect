// =====================================================================
// 工具调用卡片:Claude Code 风格紧凑行
// 一行 = 状态图标 + 工具名 + 实参预览 + 状态;点击展开详情(摘要/日志)。
// task(子代理)卡:头部点击跳右侧详情栏,展开可见内部活动日志。
// =====================================================================

import { useState } from "react";
import type { UiToolBlock } from "../store";

export const STATE_LABEL: Record<UiToolBlock["state"], string> = {
  "awaiting-approval": "等待批准",
  executing: "执行中",
  completed: "完成",
  failed: "失败",
  denied: "已拒绝",
};

/** 状态图标:时钟/转圈/对勾/叉/横杠(Claude Code 式) */
function StateIcon({ state }: { state: UiToolBlock["state"] }): React.JSX.Element {
  switch (state) {
    case "executing":
      return (
        <svg className="tool-state-spin" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
          <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "completed":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "failed":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "denied":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case "awaiting-approval":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 3.5V6l1.8 1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
  }
}

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

export interface ToolCardProps {
  block: UiToolBlock;
  /** task 卡点击头部时跳转右侧详情栏(其他工具卡忽略) */
  onOpenDetail?: () => void;
}

export function ToolCard({ block, onOpenDetail }: ToolCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const isSubagent = block.name === "task";
  const hasLog = isSubagent && !!block.log;
  const hasDetail = hasLog || !!block.summary;

  const toggleInline = (): void => setOpen((v) => !v);
  const onHeadClick = isSubagent && onOpenDetail ? onOpenDetail : toggleInline;

  return (
    <div className={`tool-card tool-${block.state}${isSubagent ? " tool-task" : ""}`}>
      <button
        className="tool-card-head"
        onClick={onHeadClick}
        aria-expanded={open}
        title={hasDetail ? "点击展开详情" : undefined}
      >
        <span className={`tool-state-icon state-${block.state}`}>
          <StateIcon state={block.state} />
        </span>
        {isSubagent && <span className="tool-subagent-badge">Subagent</span>}
        <span className="tool-name">{isSubagent ? "子代理" : block.name}</span>
        <span className="tool-preview">{block.preview}</span>
        <span className={`tool-state-label state-${block.state}`}>
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
          {block.summary && (
            <pre className="tool-summary">{block.summary}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
