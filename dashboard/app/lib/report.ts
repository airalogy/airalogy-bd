import {
  followUpStatusLabels,
  priorityLabels,
  projectOwnerLabel,
  projectRelationshipLabel,
  recordTypeLabels,
  stageLabels,
} from "./labels";
import type { CompanyEvent, DashboardData, Project } from "./types";

export type ExportScope = "current" | "all" | "cooperation" | "investment" | "resource";
export type EventOrganization = "grouped" | "timeline";

export type LeadershipReportItem = {
  id: string;
  name: string;
  counterparties: string;
  type: Project["record_type"];
  typeLabel: string;
  stageLabel: string;
  priorityLabel: string;
  followUpLabel: string;
  relationshipLabel: string | null;
  owner: string;
  latestDate: string;
  latestTitle: string;
  latestSummary: string;
  summary: string;
  nextAction: string;
  targetInvestmentAmountCny?: number;
};

export type LeadershipReportEvent = {
  id: string;
  date: string;
  source: string;
  title: string;
  summary: string;
};

export type LeadershipReport = {
  workspaceName: string;
  title: string;
  scopeLabel: string;
  dataDate: string;
  generatedAt: string;
  isInvestmentOnly: boolean;
  isResourceOnly: boolean;
  eventOrganization: EventOrganization;
  stats: {
    total: number;
    cooperation: number;
    investment: number;
    resource: number;
    highPriority: number;
    proactiveContact: number;
  };
  items: LeadershipReportItem[];
  events: LeadershipReportEvent[];
};

export type LeadershipReportInput = {
  data: DashboardData;
  projects: Project[];
  companyEvents: CompanyEvent[];
  scopeLabel: string;
  eventOrganization: EventOrganization;
};

function latestEvent(project: Project) {
  return [...project.events].sort((a, b) => b.date.localeCompare(a.date))[0];
}

