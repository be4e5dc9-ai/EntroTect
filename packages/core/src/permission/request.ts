import path from "node:path";
import type {
  ApprovalRequest,
  PermissionRisk,
  PermissionRule,
  PermissionTarget,
} from "@entrotect/shared";
import { analyzeCommand } from "../sandbox/index.js";
import type { Tool } from "../tools/types.js";
import type { SandboxMode } from "../sandbox/policy.js";
import { isInsideWorkspace, normalizePermissionResource } from "./rules.js";

type Args = Record<string, unknown>;

function value(args: Args, key: string): string | undefined {
  const candidate = args[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function absolute(cwd: string, requested: string): string {
  return normalizePermissionResource(path.resolve(cwd, requested));
}

function shellRule(command: string, highRisk: boolean): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (highRisk || /[$`(){}]/.test(normalized)) return normalized;
  const tokens = normalized.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  const executable = (tokens[0] ?? normalized).replace(/\.exe$/i, "");
  const lower = executable.toLowerCase();
  const subcommand = tokens[1]?.toLowerCase();
  const prefixSafe: Record<string, readonly string[]> = {
    git: ["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"],
    npm: ["test", "run"],
    pnpm: ["test", "run", "build", "lint", "typecheck"],
    yarn: ["test", "run", "build", "lint", "typecheck"],
    cargo: ["check", "test", "build", "fmt", "clippy"],
    dotnet: ["build", "test", "format"],
  };
  if (!subcommand || !prefixSafe[lower]?.includes(subcommand)) return normalized;
  let keep = 2;
  if (["npm", "pnpm", "yarn"].includes(lower) && subcommand === "run") keep = 3;
  const prefix = tokens.slice(0, keep).join(" ");
  return prefix === normalized ? prefix : `${prefix} *`;
}

/** Split PowerShell command chains without treating separators inside quotes as commands. */
export function splitShellStatements(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    const value = current.trim();
    if (value) statements.push(value.replace(/\s+/g, " "));
    current = "";
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "`") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (char === ";" || char === "\n" || char === "\r" || char === "|" || pair === "&&" || pair === "||") {
      push();
      if (pair === "&&" || pair === "||") index++;
      continue;
    }
    current += char;
  }
  push();
  return statements.length ? statements : [command.trim()];
}

function networkRule(resource: string): string {
  try {
    const url = new URL(resource);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return resource.startsWith("search:") ? "search:*" : resource;
  }
}

function canonicalUrl(resource: string): string {
  try {
    return new URL(resource).toString();
  } catch {
    return resource;
  }
}

function allowRules(targets: PermissionTarget[], highRisk: boolean, workspace: string): PermissionRule[] {
  return targets.flatMap((target): PermissionRule[] => {
    let resource = target.resource;
    if (target.action === "shell") resource = shellRule(target.resource, highRisk);
    else if (target.action === "network" || target.action === "search") resource = networkRule(target.resource);
    else if (target.action === "inspect" && path.isAbsolute(target.resource)) {
      return [
        { action: target.action, resource, effect: "allow", workspace },
        { action: target.action, resource: `${target.resource.replace(/\/$/, "")}/**`, effect: "allow", workspace },
      ];
    }
    else if (target.action === "external" && targets.some((candidate) => candidate.action === "inspect" && candidate.resource === target.resource)) {
      return [
        { action: target.action, resource, effect: "allow", workspace },
        { action: target.action, resource: `${target.resource.replace(/\/$/, "")}/**`, effect: "allow", workspace },
      ];
    }
    return [{ action: target.action, resource, effect: "allow", workspace }];
  }).filter((rule, index, all) =>
    all.findIndex((candidate) => candidate.action === rule.action && candidate.resource === rule.resource) === index,
  );
}

function pathTarget(action: "read" | "edit" | "inspect", cwd: string, requested: string): PermissionTarget {
  return { action, resource: absolute(cwd, requested) };
}

/** Convert validated, plugin-rewritten tool arguments into auditable resources. */
export function buildApprovalRequest(
  toolCallId: string,
  tool: Tool,
  args: unknown,
  cwd: string,
  preview: string,
  sandboxMode: SandboxMode = "full",
): ApprovalRequest {
  const input = (args && typeof args === "object" ? args : {}) as Args;
  let targets: PermissionTarget[];
  let risk: PermissionRisk = tool.isReadOnly ? "low" : "medium";
  let reason: string | undefined;
  let policyEffect: "deny" | undefined;

  switch (tool.name) {
    case "read":
      targets = [pathTarget("read", cwd, value(input, "file_path") ?? preview)];
      break;
    case "glob":
    case "grep":
    case "diagnostics":
      targets = [pathTarget("inspect", cwd, value(input, "path") ?? ".")];
      break;
    case "write":
    case "edit":
    case "library_export":
    case "library_export_table":
      targets = [pathTarget("edit", cwd, value(input, "file_path") ?? preview)];
      break;
    case "library_save":
    case "library_update":
    case "library_remove":
      targets = [{ action: "edit", resource: `library:${value(input, "id") ?? tool.name}` }];
      break;
    case "bash": {
      const command = value(input, "command") ?? preview;
      const statements = splitShellStatements(command);
      const verdict = statements.map(analyzeCommand).find((item) => item.blocked) ?? analyzeCommand(command);
      const opaqueExecution = /(?:\$\(|\biex\b|invoke-expression|encodedcommand|frombase64string)/i.test(command);
      targets = statements.map((statement) => ({ action: "shell", resource: normalizePermissionResource(statement) }));
      if (verdict.blocked) {
        risk = "high";
        reason = `检测到高风险命令：${verdict.reason}`;
        if (sandboxMode === "restricted") policyEffect = "deny";
      } else if (opaqueExecution) {
        risk = "high";
        reason = "命令包含动态或编码执行，无法可靠静态审计，因此只允许精确授权";
      } else {
        reason = "Shell 命令可启动进程并访问工作区之外的系统资源";
      }
      break;
    }
    case "webfetch":
      targets = [{ action: "network", resource: canonicalUrl(value(input, "url") ?? preview) }];
      break;
    case "websearch":
      targets = [{ action: "search", resource: `search:${value(input, "query") ?? preview}` }];
      break;
    case "task":
      targets = [{ action: "subagent", resource: "*" }];
      reason = "子代理本身不获得额外权限；它的工具调用仍逐项经过同一权限闸门";
      break;
    case "kill_shell":
      targets = [{ action: "process", resource: value(input, "id") ?? preview }];
      break;
    case "bash_output":
      targets = [{ action: "inspect", resource: `process:${value(input, "id") ?? preview}` }];
      break;
    case "generate_image": {
      const output = value(input, "file_path");
      const count = typeof input.n === "number" && Number.isInteger(input.n) ? Math.max(1, input.n) : 1;
      const outputs = output
        ? count > 1
          ? Array.from({ length: count }, (_, index) => {
              const extension = path.extname(output);
              const base = output.slice(0, output.length - extension.length);
              return `${base}-${index + 1}${extension}`;
            })
          : [output]
        : [];
      targets = [
        { action: "network", resource: "image-generation:*" },
        ...outputs.map((filePath) => pathTarget("edit", cwd, filePath)),
      ];
      break;
    }
    case "todowrite":
    case "goal":
    case "update_goal":
    case "ultra_direct":
      targets = [{ action: "state", resource: tool.name }];
      break;
    default:
      // Browser operations resolve and authorize their concrete page URL in the
      // host, including redirects. This outer gate only authorizes dispatch.
      targets = [{ action: tool.name.startsWith("browser_") ? "state" : tool.isReadOnly ? "read" : "tool", resource: tool.name }];
  }

  const externalPaths = targets.filter((target) =>
    ["read", "edit", "inspect"].includes(target.action)
    && path.isAbsolute(target.resource)
    && !isInsideWorkspace(cwd, target.resource),
  );
  if (externalPaths.length) {
    targets.push(...externalPaths.map((target) => ({ action: "external", resource: target.resource })));
    risk = "high";
    reason = "该操作会访问当前工作区之外的路径";
  }

  const sensitive = targets.some((target) => /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials|id_rsa|[^/]+\.(?:pem|key))$/i.test(target.resource));
  if (sensitive) {
    risk = "high";
    reason = "该操作会访问可能包含密钥或凭据的文件";
  }

  return {
    toolCallId,
    toolName: tool.name,
    preview,
    description: tool.description,
    workspace: normalizePermissionResource(path.resolve(cwd)),
    targets,
    risk,
    ...(reason ? { reason } : {}),
    ...(policyEffect ? { policyEffect } : {}),
    suggestedRules: allowRules(targets, risk === "high", normalizePermissionResource(path.resolve(cwd))),
  };
}
