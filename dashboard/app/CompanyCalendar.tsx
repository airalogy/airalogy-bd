"use client";

import { cloneElement, useState, useSyncExternalStore } from "react";
import { ActivityCalendar } from "react-activity-calendar";
import "react-activity-calendar/tooltips.css";
import type { CompanyEvent } from "./lib/types";
import { companyActivityCalendar } from "./lib/company-events";

const noSubscription = () => () => {};
const serverYear = () => "";
const formatDay = (date: string) => `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
const labels = {
  months: Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
  weekdays: ["日", "一", "二", "三", "四", "五", "六"],
  legend: { less: "少", more: "多" },
};

export default function CompanyCalendar({ events, years, timezone, selectedDate, onSelectDate, onClearDate }: {
  events: CompanyEvent[]; years: number[]; timezone: string; selectedDate: string;
  onSelectDate: (date: string) => void; onClearDate: () => void;
}) {
  // Use a hydration-safe local year only as the fallback for an empty workspace.
  const currentYear = useSyncExternalStore(noSubscription, () => new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric" }).format(new Date()), serverYear);
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const year = chosenYear ?? years[0] ?? (currentYear ? Number(currentYear) : null);
  const options = [...new Set([...years, ...(currentYear ? [Number(currentYear)] : []), ...(year ? [year] : [])])].sort((a, b) => b - a);
  const data = year ? companyActivityCalendar(events, year) : [];
  const total = data.reduce((sum, day) => sum + day.count, 0);
  const activeDays = data.filter(day => day.count > 0).length;

  return <section className="company-calendar" aria-labelledby="company-calendar-title">
    <div className="company-calendar-heading"><div><h2 id="company-calendar-title">动态日历</h2><p>按实际发生日期统计，点击有动态的日期查看记录。</p></div>
      {year && <label>日历年份<select value={year} onChange={event => { setChosenYear(Number(event.target.value)); onClearDate(); }}>{options.map(value => <option key={value} value={value}>{value} 年</option>)}</select></label>}
    </div>
    {year ? <>
      <div className="company-calendar-chart" role="region" aria-label={`${year} 年公司动态日历，可横向滚动`} tabIndex={0}>
        <ActivityCalendar data={data} colorScheme="light" theme={{ light: ["#edf1f5", "#b9dbee", "#78b6db", "#3d87b7", "#15557f"] }}
          labels={labels} fontSize={12} blockSize={11} blockMargin={3} blockRadius={2} weekStart={1} showWeekdayLabels={["mon", "wed", "fri"]} showTotalCount={false}
          tooltips={{ activity: { text: day => `${formatDay(day.date)}：${day.count} 条动态${day.count ? "，点击查看" : ""}` }, colorLegend: { text: level => level === 4 ? "每天 4 条及以上" : `每天 ${level} 条` } }}
          renderBlock={(block, day) => cloneElement(block, {
            className: `company-calendar-day${selectedDate === day.date ? " is-selected" : ""}`,
            role: day.count ? "button" : undefined, tabIndex: day.count ? 0 : undefined,
            "aria-hidden": day.count ? undefined : true,
            "aria-label": `${formatDay(day.date)}，${day.count} 条动态`, "aria-pressed": day.count ? selectedDate === day.date : undefined,
            onClick: day.count ? () => onSelectDate(day.date) : undefined,
            onKeyDownCapture: day.count ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectDate(day.date); } } : undefined,
            style: { ...block.props.style, ...(selectedDate === day.date ? { stroke: "#102d46", strokeWidth: 2 } : {}) },
          })} />
      </div>
      <div className="company-calendar-status"><span>{year} 年 · 当前筛选下 {total} 条动态，分布在 {activeDays} 天</span><span>颜色越深，当天动态越多</span></div>
    </> : <p className="admin-help" role="status">正在载入日历…</p>}
    {selectedDate && <div className="company-calendar-selection" role="status"><span>正在查看：{formatDay(selectedDate)}</span><button type="button" className="settings-text-button" onClick={onClearDate}>取消日期选择</button></div>}
  </section>;
}
