import { describe, it, expect } from "vitest";
import { aggregateUsageStats, type UsageRecord } from "../src/session/usage-stats.js";

// 固定时区,保证本地日期归桶的断言跨机器一致(P2-1)
process.env.TZ = "Asia/Shanghai";

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

  it("无记录:三档全零,daily 空", () => {
    const stats = aggregateUsageStats([]);
    expect(stats.all).toEqual({
      sessions: 0,
      messages: 0,
      totalTokens: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      peakHour: 0,
      favoriteModel: "",
    });
    expect(stats.d30.totalTokens).toBe(0);
    expect(stats.d7.totalTokens).toBe(0);
    expect(stats.daily).toEqual([]);
  });

  it("单日记录:all 档聚合总量/活跃 1 天/峰值时段", () => {
    const stats = aggregateUsageStats([
      rec(day(0, 10), 100, 50),
      rec(day(0, 10), 200, 80),
    ]);
    expect(stats.all.totalTokens).toBe(430);
    expect(stats.all.activeDays).toBe(1);
    expect(stats.all.longestStreak).toBe(1);
    expect(stats.all.peakHour).toBe(10);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0]!.tokens).toBe(430);
  });

  it("最近 7 天档只含窗口内记录", () => {
    const stats = aggregateUsageStats([
      rec(day(0), 10, 10),
      rec(day(3), 20, 20),
      rec(day(10), 100, 100), // 10 天前,不在 7d 内但 30d 内
    ]);
    expect(stats.d7.totalTokens).toBe(60);
    expect(stats.d30.totalTokens).toBe(260);
    expect(stats.all.totalTokens).toBe(260);
  });

  it("连续多天:longestStreak 计数", () => {
    const stats = aggregateUsageStats([
      rec(day(0), 10, 10),
      rec(day(1), 10, 10),
      rec(day(2), 10, 10),
    ]);
    expect(stats.all.longestStreak).toBe(3);
    expect(stats.all.currentStreak).toBeGreaterThanOrEqual(2);
  });

  it("favoriteModel 取 token 最大者", () => {
    const stats = aggregateUsageStats([
      rec(day(0, 8), 100, 0, "model-a"),
      rec(day(0, 9), 300, 0, "model-b"),
    ]);
    expect(stats.all.favoriteModel).toBe("model-b");
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
    const stats = aggregateUsageStats([rec(a, 10, 0), rec(b, 20, 0)]);
    expect(stats.daily).toHaveLength(3);
    expect(stats.daily[1]!.tokens).toBe(0);
  });

  it("allMessages 覆盖消息数(会话遍历近真值)", () => {
    const stats = aggregateUsageStats([rec(day(0), 10, 0)], { allMessages: 206 });
    expect(stats.all.messages).toBe(206);
  });

  it("东八区凌晨跨天:UTC 16:30 归入本地次日(P2-1)", () => {
    // 2026-08-29T16:30Z = 东八区 2026-08-30 00:30,须归入 08-30 而非 08-29
    const stats = aggregateUsageStats([rec("2026-08-29T16:30:00.000Z", 10, 0)]);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0]!.date).toBe("2026-08-30");
    expect(stats.all.activeDays).toBe(1);
  });
});
