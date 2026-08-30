// =====================================================================
// 用量聚合:从逐回合记录(usage.jsonl 行)计算 UsageStats。
// 纯函数,便于单元测试;时间相关(日历日/小时)以本地时区为准。
// All/30d/7d 三档汇总各算一份;daily 恒为全量(热力图定位)。
// =====================================================================

import type { DailyUsage, UsageStats, UsageSummary } from "@entrotect/shared";

/** 一条回合用量记录(usage.jsonl 行) */
export interface UsageRecord {
  /** ISO 时间戳 */
  ts: string;
  inputTokens: number;
  outputTokens: number;
  sessionId: string;
  model: string;
}

/** 本地日期 YYYY-MM-DD(用 localIso,避免 UTC 切片在东八区跨天错位) */
function localDateOf(ts: string): string {
  return localIso(new Date(ts));
}

/** Date → 本地日期 YYYY-MM-DD(不用 toISOString,避免 UTC 偏移跨天) */
function localIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localHourOf(ts: string): number {
  return Number(new Date(ts).getHours());
}

/** 升序填满不存在的日期(静默日期),补零 */
function fillRange(sorted: Map<string, { tokens: number; messages: number }>): DailyUsage[] {
  const dates = [...sorted.keys()];
  if (dates.length === 0) return [];
  const start = new Date(`${dates[0]}T00:00:00`);
  const end = new Date(`${dates[dates.length - 1]}T00:00:00`);
  const out: DailyUsage[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = localIso(cursor);
    const entry = sorted.get(iso);
    out.push(
      entry ? { date: iso, tokens: entry.tokens, messages: entry.messages } : { date: iso, tokens: 0, messages: 0 },
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** 连续活跃天数:从今天(或昨天,当今天还没用)往前数连续活跃日 */
function streaks(activeDates: Set<string>): { current: number; longest: number } {
  const dates = [...activeDates].sort();
  let longest = 0;
  let run = 0;
  let prev = "";
  for (const date of dates) {
    run = prev && isNextDay(prev, date) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = date;
  }
  // 当前连击:从今天往前(今天没活跃则从昨天开始)
  let today = localIso(new Date());
  if (!activeDates.has(today)) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    today = localIso(y);
  }
  let current = 0;
  let cursor = today;
  const set = new Set(activeDates);
  while (set.has(cursor)) {
    current += 1;
    const d = new Date(`${cursor}T00:00:00`);
    d.setDate(d.getDate() - 1);
    cursor = localIso(d);
  }
  return { current, longest };
}

function isNextDay(prev: string, next: string): boolean {
  const d = new Date(`${prev}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return localIso(d) === next;
}

/** 对一份记录算汇总(无条件,调用方自行过滤范围);messagesOverride 覆盖消息数(全量档用会话遍历值) */
function summarize(records: UsageRecord[], messagesOverride: number | null = null): UsageSummary {
  const totalTokens = records.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  if (records.length === 0) {
    return {
      sessions: 0,
      messages: 0,
      totalTokens: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      peakHour: 0,
      favoriteModel: "",
    };
  }

  // 每日聚合 + 活跃日期集合
  const byDate = new Map<string, { tokens: number }>();
  const hourTokens = new Array<number>(24).fill(0);
  const modelTokens = new Map<string, number>();
  const sessions = new Set<string>();
  for (const r of records) {
    const date = localDateOf(r.ts);
    const existing = byDate.get(date) ?? { tokens: 0 };
    existing.tokens += r.inputTokens + r.outputTokens;
    byDate.set(date, existing);
    const tokens = r.inputTokens + r.outputTokens;
    const hour = localHourOf(r.ts);
    hourTokens[hour] = (hourTokens[hour] ?? 0) + tokens;
    modelTokens.set(r.model, (modelTokens.get(r.model) ?? 0) + tokens);
    sessions.add(r.sessionId);
  }

  let peakHour = 0;
  let peakTokens = hourTokens[0] ?? 0;
  for (let h = 1; h < 24; h += 1) {
    const tokens = hourTokens[h] ?? 0;
    if (tokens > peakTokens) {
      peakTokens = tokens;
      peakHour = h;
    }
  }

  let favoriteModel = "";
  let bestTokens = -1;
  for (const [model, tokens] of modelTokens) {
    if (tokens > bestTokens) {
      bestTokens = tokens;
      favoriteModel = model;
    }
  }

  const { current, longest } = streaks(new Set(byDate.keys()));

  return {
    sessions: sessions.size,
    messages: messagesOverride ?? records.length,
    totalTokens,
    activeDays: byDate.size,
    currentStreak: current,
    longestStreak: longest,
    peakHour,
    favoriteModel,
  };
}

/**
 * 聚合统计。按时间窗分三档:
 * - all:全部记录
 * - d30:最近 30 天(含今天)
 * - d7 :最近 7 天(含今天)
 * daily 恒为全量(升序,补零),热力图恒定。
 */
export function aggregateUsageStats(
  records: UsageRecord[],
  options: { allMessages: number | null } = { allMessages: null },
): UsageStats {
  const now = new Date();
  const cutoffs = {
    d7: new Date(now),
    d30: new Date(now),
  };
  cutoffs.d7.setHours(0, 0, 0, 0);
  cutoffs.d7.setDate(cutoffs.d7.getDate() - 6);
  cutoffs.d30.setHours(0, 0, 0, 0);
  cutoffs.d30.setDate(cutoffs.d30.getDate() - 29);

  const within = (r: UsageRecord, cutoff: Date): boolean => new Date(r.ts) >= cutoff;

  // 每日聚合(全量)
  const daily = new Map<string, { tokens: number; messages: number }>();
  for (const r of records) {
    const date = localDateOf(r.ts);
    const existing = daily.get(date) ?? { tokens: 0, messages: 0 };
    existing.tokens += r.inputTokens + r.outputTokens;
    existing.messages += 1;
    daily.set(date, existing);
  }

  return {
    all: summarize(records, options.allMessages),
    d30: summarize(records.filter((r) => within(r, cutoffs.d30))),
    d7: summarize(records.filter((r) => within(r, cutoffs.d7))),
    daily: fillRange(daily),
  };
}
