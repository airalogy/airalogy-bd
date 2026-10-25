"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState } from "react";
import { useReactToPrint } from "react-to-print";
import {
  buildLeadershipReport,
  reportFilename,
  reportItemFollowUpLabel,
  reportItemStatusLabel,
  reportToHtml,
  reportToMarkdown,
  type EventOrganization,
  type ExportScope,
  type LeadershipReport,
  type LeadershipReportEvent,
} from "./lib/report";
import type { DashboardData, Project } from "./lib/types";

const exportScopeLabels: Record<ExportScope, string> = {
  current: "当前筛选结果",
  all: "全部事项",
  cooperation: "仅合作项目",
  investment: "仅投资人对接",
  resource: "仅资源对接",
};

const eventOrganizationLabels: Record<EventOrganization, { label: string; note: string }> = {
  grouped: { label: "按事项分组", note: "每条合作或投资线单独阅读" },
  timeline: { label: "按时间线", note: "查看各项最近发生了什么" },
};

function formatCny(value: number | undefined) {
  if (!value) return "—";
  if (value >= 10_000 && value % 10_000 === 0) {
    return `${new Intl.NumberFormat("zh-CN").format(value / 10_000)} 万元`;
  }
  return `${new Intl.NumberFormat("zh-CN").format(value)} 元`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ReportEventsTable({
  events,
  includeSource = false,
}: {
  events: LeadershipReportEvent[];
  includeSource?: boolean;
}) {
  return (
    <table className="report-table report-event-table">
      <thead>
        <tr>
          <th>日期</th>
          {includeSource && <th>所属事项</th>}
          <th>事件</th>
          <th>摘要</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id}>
            <td>{event.date}</td>
            {includeSource && <td><strong>{event.source}</strong></td>}
            <td>{event.title}</td>
            <td>{event.summary}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LeadershipReportPreview({
  report,
  reportRef,
}: {
  report: LeadershipReport;
  reportRef: React.RefObject<HTMLDivElement | null>;
}) {
  const companyEvents = report.events.filter((event) => event.source === "公司事件");

  return (
    <article className="leadership-report" ref={reportRef}>
      <header className="report-masthead">
        <span>{report.workspaceName}</span>
        <h1>{report.title}</h1>
        <p>
          数据更新至 {report.dataDate} · 导出范围：{report.scopeLabel}
        </p>
      </header>

      <section className="report-metrics" aria-label="导出报告摘要">
        <div><span>事项总数</span><strong>{report.stats.total}</strong></div>
        <div><span>合作项目</span><strong>{report.stats.cooperation}</strong></div>
        <div><span>投资人对接</span><strong>{report.stats.investment}</strong></div>
        <div><span>资源对接</span><strong>{report.stats.resource}</strong></div>
        <div><span>高优先级</span><strong>{report.stats.highPriority}</strong></div>
        <div><span>可主动跟进</span><strong>{report.stats.proactiveContact}</strong></div>
      </section>

      <section className="report-section">
        <h2>{report.isInvestmentOnly ? "投资人对接表" : report.isResourceOnly ? "资源对接表" : "事项总览"}</h2>
        {report.items.length > 0 ? (
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>{report.isInvestmentOnly ? "投资人 / 机构" : "事项 / 对接方"}</th>
                  <th>阶段 / 跟进</th>
                  {report.isInvestmentOnly && <th>意向金额</th>}
                  <th>最新进展</th>
                  <th>下一步</th>
                  <th>负责人</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{report.isInvestmentOnly ? item.counterparties || item.name : item.name}</strong>
                      {!report.isInvestmentOnly && <span>{item.counterparties}</span>}
                    </td>
                    <td>
                      <span>{item.stageLabel}</span>
                      <span>{reportItemFollowUpLabel(item)}</span>
                    </td>
                    {report.isInvestmentOnly && (
                      <td>{formatCny(item.targetInvestmentAmountCny)}</td>
                    )}
                    <td>
                      <time dateTime={item.latestDate}>{item.latestDate}</time>
                      <strong>{item.latestTitle}</strong>
                    </td>
                    <td>{item.nextAction}</td>
                    <td>{item.owner}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="report-empty">当前范围内暂无事项。</p>
        )}
      </section>

      <section className="report-section report-item-details">
        <h2>{report.eventOrganization === "grouped" ? "分事项进展" : "重点事项"}</h2>
        {report.items.length > 0 ? report.items.map((item) => (
          <article className="report-item" key={item.id}>
            <h3>{item.name}</h3>
            <dl>
              <div><dt>对接方</dt><dd>{item.counterparties || "—"}</dd></div>
              <div><dt>当前状态</dt><dd>{reportItemStatusLabel(item)}</dd></div>
              <div><dt>最新进展</dt><dd>{item.latestDate} {item.latestTitle}。{item.latestSummary}</dd></div>
              <div><dt>下一步</dt><dd>{item.nextAction}</dd></div>
            </dl>
            <p>{item.summary}</p>
            {report.eventOrganization === "grouped" && (
              <div className="report-item-events">
                <h4>关键事件</h4>
                {report.events.some((event) => event.source === item.name) ? (
                  <ReportEventsTable
                    events={report.events.filter((event) => event.source === item.name)}
                  />
                ) : (
                  <span>暂无关键事件。</span>
                )}
              </div>
            )}
          </article>
        )) : <p className="report-empty">当前范围内暂无事项。</p>}
      </section>

      {report.eventOrganization === "timeline" ? (
        <section className="report-section">
          <h2>核心事件时间线</h2>
          {report.events.length > 0 ? (
            <ReportEventsTable events={report.events} includeSource />
          ) : (
            <p className="report-empty">当前范围内暂无关键事件。</p>
          )}
        </section>
      ) : companyEvents.length > 0 ? (
        <section className="report-section">
          <h2>公司事件</h2>
          <ReportEventsTable events={companyEvents} />
        </section>
      ) : null}

      <footer className="report-footer">
        本报告由 {report.workspaceName} 业务与融资看板生成
      </footer>
    </article>
  );
}

export default function ExportDialog({
  data,
  currentProjects,
  currentScopeLabel,
  includeCurrentCompanyEvents,
  open,
  onOpenChange,
}: {
  data: DashboardData;
  currentProjects: Project[];
  currentScopeLabel: string;
  includeCurrentCompanyEvents: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [scope, setScope] = useState<ExportScope>("current");
  const [eventOrganization, setEventOrganization] =
    useState<EventOrganization>("grouped");
  const [wordStatus, setWordStatus] = useState<"idle" | "working" | "error">("idle");
  const reportRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const report = useMemo(() => {
    let projects = currentProjects;
    let companyEvents = includeCurrentCompanyEvents ? data.company_events : [];
    let scopeLabel = currentScopeLabel;

    if (scope === "all") {
      projects = data.projects;
      companyEvents = data.company_events;
      scopeLabel = "全部事项";
    } else if (scope === "cooperation") {
      projects = data.projects.filter((project) => project.record_type === "cooperation");
      companyEvents = [];
      scopeLabel = "全部合作项目";
    } else if (scope === "investment") {
      projects = data.projects.filter((project) => project.record_type === "investment");
      companyEvents = [];
      scopeLabel = "全部投资人对接";
    } else if (scope === "resource") {
      projects = data.projects.filter((project) => project.record_type === "resource");
      companyEvents = [];
      scopeLabel = "全部资源对接";
    }

    return buildLeadershipReport({
      data,
      projects,
      companyEvents,
      scopeLabel,
      eventOrganization: projects.length > 1 ? eventOrganization : "grouped",
    });
  }, [
    currentProjects,
    currentScopeLabel,
    data,
    eventOrganization,
    includeCurrentCompanyEvents,
    scope,
  ]);

  const printReport = useReactToPrint({
    contentRef: reportRef,
    documentTitle: reportFilename(report, "pdf").replace(/\.pdf$/, ""),
    pageStyle: `
      @page { size: A4 portrait; margin: 12mm; }
      html, body { background: #fff !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .leadership-report { box-shadow: none !important; margin: 0 !important; max-width: none !important; padding: 0 !important; }
      .report-table-wrap { overflow: visible !important; }
      .report-table { font-size: 8.5pt !important; }
      .report-item, .report-table tr { break-inside: avoid; page-break-inside: avoid; }
      .report-section h2, .report-item h3 { break-after: avoid; page-break-after: avoid; }
    `,
  });

  const exportMarkdown = () => {
    const blob = new Blob(["\uFEFF", reportToMarkdown(report)], {
      type: "text/markdown;charset=utf-8",
    });
    downloadBlob(blob, reportFilename(report, "md"));
  };

  const exportHtml = () => {
    const blob = new Blob(["\uFEFF", reportToHtml(report)], {
      type: "text/html;charset=utf-8",
    });
    downloadBlob(blob, reportFilename(report, "html"));
  };

  const exportWord = async () => {
    setWordStatus("working");
    try {
      const { createLeadershipDocx } = await import("./lib/export-docx");
      const blob = await createLeadershipDocx(report);
      downloadBlob(blob, reportFilename(report, "docx"));
      setWordStatus("idle");
    } catch (error) {
      console.error(error);
      setWordStatus("error");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="export-dialog-overlay" />
        <Dialog.Content className="export-dialog" aria-describedby="export-description"
          onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => { event.preventDefault(); openerRef.current?.focus(); }}>
          <header className="export-dialog-head">
            <div>
              <div className="eyebrow">报告导出</div>
              <Dialog.Title>进展摘要</Dialog.Title>
              <Dialog.Description id="export-description">
                统一生成 Markdown、Word 和 PDF 版，保留当前最新数据。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="close-button" aria-label="关闭导出面板">×</button>
            </Dialog.Close>
          </header>

          <div className="export-dialog-body">
            <aside className="export-settings">
              <div className="export-setting-group">
                <span>导出范围</span>
                <div className="export-scope-options">
                  {(Object.entries(exportScopeLabels) as Array<[ExportScope, string]>).map(
                    ([value, label]) => (
                      <button
                        type="button"
                        className={scope === value ? "active" : ""}
                        key={value}
                        onClick={() => setScope(value)}
                        aria-pressed={scope === value}
                      >
                        <strong>{label}</strong>
                        {value === "current" && <small>{currentProjects.length} 个事项</small>}
                      </button>
                    ),
                  )}
                </div>
              </div>

              {report.items.length > 1 && (
                <div className="export-setting-group export-organization-group">
                  <span>事件组织</span>
                  <div className="export-organization-options">
                    {(Object.entries(eventOrganizationLabels) as Array<
                      [EventOrganization, { label: string; note: string }]
                    >).map(([value, option]) => (
                      <button
                        type="button"
                        className={eventOrganization === value ? "active" : ""}
                        key={value}
                        onClick={() => setEventOrganization(value)}
                        aria-pressed={eventOrganization === value}
                      >
                        <strong>{option.label}</strong>
                        <small>{option.note}</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="export-format-group">
                <span>导出格式</span>
                <button type="button" onClick={exportMarkdown}>
                  <i>.md</i><strong>Markdown</strong><small>便于继续编辑</small>
                </button>
                <button type="button" onClick={exportHtml}>
                  <i>HTML</i><strong>HTML</strong><small>浏览器离线查看</small>
                </button>
                <button type="button" onClick={exportWord} disabled={wordStatus === "working"}>
                  <i>W</i><strong>{wordStatus === "working" ? "正在生成…" : "Word"}</strong><small>.docx 可继续编辑和批注</small>
                </button>
                <button type="button" onClick={() => printReport()}>
                  <i>PDF</i><strong>PDF</strong><small>打印窗口中选择存储</small>
                </button>
                {wordStatus === "error" && (
                  <p className="export-error">生成 Word 失败，请重试。</p>
                )}
              </div>

              <p className="export-note">
                PDF 使用系统打印功能生成，中文字体和文字可复制性更稳定。
              </p>
            </aside>

            <div className="export-preview-shell">
              <div className="export-preview-label">
                <span>预览</span>
                <strong>
                  {report.items.length} 个事项 · {report.events.length} 条核心事件 · {eventOrganizationLabels[report.eventOrganization].label}
                </strong>
              </div>
              <div className="export-preview-scroll">
                <LeadershipReportPreview report={report} reportRef={reportRef} />
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
