"use client";

import { useState, type ReactNode } from "react";
import ActivityCalendarPanel from "./ActivityCalendarPanel";
import { activityYears, type ScopedActivityEvent } from "./lib/activity-calendar";

export default function OverviewActivity({events, timezone, includeCompanyEvents, scopeLabel, renderEvent}: {
  events: ScopedActivityEvent[]; timezone: string; includeCompanyEvents: boolean; scopeLabel: string;
  renderEvent: (event: ScopedActivityEvent) => ReactNode;
}) {
  const [selectedDate, setSelectedDate] = useState("");
  return <section className="panel overview-activity" aria-label="业务与公司统一动态日历">
    <ActivityCalendarPanel events={events} years={activityYears(events)} timezone={timezone} scopeLabel={scopeLabel}
      description={includeCompanyEvents ? "事项进展与公司动态 · 按发生日期统计" : "当前事项进展 · 按发生日期统计"}
      selectedDate={selectedDate} onSelectDate={setSelectedDate} onClearDate={() => setSelectedDate("")}
      renderDay={date => <div className="overview-activity-day" key={date}>
        <div className="event-list" tabIndex={0} role="region" aria-label={`${date} 当天动态`}>
          {events.filter(event => event.date === date).map(event => <div key={event.activityId}>{renderEvent(event)}</div>)}
        </div>
      </div>} />
  </section>;
}
