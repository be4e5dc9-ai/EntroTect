// =====================================================================
// 插件系统测试:hooks 应用函数、主循环集成、目录加载器
// 设计依据:opencode/13 §2——插件异常只 warn 不影响主流程;
// loader 走真实文件系统 + 动态 import。
// =====================================================================

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@entrotect/shared";
import { runAgent } from "../src/loop/agent.js";
import { buildBuiltinTools } from "../src/tools/registry.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import {
  applyChatMessage,
  applyToolBefore,
  loadPluginsFromDir,
} from "../src/plugins/index.js";
import type { PluginHooks } from "../src/plugins/types.js";
import { MockProvider, textBlock, toolCall, turnComplete } from "./helpers/mock-provider.js";

async function makeAgentEnv(): Promise<{ cwd: string; artifactDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "entrotect-plugins-"));
  const artifactDir = path.join(cwd, ".artifacts");
  return { cwd, artifactDir };
}

function makeAgentDeps(cwd: string, artifactDir: string, overrides: Record<string, unknown> = {}) {
  const deps = {
    provider: new MockProvider([]),
    tools: buildBuiltinTools(),
    systemPrompt: buildSystemPrompt({ cwd, model: "mock", platform: "win32", date: "2026-08-23" }),
    maxTokens: 2048,
    emit: () => {},
    approve: async () => ({ decision: "allow-once" as const }),
    cwd,
    artifactDir,
    ...overrides,
  };
  return deps;
}

describe("applyChatMessage", () => {
  it("链式改写:按注册顺序逐个替换,undefined 保持原样", () => {
    const hooks: PluginHooks[] = [
      { "chat.message": (text) => text.replace("你好", "您好") },
      { "chat.message": (text) => text + "!" },
      {}, // 无该钩子的插件直接跳过
      { "chat.message": () => undefined }, // undefined → 保持原样
    ];
    expect(applyChatMessage(hooks, "你好")).toBe("您好!");
  });

  it("hook 抛错只 warn,不中断改写链", () => {
    const hooks: PluginHooks[] = [
      {
        "chat.message": () => {
          throw new Error("boom");
        },
      },
      { "chat.message": (text) => text.toUpperCase() },
    ];
    expect(applyChatMessage(hooks, "abc")).toBe("ABC");
  });
});

describe("applyToolBefore", () => {
  it("返回 JSON 字符串 → 新 args 对象;undefined → 原对象;抛错 → 不影响", () => {
    const original = { file_path: "a.txt" };

    const replacing: PluginHooks[] = [
      { "tool.execute.before": () => JSON.stringify({ file_path: "b.txt" }) },
    ];
    expect(applyToolBefore(replacing, "read", original)).toEqual({ file_path: "b.txt" });

    const passthrough: PluginHooks[] = [
      { "tool.execute.before": () => undefined },
    ];
    expect(applyToolBefore(passthrough, "read", original)).toBe(original);

    const invalidJson: PluginHooks[] = [
      { "tool.execute.before": () => "不是合法JSON{{{" },
    ];
    expect(applyToolBefore(invalidJson, "read", original)).toBe(original);

    const throwing: PluginHooks[] = [
      {
        "tool.execute.before": () => {
          throw new Error("boom");
        },
      },
      { "tool.execute.before": () => JSON.stringify({ file_path: "c.txt" }) },
    ];
    // 抛错 hook 被忽略,后续 hook 继续生效
    expect(applyToolBefore(throwing, "read", original)).toEqual({ file_path: "c.txt" });
  });
});

describe("runAgent 集成", () => {
  it("before 换参生效,after 收到 isError=false 与输出文本", async () => {
    const { cwd, artifactDir } = await makeAgentEnv();
    await writeFile(path.join(cwd, "b.txt"), "plugin saw me", "utf8");

    const beforeCalls: Array<{ toolName: string; args: unknown }> = [];
    const afterCalls: Array<{ toolName: string; output: string; isError: boolean }> = [];
    const hooks: PluginHooks[] = [
      {
        // 模型请求 a.txt,插件改写成 b.txt
        "tool.execute.before": (toolName, args) => {
          beforeCalls.push({ toolName, args });
          return JSON.stringify({ file_path: "b.txt" });
        },
        "tool.execute.after": (toolName, output, isError) => {
          afterCalls.push({ toolName, output, isError });
        },
      },
    ];

    const provider = new MockProvider([
      { events: [toolCall("c1", "read", JSON.stringify({ file_path: "a.txt" })), turnComplete()] },
      { events: [textBlock("完成。"), turnComplete()] },
    ]);
    const deps = makeAgentDeps(cwd, artifactDir, { provider, plugins: hooks });
    const initial: Message[] = [{ role: "user", content: [{ type: "text", text: "读一下" }] }];

    const result = await runAgent(initial, deps);

    expect(result.error).toBeNull();
    // before 收到模型原始 args
    expect(beforeCalls).toHaveLength(1);
    expect(beforeCalls[0]?.toolName).toBe("read");
    expect(beforeCalls[0]?.args).toEqual({ file_path: "a.txt" });
    // 换参生效:读到的实际是 b.txt 的内容
    const toolResult = result.messages[2]?.content[0];
    expect(String(toolResult?.content)).toContain("plugin saw me");
    // after 观察成功结果
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]?.toolName).toBe("read");
    expect(afterCalls[0]?.isError).toBe(false);
    expect(afterCalls[0]?.output).toContain("plugin saw me");
  });

  it("工具失败时 after 收到 isError=true 与错误输出", async () => {
    const { cwd, artifactDir } = await makeAgentEnv();
    const afterCalls: Array<{ toolName: string; output: string; isError: boolean }> = [];
    const hooks: PluginHooks[] = [
      {
        "tool.execute.after": (toolName, output, isError) => {
          afterCalls.push({ toolName, output, isError });
        },
      },
    ];

    const provider = new MockProvider([
      { events: [toolCall("e1", "read", JSON.stringify({ file_path: "missing.txt" })), turnComplete()] },
      { events: [textBlock("换个路径。"), turnComplete()] },
    ]);
    const deps = makeAgentDeps(cwd, artifactDir, { provider, plugins: hooks });
    const initial: Message[] = [{ role: "user", content: [{ type: "text", text: "读 missing.txt" }] }];

    const result = await runAgent(initial, deps);

    expect(result.finalText).toBe("换个路径。");
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0]?.isError).toBe(true);
    expect(afterCalls[0]?.output).toContain("tool_use_error");
  });
});

describe("loadPluginsFromDir", () => {
  it("加载工厂插件、过滤坏文件与无关文件,目录不存在返回 []", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "entrotect-plugins-load-"));

    // 正常插件:默认导出工厂返回 Hooks,缺 name 用文件名
    await writeFile(
      path.join(dir, "hello.mjs"),
      [
        "export default (api) => {",
        "  api.log('loaded');",
        "  return { 'chat.message': (text) => text + '!' };",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    // 坏插件:模块顶层抛错 → loadPluginFile 返回 null 被过滤
    await writeFile(path.join(dir, "broken.mjs"), "throw new Error('broken plugin');\n", "utf8");

    // 非 .mjs 文件:不加载
    await writeFile(path.join(dir, "readme.txt"), "忽略我", "utf8");

    const plugins = await loadPluginsFromDir(dir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("hello");
    expect(applyChatMessage(plugins.map((p) => p.hooks), "hi")).toBe("hi!");

    // 目录不存在 → []
    expect(await loadPluginsFromDir(path.join(dir, "nope"))).toEqual([]);
  });
});
