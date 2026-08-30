// =====================================================================
// 插件加载器:目录扫描 + 动态 import
// 设计依据:opencode/13 §2 ".opencode/plugin 自动发现" 的宿主侧 v1——
// 只扫 {appData}/plugins 下的 *.mjs,default export 为工厂或 Hooks 对象。
// 铁律:任何插件文件加载异常只 console.warn 并跳过,不影响宿主启动。
// =====================================================================

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, PluginFactory, PluginHooks } from "./types.js";

/**
 * 加载单个插件文件。default export 为函数则调用之(注入 {log}),
 * 得到 Plugin 或 PluginHooks 再包装;缺 name 时用文件名(去 .mjs)。
 * 任何异常 console.warn 并返回 null。
 */
export async function loadPluginFile(filePath: string): Promise<Plugin | null> {
  const fallbackName = path.basename(filePath, ".mjs");
  try {
    const mod = (await import(pathToFileURL(filePath).href)) as {
      default?: unknown;
    };
    const exported = mod.default;

    if (typeof exported === "function") {
      // 工厂形态:注入宿主 API,返回值可能是 Promise(兼容异步工厂)
      const result = (await (exported as PluginFactory)({
        log: (...args: unknown[]) => console.log("[plugin]", ...args),
      })) as Plugin | PluginHooks;
      const plugin = wrapPlugin(result, fallbackName);
      if (!plugin) {
        console.warn(`[plugins] ${filePath} 工厂未返回 hooks 对象,已跳过`);
      }
      return plugin;
    }

    if (exported && typeof exported === "object") {
      // 直接导出 Plugin / PluginHooks
      return wrapPlugin(exported as Plugin | PluginHooks, fallbackName);
    }

    console.warn(`[plugins] ${filePath} 未导出工厂函数或 hooks 对象,已跳过`);
    return null;
  } catch (error) {
    console.warn(`[plugins] 加载插件失败: ${filePath}`, error);
    return null;
  }
}

/** 把 Plugin 或裸 PluginHooks 包装成 Plugin,缺 name 时用文件名 */
function wrapPlugin(
  result: Plugin | PluginHooks,
  fallbackName: string,
): Plugin | null {
  if (!result || typeof result !== "object") return null;
  if ("hooks" in result) {
    return { name: result.name || fallbackName, hooks: result.hooks };
  }
  return { name: fallbackName, hooks: result as PluginHooks };
}

/**
 * 加载目录下全部 *.mjs 插件。目录不存在返回 [];
 * 单个文件加载失败(null)被过滤,不影响其余插件。
 */
export async function loadPluginsFromDir(dir: string): Promise<Plugin[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // 目录不存在:视为无插件
    return [];
  }

  const plugins: Plugin[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".mjs")) continue;
    const filePath = path.join(dir, entry);
    const plugin = await loadPluginFile(filePath);
    if (plugin) {
      plugins.push(plugin);
      // 加载成功即在主进程日志记录(console.warn 级别,便于审计插件清单)
      console.warn(`[plugins] 已加载插件: ${plugin.name} (${filePath})`);
    }
  }
  return plugins;
}
