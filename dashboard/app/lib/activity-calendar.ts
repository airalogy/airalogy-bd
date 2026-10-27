import type { CompanyEvent, Project, ProjectEvent } from "./types";

export type ScopedActivityEvent = ProjectEvent & {
  activityId: string;
  sourceLabel: string;
  scopeType: "company" | "project";
  projectId?: string;
};

// Call with the already authorized, currently filtered projects and company events.
export function collectActivityEvents(projects: Project[], companyEvents: CompanyEvent[]): ScopedActivityEvent[] {
  return [
    ...projects.flatMap(project => project.events.map(event => ({...event,
      activityId: `project:${project.id}:${event.id}`, projectId: project.id,
      sourceLabel: project.name, scopeType: "project" as const,
    }))),
    ...companyEvents.map(event => ({...event, activityId: `company:${event.id}`,
      sourceLabel: "公司事件", scopeType: "company" as const,
    })),
  ];
}

export function activityYears(events: {date: string}[]) {
  return [...new Set(events.map(event => Number(event.date.slice(0, 4))))]
    .filter(year => Number.isInteger(year) && year >= 1000 && year <= 9999)
    .sort((a, b) => b - a);
}

export function activityCalendar(events: {date: string}[], year: number) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError("Invalid calendar year");
  const counts = new Map<string, number>([[`${year}-01-01`, 0], [`${year}-12-31`, 0]]);
  for (const event of events) {
    if (event.date.startsWith(`${year}-`)) counts.set(event.date, (counts.get(event.date) ?? 0) + 1);
  }
  // The calendar component fills missing dates and handles week alignment/leap years.
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count, level: Math.min(count, 4) }));
}
