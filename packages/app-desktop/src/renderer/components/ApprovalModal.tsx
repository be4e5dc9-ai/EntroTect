// =====================================================================
// 审批弹窗:弹簧入场(WAAPI 播放 Python 烘焙的 pop 关键帧),
// Escape = 拒绝。模态保持 transform-origin 居中(emil 例外条款)。
// =====================================================================

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { bridge } from "../bridge";
import motion from "@entrotect/shared/tokens/motion.json";
import type { ApprovalDecision } from "@entrotect/shared";

export function ApprovalModal(): React.JSX.Element | null {
  const approval = useStore((s) => s.approval);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [denyReason, setDenyReason] = useState("");

  useEffect(() => {
    if (!approval) return;
    setDenyReason("");
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

  const decide = (decision: ApprovalDecision, reason?: string) => {
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
        <h3 className="approval-title">操作需要你的批准</h3>
        <p className="approval-tool">
          <code>{approval.toolName}</code>
          <span className={`approval-risk ${approval.risk ?? "medium"}`}>
            {approval.risk === "high" ? "高风险" : approval.risk === "low" ? "低风险" : "需确认"}
          </span>
        </p>
        <pre className="approval-preview">{approval.preview}</pre>
        <p className="approval-desc">{approval.reason ?? `${approval.description.split("。")[0]}。`}</p>
        {approval.targets?.length ? (
          <div className="approval-targets" aria-label="本次权限范围">
            {approval.targets.map((target, index) => (
              <div className="approval-target" key={`${target.action}-${target.resource}-${index}`}>
                <span>{target.action}</span>
                <code>{target.resource}</code>
              </div>
            ))}
          </div>
        ) : null}
        <div className="approval-actions">
          <button className="btn btn-ghost" onClick={() => decide("deny", denyReason.trim() || undefined)}>
            拒绝
          </button>
          <button className="btn btn-ghost" onClick={() => decide("allow-once")}>
            允许一次
          </button>
          <button className="btn btn-primary" onClick={() => decide("allow-always")}>
            本会话允许
          </button>
          <button className="btn btn-primary" onClick={() => decide("allow-project")}>
            此项目允许
          </button>
        </div>
        <input
          className="approval-deny-reason"
          value={denyReason}
          onChange={(event) => setDenyReason(event.target.value)}
          placeholder="可选：告诉 Agent 为什么拒绝，便于它调整方案"
          aria-label="拒绝原因"
        />
        <p className="approval-hint">Esc = 拒绝 · 超时默认拒绝 · 长期授权仅保存上方列出的动作与资源范围</p>
      </div>
    </div>
  );
}
