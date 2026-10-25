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
