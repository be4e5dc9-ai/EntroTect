import { describe, it, expect } from "vitest";
import { buildWeeks } from "../../app-desktop/src/renderer/components/UsageOverview.js";
import type { DailyUsage } from "@entrotect/shared";

// 固定"今天"= 2026-08-30(周日),使测试不依赖真实时钟
const TODAY = new Date("2026-08-30T12:00:00");

describe("buildWeeks(热力图分周)", () => {
  it("只有一天数据时也铺满约 27 周(而非 1 列拉伸)", () => {
    const daily: DailyUsage[] = [{ date: "2026-08-30", tokens: 1000, messages: 5 }];
    const weeks = buildWeeks(daily, TODAY);
    expect(weeks.length).toBe(27);
  });

  it("今天所在格被标记 today,且落在正确的星期行(周日)", () => {
    const daily: DailyUsage[] = [{ date: "2026-08-30", tokens: 1000, messages: 5 }];
    const weeks = buildWeeks(daily, TODAY);
    const lastCol = weeks[weeks.length - 1]!;
    // 2026-08-30 是周日 → 最后一列第 0 行
    expect(lastCol[0]!.date).toBe("2026-08-30");
    expect(lastCol[0]!.today).toBe(true);
  });

  it("首数据日早于 26 周前时,按首日星期补幽灵格对齐列首", () => {
    const firstDate = "2025-01-01"; // 早于 floor,触发周首对齐
    const daily: DailyUsage[] = [{ date: firstDate, tokens: 1, messages: 1 }];
    const weeks = buildWeeks(daily, TODAY);
    const pad = new Date(`${firstDate}T00:00:00`).getDay();
    for (let i = 0; i < pad; i += 1) {
      expect(weeks[0]![i]!.date).toBe("");
    }
    expect(weeks[0]![pad]!.date).toBe(firstDate);
    // 网格从首数据日开始(而非 26 周前)
    expect(weeks[0]![pad]!.tokens).toBe(1);
  });
});
