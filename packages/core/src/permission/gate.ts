// =====================================================================
// 权限闸门:会话级三态审批
// 设计依据:ClaudeCode/06 权限三态 + opencode/09 last-match-wins 的
// v1 精简版。v1 范围:
//   - 只读工具自动放行(read/glob/grep);
//   - 写类工具(write/edit/bash)等待用户三选一;
//   - allow-always 按工具名记忆(会话级);
//   - fail-closed:审批超时默认 deny,deny 理由回喂模型。
// =====================================================================

import type { ApprovalDecision, ApprovalRequest } from "@entrotect/shared";
import type { Tool } from "../tools/types.js";

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** deny 时附带的理由,会回喂给模型 */
  reason?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/** 审批超时(fail-closed 兜底):10 分钟未响应默认拒绝 */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export class SessionPermissionGate {
  /** 会话内允许名单(allow-always 按工具名记忆) */
  private readonly alwaysAllowed = new Set<string>();
  private readonly readOnlyTools = new Set<string>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;

  constructor(tools: Tool[], timeoutMs: number = APPROVAL_TIMEOUT_MS) {
    for (const tool of tools) {
      if (tool.isReadOnly) this.readOnlyTools.add(tool.name);
    }
    this.timeoutMs = timeoutMs;
  }

  /**
   * 主循环在每次工具执行前调用。
   * 只读工具/已 allow-always 的工具即时放行;
   * 其余挂起,等待 host 调 respond() 或超时 fail-closed deny。
   */
  request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.readOnlyTools.has(request.toolName) || this.alwaysAllowed.has(request.toolName)) {
      return Promise.resolve({ decision: "allow-once" });
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.toolCallId);
        resolve({ decision: "deny", reason: "审批超时,默认拒绝" });
      }, this.timeoutMs);
      this.pending.set(request.toolCallId, { request, resolve, timer });
    });
  }

  /** host(UI)回传用户决定。已超时的调用幂等忽略。 */
  respond(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    this.pending.delete(toolCallId);
    clearTimeout(pending.timer);
    if (decision === "allow-always") {
      this.alwaysAllowed.add(pending.request.toolName);
    }
    pending.resolve({ decision, reason });
  }

  /** 会话结束清理挂起审批 */
  dispose(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ decision: "deny", reason: "会话已关闭" });
    }
    this.pending.clear();
  }
}
