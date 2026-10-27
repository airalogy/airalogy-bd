import type { CompanyEvent } from "./types";

const categoryLabels: Record<string, string> = {
  fundraising: "融资与路演",
  "industry-recognition": "行业活动与荣誉",
  "product-launch": "产品发布",
  company: "公司事务",
};

export const companyCategoryLabel = (category: string) =>
  categoryLabels[category] ?? category;

export function filterCompanyEvents(
  events: CompanyEvent[],
  filters: { query: string; category: string; from: string; to: string },
) {
  if (filters.from && filters.to && filters.from > filters.to) return [];
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return events.filter((event) => {
    const text = [
      event.title, event.summary, event.related_document?.markdown,
      ...event.participants, ...(event.organizers ?? []),
      companyCategoryLabel(event.category),
    ].join(" ").toLocaleLowerCase();
    return (filters.category === "all" || event.category === filters.category)
      && (!filters.from || event.date >= filters.from)
      && (!filters.to || event.date <= filters.to)
      && terms.every((term) => text.includes(term));
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export function companyActivityYears(events: CompanyEvent[]) {
  return [...new Set(events.map(event => Number(event.date.slice(0, 4))))]
    .filter(year => Number.isInteger(year) && year >= 1000 && year <= 9999)
    .sort((a, b) => b - a);
}

export function companyActivityCalendar(events: CompanyEvent[], year: number) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError("Invalid calendar year");
  const counts = new Map<string, number>([[`${year}-01-01`, 0], [`${year}-12-31`, 0]]);
  for (const event of events) {
    if (event.date.startsWith(`${year}-`)) counts.set(event.date, (counts.get(event.date) ?? 0) + 1);
  }
  // The calendar component fills missing dates and handles week alignment/leap years.
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count, level: Math.min(count, 4) }));
}
