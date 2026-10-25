"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState } from "react";
import { useReactToPrint } from "react-to-print";
import type { DashboardData } from "./lib/types";
import {
  adjacentReportWeek, buildWeeklyReport, validReportPeriod, weekForDate, workspaceToday,
  weeklyReportFilename, weeklyReportSummary, weeklyReportToHtml, weeklyReportToMarkdown,
  weeklyReportToText, type WeeklyReport,
} from "./lib/weekly-report";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function WeeklyPreview({ report, reportRef }: {
  report: WeeklyReport;
  reportRef: React.RefObject<HTMLDivElement | null>;
}) {
  return <article className="leadership-report weekly-report" ref={reportRef}>
    <header className="report-masthead">
      <span>{report.workspaceName}</span><h1>{report.title}</h1>
      <p>报告周期：{report.period.from} — {report.period.to}</p>
    </header>
    <p className="weekly-report-summary">{weeklyReportSummary(report)}</p>
    {report.sections.map((section) => <section className="report-section" key={section.kind}>
      <h2>{section.title}</h2>
      {section.groups.map((group) => <div className="weekly-report-group" key={group.id}>
        {section.kind !== "company" && <h3>{group.name}</h3>}
        {group.events.map((event) => <article className="weekly-report-event" key={event.id}>
          <time dateTime={event.date}>{event.date}</time>
          <h4>{event.title}</h4><p>{event.summary}</p>
        </article>)}
      </div>)}
    </section>)}
    {report.eventCount === 0 && <p className="report-empty">所选周期暂无进展记录。</p>}
  </article>;
}

