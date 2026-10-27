"use client";

import { useState, type ReactNode } from "react";
import type { CompanyEvent } from "./lib/types";
import { companyCategoryLabel, filterCompanyEvents } from "./lib/company-events";

import ActivityCalendarPanel from "./ActivityCalendarPanel";
import { activityYears } from "./lib/activity-calendar";

export default function CompanyActivity({
  events, renderEvent, timezone = "Asia/Shanghai",
}: {
  events: CompanyEvent[];
  timezone?: string;
  renderEvent: (event: CompanyEvent) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const filtered = filterCompanyEvents(events, { query, category, from, to });
  const visible = selectedDate ? filtered.filter(event => event.date === selectedDate) : filtered;
  const categories = [...new Set(events.map((event) => event.category))].sort();
  const invalidRange = Boolean(from && to && from > to);
  const months = [...new Set(visible.map((event) => event.date.slice(0, 7)))];
  const reset = () => { setQuery(""); setCategory("all"); setFrom(""); setTo(""); setSelectedDate(""); };

  return (
    <section className="panel company-activity" aria-labelledby="company-title">
      <div className="section-heading page-heading">
        <div>
          <div className="eyebrow">活动与里程碑</div>
          <h1 id="company-title">公司动态</h1>
          <p>集中查看参会、路演、行业荣誉和产品发布。</p>
        </div>
        <span>{events.length} 条动态</span>
      </div>
      <div className="company-activity-filters workspace-filters">
        <label className="control-field">
          <span>关键词</span>
          <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setSelectedDate(""); }}
            placeholder="活动、内容或参与人" aria-label="搜索公司动态" />
        </label>
        <label className="control-field">
          <span>活动类型</span>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setSelectedDate(""); }}>
            <option value="all">全部类型</option>
            {categories.map((value) => <option key={value} value={value}>{companyCategoryLabel(value)}</option>)}
          </select>
        </label>
        <label className="control-field">
          <span>开始日期</span>
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setSelectedDate(""); }} aria-invalid={invalidRange} />
        </label>
        <label className="control-field">
          <span>结束日期</span>
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setSelectedDate(""); }} aria-invalid={invalidRange} />
        </label>
        <button type="button" className="history-trigger" onClick={reset}>重置筛选</button>
      </div>
      <ActivityCalendarPanel events={filtered} years={activityYears(events)} timezone={timezone} selectedDate={selectedDate}
        onSelectDate={date => setSelectedDate(current => current === date ? "" : date)} onClearDate={() => setSelectedDate("")} />
      <div className="event-history-status" aria-live="polite">
        <span>显示 {visible.length} / {events.length} 条动态</span>
        {invalidRange && <span className="range-error">开始日期不能晚于结束日期</span>}
      </div>
      {months.map((month) => (
        <section className="event-month-group" key={month} aria-label={month}>
          <h2>{month.replace("-", " 年 ")} 月</h2>
          <div className="event-list">
            {visible.filter((event) => event.date.startsWith(month)).map((event) => (
              <div key={event.id}>{renderEvent(event)}</div>
            ))}
          </div>
        </section>
      ))}
      {visible.length === 0 && !invalidRange && (
        <div className="panel-empty-state">
          {events.length === 0 ? "暂无公司动态。" : "没有符合筛选条件的公司动态。"}
        </div>
      )}
    </section>
  );
}
