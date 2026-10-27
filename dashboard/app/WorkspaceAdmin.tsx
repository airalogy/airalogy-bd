"use client";
import { useState } from "react";
import type { DashboardData } from "./lib/types";
import type { RecordTarget } from "./lib/workspace-types";
import { companyCategoryLabel } from "./lib/company-events";

export default function WorkspaceAdmin({data, onEdit, onHistory, onFiles, onNdaFiles}: {data:DashboardData; onEdit:(target:RecordTarget) => void; onHistory:(target:RecordTarget) => void; onFiles:(projectId?:string,eventId?:string) => void; onNdaFiles:() => void}) {
  const [kind, setKind] = useState<"project" | "person" | "company">("project");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const options = kind === "project" ? data.projects.map(project => ({id:project.id,name:project.name,description:project.summary})) : kind === "person" ? data.people.map(person => ({id:person.id,name:person.name,description:person.affiliation})) : data.company_events.map(event => ({id:event.id,name:event.title,description:`${event.date} · ${companyCategoryLabel(event.category)}`}));
  const items = options.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const labels = {project:"事项",person:"人员",company:"公司动态"};
  const project = data.projects.find(project => project.id === selected);
  return <section className="panel workspace-admin" aria-labelledby="admin-title">
    <div className="section-heading page-heading"><div><div className="eyebrow">资料维护</div><h1 id="admin-title">资料管理</h1><p>新增或修改资料，每次保存都有可恢复版本。</p></div><div className="admin-actions"><button type="button" className="admin-button" onClick={() => onFiles()}>事项资料</button><button type="button" className="admin-button" onClick={onNdaFiles}>全部 NDA</button><button type="button" className="admin-button admin-primary" onClick={() => onEdit({kind,id:""})}>新增{labels[kind]}</button></div></div>
    <div className="admin-tabs" role="group" aria-label="资料类型">{(["project","person","company"] as const).map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => {setKind(value);setSelected("");setQuery("");}}>{labels[value]}</button>)}</div>
    <div className="admin-layout"><aside className="admin-list"><input type="search" aria-label={`搜索${labels[kind]}资料`} placeholder="搜索名称或内容" value={query} onChange={e => setQuery(e.target.value)} /><div className="admin-list-items">{items.map(item => <button type="button" key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><small>{item.description}</small></button>)}{!items.length && <p className="admin-help">暂无符合条件的资料。</p>}</div></aside>
      <div className="admin-detail">{!selected ? <div className="panel-empty-state">选择一条{labels[kind]}资料，查看或编辑。</div> : <>
        <h2>{options.find(item => item.id === selected)?.name}</h2><p className="admin-help">{options.find(item => item.id === selected)?.description}</p>
        <div className="admin-actions"><button type="button" className="admin-button" onClick={() => onEdit({kind,id:selected})}>编辑{labels[kind]}</button><button type="button" className="admin-button" onClick={() => onHistory({kind,id:selected})}>查看修改历史</button>{kind === "project" && <button type="button" className="admin-button admin-primary" onClick={() => onEdit({kind:"progress",id:"",project_id:selected})}>新增沟通进展</button>}</div>
        {kind === "project" && project && <section className="admin-progress-list"><div className="admin-actions admin-related-actions"><button type="button" className="admin-button" onClick={() => onEdit({kind:"counterparty",id:project.primary_counterparty_id})}>对接方档案与共用联系人</button><button type="button" className="admin-button" onClick={() => onHistory({kind:"counterparty",id:project.primary_counterparty_id})}>对接方修改历史</button><button type="button" className="admin-button" onClick={() => onFiles(selected)}>查看事项资料</button></div><h3>沟通进展</h3>{[...project.events].sort((a,b) => b.date.localeCompare(a.date)).map(event => <article key={event.id}><div><time>{event.date}</time><h4>{event.title}</h4><p>{event.summary}</p></div><div className="admin-actions"><button type="button" className="admin-button" onClick={() => onEdit({kind:"progress",id:event.id,project_id:selected})} aria-label={`编辑进展：${event.title}`}>编辑</button><button type="button" className="admin-button" onClick={() => onFiles(selected,event.id)} aria-label={`关联资料：${event.title}`}>资料</button></div></article>)}</section>}
        {kind === "person" && (() => {const person = data.people.find(person => person.id === selected); return person ? <dl className="admin-person-details"><dt>单位及职位</dt><dd>{person.affiliation}</dd><dt>电话</dt><dd>{person.phone || "未填写"}</dd><dt>微信</dt><dd>{person.wechat || "未填写"}</dd><dt>邮箱</dt><dd>{person.email || "未填写"}</dd><dt>关联事项</dt><dd>{person.projects.map(project => project.project_name).join("、") || "暂无关联事项"}</dd></dl> : null;})()}
        {kind === "company" && <p>{data.company_events.find(event => event.id === selected)?.summary}</p>}
      </>}</div>
    </div>
  </section>;
}
