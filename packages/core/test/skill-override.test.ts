import { describe, expect, it } from "vitest";
import {
  isSkillEnabled,
  isSkillInSlash,
  skillOverrideFor,
} from "@entrotect/shared";

const SKILL = "C:\\Users\\me\\.claude\\skills\\animate";

describe("skill overrides: 默认值", () => {
  it("无配置/无该 skill 条目时默认启用且斜杠可见", () => {
    expect(skillOverrideFor(undefined, SKILL)).toEqual({ enabled: true, inSlash: true });
    expect(skillOverrideFor(null, SKILL)).toEqual({ enabled: true, inSlash: true });
    expect(skillOverrideFor({}, SKILL)).toEqual({ enabled: true, inSlash: true });
    expect(isSkillEnabled(undefined, SKILL)).toBe(true);
    expect(isSkillInSlash(undefined, SKILL)).toBe(true);
  });
});

describe("skill overrides: 显式配置", () => {
  it("enabled=false 时完全不可用，斜杠也不可见", () => {
    const config = { skillOverrides: { [SKILL]: { enabled: false, inSlash: true } } };
    expect(isSkillEnabled(config, SKILL)).toBe(false);
    expect(isSkillInSlash(config, SKILL)).toBe(false);
  });

  it("enabled=true 且 inSlash=false 时可用但斜杠不显示", () => {
    const config = { skillOverrides: { [SKILL]: { enabled: true, inSlash: false } } };
    expect(isSkillEnabled(config, SKILL)).toBe(true);
    expect(isSkillInSlash(config, SKILL)).toBe(false);
  });

  it("enabled=true 且 inSlash=true 时斜杠可见", () => {
    const config = { skillOverrides: { [SKILL]: { enabled: true, inSlash: true } } };
    expect(isSkillInSlash(config, SKILL)).toBe(true);
  });

  it("不同 skill 的开关互不影响", () => {
    const other = "C:\\Users\\me\\.claude\\skills\\other";
    const config = { skillOverrides: { [SKILL]: { enabled: false, inSlash: true } } };
    expect(isSkillEnabled(config, other)).toBe(true);
  });
});
