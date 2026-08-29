import { describe, it, expect } from "vitest";
import { aggregateUsageStats, type UsageRecord } from "../src/session/usage-stats.js";

function rec(ts: string, input: number, output: number, model = "deepseek-chat"): UsageRecord {
  return { ts, inputTokens: input, outputTokens: output, sessionId: "s1", model };
}

describe("aggregateUsageStats", () => {
  const day = (offset: number, hour = 12): string =>
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    })();

  it("无记录:全部归零", () => {
    const stats = aggregateUsageStats([], { sessions: 2, messages: 5 });
    expect(stats).toEqual({
      sessions: 2,
      messages: 5,
      totalTokens: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      peakHour: 0,
      favoriteModel: "",
      daily: [],
    });
  });

  it("单日记录:聚合总量/活跃 1 天/峰值时段", () => {
    const stats = aggregateUsageStats(
      [
        rec(day(0, 10), 100, 50),
        rec(day(0, 10), 200, 80),
      ],
      { sessions: 1, messages: 2 },
    );
    expect(stats.totalTokens).toBe(430);
    expect(stats.activeDays).toBe(1);
    expect(stats.longestStreak).toBe(1);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].tokens).toBe(430);
    expect(stats.daily[0].messages).toBe(2);
  });

  it("连续多天:longestStreak 计数", () => {
    const stats = aggregateUsageStats(
      [rec(day(0), 10, 10), rec(day(1), 10, 10), rec(day(2), 10, 10)],
      { sessions: 1, messages: 3 },
    );
    expect(stats.longestStreak).toBe(3);
    expect(stats.currentStreak).toBeGreaterThanOrEqual(2);
  });

  it("峰值时段按 token 总量", () => {
    const stats = aggregateUsageStats(
      [
        rec(day(0, 8), 10, 10),
        rec(day(0, 16), 500, 500),
      ],
      { sessions: 1, messages: 2 },
    );
    expect(stats.peakHour).toBe(16);
    expect(stats.totalTokens).toBe(1020);
  });

  it("favoriteModel 取 token 最大者", () => {
    const stats = aggregateUsageStats(
      [
        rec(day(0, 8), 100, 0, "model-a"),
        rec(day(0, 9), 300, 0, "model-b"),
      ],
      { sessions: 1, messages: 2 },
    );
    expect(stats.favoriteModel).toBe("model-b");
  });

  it("daily 升序连续,间隙日期补零", () => {
    const a = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 2);
      d.setHours(8, 0, 0, 0);
      return d.toISOString();
    })();
    const b = (() => {
      const d = new Date();
      d.setHours(8, 0, 0, 0);
      return d.toISOString();
    })();
    const stats = aggregateUsageStats([rec(a, 10, 0), rec(b, 20, 0)], { sessions: 1, messages: 2 });
    expect(stats.daily).toHaveLength(3);
    expect(stats.daily[1].tokens).toBe(0);
  });
});
