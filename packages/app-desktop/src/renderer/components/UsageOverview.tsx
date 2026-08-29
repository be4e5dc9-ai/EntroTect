// =====================================================================
// UsageOverview:空态页用量总览面板(类 Claude Code 打卡页)
// - 8 张统计卡:Sessions / Messages / Total tokens / Active days /
//   Current streak / Longest streak / Peak hour / Favorite model
// - GitHub 风格热力图,All/30d/7d 三档切换
// - 数据来自 usage-stats 事件(主进程聚合)
// =====================================================================

import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { UsageStats } from "@entrotect/shared";

type Range = "all" | "30d" | "7d";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(tokens);
}

/** 本地日期 YYYY-MM-DD → Date(午夜,本地) */
function parseLocal(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

function localIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 热力图按周分桶:列 = 周(周日起始),行 = 周一~周日 */
interface WeekCell {
  date: string;
  tokens: number;
  messages: number;
  today: boolean;
}

function buildWeeks(daily: UsageStats["daily"], range: Range): WeekCell[][] {
  if (daily.length === 0) return [];
  const lastEntry = daily[daily.length - 1]!;
  const lastDate = parseLocal(lastEntry.date);
  let first: Date;
  if (range === "7d") {
    first = new Date(lastDate);
    first.setDate(first.getDate() - 6);
  } else if (range === "30d") {
    first = new Date(lastDate);
    first.setDate(first.getDate() - 29);
  } else {
    first = parseLocal(daily[0]!.date);
  }
  // 补空日 -> 最后记录日为止
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const todayIso = localIso(new Date());
  const cursor = new Date(first);
  const cells: WeekCell[] = [];
  const end = new Date(lastDate);
  while (cursor <= end) {
    const iso = localIso(cursor);
    const entry = byDate.get(iso);
    cells.push({
      date: iso,
      tokens: entry?.tokens ?? 0,
      messages: entry?.messages ?? 0,
      today: iso === todayIso,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  // 周首对齐:周日之前补幽灵格(0=周日;为对齐列首,首列补 0/1~6 格)
  const padDays = new Date(`${cells[0]!.date}T00:00:00`).getDay();
  const padded: WeekCell[] = [
    ...Array.from({ length: padDays }, () => ({ date: "", tokens: 0, messages: 0, today: false })),
    ...cells,
  ];
  // 每 7 个一列
  const weeks: WeekCell[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }
  return weeks;
}

function colorOf(tokens: number, max: number): number {
  if (tokens <= 0) return 0;
  const ratio = max > 0 ? tokens / max : 0;
  if (ratio > 0.8) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export function UsageOverview(): React.JSX.Element | null {
  const stats = useStore((s) => s.usageStats);
  const [range, setRange] = useState<Range>("all");

  const weeks = useMemo(() => {
    if (!stats) return [];
    return buildWeeks(stats.daily, range);
  }, [stats, range]);

  if (!stats || stats.totalTokens === 0 && stats.messages === 0) {
    return (
      <div className="usage-overview">
        <div className="usage-head">
          <span className="usage-title">用量概览</span>
        </div>
        <p className="usage-empty">还没有用量记录,发一条消息开始吧。</p>
      </div>
    );
  }

  const maxTokens = Math.max(1, ...stats.daily.map((d) => d.tokens));

  const statCards: Array<{ label: string; value: string }> = [
    { label: "会话", value: String(stats.sessions) },
    { label: "消息", value: String(stats.messages) },
    { label: "总 tokens", value: formatTokens(stats.totalTokens) },
    { label: "活跃天数", value: String(stats.activeDays) },
    { label: "当前连续", value: `${stats.currentStreak} 天` },
    { label: "最长连续", value: `${stats.longestStreak} 天` },
    { label: "最活跃时段", value: `${String(stats.peakHour).padStart(2, "0")}:00` },
    { label: "常用模型", value: stats.favoriteModel || "—" },
  ];

  return (
    <div className="usage-overview">
      <div className="usage-head">
        <span className="usage-title">用量概览</span>
        <div className="usage-range" role="tablist">
          {(
            [
              ["all", "All"],
              ["30d", "30d"],
              ["7d", "7d"],
            ] as Array<[Range, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`usage-range-btn${range === key ? " active" : ""}`}
              onClick={() => setRange(key)}
              role="tab"
              aria-selected={range === key}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="usage-stats">
        {statCards.map((card) => (
          <div className={`usage-stat${card.label === "常用模型" ? " wide" : ""}`} key={card.label}>
            <span className="usage-stat-label">{card.label}</span>
            <span className="usage-stat-value" title={card.value}>{card.value}</span>
          </div>
        ))}
      </div>

      <div className="usage-heatmap">
        <div className="heatmap-weekdays" aria-hidden="true">
          {WEEKDAYS.map((w) => (
            <span key={w} className="heatmap-weekday">{w}</span>
          ))}
        </div>
        <div className="heatmap-grid">
          {weeks.map((week, wi) => (
            <div className="heatmap-col" key={wi}>
              {week.map((cell, di) => {
                if (!cell.date) {
                  return <span className="heatmap-cell ghost" key={di} />;
                }
                const level = colorOf(cell.tokens, maxTokens);
                return (
                  <span
                    className={`heatmap-cell lv-${level}${cell.today ? " today" : ""}`}
                    key={di}
                    title={`${cell.date} · ${formatTokens(cell.tokens)} tokens${cell.today ? " · 今天" : ""}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <p className="usage-footnote">
        累计 {formatTokens(stats.totalTokens)} tokens · 最常用「{stats.favoriteModel}」
      </p>
    </div>
  );
}
