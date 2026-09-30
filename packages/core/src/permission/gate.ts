// =====================================================================
// 权限闸门:动作 + 资源规则、会话授权、项目持久授权与 fail-closed 审批。
// 规则采用 last-match-wins；同一工具的不同文件、命令或域名分别裁决。
// =====================================================================

import type {
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
  PermissionRule,
} from "@entrotect/shared";
import type { Tool } from "../tools/types.js";
import { evaluatePermission, rulesForApproval } from "./rules.js";

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** deny 时附带的理由,会回喂给模型 */
  reason?: string;
  /** allow-project 时由 host 持久化的最小范围规则。 */
  rules?: PermissionRule[];
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/** 审批超时(fail-closed 兜底):10 分钟未响应默认拒绝 */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 权限闸门。模式:
 *   full  - 完全访问:全部自动放行(免审批)
 *   write - 修改需批准:只读工具放行,写工具(write/edit/bash)需批准
 *   ask   - 每项操作需批准:所有工具调用(含只读)都需批准
 * fail-closed:审批超时默认拒绝,deny 理由回喂模型。
 */
export class SessionPermissionGate {
  /** 会话内规则只存在于本次会话，不污染其他项目或会话。 */
  private readonly sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[];
  private readonly readOnlyTools = new Set<string>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;
  private mode: PermissionMode;

  constructor(
    tools: Tool[],
    timeoutMs: number = APPROVAL_TIMEOUT_MS,
    mode: PermissionMode = "write",
    projectRules: readonly PermissionRule[] = [],
  ) {
    for (const tool of tools) {
      if (tool.isReadOnly) this.readOnlyTools.add(tool.name);
    }
    this.timeoutMs = timeoutMs;
    this.mode = mode;
    this.projectRules = projectRules.map((rule) => ({ ...rule }));
  }

  /** 更新后续检查使用的模式;已挂起的审批仍由原有 respond/超时路径收口。 */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** 配置更新后替换持久规则；会话规则继续保留。 */
  setProjectRules(rules: readonly PermissionRule[]): void {
    this.projectRules = rules.map((rule) => ({ ...rule }));
  }

  /** Preserve conversation grants while a new run releases old approvals. */
  copySessionGrantsFrom(previous: SessionPermissionGate): void {
    this.sessionRules.push(...previous.sessionRules.map((rule) => ({ ...rule })));
  }

  /**
   * 主循环在每次工具执行前调用。
   * full 模式/匹配 allow 规则即时放行;write 模式低风险只读动作默认放行;
   * 其余挂起,等待 host 调 respond() 或超时 fail-closed deny。
   */
  request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const evaluation = this.evaluate(request);
    if (evaluation.effect === "allow") {
      return Promise.resolve({ decision: "allow-once" });
    }
    if (evaluation.effect === "deny") {
      return Promise.resolve({
        decision: "deny",
        reason: evaluation.rule
          ? `项目权限规则拒绝了 ${evaluation.target?.action ?? "操作"}: ${evaluation.target?.resource ?? request.preview}`
          : evaluation.reason ?? request.reason ?? "权限规则拒绝了该操作",
      });
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.toolCallId);
        resolve({ decision: "deny", reason: "审批超时,默认拒绝" });
      }, this.timeoutMs);
      this.pending.set(request.toolCallId, { request, resolve, timer });
    });
  }

  /** 请求是否会走挂起(需要用户裁决)路径;用于 host 决定是否上报 approval-requested */
  wantsApproval(request: ApprovalRequest): boolean {
    return this.evaluate(request).effect === "ask";
  }

  private evaluate(request: ApprovalRequest) {
    if (request.policyEffect === "deny") {
      return { effect: "deny" as const, reason: request.reason ?? "宿主安全策略拒绝了该操作" };
    }
    return evaluatePermission(
      request,
      this.mode,
      this.readOnlyTools.has(request.toolName),
      this.projectRules,
      this.sessionRules,
    );
  }

  /** host(UI)回传用户决定。已超时的调用幂等忽略。 */
  respond(toolCallId: string, decision: ApprovalDecision, reason?: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    this.pending.delete(toolCallId);
    clearTimeout(pending.timer);
    const readOnly = this.readOnlyTools.has(pending.request.toolName);
    if (decision === "allow-always" || decision === "allow-project") {
      const rules = rulesForApproval(pending.request, readOnly);
      if (decision === "allow-always") this.sessionRules.push(...rules);
      else this.projectRules.push(...rules);
      pending.resolve({ decision, reason, ...(decision === "allow-project" ? { rules } : {}) });
      return;
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