export function buildLeadershipReport({
  data,
  projects,
  companyEvents,
  scopeLabel,
  eventOrganization,
}: LeadershipReportInput): LeadershipReport {
  const sortedProjects = [...projects].sort(
    (a, b) =>
      b.last_activity.localeCompare(a.last_activity) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
  const isInvestmentOnly =
    sortedProjects.length > 0 &&
    sortedProjects.every((project) => project.record_type === "investment");
  const isResourceOnly =
    sortedProjects.length > 0 &&
    sortedProjects.every((project) => project.record_type === "resource");

  const items = sortedProjects.map((project) => {
    const event = latestEvent(project);
    return {
      id: project.id,
      name: project.name,
      counterparties: project.counterparties.join("、"),
      type: project.record_type,
      typeLabel: recordTypeLabels[project.record_type],
      stageLabel: stageLabels[project.stage] ?? project.stage,
      priorityLabel: `${priorityLabels[project.priority] ?? project.priority}优先级`,
      followUpLabel: followUpStatusLabels[project.follow_up_status],
      relationshipLabel: projectRelationshipLabel(project),
      owner: projectOwnerLabel(project.owner),
      latestDate: event?.date ?? project.last_activity,
      latestTitle: event?.title ?? "暂无事件",
      latestSummary: event?.summary ?? project.summary,
      summary: project.summary,
      nextAction: project.next_action,
      targetInvestmentAmountCny: project.target_investment_amount_cny,
    } satisfies LeadershipReportItem;
  });

  const projectEvents = sortedProjects.flatMap((project) =>
    project.events
      .filter((event) => event.importance === "key")
      .map((event) => ({
        id: `${project.id}-${event.id}`,
        date: event.date,
        source: project.name,
        title: event.title,
        summary: event.summary,
      })),
  );
  const organizationEvents = companyEvents
    .filter((event) => event.importance === "key")
    .map((event) => ({
      id: `company-${event.id}`,
      date: event.date,
      source: "公司事件",
      title: event.title,
      summary: event.summary,
    }));

  return {
    workspaceName: data.workspace.short_name,
    title: isInvestmentOnly
      ? "投资人对接进展"
      : isResourceOnly
        ? "资源对接进展"
        : "业务与融资进展",
    scopeLabel,
    dataDate: data.updated_at ?? "",
    generatedAt: new Date().toISOString(),
    isInvestmentOnly,
    isResourceOnly,
    eventOrganization,
    stats: {
      total: items.length,
      cooperation: items.filter((item) => item.type === "cooperation").length,
      investment: items.filter((item) => item.type === "investment").length,
      resource: items.filter((item) => item.type === "resource").length,
      highPriority: sortedProjects.filter((project) => project.priority === "high")
        .length,
      proactiveContact: sortedProjects.filter(
        (project) => project.follow_up_status === "proactive_contact",
      ).length,
    },
    items,
    events: [...projectEvents, ...organizationEvents].sort(
      (a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source, "zh-CN"),
    ),
  };
}

function escapeMarkdownCell(value: string | number | undefined) {
  if (value === undefined || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function formatCny(value: number | undefined) {
  if (!value) return "—";
  if (value >= 10_000 && value % 10_000 === 0) {
    return `${new Intl.NumberFormat("zh-CN").format(value / 10_000)} 万元`;
  }
  return `${new Intl.NumberFormat("zh-CN").format(value)} 元`;
}

export function reportItemFollowUpLabel(
  item: Pick<LeadershipReportItem, "followUpLabel" | "relationshipLabel">,
  separator = " · ",
) {
  return [item.followUpLabel, item.relationshipLabel].filter(Boolean).join(separator);
}

export function reportItemStatusLabel(item: LeadershipReportItem) {
  return [
    item.typeLabel,
    item.stageLabel,
    item.followUpLabel,
    item.relationshipLabel,
  ].filter(Boolean).join(" · ");
}

function escapeHtml(value: string | number | undefined) {
  if (value === undefined || value === "") return "—";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlId(value: string) {
  return `item-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function eventsToHtml(events: LeadershipReportEvent[], includeSource = false) {
  if (events.length === 0) return '<p class="empty">暂无关键事件。</p>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>日期</th>${includeSource ? "<th>所属事项</th>" : ""}<th>事件</th><th>摘要</th></tr></thead>
        <tbody>
          ${events.map((event) => `
            <tr>
              <td class="nowrap">${escapeHtml(event.date)}</td>
              ${includeSource ? `<td><strong>${escapeHtml(event.source)}</strong></td>` : ""}
              <td>${escapeHtml(event.title)}</td>
              <td>${escapeHtml(event.summary)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

export function reportToHtml(report: LeadershipReport) {
  const companyEvents = report.events.filter((event) => event.source === "公司事件");
  const overviewHead = report.isInvestmentOnly
    ? "<th>投资人 / 机构</th><th>阶段 / 跟进</th><th>意向金额</th><th>最新进展</th><th>下一步</th><th>负责人</th>"
    : "<th>事项 / 对接方</th><th>类型 / 阶段</th><th>优先级 / 跟进</th><th>最新进展</th><th>下一步</th><th>负责人</th>";
  const overviewRows = report.items.map((item) => report.isInvestmentOnly
    ? `<tr>
        <td><a href="#${htmlId(item.id)}"><strong>${escapeHtml(item.counterparties || item.name)}</strong></a></td>
        <td>${escapeHtml(item.stageLabel)}<small>${escapeHtml(reportItemFollowUpLabel(item))}</small></td>
        <td>${escapeHtml(formatCny(item.targetInvestmentAmountCny))}</td>
        <td><time>${escapeHtml(item.latestDate)}</time><strong>${escapeHtml(item.latestTitle)}</strong></td>
        <td>${escapeHtml(item.nextAction)}</td><td>${escapeHtml(item.owner)}</td>
      </tr>`
    : `<tr>
        <td><a href="#${htmlId(item.id)}"><strong>${escapeHtml(item.name)}</strong></a><small>${escapeHtml(item.counterparties)}</small></td>
        <td>${escapeHtml(item.typeLabel)}<small>${escapeHtml(item.stageLabel)}</small></td>
        <td>${escapeHtml(item.priorityLabel)}<small>${escapeHtml(reportItemFollowUpLabel(item))}</small></td>
        <td><time>${escapeHtml(item.latestDate)}</time><strong>${escapeHtml(item.latestTitle)}</strong></td>
        <td>${escapeHtml(item.nextAction)}</td><td>${escapeHtml(item.owner)}</td>
      </tr>`).join("");
  const itemSections = report.items.map((item) => {
    const itemEvents = report.events.filter((event) => event.source === item.name);
    return `
      <details class="item" id="${htmlId(item.id)}" open>
        <summary>
          <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.counterparties)}</small></span>
          <span class="status">${escapeHtml(item.stageLabel)} · ${escapeHtml(reportItemFollowUpLabel(item))}</span>
        </summary>
        <div class="item-body">
          <dl>
            <div><dt>对接方</dt><dd>${escapeHtml(item.counterparties)}</dd></div>
            <div><dt>当前状态</dt><dd>${escapeHtml(reportItemStatusLabel(item))}</dd></div>
            <div><dt>最新进展</dt><dd>${escapeHtml(item.latestDate)} ${escapeHtml(item.latestTitle)}。${escapeHtml(item.latestSummary)}</dd></div>
            <div><dt>下一步</dt><dd>${escapeHtml(item.nextAction)}</dd></div>
            <div><dt>负责人</dt><dd>${escapeHtml(item.owner)}</dd></div>
          </dl>
          <p class="summary">${escapeHtml(item.summary)}</p>
          ${report.eventOrganization === "grouped" ? `<h4>关键事件</h4>${eventsToHtml(itemEvents)}` : ""}
        </div>
      </details>`;
  }).join("");
  const navigation = report.items.map((item) =>
    `<a href="#${htmlId(item.id)}">${escapeHtml(item.name)}</a>`,
  ).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(report.workspaceName)}${escapeHtml(report.title)}</title>
  <style>
    :root{--navy:#17365d;--blue:#2e74b5;--ink:#26384a;--muted:#6f7e90;--line:#dce3e9;--soft:#f3f7fa;--paper:#fff}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#eef2f5;color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",Arial,sans-serif;line-height:1.65}
    a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}.page{background:var(--paper);box-shadow:0 14px 44px rgba(23,54,93,.1);margin:28px auto;max-width:1180px;padding:48px 56px}
    .masthead{border-top:6px solid var(--blue);padding-top:16px}.kicker{color:var(--blue);font-size:12px;font-weight:800;letter-spacing:.08em}.masthead h1{color:var(--navy);font-size:32px;line-height:1.25;margin:9px 0 5px}.meta{color:var(--muted);font-size:12px;margin:0}
    .metrics{background:var(--soft);border:1px solid var(--line);display:grid;grid-template-columns:repeat(6,1fr);margin:26px 0}.metric{border-left:1px solid var(--line);display:grid;gap:2px;padding:13px 15px}.metric:first-child{border-left:0}.metric span{color:var(--muted);font-size:10px}.metric strong{color:var(--navy);font-size:22px}
    nav{align-items:center;border:1px solid var(--line);display:flex;flex-wrap:wrap;gap:7px;margin:22px 0;padding:10px 12px}nav>strong{color:var(--navy);font-size:11px;margin-right:4px}nav a{background:var(--soft);border-radius:999px;font-size:10px;padding:4px 9px}
    section{margin-top:32px;scroll-margin-top:16px}h2{border-bottom:2px solid #cfdeea;color:var(--blue);font-size:19px;margin:0 0 14px;padding-bottom:7px}h4{color:var(--navy);font-size:13px;margin:20px 0 8px}
    .table-wrap{overflow-x:auto}table{border-collapse:collapse;font-size:11px;line-height:1.5;width:100%}th,td{border:1px solid var(--line);padding:8px 9px;text-align:left;vertical-align:top}th{background:var(--navy);color:#fff;white-space:nowrap}td small,td time{color:var(--muted);display:block;font-size:9px;margin-top:2px}td>strong{display:block}.nowrap{white-space:nowrap}.empty{color:var(--muted);font-size:11px}
    .item{border:1px solid var(--line);border-radius:10px;margin:10px 0;scroll-margin-top:16px}.item summary{align-items:center;background:#f8fafb;cursor:pointer;display:flex;gap:20px;justify-content:space-between;padding:13px 15px}.item summary:hover{background:#f1f6f9}.item summary span:first-child{display:grid;gap:1px}.item summary strong{color:var(--navy);font-size:14px}.item summary small{color:var(--muted);font-size:9px}.status{color:#496b86;font-size:10px;white-space:nowrap}.item-body{border-top:1px solid var(--line);padding:16px 18px 20px}.item dl{display:grid;gap:6px;margin:0}.item dl div{display:grid;gap:10px;grid-template-columns:88px 1fr}.item dt{color:var(--muted);font-size:10px;font-weight:700}.item dd{font-size:11px;margin:0}.summary{color:#526274;font-size:11px;margin:13px 0 0}
    footer{border-top:1px solid var(--line);color:#8793a1;font-size:9px;margin-top:36px;padding-top:10px;text-align:right}
    @media(max-width:760px){body{background:#fff}.page{box-shadow:none;margin:0;padding:28px 18px}.masthead h1{font-size:25px}.metrics{grid-template-columns:repeat(2,1fr)}.metric{border-bottom:1px solid var(--line)}.item summary{align-items:flex-start;flex-direction:column;gap:5px}.status{white-space:normal}.item dl div{grid-template-columns:1fr;gap:1px}}
    @media print{@page{size:A4 portrait;margin:12mm}body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}nav{display:none}.item{break-inside:avoid}.item:not([open])>.item-body{display:block}.item summary{list-style:none}tr{break-inside:avoid}a{color:inherit}}
  </style>
</head>
<body>
  <main class="page">
    <header class="masthead"><span class="kicker">${escapeHtml(report.workspaceName)}</span><h1>${escapeHtml(report.title)}</h1><p class="meta">数据更新至 ${escapeHtml(report.dataDate)} · 导出范围：${escapeHtml(report.scopeLabel)} · ${report.eventOrganization === "grouped" ? "按事项分组" : "按时间线"}</p></header>
    <div class="metrics">
      <div class="metric"><span>事项总数</span><strong>${report.stats.total}</strong></div><div class="metric"><span>合作项目</span><strong>${report.stats.cooperation}</strong></div><div class="metric"><span>投资人对接</span><strong>${report.stats.investment}</strong></div><div class="metric"><span>资源对接</span><strong>${report.stats.resource}</strong></div><div class="metric"><span>高优先级</span><strong>${report.stats.highPriority}</strong></div><div class="metric"><span>可主动跟进</span><strong>${report.stats.proactiveContact}</strong></div>
    </div>
    ${report.items.length > 0 ? `<nav aria-label="事项目录"><strong>快速定位</strong><a href="#overview">总览</a>${navigation}${report.eventOrganization === "timeline" ? '<a href="#timeline">时间线</a>' : ""}</nav>` : ""}
    <section id="overview"><h2>${report.isInvestmentOnly ? "投资人对接表" : report.isResourceOnly ? "资源对接表" : "事项总览"}</h2>${report.items.length > 0 ? `<div class="table-wrap"><table><thead><tr>${overviewHead}</tr></thead><tbody>${overviewRows}</tbody></table></div>` : '<p class="empty">当前范围内暂无事项。</p>'}</section>
    <section><h2>${report.eventOrganization === "grouped" ? "分事项进展" : "重点事项"}</h2>${itemSections || '<p class="empty">当前范围内暂无事项。</p>'}</section>
    ${report.eventOrganization === "timeline" ? `<section id="timeline"><h2>核心事件时间线</h2>${eventsToHtml(report.events, true)}</section>` : companyEvents.length > 0 ? `<section><h2>公司事件</h2>${eventsToHtml(companyEvents)}</section>` : ""}
    <footer>本报告由 ${escapeHtml(report.workspaceName)} 业务与融资看板生成。文件内容可离线阅读，不依赖外部网络资源。</footer>
  </main>
</body>
</html>`;
}

export function reportToMarkdown(report: LeadershipReport) {
  const lines = [
    `# ${report.workspaceName}${report.title}`,
    "",
    `> 数据更新至：${report.dataDate}  `,
    `> 导出范围：${report.scopeLabel}  `,
    `> 事件组织：${report.eventOrganization === "grouped" ? "按事项分组" : "按时间线"}`,
    "",
    "## 管理摘要",
    "",
    `- 共 ${report.stats.total} 个事项：合作项目 ${report.stats.cooperation} 个，投资人对接 ${report.stats.investment} 个，资源对接 ${report.stats.resource} 个。`,
    `- 高优先级 ${report.stats.highPriority} 个，可主动跟进 ${report.stats.proactiveContact} 个。`,
    "",
    `## ${report.isInvestmentOnly ? "投资人对接表" : report.isResourceOnly ? "资源对接表" : "事项总览"}`,
    "",
  ];

  if (report.isInvestmentOnly) {
    lines.push(
      "| 投资人 / 机构 | 阶段 / 跟进 | 意向金额 | 最新进展 | 下一步 | 负责人 |",
      "| --- | --- | ---: | --- | --- | --- |",
      ...report.items.map((item) =>
        [
          item.counterparties || item.name,
          `${item.stageLabel} / ${reportItemFollowUpLabel(item, " / ")}`,
          formatCny(item.targetInvestmentAmountCny),
          `${item.latestDate} ${item.latestTitle}`,
          item.nextAction,
          item.owner,
        ]
          .map(escapeMarkdownCell)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      ),
    );
  } else {
    lines.push(
      "| 事项 / 对接方 | 类型 / 阶段 | 优先级 / 跟进 | 最新进展 | 下一步 | 负责人 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...report.items.map((item) =>
        [
          `${item.name}<br>${item.counterparties}`,
          `${item.typeLabel} / ${item.stageLabel}`,
          `${item.priorityLabel} / ${reportItemFollowUpLabel(item, " / ")}`,
          `${item.latestDate} ${item.latestTitle}`,
          item.nextAction,
          item.owner,
        ]
          .map(escapeMarkdownCell)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      ),
    );
  }

  lines.push(
    "",
    `## ${report.eventOrganization === "grouped" ? "分事项进展" : "重点事项"}`,
    "",
  );
  if (report.items.length === 0) {
    lines.push("当前范围内暂无事项。", "");
  } else {
    for (const item of report.items) {
      lines.push(
        `### ${item.name}`,
        "",
        `- **对接方**：${item.counterparties || "—"}`,
        `- **当前状态**：${reportItemStatusLabel(item)}`,
        `- **最新进展**：${item.latestDate} ${item.latestTitle}。${item.latestSummary}`,
        `- **下一步**：${item.nextAction}`,
        `- **负责人**：${item.owner}`,
        "",
        item.summary,
        "",
      );

      if (report.eventOrganization === "grouped") {
        const itemEvents = report.events.filter((event) => event.source === item.name);
        lines.push("关键事件：", "");
        if (itemEvents.length > 0) {
          lines.push(
            "| 日期 | 事件 | 摘要 |",
            "| --- | --- | --- |",
            ...itemEvents.map((event) =>
              [event.date, event.title, event.summary]
                .map(escapeMarkdownCell)
                .join(" | ")
                .replace(/^/, "| ")
                .replace(/$/, " |"),
            ),
            "",
          );
        } else {
          lines.push("暂无关键事件。", "");
        }
      }
    }
  }

  if (report.eventOrganization === "grouped") {
    const companyEvents = report.events.filter((event) => event.source === "公司事件");
    if (companyEvents.length > 0) {
      lines.push(
        "## 公司事件",
        "",
        "| 日期 | 事件 | 摘要 |",
        "| --- | --- | --- |",
        ...companyEvents.map((event) =>
          [event.date, event.title, event.summary]
            .map(escapeMarkdownCell)
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        ),
        "",
      );
    }
  } else {
    lines.push("## 核心事件时间线", "");
    if (report.events.length === 0) {
      lines.push("当前范围内暂无关键事件。", "");
    } else {
      lines.push(
        "| 日期 | 所属事项 | 事件 | 摘要 |",
        "| --- | --- | --- | --- |",
        ...report.events.map((event) =>
          [event.date, event.source, event.title, event.summary]
            .map(escapeMarkdownCell)
            .join(" | ")
            .replace(/^/, "| ")
            .replace(/$/, " |"),
        ),
        "",
      );
    }
  }

  lines.push("---", "", `本文档由 ${report.workspaceName} 业务与融资看板生成。`, "");
  return lines.join("\n");
}

export function reportFilename(report: LeadershipReport, extension: string) {
  const filename = [
    report.dataDate,
    report.workspaceName,
    report.title,
    report.scopeLabel,
  ]
    .join("-")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "")
    .slice(0, 80);
  return `${filename}.${extension}`;
}
