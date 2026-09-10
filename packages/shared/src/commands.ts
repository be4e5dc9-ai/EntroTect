/** Built-ins share one catalog between completion, help and host dispatch. Unknown names remain Skills. */
export const SLASH_COMMANDS = [
  { name: "plan", description: "仅规划：先调研与设计，不修改项目", usage: "/plan [任务内容 | on | off | status]" },
  { name: "goal", description: "设定持续目标，跨回合保留进度", usage: "/goal <目标> · status / done / clear / resume" },
  { name: "compact", description: "压缩当前会话上下文", usage: "/compact" },
  { name: "help", description: "查看内置命令用法", usage: "/help" },
] as const;

export type SlashCommand =
  | { kind: "plan"; action: "on" | "off" | "status"; prompt: string }
  | { kind: "goal"; action: "set"; objective: string }
  | { kind: "goal"; action: "status" | "done" | "clear" | "resume" }
  | { kind: "compact" }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

export function parseSlashCommand(text: string): SlashCommand | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const argument = (match[2] ?? "").trim();
  const action = argument.toLowerCase();
  if (name === "plan") {
    if (!argument || action === "on") return { kind: "plan", action: "on", prompt: "" };
    if (action === "off" || action === "status") return { kind: "plan", action, prompt: "" };
    return { kind: "plan", action: "on", prompt: argument };
  }
  if (name === "goal") {
    if (!argument || action === "status") return { kind: "goal", action: "status" };
    if (action === "done" || action === "clear" || action === "resume") return { kind: "goal", action };
    // /goal set allows objectives that happen to match a reserved action.
    const objective = /^set(?:\s|$)/i.test(argument) ? argument.slice(3).trim() : argument;
    return objective
      ? { kind: "goal", action: "set", objective }
      : { kind: "invalid", message: "请在 /goal set 后填写目标内容。" };
  }
  if (name === "compact" || name === "help") {
    return argument
      ? { kind: "invalid", message: `/${name} 不接受参数。` }
      : { kind: name };
  }
  return null;
}

export const SLASH_HELP = SLASH_COMMANDS.map((command) => `${command.usage}\n${command.description}`).join("\n\n");