export default function WeeklyReportDialog({ data, open, onOpenChange }: {
  data: DashboardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [period, setPeriod] = useState(() => weekForDate(workspaceToday(data.workspace.timezone)));
  const [participant, setParticipant] = useState("");
  const [wordStatus, setWordStatus] = useState<"idle" | "working" | "error">("idle");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const reportRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const valid = validReportPeriod(period);
  const report = useMemo(() => valid ? buildWeeklyReport(data, period, participant) : null, [data, period, participant, valid]);
  const disabled = !report || report.eventCount === 0;
  const today = workspaceToday(data.workspace.timezone);
  const currentWeek = weekForDate(today);
  const previousPeriod = adjacentReportWeek(period, -1);
  const nextPeriod = adjacentReportWeek(period, 1);
  const latestWeek = data.updated_at ? weekForDate(data.updated_at) : null;
  const isCurrentWeek = period.from === currentWeek.from && period.to === currentWeek.to;
  const isCustomPeriod = valid && (period.from !== weekForDate(period.from).from || period.to !== weekForDate(period.from).to);
  const participantIds = new Set([
    ...data.projects.flatMap((project) => project.events.flatMap((event) => event.participants)),
    ...data.company_events.flatMap((event) => event.participants),
  ]);
  const participants = data.people.filter((person) => participantIds.has(person.id))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const selectPeriod = (next: typeof period) => {
    setPeriod(next);
    setCopyStatus("idle");
    if (wordStatus === "error") setWordStatus("idle");
    previewScrollRef.current?.scrollTo({ top: 0 });
  };
  const print = useReactToPrint({
    contentRef: reportRef,
    documentTitle: report ? weeklyReportFilename(report, "pdf").replace(/\.pdf$/, "") : "工作周报",
    pageStyle: `
      @page { size: A4 portrait; margin: 16mm; }
      html, body { background: white !important; }
      .weekly-report { min-height: 0 !important; padding: 0 !important; margin: 0 !important; max-width: none !important; box-shadow: none !important; }
      .weekly-report-event { break-inside: avoid; }
      .weekly-report h2, .weekly-report h3, .weekly-report h4 { break-after: avoid; }
    `,
  });
  const copy = async () => {
    if (!report) return;
    const text = weeklyReportToText(report);
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("aria-hidden", "true");
    area.style.cssText = "position:fixed;left:-9999px;top:0";
    const active = document.activeElement;
    let copied = false;
    try {
      (active?.closest('[role="dialog"]') ?? document.body).append(area); area.select();
      copied = document.execCommand("copy");
    } catch { /* Fall back to the asynchronous clipboard API. */ }
    finally { area.remove(); if (active instanceof HTMLElement) active.focus(); }
    try {
      if (!copied) await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("复制超时")), 3000)),
      ]);
      setCopyStatus("copied");
    } catch { setCopyStatus("error"); }
  };
  const word = async () => {
    if (!report) return;
    setWordStatus("working");
    try {
      const { createWeeklyDocx } = await import("./lib/export-weekly-docx");
      download(await createWeeklyDocx(report), weeklyReportFilename(report, "docx"));
      setWordStatus("idle");
    } catch (error) { console.error(error); setWordStatus("error"); }
  };
  const textFile = (format: "md" | "html") => {
    if (!report) return;
    const text = format === "md" ? weeklyReportToMarkdown(report) : weeklyReportToHtml(report);
    download(new Blob(["\uFEFF", text], { type: format === "md" ? "text/markdown;charset=utf-8" : "text/html;charset=utf-8" }), weeklyReportFilename(report, format));
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="export-dialog-overlay" />
      <Dialog.Content className="export-dialog weekly-dialog" aria-describedby="weekly-description"
        onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); openerRef.current?.focus(); }}>
        <header className="export-dialog-head">
          <div><div className="eyebrow">每周进展汇报</div><Dialog.Title>工作周报</Dialog.Title>
            <Dialog.Description id="weekly-description">选择周期，预览并导出这一周实际记录的进展。</Dialog.Description></div>
          <Dialog.Close asChild><button className="close-button" type="button" aria-label="关闭周报面板">×</button></Dialog.Close>
        </header>
        <div className="export-dialog-body">
          <aside className="export-settings weekly-settings">
            <div className="export-setting-group">
              <span>报告周期（周一至周日，可调整日期）</span>
              <div className="weekly-navigation" role="group" aria-label="按周切换报告周期">
                <button type="button" disabled={!previousPeriod} onClick={() => previousPeriod && selectPeriod(previousPeriod)}><span aria-hidden="true">‹</span> 上一周</button>
                <button type="button" aria-pressed={isCurrentWeek} onClick={() => selectPeriod(currentWeek)}>本周</button>
                <button type="button" disabled={!nextPeriod} onClick={() => nextPeriod && selectPeriod(nextPeriod)}>下一周 <span aria-hidden="true">›</span></button>
              </div>
              <p className="weekly-period-status" role="status" aria-atomic="true">{valid ? `${period.from} — ${period.to}` : "请选择有效日期"}</p>
              {latestWeek && <div className="weekly-presets"><button className="history-trigger" type="button"
                aria-pressed={period.from === latestWeek.from && period.to === latestWeek.to}
                onClick={() => selectPeriod(latestWeek)}>最近记录所在周</button></div>}
              <label className="control-field"><span>开始日期</span><input type="date" aria-invalid={!valid} value={period.from} onInput={(e) => selectPeriod({ ...period, from: e.currentTarget.value })} onChange={(e) => selectPeriod({ ...period, from: e.target.value })} /></label>
              <label className="control-field"><span>结束日期</span><input type="date" aria-invalid={!valid} value={period.to} onInput={(e) => selectPeriod({ ...period, to: e.currentTarget.value })} onChange={(e) => selectPeriod({ ...period, to: e.target.value })} /></label>
              {isCustomPeriod && <p className="export-note weekly-custom-note">按周切换时，以开始日期所在周为基准。</p>}
              {!valid && <p className="export-error" role="alert">请选择有效日期，结束日期不能早于开始日期。</p>}
            </div>
            <label className="control-field weekly-participant"><span>参与人</span><select value={participant} onChange={(e) => { setParticipant(e.target.value); setCopyStatus("idle"); }}>
              <option value="">全部参与人</option>{participants.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select></label>
            <p className="export-note">筛选参与人后，仅汇总记录中列明该人参与的沟通与活动。</p>
            <div className="export-format-group">
              <span>发送或导出</span>
              <button type="button" onClick={copy} disabled={disabled}><i>复制</i><strong>{copyStatus === "copied" ? "已复制周报" : "复制周报"}</strong><small>可直接粘贴到微信或邮件</small></button>
              <button type="button" onClick={word} disabled={disabled || wordStatus === "working"}><i>W</i><strong>{wordStatus === "working" ? "正在生成…" : "导出 Word"}</strong><small>可继续编辑的 .docx</small></button>
              <button type="button" onClick={() => print()} disabled={disabled}><i>PDF</i><strong>导出 PDF</strong><small>打印窗口中选择存储</small></button>
              <button type="button" onClick={() => textFile("md")} disabled={disabled}><i>.md</i><strong>导出 Markdown</strong><small>保留可编辑的文字记录</small></button>
              <button type="button" onClick={() => textFile("html")} disabled={disabled}><i>HTML</i><strong>导出 HTML</strong><small>浏览器离线查看</small></button>
              {copyStatus === "error" && <p className="export-error" role="alert">复制失败，可导出 Word 或 Markdown 后发送。</p>}
              {wordStatus === "error" && <p className="export-error" role="alert">Word 生成失败，请重试。</p>}
            </div>
          </aside>
          <div className="export-preview-shell">
            <div className="export-preview-label"><span>周报预览</span><strong>{report ? report.projectCount + " 个事项 · " + report.eventCount + " 条进展" : "请先选择有效日期"}</strong></div>
            <div className="export-preview-scroll" ref={previewScrollRef}>
              {report ? <WeeklyPreview report={report} reportRef={reportRef} /> : <div className="panel-empty-state">选择有效的报告周期后显示预览。</div>}
            </div>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
