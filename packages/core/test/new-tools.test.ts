import { describe, expect, it } from "vitest";
import { buildBuiltinTools } from "../src/tools/index.js";
import { todowriteTool } from "../src/tools/todowrite.js";
import {
  COMPACT_KEEP_RECENT,
  COMPACT_MIN_MESSAGES,
  estimateTokens,
  shouldAutoCompact,
} from "../src/compact.js";
import type { Message } from "@entrotect/shared";

describe("新工具注册表", () => {
  it("包含 webfetch/websearch/todowrite/diagnostics/bash_output/kill_shell", () => {
    const tools = buildBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("webfetch");
    expect(names).toContain("websearch");
    expect(names).toContain("todowrite");
    expect(names).toContain("diagnostics");
    expect(names).toContain("bash_output");
    expect(names).toContain("kill_shell");
    // 只读工具排在写工具之前(prompt cache 前缀稳定)
    const readIdx = names.indexOf("read");
    const writeIdx = names.indexOf("write");
    const bashIdx = names.indexOf("bash");
    expect(readIdx).toBeLessThan(writeIdx);
    expect(readIdx).toBeLessThan(bashIdx);
  });
});

describe("todowrite 计划板", () => {
  it("整表快照写入并返回紧凑进度", async () => {
    const output = await todowriteTool.call(
      {
        todos: [
          { content: "实现 webfetch 工具", status: "completed", priority: "high" },
          { content: "实现 websearch 工具", status: "in_progress", priority: "high" },
          { content: "写测试", status: "pending", priority: "medium" },
        ],
      },
      { cwd: "E:\\Test", artifactDir: "E:\\Test" },
    );
    expect(output).toContain("计划已同步：1/3 已处理");
    expect(output).toContain("当前：实现 websearch 工具");
    expect(todowriteTool.isReadOnly).toBe(true);
  });

  it("同时多个 in_progress 拒绝", async () => {
    await expect(
      todowriteTool.call(
        {
          todos: [
            { content: "a", status: "in_progress", priority: "high" },
            { content: "b", status: "in_progress", priority: "high" },
          ],
        },
        { cwd: "E:\\Test", artifactDir: "E:\\Test" },
      ),
    ).rejects.toThrow("in_progress");
  });
});

describe("compact 阈值与估算", () => {
  it("estimateTokens 粗估为正且随长度增长", () => {
    const one: Message = { role: "user", content: [{ type: "text", text: "你好世界" }] };
    const long: Message = {
      role: "user",
      content: [{ type: "text", text: "x".repeat(2500) }],
    };
    expect(estimateTokens([one])).toBeGreaterThan(0);
    expect(estimateTokens([long])).toBeGreaterThan(estimateTokens([one]));
  });

  it("消息数低于旧下限仍按预算触发", () => {
    const few: Message[] = Array.from({ length: COMPACT_MIN_MESSAGES - 1 }, () => ({
      role: "user",
      content: [{ type: "text", text: "x".repeat(100000) }],
    }));
    expect(shouldAutoCompact(few, "unknown-model")).toBe(true);
  });

  it("保留最近消息数常量合理", () => {
    expect(COMPACT_KEEP_RECENT).toBeGreaterThanOrEqual(2);
    expect(COMPACT_KEEP_RECENT).toBeLessThanOrEqual(12);
  });
});
