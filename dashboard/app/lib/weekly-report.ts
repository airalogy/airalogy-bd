import type { DashboardData, Project, ProjectEvent } from "./types";

export type ReportPeriod = { from: string; to: string };
export type WeeklyReportEvent = Pick<ProjectEvent, "id" | "date" | "title" | "summary">;
export type WeeklyReportGroup = { id: string; name: string; events: WeeklyReportEvent[] };
export type WeeklyReportSection = {
  kind: Project["record_type"] | "company";
  title: string;
  groups: WeeklyReportGroup[];
};
export type WeeklyReport = {
  workspaceName: string;
  title: string;
  period: ReportPeriod;
  projectCount: number;
  eventCount: number;
  companyEventCount: number;
  sections: WeeklyReportSection[];
};

function isoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function validReportPeriod(period: ReportPeriod): boolean {
  return Boolean(isoDate(period.from) && isoDate(period.to) && period.from <= period.to);
}

export function weekForDate(value: string): ReportPeriod {
  const date = isoDate(value);
  if (!date) throw new Error("日期无效");
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const from = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { from, to: date.toISOString().slice(0, 10) };
}

export function previousWeek(value: string): ReportPeriod {
  const period = weekForDate(value);
  const date = isoDate(period.from)!;
  date.setUTCDate(date.getUTCDate() - 7);
  return weekForDate(date.toISOString().slice(0, 10));
}

export function adjacentReportWeek(period: ReportPeriod, direction: -1 | 1): ReportPeriod | null {
  if (!validReportPeriod(period)) return null;
  const date = isoDate(period.from)!;
  date.setUTCDate(date.getUTCDate() + direction * 7);
  const value = date.toISOString().slice(0, 10);
  if (!isoDate(value)) return null;
  const next = weekForDate(value);
  return validReportPeriod(next) ? next : null;
}

export function workspaceToday(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

export function buildWeeklyReport(data: DashboardData, period: ReportPeriod, participantId = ""): WeeklyReport {
  if (!validReportPeriod(period)) throw new Error("请选择有效的起止日期");
  const inPeriod = (event: ProjectEvent) => event.date >= period.from && event.date <= period.to
    && (!participantId || event.participants.includes(participantId));
  const selectEvents = (events: ProjectEvent[]): WeeklyReportEvent[] => events.filter(inPeriod)
    .map((event) => ({ id: event.id, date: event.date, title: event.title, summary: event.summary }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const kinds = [
    ["cooperation", "合作进展"], ["investment", "投资对接"], ["resource", "资源对接"],
  ] as const;
  const sections: WeeklyReportSection[] = kinds.map(([kind, title]) => ({
    kind, title,
    groups: data.projects.filter((project) => project.record_type === kind).map((project) => ({
      id: project.id, name: project.name, events: selectEvents(project.events),
    })).filter((group) => group.events.length > 0).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
  })).filter((section) => section.groups.length > 0);
  const companyEvents = selectEvents(data.company_events);
  if (companyEvents.length) sections.push({
    kind: "company", title: "公司动态", groups: [{ id: "company", name: "公司动态", events: companyEvents }],
  });
  return {
    workspaceName: data.workspace.short_name, title: "工作周报", period: { ...period },
    projectCount: sections.filter((section) => section.kind !== "company").reduce((count, section) => count + section.groups.length, 0),
    eventCount: sections.reduce((count, section) => count + section.groups.reduce((count, group) => count + group.events.length, 0), 0),
    companyEventCount: companyEvents.length, sections,
  };
}

export function weeklyReportSummary(report: WeeklyReport): string {
  return "本期记录 " + report.eventCount + " 条进展，涉及 " + report.projectCount + " 个事项、" + report.companyEventCount + " 条公司动态。";
}

export function weeklyReportFilename(report: WeeklyReport, extension: string): string {
  return (report.workspaceName + "-" + report.title + "-" + report.period.from + "_" + report.period.to)
    .replace(/[\\/:*?"<>|]/g, "-") + "." + extension;
}

export function weeklyReportToText(report: WeeklyReport): string {
  const lines = [report.workspaceName + " · " + report.title, report.period.from + " — " + report.period.to,
    weeklyReportSummary(report)];
  for (const section of report.sections) {
    lines.push("", section.title);
    for (const group of section.groups) {
      if (section.kind !== "company") lines.push(group.name);
      for (const event of group.events) lines.push("• " + event.date + " " + event.title, event.summary);
    }
  }
  if (!report.eventCount) lines.push("", "所选周期暂无进展记录。");
  return lines.join("\n");
}

const escapeMarkdown = (value: string) => value.replace(/([\\`*_{}\[\]<>#|])/g, "\\$1");
export function weeklyReportToMarkdown(report: WeeklyReport): string {
  const lines = ["# " + escapeMarkdown(report.workspaceName) + " · " + report.title, "",
    "**报告周期**：" + report.period.from + " — " + report.period.to,
    "", weeklyReportSummary(report)];
  for (const section of report.sections) {
    lines.push("", "## " + section.title);
    for (const group of section.groups) {
      if (section.kind !== "company") lines.push("", "### " + escapeMarkdown(group.name));
      for (const event of group.events) lines.push("", "- **" + event.date + " " + escapeMarkdown(event.title) + "**", "  " + escapeMarkdown(event.summary).replaceAll("\n", "\n  "));
    }
  }
  if (!report.eventCount) lines.push("", "所选周期暂无进展记录。");
  return lines.join("\n") + "\n";
}

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export function weeklyReportToHtml(report: WeeklyReport): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.workspaceName)} · ${report.title} · ${report.period.from}</title>
<style>
body{margin:0;background:#f2f5f7;color:#26384a;font:15px/1.7 "Microsoft YaHei","PingFang SC",sans-serif}
main{max-width:820px;margin:32px auto;padding:40px;background:#fff}header{border-top:5px solid #2e74b5;padding-top:16px}
h1{font-size:28px;color:#17365d;margin:8px 0}h2{font-size:20px;color:#2e74b5;border-bottom:1px solid #dce3e9;padding-bottom:8px}h3{font-size:17px;color:#17365d}
.meta,time{font-size:13px;color:#667085}.summary{background:#f3f7fa;padding:16px}article{margin:16px 0}article p{margin:5px 0;white-space:pre-wrap}
@media(max-width:600px){main{padding:20px;margin:0}}@media print{@page{size:A4;margin:16mm}body{background:#fff}main{padding:0;margin:0}article{break-inside:avoid}h2,h3{break-after:avoid}}
</style></head><body><main><header><span>${escapeHtml(report.workspaceName)}</span><h1>${report.title}</h1>
<p class="meta">报告周期：${report.period.from} — ${report.period.to}</p></header>
<p class="summary">${weeklyReportSummary(report)}</p>
${report.sections.map((section) => `<section><h2>${section.title}</h2>${section.groups.map((group) => `<div>${section.kind === "company" ? "" : `<h3>${escapeHtml(group.name)}</h3>`}${group.events.map((event) => `<article><time>${event.date}</time><p><strong>${escapeHtml(event.title)}</strong></p><p>${escapeHtml(event.summary)}</p></article>`).join("")}</div>`).join("")}</section>`).join("")}
${report.eventCount ? "" : "<p>所选周期暂无进展记录。</p>"}
</main></body></html>`;
}
