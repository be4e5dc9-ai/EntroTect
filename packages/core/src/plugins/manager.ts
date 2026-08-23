// =====================================================================
// 插件管理器:hooks 注册表 + 三个同步应用函数
// 设计依据:opencode/13 §2——hooks 在主流程内联调用;
// 铁律:任何 hook 抛错只 console.warn 并忽略该 hook,绝不中断主流程。
// =====================================================================

import type { Plugin, PluginHooks } from "./types.js";

/** 插件注册表(宿主侧持有;v1 只需 hooks 列表即可驱动) */
export class PluginManager {
  private readonly plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  /** 取出全部 hooks,供主流程按序应用 */
  hooks(): PluginHooks[] {
    return this.plugins.map((plugin) => plugin.hooks);
  }
}

/**
 * chat.message 链式改写:按注册顺序逐个 hook 改写文本,
 * 返回 string 即替换当前值,返回 undefined 保持原样。
 */
export function applyChatMessage(hooks: PluginHooks[], text: string): string {
  let current = text;
  for (const hookSet of hooks) {
    const rewrite = hookSet["chat.message"];
    if (!rewrite) continue;
    try {
      const result = rewrite(current);
      if (typeof result === "string") current = result;
    } catch (error) {
      console.warn("[plugins] chat.message hook 抛错,已忽略:", error);
    }
  }
  return current;
}

/**
 * tool.execute.before 链式改写:返回 string 视为新 args 的 JSON 字符串
 * (解析失败则沿用当前 args),返回 undefined 保持原样,其他值直接采用。
 * hook 抛错只 warn 并忽略,绝不中断主流程。
 */
export function applyToolBefore(
  hooks: PluginHooks[],
  toolName: string,
  args: unknown,
): unknown {
  let current = args;
  for (const hookSet of hooks) {
    const rewrite = hookSet["tool.execute.before"];
    if (!rewrite) continue;
    try {
      const result = rewrite(toolName, current);
      if (typeof result === "string") {
        try {
          current = JSON.parse(result);
        } catch {
          console.warn(
            `[plugins] tool.execute.before 返回非法 JSON,已忽略 (${toolName})`,
          );
        }
      } else if (result !== undefined) {
        current = result;
      }
    } catch (error) {
      console.warn(
        `[plugins] tool.execute.before hook 抛错,已忽略 (${toolName}):`,
        error,
      );
    }
  }
  return current;
}

/** tool.execute.after 广播:只观察不修改,抛错仅 warn */
export function notifyToolAfter(
  hooks: PluginHooks[],
  toolName: string,
  output: string,
  isError: boolean,
): void {
  for (const hookSet of hooks) {
    const observe = hookSet["tool.execute.after"];
    if (!observe) continue;
    try {
      observe(toolName, output, isError);
    } catch (error) {
      console.warn(
        `[plugins] tool.execute.after hook 抛错,已忽略 (${toolName}):`,
        error,
      );
    }
  }
}
