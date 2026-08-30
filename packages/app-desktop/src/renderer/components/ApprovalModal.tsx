// =====================================================================
// 审批弹窗:弹簧入场(WAAPI 播放 Python 烘焙的 pop 关键帧),
// Escape = 拒绝。模态保持 transform-origin 居中(emil 例外条款)。
// =====================================================================

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { bridge } from "../bridge";
import motion from "@entrotect/shared/tokens/motion.json";

export function ApprovalModal(): React.JSX.Element | null {
  const approval = useStore((s) => s.approval);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!approval) return;
    const panel = panelRef.current;
    if (panel) {
      const spring = motion.springs.pop;
      panel.animate(
        spring.keyframes.map((k) => ({
          offset: k.offset,
          opacity: k.opacity,
          transform: k.transform,
        })),
        { duration: spring.durationMs, easing: "linear", fill: "both" },
      );
    }
  }, [approval]);

  useEffect(() => {
    if (!approval) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") decide("deny", "用户取消");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval]);

  if (!approval) return null;

  const decide = (decision: "allow-once" | "allow-always" | "deny", reason?: string) => {
    bridge().send({ kind: "ApprovalDecision", toolCallId: approval.toolCallId, decision, reason });
    useStore.setState({ approval: null });
  };

  return (
    <div className="modal-backdrop" ref={backdropRef}>
      <div className="modal approval-modal" ref={panelRef} role="dialog" aria-modal="true" aria-label="工具审批">
        <div className="approval-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M9 1.5 16 3.6v5.2c0 4.2-2.9 6.8-7 7.7-4.1-.9-7-3.5-7-7.7V3.6L9 1.5Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path d="M9 5.5v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="9" cy="12" r="0.9" fill="currentColor" />
          </svg>
        </div>
        <h3 className="approval-title">工具需要你的批准</h3>
        <p className="approval-tool">
          <code>{approval.toolName}</code>
        </p>
        <pre className="approval-preview">{approval.preview}</pre>
        <p className="approval-desc">{approval.description.split("。")[0]}。</p>
        <div className="approval-actions">
          <button className="btn btn-ghost" onClick={() => decide("deny")}>
            拒绝
          </button>
          <button className="btn btn-ghost" onClick={() => decide("allow-once")}>
            允许一次
          </button>
          <button className="btn btn-primary" onClick={() => decide("allow-always")}>
            本会话总是允许
          </button>
        </div>
        <p className="approval-hint">Esc = 拒绝 · 超时未响应将默认拒绝 · 总是允许 = 本会话内该工具全部调用免审</p>
      </div>
    </div>
  );
}
