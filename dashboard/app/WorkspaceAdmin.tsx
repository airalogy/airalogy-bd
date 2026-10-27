"use client";
import { useState } from "react";
import type { DashboardData, ProjectEvent } from "./lib/types";
import type { RecordTarget } from "./lib/workspace-types";
import { companyCategoryLabel } from "./lib/company-events";
import { filesForEvent } from "./lib/file-library";
import { recordTypeLabels, stageLabels } from "./lib/labels";

export default function WorkspaceAdmin({data, onEdit, onHistory, onFiles, onNdaFiles, onOpenRecord}: {
  data: DashboardData;
  onEdit: (target: RecordTarget) => void;
  onHistory: (target: RecordTarget) => void;
  onFiles: (projectId?: string, eventId?: string) => void;
  onNdaFiles: () => void;
  onOpenRecord: (event: ProjectEvent, sourceLabel: string) => void;
}) {
  const [kind, setKind] = useState<"project" | "person" | "company">("project");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const options = kind === "project" ? data.projects.map(project => ({id:project.id,name:project.name,description:project.summary})) : kind === "person" ? data.people.map(person => ({id:person.id,name:person.name,description:person.affiliation})) : data.company_events.map(event => ({id:event.id,name:event.title,description:`${event.date} · ${companyCategoryLabel(event.category)}`}));
  const items = options.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const labels = {project:"事项",person:"人员",company:"公司动态"};
  const selection = options.find(item => item.id === selected);
  const project = kind === "project" ? data.projects.find(project => project.id === selected) : undefined;
  const party = data.counterparties.find(item => item.id === project?.primary_counterparty_id);
  const attachments = (data.files || []).filter(file => !file.archived && file.project_ids.includes(selected));
  return <section className="panel workspace-admin" aria-labelledby="admin-title">
    <div className="section-heading page-heading"><div><div className="eyebrow">资料维护</div><h1 id="admin-title">资料管理</h1><p>新增或修改资料，每次保存都有可恢复版本。</p></div><div className="admin-actions"><button type="button" className="admin-button" onClick={() => onFiles()}>事项资料</button><button type="button" className="admin-button" onClick={onNdaFiles}>全部 NDA</button><button type="button" className="admin-button admin-primary" onClick={() => onEdit({kind,id:""})}>新增{labels[kind]}</button></div></div>
    <div className="admin-tabs" role="group" aria-label="资料类型">{(["project","person","company"] as const).map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => {setKind(value);setSelected("");setQuery("");}}>{labels[value]}</button>)}</div>
    <div className="admin-layout">
      <aside className="admin-list" aria-label={`${labels[kind]}列表`}>
        <input type="search" aria-label={`搜索${labels[kind]}资料`} placeholder="搜索名称或内容" value={query} onChange={event => setQuery(event.target.value)} />
        <p className="admin-list-count">{items.length} 条{labels[kind]}</p>
        <div className="admin-list-items">{items.map(item => <button type="button" key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><small>{item.description}</small></button>)}{!items.length && <p className="admin-help">暂无符合条件的资料。</p>}</div>
      </aside>
      <div className="admin-detail">{!selection ? <div className="panel-empty-state">选择一条{labels[kind]}资料，查看或编辑。</div> : <>
        <header className="admin-record-head">
          <div className="admin-record-heading"><div><div className="eyebrow">{project ? `${recordTypeLabels[project.record_type]} · ${stageLabels[project.stage] || project.stage}` : `${labels[kind]}档案`}</div><h2>{selection.name}</h2></div><button type="button" className="admin-button" onClick={() => onEdit({kind,id:selected})}>编辑{labels[kind]}</button></div>
          {selection.description && <p className="admin-record-summary">{selection.description}</p>}
          <button type="button" className="event-secondary-trigger" onClick={() => onHistory({kind,id:selected})}>查看修改历史</button>
        </header>
        {project && <>
          <section className="admin-record-context" aria-label="对接方与事项资料">
            <div className="admin-party-context"><span className="admin-context-label">对接方与共用联系人</span><strong>{party?.name || project.counterparties.join("、")}</strong><div className="admin-context-links"><button type="button" className="event-secondary-trigger" onClick={() => onEdit({kind:"counterparty",id:project.primary_counterparty_id})}>查看档案与联系人</button><button type="button" className="event-secondary-trigger" onClick={() => onHistory({kind:"counterparty",id:project.primary_counterparty_id})}>对接方修改历史</button></div></div>
            <div className="admin-file-context"><span className="admin-context-label">事项资料</span><strong>{attachments.length ? `${attachments.length} 份资料` : "暂无归档资料"}</strong><button type="button" className="event-secondary-trigger" onClick={() => onFiles(selected)}>{attachments.length ? "查看事项资料" : "导入或关联资料"}</button></div>
          </section>
          <section className="admin-progress-list" aria-labelledby="admin-progress-title">
            <div className="admin-progress-heading"><div><h3 id="admin-progress-title">沟通进展</h3><span>{project.events.length} 条记录 · 最近在前</span></div><button type="button" className="admin-button admin-primary" onClick={() => onEdit({kind:"progress",id:"",project_id:selected})}>新增沟通进展</button></div>
            {!project.events.length && <p className="panel-empty-state">暂无沟通进展，添加第一次交流记录。</p>}
            <div className="admin-progress-items">{[...project.events].sort((a,b) => b.date.localeCompare(a.date)).map(event => {
              const fileCount = filesForEvent(data.files || [],project.id,event.id).length;
              return <article className="admin-progress-item" key={event.id}>
                <time dateTime={event.date}>{event.date}</time><h4>{event.title}</h4>{event.summary && <p>{event.summary}</p>}
                <div className="admin-context-links">
                  {event.related_document && <button type="button" className="event-secondary-trigger" onClick={() => onOpenRecord(event,project.name)}>阅读完整记录</button>}
                  {fileCount > 0 && <button type="button" className="event-secondary-trigger" onClick={() => onFiles(selected,event.id)} aria-label={`关联资料：${event.title}`}>相关资料 · {fileCount}</button>}
                  <button type="button" className="event-secondary-trigger" onClick={() => onEdit({kind:"progress",id:event.id,project_id:selected})} aria-label={`编辑进展：${event.title}`}>编辑进展</button>
                </div>
              </article>;
            })}</div>
          </section>
        </>}
        {kind === "person" && (() => {const person = data.people.find(person => person.id === selected); return person ? <dl className="admin-person-details"><dt>单位及职位</dt><dd>{person.affiliation}</dd><dt>电话</dt><dd>{person.phone || "未填写"}</dd><dt>微信</dt><dd>{person.wechat || "未填写"}</dd><dt>邮箱</dt><dd>{person.email || "未填写"}</dd><dt>关联事项</dt><dd>{person.projects.map(project => project.project_name).join("、") || "暂无关联事项"}</dd></dl> : null;})()}
        {kind === "company" && <p>{data.company_events.find(event => event.id === selected)?.summary}</p>}
      </>}</div>
    </div>
  </section>;
}
