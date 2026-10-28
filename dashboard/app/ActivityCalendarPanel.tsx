"use client";

import { cloneElement, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityCalendar } from "react-activity-calendar";
import "react-activity-calendar/tooltips.css";
import { activityCalendar } from "./lib/activity-calendar";

const noSubscription = () => () => {};
const serverYear = () => "";
const formatDay = (date: string) => `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
const labels = {
  months: Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
  weekdays: ["日", "一", "二", "三", "四", "五", "六"],
  legend: { less: "少", more: "多" },
};

export default function ActivityCalendarPanel({ events, years, timezone, selectedDate, onSelectDate, onClearDate, description = "按实际发生日期统计，点击有动态的日期查看记录。", scopeLabel = "公司动态", renderDetails }: {
  events: {date: string}[]; description?: string; scopeLabel?: string; years: number[]; timezone: string; selectedDate: string;
  onSelectDate: (date: string) => void; onClearDate: () => void;
  renderDetails?: (selection: {year: number; date: string}) => ReactNode;
}) {
  const titleId = useId();
  const chartRef = useRef<HTMLDivElement>(null);
  const [blockSize, setBlockSize] = useState(11);
  // Use a hydration-safe local year only as the fallback for an empty workspace.
  const currentYear = useSyncExternalStore(noSubscription, () => new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric" }).format(new Date()), serverYear);
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const year = chosenYear ?? years[0] ?? (currentYear ? Number(currentYear) : null);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const observer = new ResizeObserver(([entry]) => {
      // Keep the existing calendar's sizing API; fit 53 weeks without stretching text.
      setBlockSize(Math.max(10, Math.min(18, Math.floor((entry.contentRect.width - 34) / 53) - 3)));
    });
    observer.observe(chart);
    return () => observer.disconnect();
  }, [year]);
  const options = [...new Set([...years, ...(currentYear ? [Number(currentYear)] : []), ...(year ? [year] : [])])].sort((a, b) => b - a);
  const data = year ? activityCalendar(events, year) : [];
  const total = data.reduce((sum, day) => sum + day.count, 0);
  const activeDays = data.filter(day => day.count > 0).length;
  const displayDate = data.some(day => day.date === selectedDate && day.count) ? selectedDate : "";
  const heading = <div className="activity-calendar-heading"><div><h2 id={titleId}>动态日历</h2><p>{description}</p></div>
      {year && <label><span className="sr-only">日历年份</span><select value={year} onChange={event => { setChosenYear(Number(event.target.value)); onClearDate(); }}>{options.map(value => <option key={value} value={value}>{value} 年</option>)}</select></label>}
    </div>;

  return <section className="activity-calendar" aria-labelledby={titleId}>

    {year ? <>
      <div className="activity-calendar-content">
      <div className="activity-calendar-main">
      {heading}
      <div ref={chartRef} className="activity-calendar-chart" role="region" aria-label={`${year} 年${scopeLabel}日历，可横向滚动`} tabIndex={0}>
        <ActivityCalendar data={data} colorScheme="light" theme={{ light: ["#edf1f5", "#b9dbee", "#78b6db", "#3d87b7", "#15557f"] }}
          labels={labels} fontSize={12} blockSize={blockSize} blockMargin={3} blockRadius={2} weekStart={1} showWeekdayLabels={["mon", "wed", "fri"]} showTotalCount={false}
          tooltips={{ activity: { text: day => `${formatDay(day.date)}：${day.count} 条动态${day.count ? "，点击查看" : ""}` }, colorLegend: { text: level => level === 4 ? "每天 4 条及以上" : `每天 ${level} 条` } }}
          renderBlock={(block, day) => cloneElement(block, {
            className: `activity-calendar-day${displayDate === day.date ? " is-selected" : ""}`,
            role: day.count ? "button" : undefined, tabIndex: day.count ? 0 : undefined,
            "aria-hidden": day.count ? undefined : true,
            "aria-label": `${formatDay(day.date)}，${day.count} 条动态`, "aria-pressed": day.count ? displayDate === day.date : undefined,
            onClick: day.count ? () => onSelectDate(day.date) : undefined,
            onKeyDownCapture: day.count ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectDate(day.date); } } : undefined,
            style: { ...block.props.style, ...(displayDate === day.date ? { stroke: "#102d46", strokeWidth: 2 } : {}) },
          })} />
      </div>
      <div className="activity-calendar-status"><span>{scopeLabel}</span>{renderDetails && <span><strong>{total}</strong> 条动态 · <strong>{activeDays}</strong> 个活跃日</span>}</div>
      </div>
      <aside className="activity-calendar-detail" aria-label={renderDetails ? "动态进展" : "年度动态概况"}>
        {renderDetails ? renderDetails({year, date: displayDate}) : <>
          <div className="activity-calendar-totals"><div><strong>{total}</strong><span>条动态</span></div><div><strong>{activeDays}</strong><span>个活跃日</span></div></div>
          <p className="activity-calendar-hint">{total ? "点击有颜色的日期，查看当天记录。" : "当前筛选下暂无动态。"}</p>
          {selectedDate && <div className="activity-calendar-selection" role="status"><span>{formatDay(selectedDate)}</span><button type="button" className="settings-text-button" onClick={onClearDate}>取消日期选择</button></div>}
        </>}
      </aside>
      </div>
    </> : <div>{heading}<p className="admin-help" role="status">正在载入日历…</p></div>}
  </section>;
}
