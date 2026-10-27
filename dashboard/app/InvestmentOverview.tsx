"use client";

import { Fragment, useState } from "react";
import type { Project } from "./lib/types";
import { followUpStatusLabels, priorityLabels, roleLabels, stageLabels } from "./lib/labels";
import { csvCell, externalContacts, filterInvestments, hasContactChannel, needsContactInfo, type InvestmentFilters } from "./lib/investments";

const defaults: InvestmentFilters = { query: "", followUp: "all", priority: "all", stage: "all", missingContact: false, sort: "follow_up" };

export default function InvestmentOverview({ projects, onOpenProject }: {
  projects: Project[];
  onOpenProject: (project: Project) => void;
}) {
  const [filters, setFilters] = useState<InvestmentFilters>(defaults);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const investments = projects.filter((project) => project.record_type === "investment");
  const visible = filterInvestments(investments, filters);
  const people = new Set(investments.flatMap((project) => externalContacts(project).map((contact) => contact.person_id)));
  const allExpanded = visible.length > 0 && visible.every((project) => expanded.has(project.id));
  const update = (patch: Partial<InvestmentFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const exportCsv = () => {
    const rows = [["事项", "投资机构或个人", "阶段", "跟进状态", "优先级", "最近进展日期", "管理摘要", "下一步", "下一步期限", "负责人", "联系人", "关系", "单位及职位", "角色", "电话", "微信", "邮箱", "最近参与日期", "联系备注"]];
    for (const project of visible) {
      const contacts = externalContacts(project);
      for (const contact of contacts.length ? contacts : [null]) {
        rows.push([
          project.name, project.counterparties.join("、"), stageLabels[project.stage] ?? project.stage,
          followUpStatusLabels[project.follow_up_status], priorityLabels[project.priority], project.last_activity,
          project.summary, project.next_action, project.next_action_due ?? "", project.owner,
          contact?.name ?? "", contact ? (contact.side === "advisor" ? "引荐 / 顾问" : "机构 / 对方") : "",
          contact?.affiliation ?? "", contact?.project_roles.map((role) => roleLabels[role] ?? role).join("、") ?? "",
          contact?.phone ?? "", contact?.wechat ?? "", contact?.email ?? "", contact?.last_activity ?? "", contact?.notes ?? "",
        ]);
      }
    }
    const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "投资对接总览.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="panel investment-overview" aria-labelledby="investment-title">
      <div className="section-heading page-heading">
        <div><div className="eyebrow">机构 · 联系人 · 跟进</div><h1 id="investment-title">投资总览</h1>
          <p>按投资对接事项汇总机构与个人，展开查看全部对外联系人及联系方式。</p></div>
        <button className="history-trigger" type="button" onClick={exportCsv} disabled={!visible.length}>导出当前表格</button>
      </div>
      <div className="investment-stats">
        <div><strong>{investments.length}</strong><span>投资对接事项</span></div>
        <div><strong>{people.size}</strong><span>对外联系人（去重）</span></div>
        <div><strong>{investments.filter((project) => project.follow_up_status === "proactive_contact").length}</strong><span>可主动跟进</span></div>
        <div><strong>{investments.filter(needsContactInfo).length}</strong><span>联系方式待补充的事项</span></div>
      </div>
      <div className="investment-filters workspace-filters">
        <label className="control-field investment-search"><span>关键词</span>
          <input type="search" aria-label="搜索投资对接" placeholder="机构、姓名、联系方式或进展" value={filters.query} onChange={(e) => update({ query: e.target.value })} /></label>
        <label className="control-field"><span>跟进状态</span><select value={filters.followUp} onChange={(e) => update({ followUp: e.target.value })}>
          <option value="all">全部状态</option>{Object.entries(followUpStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="control-field"><span>阶段</span><select value={filters.stage} onChange={(e) => update({ stage: e.target.value })}>
          <option value="all">全部阶段</option>{Object.entries(stageLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="control-field"><span>优先级</span><select value={filters.priority} onChange={(e) => update({ priority: e.target.value })}>
          <option value="all">全部优先级</option>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className="control-field"><span>排序</span><select value={filters.sort} onChange={(e) => update({ sort: e.target.value as InvestmentFilters["sort"] })}>
          <option value="follow_up">可主动跟进优先</option><option value="stale">最久未更新</option><option value="recent">最近进展</option>
        </select></label>
      </div>
      <div className="investment-toolbar">
        <label><input type="checkbox" checked={filters.missingContact} onChange={(e) => update({ missingContact: e.target.checked })} /> 仅看联系方式待补充</label>
        <span className="investment-help">无对外联系人，或有联系人三项联系方式均未填写</span>
        <button className="history-trigger" type="button" onClick={() => setFilters(defaults)}>重置筛选</button>
      </div>
      <div className="event-history-status">
        <span aria-live="polite">显示 {visible.length} / {investments.length} 条投资对接</span>
        <button className="history-trigger" type="button" disabled={!visible.length} onClick={() => setExpanded(allExpanded ? new Set() : new Set(visible.map((project) => project.id)))}>{allExpanded ? "收起全部联系人" : "展开全部联系人"}</button>
      </div>
      {visible.length > 0 ? <div className="investment-table-scroll" role="region" aria-label="投资对接表格，可横向滚动" tabIndex={0}>
        <table className="investment-table">
          <caption className="sr-only">投资机构及个人对接总览</caption>
          <thead><tr><th scope="col">机构 / 个人</th><th scope="col">联系人</th><th scope="col">阶段 / 跟进</th><th scope="col">最近进展</th><th scope="col">下一步</th><th scope="col">负责人</th></tr></thead>
          <tbody>{visible.map((project) => {
            const contacts = externalContacts(project);
            const direct = contacts.filter((contact) => contact.side === "counterparty");
            const advisors = contacts.filter((contact) => contact.side === "advisor");
            const open = expanded.has(project.id);
            const latest = [...project.events].sort((a, b) => b.date.localeCompare(a.date))[0];
            const displayName = project.counterparties.join("、") || project.name;
            const multipleMatters = investments.filter(item => item.primary_counterparty_id === project.primary_counterparty_id).length > 1;
            return <Fragment key={project.id}>
              <tr className={open ? "investment-row is-expanded" : "investment-row"}>
                <th scope="row"><button type="button" className="investment-name" title={project.name} onClick={() => onOpenProject(project)}>{displayName}</button>{multipleMatters && <small>{project.name}</small>}
                  <span className={"investment-priority priority-" + project.priority}>{priorityLabels[project.priority]}优先级</span></th>
                <td><div>{direct.map((contact) => contact.name).join("、") || "暂无机构 / 对方联系人"}</div>
                  {advisors.length > 0 && <small>引荐 / 顾问：{advisors.map((contact) => contact.name).join("、")}</small>}
                  <button className="investment-expand" type="button" aria-expanded={open} aria-controls={"investment-contacts-" + project.id} onClick={() => toggle(project.id)}>{open ? "收起" : "展开"} {contacts.length} 位联系人</button>
                </td>
                <td><div>{stageLabels[project.stage] ?? project.stage}</div><span className={"investment-followup followup-" + project.follow_up_status}>{followUpStatusLabels[project.follow_up_status]}</span></td>
                <td><time>{project.last_activity}</time><p>{latest?.summary || project.summary || "暂无进展摘要"}</p>
                  <button className="history-trigger" type="button" onClick={() => onOpenProject(project)}>查看完整进展</button></td>
                <td><p>{project.next_action || "未记录"}</p>{project.next_action_due && <small>期限：{project.next_action_due}</small>}</td>
                <td>{project.owner || "未记录"}</td>
              </tr>
              <tr id={"investment-contacts-" + project.id} hidden={!open} className="investment-contact-row"><td colSpan={6}>
                {contacts.length > 0 ? <table className="investment-contacts">
                  <caption>{displayName} · 对外联系人</caption>
                  <thead><tr><th scope="col">姓名 / 关系</th><th scope="col">单位及职位 / 角色</th><th scope="col">电话</th><th scope="col">微信</th><th scope="col">邮箱</th><th scope="col">最近参与 / 备注</th></tr></thead>
                  <tbody>{contacts.map((contact) => <tr key={contact.person_id}>
                    <th scope="row">{contact.name}<small>{contact.side === "advisor" ? "引荐 / 顾问" : "机构 / 对方"}</small>{!hasContactChannel(contact) && <small className="contact-missing">联系方式待补充</small>}</th>
                    <td>{contact.affiliation}<small>{contact.project_roles.map((role) => roleLabels[role] ?? role).join(" · ")}</small></td>
                    <td className="contact-value">{contact.phone?.trim() || "未填写"}</td><td className="contact-value">{contact.wechat?.trim() || "未填写"}</td><td className="contact-value">{contact.email?.trim() || "未填写"}</td>
                    <td><time>{contact.last_activity}</time><p>{contact.notes || "—"}</p></td>
                  </tr>)}</tbody>
                </table> : <p>暂无对外联系人记录。</p>}
                {project.source_note && <p className="investment-source"><strong>最初对接来源：</strong>{project.source_note}</p>}
              </td></tr>
            </Fragment>;
          })}</tbody>
        </table>
      </div> : <div className="panel-empty-state">{investments.length ? "没有符合筛选条件的投资对接。" : "暂无投资对接事项。"}</div>}
    </section>
  );
}
