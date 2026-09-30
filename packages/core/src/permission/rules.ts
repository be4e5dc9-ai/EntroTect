import path from "node:path";
import type {
  ApprovalRequest,
  PermissionEffect,
  PermissionMode,
  PermissionRule,
  PermissionTarget,
} from "@entrotect/shared";

const WRITE_SAFE_ACTIONS = new Set(["read", "inspect", "search", "state", "subagent", "browser.read"]);
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|credentials(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i;
const CONTROL_PATH = /(?:^|\/)(?:\.git\/(?:config|hooks)(?:\/|$)|\.ssh(?:\/|$))/i;

export interface PermissionEvaluation {
  effect: PermissionEffect;
  target?: PermissionTarget;
  rule?: PermissionRule;
  reason?: string;
}

/** Stable comparison form for paths, URLs and commands without losing display data. */
export function normalizePermissionResource(resource: string): string {
  const trimmed = resource.trim();
  const url = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(trimmed);
  // Web paths, query values and fragments remain case-sensitive on Windows.
  // Normalize only the scheme and authority; resources can contain glob stars.
  if (url) {
    const suffix = url[3] || "/";
    return `${url[1]!.toLowerCase()}${url[2]!.toLowerCase()}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function globRegex(pattern: string): RegExp {
  const source = normalizePermissionResource(pattern);
  const urlPattern = /^https?:\/\//.test(source);
  let output = "^";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "*") {
      while (source[index + 1] === "*") index++;
      output += ".*";
    } else if (char === "?" && !urlPattern) {
      output += ".";
    } else {
      output += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`, process.platform === "win32" && !urlPattern ? "i" : "");
}

export function permissionRuleMatches(rule: PermissionRule, target: PermissionTarget, workspace?: string): boolean {
  if (rule.workspace && normalizePermissionResource(rule.workspace) !== normalizePermissionResource(workspace ?? "")) return false;
  return globRegex(rule.action).test(target.action) && globRegex(rule.resource).test(normalizePermissionResource(target.resource));
}

function defaultEffect(mode: PermissionMode, target: PermissionTarget, readOnly: boolean): PermissionEffect {
  if (mode === "full") return "allow";
  if (mode === "ask") return "ask";
  if (WRITE_SAFE_ACTIONS.has(target.action) || (readOnly && target.action === "read")) return "allow";
  return "ask";
}

function securityBaseline(target: PermissionTarget, mode: PermissionMode): PermissionEvaluation | undefined {
  if (mode === "full") return undefined;
  if ((target.action === "read" || target.action === "edit") && SENSITIVE_PATH.test(target.resource)) {
    return {
      effect: "ask",
      target,
      reason: "该操作会访问凭据、密钥或环境变量文件",
    };
  }
  if (target.action === "edit" && CONTROL_PATH.test(target.resource)) {
    return {
      effect: "ask",
      target,
      reason: "该操作会修改版本控制或身份配置",
    };
  }
  return undefined;
}

export function targetsForRequest(request: ApprovalRequest, readOnly: boolean): PermissionTarget[] {
  if (request.targets?.length) {
    return request.targets.map((target) => ({
      action: target.action,
      resource: normalizePermissionResource(target.resource),
    }));
  }
  return [{ action: readOnly ? "read" : "tool", resource: request.toolName }];
}

/** Evaluate all targets independently, then choose deny > ask > allow. */
export function evaluatePermission(
  request: ApprovalRequest,
  mode: PermissionMode,
  readOnly: boolean,
  projectRules: readonly PermissionRule[],
  sessionRules: readonly PermissionRule[],
): PermissionEvaluation {
  const evaluations = targetsForRequest(request, readOnly).map((target): PermissionEvaluation => {
    let result: PermissionEvaluation = { effect: defaultEffect(mode, target, readOnly), target };
    const baseline = securityBaseline(target, mode);
    if (baseline) result = baseline;
    // Project rules are evaluated after ephemeral grants so a rule added while
    // the session is running can immediately tighten or revoke prior access.
    for (const rule of [...sessionRules, ...projectRules]) {
      if (!permissionRuleMatches(rule, target, request.workspace)) continue;
      result = { effect: rule.effect, target, rule };
    }
    return result;
  });
  return evaluations.find((item) => item.effect === "deny")
    ?? evaluations.find((item) => item.effect === "ask")
    ?? evaluations[0]
    ?? { effect: mode === "full" ? "allow" : "ask" };
}

export function rulesForApproval(request: ApprovalRequest, readOnly: boolean): PermissionRule[] {
  const supplied = request.suggestedRules?.filter((rule) => rule.effect === "allow");
  if (supplied?.length) return supplied.map((rule) => ({ ...rule, resource: normalizePermissionResource(rule.resource) }));
  return targetsForRequest(request, readOnly).map((target) => ({ ...target, effect: "allow" }));
}

/** Whether an absolute resource is inside the active workspace. */
export function isInsideWorkspace(cwd: string, resource: string): boolean {
  const relative = path.relative(path.resolve(cwd), path.resolve(resource));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
