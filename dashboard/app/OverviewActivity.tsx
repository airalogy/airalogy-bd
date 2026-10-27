"use client";

import { useState, type ReactNode } from "react";
import ActivityCalendarPanel from "./ActivityCalendarPanel";
import { activityYears, type ScopedActivityEvent } from "./lib/activity-calendar";

export default function OverviewActivity({events, timezone, includeCompanyEvents, scopeLabel, renderEvent}: {
  events: ScopedActivityEvent[]; timezone: string; includeCompanyEvents: boolean; scopeLabel: string;
  renderEvent: (event: ScopedActivityEvent) => ReactNode;
}) {
  const [selectedDate, setSelectedDate] = useState("");
  const daily = events.filter(event => event.date === selectedDate);
  const projectCount = events.filter(event => event.scopeType === "project").length;
  const companyCount = events.length - projectCount;
  return <section className="panel overview-activity" aria-label="业务与公司统一动态日历">
    <ActivityCalendarPanel events={events} years={activityYears(events)} timezone={timezone} scopeLabel="业务与公司动态"
      description={includeCompanyEvents ? "汇总事项进展与公司动态，按实际发生日期统计。点击日期查看当天记录。" : "按当前事项筛选范围统计实际发生日期。点击日期查看当天进展。"}
      selectedDate={selectedDate} onSelectDate={date => setSelectedDate(current => current === date ? "" : date)} onClearDate={() => setSelectedDate("")} />
    <p className="overview-activity-scope">{scopeLabel} · 事项进展 {projectCount} 条{includeCompanyEvents ? ` · 公司动态 ${companyCount} 条` : " · 当前不包含公司动态"}</p>
    {selectedDate && <section className="overview-activity-day" aria-label={`${selectedDate} 当天动态`}>
      <h3>{selectedDate} · {daily.length} 条动态</h3>
      <div className="event-list">{daily.map(event => <div key={event.activityId}>{renderEvent(event)}</div>)}</div>
      {!daily.length && <p className="admin-help">当前范围内该日暂无动态。</p>}
    </section>}
  </section>;
}
