import type { SessionControls } from "@entrotect/shared";
import type { Tool } from "./types.js";

const SAFE_POWERSHELL = /^(?:get|test|resolve|select|measure|compare|format|sort|group)-[a-z0-9-]+\b/i;
const SAFE_SIMPLE = /^(?:rg|fd|findstr|where(?:\.exe)?|tree|dir|ls|pwd)\b/i;
const SAFE_GIT = /^git\s+(?:status|diff|log|show|grep|rev-parse|ls-files|describe|shortlog|blame|remote\s+-v)(?:\s|$)/i;
const SAFE_CHECK = /^(?:pnpm|npm|yarn|bun|npx|cargo|go|dotnet|mvn|gradle|\.\\gradlew(?:\.bat)?|\.\/gradlew)\b[\s\S]*\b(?:test|build|check|typecheck|lint|vitest|jest|pytest|tsc|clippy|vet)\b/i;
const FORBIDDEN_ANYWHERE = /(?:^|\s|[|;&])(set-content|add-content|out-file|tee-object|remove-item|move-item|copy-item|rename-item|new-item|clear-content|invoke-expression|start-process|apply_patch|rm|del|erase|rmdir|mkdir|cp|mv|touch|git\s+(?:add|commit|push|pull|fetch|merge|rebase|reset|restore|checkout|switch|clean|tag)|(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|publish)|--fix\b|--write\b|--apply\b|--output(?:=|\s)|(?:node|python|py|ruby|perl)\s+(?:-e|-c)\b)/i;

export interface PlanCommandVerdict { allowed: boolean; reason?: string }

/** Conservative classifier for Plan-mode shell calls. Unknown commands fail closed. */
export function analyzePlanCommand(command: string, background = false): PlanCommandVerdict {
  const source = command.trim();
  if (!source) return { allowed: false, reason: "命令为空" };
  if (background) return { allowed: false, reason: "规划模式不启动后台进程" };
  if (/[<>]/.test(source) || FORBIDDEN_ANYWHERE.test(source)) {
    return { allowed: false, reason: "命令包含写入、进程启动或版本库变更操作" };
  }
  // Check every statement/pipeline stage so `rg x; Set-Content ...` cannot hide behind a safe prefix.
  const stages = source.split(/(?:\r?\n|;|\|{1,2}|&&)/).map((part) => part.trim()).filter(Boolean);
  for (const stage of stages) {
    if (/^(?:set-location|write-output)\b/i.test(stage)) continue;
    if (SAFE_POWERSHELL.test(stage) || SAFE_SIMPLE.test(stage) || SAFE_GIT.test(stage) || SAFE_CHECK.test(stage)) continue;
    return { allowed: false, reason: `无法确认是非变更命令：${stage.slice(0, 80)}` };
  }
  return { allowed: true };
}

function readonlyBash(tool: Tool): Tool {
  return {
    ...tool,
    description: "规划模式的非变更 Shell：仅用于仓库探索、测试、构建和静态检查；拒绝写文件、安装、格式化修复、Git 变更、后台进程及无法确认安全的命令。",
    isReadOnly: true,
    async call(rawArgs, ctx) {
      const args = rawArgs as { command?: unknown; background?: unknown };
      const command = typeof args?.command === "string" ? args.command : "";
      const verdict = analyzePlanCommand(command, args?.background === true);
      if (!verdict.allowed) throw new Error(`[Plan mode] ${verdict.reason}。请继续只读调研，或让用户用 /plan off 退出规划模式。`);
      return tool.call(rawArgs, ctx);
    },
  };
}

/** Plan mode keeps research/validation tools, removes implementation and Todo tools. */
export function toolsForSession(tools: Tool[], controls?: SessionControls): Tool[] {
  if (controls?.mode !== "plan") return tools;
  return tools.flatMap((tool) => {
    if (["write", "edit", "generate_image", "kill_shell", "todowrite"].includes(tool.name)) return [];
    if (tool.name === "bash") return [readonlyBash(tool)];
    if (tool.name === "task") return [{ ...tool, isReadOnly: true, description: "把独立的只读代码探索、资料调研或方案复核交给子代理；子代理同样处于 Plan mode，不能实施修改。" }];
    return [tool];
  });
}
