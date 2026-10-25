import type { Contact, ContactChannels, Project } from "./types";

export type InvestmentFilters = {
  query: string;
  followUp: string;
  priority: string;
  stage: string;
  missingContact: boolean;
  sort: "follow_up" | "recent" | "stale";
};

export function externalContacts(project: Project): Contact[] {
  return project.contacts.filter((contact) => contact.side !== "internal");
}

export function hasContactChannel(person: ContactChannels): boolean {
  return [person.phone, person.wechat, person.email].some((value) => Boolean(value?.trim()));
}

export function needsContactInfo(project: Project): boolean {
  const contacts = externalContacts(project);
  return contacts.length === 0 || contacts.some((contact) => !hasContactChannel(contact));
}

export function filterInvestments(projects: Project[], filters: InvestmentFilters): Project[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const ranks: Record<string, number> = { proactive_contact: 0, active_progress: 1, awaiting_response: 2, on_hold: 3, closed: 4 };
  const priorities = { high: 0, medium: 1, low: 2 };
  return projects.filter((project) => {
    if (project.record_type !== "investment") return false;
    if (filters.followUp !== "all" && project.follow_up_status !== filters.followUp) return false;
    if (filters.priority !== "all" && project.priority !== filters.priority) return false;
    if (filters.stage !== "all" && project.stage !== filters.stage) return false;
    if (filters.missingContact && !needsContactInfo(project)) return false;
    const text = [
      project.name, ...project.counterparties, project.owner, project.summary,
      project.next_action, project.source_note, ...project.sourced_by,
      ...externalContacts(project).flatMap((contact) => [
        contact.name, contact.affiliation, contact.phone, contact.wechat, contact.email, contact.notes,
      ]),
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => {
    if (filters.sort === "recent") return b.last_activity.localeCompare(a.last_activity) || a.name.localeCompare(b.name, "zh-CN");
    if (filters.sort === "stale") return a.last_activity.localeCompare(b.last_activity) || a.name.localeCompare(b.name, "zh-CN");
    return (ranks[a.follow_up_status] - ranks[b.follow_up_status])
      || (priorities[a.priority] - priorities[b.priority])
      || a.last_activity.localeCompare(b.last_activity)
      || a.name.localeCompare(b.name, "zh-CN");
  });
}

// Spreadsheet applications may interpret leading formula characters even in quoted CSV cells.
export function csvCell(value: string | null | undefined): string {
  let text = value ?? "";
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
