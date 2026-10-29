import type { Contact, ContactChannels, Project } from "./types";
import type { LibraryFile } from "./file-library";
import { projectOwnerLabel } from "./labels";

export type InvestmentFilters = {
  query: string;
  followUp: string;
  priority: string;
  stage: string;
  bpStatus?: "all" | "sent" | "unrecorded";
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

export function bpSendings(projectId: string, files: LibraryFile[]) {
  return files.filter(file => file.category === "bp" && file.project_ids.includes(projectId)).flatMap(file =>
    file.records.filter(record => record.kind === "sent" && record.project_id === projectId).map(record => {
      const index = file.versions.findIndex(version => version.id === record.version_id);
      return { ...record, fileId: file.id, title: file.title, archived: file.archived,
        versionLabel: index >= 0 ? `v${index + 1}` : "版本信息缺失", filename: file.versions[index]?.filename || "" };
    }),
  ).sort((a, b) => b.date.localeCompare(a.date) || a.fileId.localeCompare(b.fileId) || a.id.localeCompare(b.id));
}

export function filterInvestments(projects: Project[], filters: InvestmentFilters, files: LibraryFile[] = []): Project[] {
  const terms = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const ranks: Record<string, number> = { proactive_contact: 0, active_progress: 1, awaiting_response: 2, on_hold: 3, closed: 4 };
  const priorities = { high: 0, medium: 1, low: 2 };
  return projects.filter((project) => {
    if (project.record_type !== "investment") return false;
    if (filters.followUp !== "all" && project.follow_up_status !== filters.followUp) return false;
    if (filters.priority !== "all" && project.priority !== filters.priority) return false;
    if (filters.stage !== "all" && project.stage !== filters.stage) return false;
    if (filters.missingContact && !needsContactInfo(project)) return false;
    if (filters.bpStatus && filters.bpStatus !== "all" && (bpSendings(project.id, files).length > 0) !== (filters.bpStatus === "sent")) return false;
    const text = [
      project.name, ...project.counterparties, project.owner, projectOwnerLabel(project.owner), project.summary,
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
