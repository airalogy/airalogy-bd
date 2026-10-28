"use client";

import { useId, useState, type ReactNode } from "react";
import ActivityCalendarPanel from "./ActivityCalendarPanel";
import { activityFeed, activityYears, type ScopedActivityEvent } from "./lib/activity-calendar";

const formatDay = (date: string) => `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;

export default function OverviewActivity({events, timezone, includeCompanyEvents, scopeLabel, renderEvent, historyAction}: {
  events: ScopedActivityEvent[]; timezone: string; includeCompanyEvents: boolean; scopeLabel: string;
  renderEvent: (event: ScopedActivityEvent) => ReactNode; historyAction: ReactNode;
}) {
  const [selectedDate, setSelectedDate] = useState("");
  const [keyEventsOnly, setKeyEventsOnly] = useState(false);
  const feedId = useId();
  return <section className="panel overview-activity" id="events" aria-label="动态日历与进展">
    <ActivityCalendarPanel events={events} years={activityYears(events)} timezone={timezone} scopeLabel={scopeLabel}
      description={includeCompanyEvents ? "事项进展与公司动态 · 点击日期查看当天进展" : "当前事项进展 · 点击日期查看当天进展"}
      selectedDate={selectedDate} onSelectDate={date => setSelectedDate(current => current === date ? "" : date)} onClearDate={() => setSelectedDate("")}
      renderDetails={({year, date}) => {
        const visible = activityFeed(events, {year, date, keyOnly: keyEventsOnly});
        const title = date ? "当天进展" : "最近进展";
        return <section className={`activity-feed${date ? " is-day" : ""}`} aria-label={title}>
          <div className="activity-feed-heading"><h3>{title}</h3>
            {date && <button type="button" className="settings-text-button" onClick={() => setSelectedDate("")}>返回最近进展</button>}
          </div>
          <div className="activity-feed-toolbar">
            <span role="status">{date ? `${formatDay(date)} · ${visible.length} 条` : `${year} 年 · 最近 ${visible.length} 条`}</span>
            <div className="event-panel-actions">
              <button type="button" className="history-trigger event-key-filter" aria-pressed={keyEventsOnly} aria-controls={feedId}
                onClick={() => setKeyEventsOnly(current => !current)}>仅看关键</button>
              {historyAction}
            </div>
          </div>
          <div className="event-list" id={feedId} tabIndex={0} role="region" aria-label={date ? `${date} 当天进展列表` : `${year} 年最近进展列表`} key={`${date}:${year}:${keyEventsOnly}`}>
            {visible.map(event => <div key={event.activityId}>{renderEvent(event)}</div>)}
            {!visible.length && <p className="activity-calendar-empty">{keyEventsOnly ? "当前范围内暂无关键进展，可关闭“仅看关键”查看。" : "当前范围内暂无进展。"}</p>}
          </div>
        </section>;
      }} />
  </section>;
}
