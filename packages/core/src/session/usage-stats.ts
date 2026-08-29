// =====================================================================
// 用量聚合:从逐回合记录(usage.jsonl 行)计算 UsageStats。
// 纯函数,便于单元测试;时间相关(日历日/小时)以本地时区为准。
// =====================================================================

import type { DailyUsage, UsageStats } from "@entrotect/shared";

/** 一条回合用量记录(usage.jsonl 行) */
export interface UsageRecord {
  /** ISO 时间戳 */
  ts: string;
  inputTokens: number;
  outputTokens: number;
  sessionId: string;
  model: string;
}

/** 本地日期 YYYY-MM-DD */
function localDateOf(ts: string): string {
  return ts.slice(0, 10);
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
    out.push(entry ? { date: iso, tokens: entry.tokens, messages: entry.messages } : { date: iso, tokens: 0, messages: 0 });
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

/**
 * 聚合统计。records 应已含当天用量;messages/sessions 由调用方
 * 从会话存储层补充(本函数不知道消息形状)。
 */
export function aggregateUsageStats(
  records: UsageRecord[],
  extra: { sessions: number; messages: number },
): UsageStats {
  const totalTokens = records.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  if (records.length === 0) {
    return {
      sessions: extra.sessions,
      messages: extra.messages,
      totalTokens: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      peakHour: 0,
      favoriteModel: "",
      daily: [],
    };
  }

  // 每日聚合 + 活跃日期集合
  const byDate = new Map<string, { tokens: number; messages: number }>();
  const hourTokens = new Array<number>(24).fill(0);
  const modelTokens = new Map<string, number>();
  let activeDays = 0;
  for (const r of records) {
    const date = localDateOf(r.ts);
    const existing = byDate.get(date) ?? { tokens: 0, messages: 0 };
    existing.tokens += r.inputTokens + r.outputTokens;
    existing.messages += 1;
    byDate.set(date, existing);
    const tokens = r.inputTokens + r.outputTokens;
    const hour = localHourOf(r.ts);
    hourTokens[hour] = (hourTokens[hour] ?? 0) + tokens;
    modelTokens.set(r.model, (modelTokens.get(r.model) ?? 0) + tokens);
  }
  activeDays = byDate.size;

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
    sessions: extra.sessions,
    messages: extra.messages,
    totalTokens,
    activeDays,
    currentStreak: current,
    longestStreak: longest,
    peakHour,
    favoriteModel,
    daily: fillRange(byDate),
  };
}
