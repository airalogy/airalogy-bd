import { followUpStatusLabels, recordTypeLabels, roleLabels, stageLabels } from "./labels";
import type { Project } from "./types";

/** The drawer passes exactly one already authorized matter, including when viewing a snapshot. */
export function matterBriefMarkdown(project: Project, includeRecords = false, historical = false): string {
  const lines = [`# ${project.name}`, "", historical ? "事项背景（历史版本）" : "事项背景", ""];
  if (project.counterparties.length) lines.push(`- 对接方：${project.counterparties.join("、")}`);
  lines.push(`- 类型：${recordTypeLabels[project.record_type]}`, `- 当前阶段：${stageLabels[project.stage] ?? project.stage}`,
    `- 跟进状态：${followUpStatusLabels[project.follow_up_status]}`);
  if (project.owner && project.owner !== "待确认") lines.push(`- 负责人：${project.owner}`);
  if (project.summary) lines.push("", "## 背景摘要", "", project.summary);

  if (project.contacts.length) {
    lines.push("", "## 相关人员", "");
    for (const person of project.contacts) {
      const roles = person.project_roles.map(role => roleLabels[role] ?? role).join("、");
      lines.push(`- ${[person.name, person.affiliation, roles].filter(Boolean).join(" · ")}`);
    }
  }

  const people = new Map(project.contacts.map(person => [person.person_id, person.name]));
  lines.push("", "## 沟通进展", "");
  if (!project.events.length) lines.push("暂无沟通进展记录。");
  for (const event of [...project.events].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push(`### ${event.date} ${event.title}`, "");
    if (event.participants.length) lines.push(`参与人：${event.participants.map(id => people.get(id) ?? id).join("、")}`, "");
    if (event.summary) lines.push(event.summary, "");
    const document = event.related_document;
    if (includeRecords && document?.markdown.trim()) {
      const record = [document.title && `# ${document.title}`, document.markdown.trim()].filter(Boolean).join("\n\n");
      lines.push("完整沟通记录", "", ...record.split(/\r?\n/).map(line => line ? `> ${line}` : ">"), "");
    }
  }
  lines.push("", "## 下一步", "", project.next_action || "暂无已记录的下一步。");
  if (project.next_action_due) lines.push("", `期限：${project.next_action_due}`);
  if (project.management_decisions.length) lines.push("", "## 待决事项", "", ...project.management_decisions.map(item => `- ${item}`));
  return lines.join("\n").trimEnd() + "\n";
}

export function matterBriefFilename(name: string): string {
  return `事项背景-${name.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 80)}.md`;
}
