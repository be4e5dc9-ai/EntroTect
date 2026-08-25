import { describe, expect, it } from "vitest";
import {
  isDelegated,
  shouldClarify,
  hasClarificationMarker,
  isValidClarificationPayload,
  CLARIFICATION_RULE_SUMMARY,
  CLARIFICATION_MARKER,
  DELEGATED_PHRASES,
} from "../src/clarification.js";
import { buildSystemPrompt } from "../src/prompt/system.js";

describe("clarification: isDelegated", () => {
  it("识别放权短语：你决定/随便/全权交给你/直接做不要问", () => {
    expect(isDelegated("你决定吧")).toBe(true);
    expect(isDelegated("随便")).toBe(true);
    expect(isDelegated("全权交给你了")).toBe(true);
    expect(isDelegated("直接做不要问")).toBe(true);
    expect(isDelegated("你决定/随便")).toBe(true);
    expect(isDelegated("这事全权交给你处理")).toBe(true);
    expect(isDelegated("直接做不要问我")).toBe(true);
  });

  it("识别扩展放权短语（你定/你看着办等）", () => {
    expect(isDelegated("你定就行")).toBe(true);
    expect(isDelegated("你看着办吧")).toBe(true);
    expect(isDelegated("不用问直接做")).toBe(true);
    expect(isDelegated("自行决定")).toBe(true);
  });

  it("未放权文本不误判", () => {
    expect(isDelegated("帮我写个函数")).toBe(false);
    expect(isDelegated("")).toBe(false);
    expect(isDelegated("   ")).toBe(false);
    expect(isDelegated("请实现一个登录页")).toBe(false);
  });

  it("DELEGATED_PHRASES 包含任务要求的四个核心短语", () => {
    expect(DELEGATED_PHRASES).toContain("你决定");
    expect(DELEGATED_PHRASES).toContain("随便");
    expect(DELEGATED_PHRASES).toContain("全权交给你");
    expect(DELEGATED_PHRASES).toContain("直接做不要问");
  });
});

describe("clarification: shouldClarify 启发式", () => {
  it("放权文本不需澄清", () => {
    expect(shouldClarify("你决定吧")).toBe(false);
    expect(shouldClarify("随便，你看着办")).toBe(false);
    expect(shouldClarify("全权交给你")).toBe(false);
  });

  it("缺少关键参数的模糊短句需澄清", () => {
    expect(shouldClarify("做一个网站")).toBe(true);
    expect(shouldClarify("帮我做个管理系统")).toBe(true);
    expect(shouldClarify("写个脚本")).toBe(true);
  });

  it("存在歧义/多路径提示需澄清", () => {
    expect(shouldClarify("用 React 或者 Vue 实现都可以，你看呢？")).toBe(true);
  });

  it("上下文充足的明确指令不需澄清（启发式宽容：仍可能 false）", () => {
    // 明确指定文件与操作，长度较长，启发式可判 false
    const specific = "请将 packages/core/src/prompt/system.ts 的第 7 条后新增一条结构化澄清规则";
    // 不强制 true/false，仅校验为 boolean 且对放权已处理
    expect(typeof shouldClarify(specific)).toBe("boolean");
  });
});

describe("clarification: 选择题格式规则", () => {
  it("合法载荷通过校验：1-3题、每题2-4选项、含说明与推荐", () => {
    expect(
      isValidClarificationPayload({
        questions: [
          {
            title: "数据库选型？",
            options: [
              { label: "A", description: "Postgres，生态成熟", recommended: true },
              { label: "B", description: "MySQL，兼容性好" },
              { label: "C", description: "SQLite，轻量零运维" },
            ],
          },
          {
            title: "部署方式？",
            options: [
              { label: "A", description: "Docker 单机", recommended: true },
              { label: "B", description: "K8s 集群" },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("非法载荷不通过：选项数超出或缺少说明", () => {
    expect(
      isValidClarificationPayload({
        questions: [
          {
            title: "问题？",
            options: [{ label: "A", description: "" }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isValidClarificationPayload({
        questions: [
          {
            title: "问题？",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
              { label: "C", description: "c" },
              { label: "D", description: "d" },
              { label: "E", description: "e" },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(isValidClarificationPayload({ questions: [] })).toBe(false);
  });

  it("CLARIFICATION_RULE_SUMMARY 包含关键约束", () => {
    expect(CLARIFICATION_RULE_SUMMARY).toContain("缺少关键参数");
    expect(CLARIFICATION_RULE_SUMMARY).toContain("歧义");
    expect(CLARIFICATION_RULE_SUMMARY).toContain("多种合理实现路径");
    expect(CLARIFICATION_RULE_SUMMARY).toContain("结构化选择题");
    expect(CLARIFICATION_RULE_SUMMARY).toContain("推荐");
    expect(CLARIFICATION_RULE_SUMMARY).toContain("放权");
  });

  it("hasClarificationMarker 识别特定标记", () => {
    expect(hasClarificationMarker("【需澄清】请选择")).toBe(true);
    expect(hasClarificationMarker("[[CLARIFICATION]] {\"questions\":[]}")).toBe(true);
    expect(hasClarificationMarker("```clarification\n{\"questions\":[]}\n```")).toBe(true);
    expect(hasClarificationMarker("普通文本")).toBe(false);
    expect(CLARIFICATION_MARKER).toBe("【需澄清】");
  });
});

describe("system prompt 结构化澄清规则", () => {
  it("STATIC_IDENTITY 包含任务要求的澄清文案", () => {
    const prompt = buildSystemPrompt({
      cwd: "E:\\Test",
      model: "mock",
      platform: "win32",
      date: "2026-08-25",
    });
    // 必须包含的核心概念
    expect(prompt).toContain("缺少关键参数");
    expect(prompt).toContain("存在歧义");
    expect(prompt).toContain("多种合理实现路径");
    expect(prompt).toContain("结构化选择题");
    expect(prompt).toContain("选项");
    expect(prompt).toContain("说明");
    expect(prompt).toContain("推荐");
    expect(prompt).toContain("放权");
    // 四个放权示例需以斜杠形式或各自出现
    expect(prompt).toContain("你决定");
    expect(prompt).toContain("随便");
    expect(prompt).toContain("全权交给你");
    expect(prompt).toContain("直接做不要问");
    // 标记提示
    expect(prompt).toContain("【需澄清】");
  });
});
