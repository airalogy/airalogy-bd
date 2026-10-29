"use client";
import { Children, cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";
import type { DashboardData } from "./lib/types";
import { followUpStatusLabels, priorityLabels, projectOwnerLabel, recordTypeLabels, relationshipLabels, roleLabels, stageLabels } from "./lib/labels";
import type { EditableEvent, EditablePerson, EditableProgress, EditableProject, Relation } from "./lib/workspace-types";

export const fieldLabels: Record<string, string> = {name: "名称", primary_counterparty_id:"归档对接方", counterparty_ids:"参与对接方", new_counterparty:"新建对接方", short_name:"简称", people:"共用联系人", kind:"对接方类型", affiliation: "单位及职位", phone: "电话", wechat: "微信", email: "邮箱", counterparties: "对方单位", record_type: "事项类型", category: "分类", stage: "阶段", relationship: "关系", priority: "优先级", owner: "负责人", first_contact: "首次接触日期", first_contact_certainty: "日期依据", sourced_by: "来源人员", source_certainty: "来源依据", source_note: "来源说明", follow_up_status: "跟进状态", next_action: "下一步", next_action_due: "下一步期限", target_investment_amount_cny: "目标投资金额（元）", date: "实际日期", type: "事件类型", title: "标题", summary: "进展摘要", importance: "重要程度", participants: "参与人", organizers: "主办方", location: "地点", body: "正文", metadata: "事项信息", event: "进展信息", document: "记录信息", contacts: "事项联系人", events: "历史进展", documents: "沟通记录", id: "标识", person_id: "姓名", side: "关系", project_roles: "角色", notes: "备注"};
Object.assign(fieldLabels, {agreement_date:"协议载明日期",signing_completed_date:"实际签署完成日期",organization:"归档机构",project_ids:"关联事项",archived:"回收站状态",current_version:"当前文件版本",versions:"文件版本",records:"使用与发送记录",filename:"文件名",sha256:"文件指纹",size:"文件大小",status:"文件状态",created_at:"归档时间",note:"说明",archive_path:"归档位置",version_id:"具体版本",kind:"使用情况",people:"相关人员",channel:"渠道",event_id:"关联交流",project_id:"关联事项"});
export const eventTypes: Record<string, string> = {contact: "接触", meeting: "会议", proposal: "方案", agreement: "协议", administrative: "手续", decision: "决策", payment: "付款", milestone: "里程碑", status_change: "阶段变化", other: "其他"};
export const sideLabels = {counterparty: "对接方", internal: "我方", advisor: "引荐人 / 顾问"};
const certaintyLabels = {confirmed: "有明确依据", provisional: "暂定", unknown: "待明确"};
const valueLabels: Record<string, string> = {...stageLabels, ...followUpStatusLabels, ...relationshipLabels, ...recordTypeLabels, ...roleLabels, ...eventTypes, ...sideLabels, confirmed: "有明确依据", provisional: "暂定", unknown: "待明确", key: "重要", normal: "普通"};
export function readable(value: string): string {
  const convert = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(convert);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "id").map(([key, item]) => [fieldLabels[key] || key, convert(item)]));
    return typeof input === "string" ? valueLabels[input] || input : input;
  };
  try { return JSON.stringify(convert(JSON.parse(value)), null, 2); } catch { return valueLabels[value] || value; }
}
export function Field({label, children, wide = false, hint}: {label: string; children: ReactNode; wide?: boolean; hint?: string}) {
  const id = useId();
  const elements = Children.toArray(children);
  const controlIndex = elements.findIndex(child => isValidElement(child) && (child.type === Choice || child.type === LinesInput || (typeof child.type === "string" && ["input","select","textarea"].includes(child.type))));
  const controls = elements.map((child, index) => index === controlIndex ? cloneElement(child as ReactElement<{id?:string}>, {id}) : child);
  return <div className={`edit-field${wide ? " edit-field-wide" : ""}`}><label htmlFor={id}>{label}</label>{controls}{hint && <small>{hint}</small>}</div>;
}
function Choice({value, onChange, options, required = false, id}: {value: string; onChange: (value: string) => void; options: Record<string,string>; required?: boolean; id?:string}) {
  return <select id={id} value={value} required={required} onChange={(event) => onChange(event.target.value)}>{!value && <option value="">请选择</option>}{Object.entries(options).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>;
}
const lines = (value: string) => value.split(/\n|，|,/).map(item => item.trim()).filter(Boolean);
function LinesInput({values, onChange, required = false, id}: {values:string[]; onChange:(value:string[]) => void; required?:boolean; id?:string}) {
  const [raw,setRaw] = useState(values.join("\n"));
  return <textarea id={id} rows={2} required={required} value={raw} onChange={event => {setRaw(event.target.value);onChange(lines(event.target.value));}} />;
}

export function PeoplePicker({data, selected, onChange, label = "参与人", allowed}: {data: DashboardData; selected: string[]; onChange: (ids: string[]) => void; label?: string; allowed?: string[]}) {
  const [query, setQuery] = useState("");
  const people = data.people.filter(person => (!allowed || allowed.includes(person.id)) && `${person.name} ${person.affiliation}`.includes(query));
  return <fieldset className="edit-people-picker"><legend>{label}</legend><input type="search" aria-label={`搜索${label}`} placeholder="搜索姓名或单位" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="edit-people-selected">{selected.length ? selected.map(id => <button type="button" key={id} onClick={() => onChange(selected.filter(item => item !== id))} aria-label={`移除${label}${id}`}>{id} ×</button>) : <span>尚未选择</span>}</div>
    <div className="edit-people-options">{people.map(person => <label key={person.id}><input type="checkbox" checked={selected.includes(person.id)} onChange={e => onChange(e.target.checked ? [...selected,person.id] : selected.filter(id => id !== person.id))} /><span><strong>{person.name}</strong><small>{person.affiliation}</small></span></label>)}{!people.length && <p>没有符合条件的人员。</p>}</div>
  </fieldset>;
}

export function RelationEditor({relation, onChange, onRemove, data, showPerson = false, excluded = []}: {relation: Relation; onChange: (relation: Relation) => void; onRemove?: () => void; data: DashboardData; showPerson?: boolean; excluded?: string[]}) {
  const roles = {...roleLabels, ...Object.fromEntries(relation.project_roles.filter(role => !roleLabels[role]).map(role => [role,role]))};
  return <div className="edit-relation">
    <div className="edit-relation-title">{showPerson ? <Field label="人员"><select aria-label="事项联系人姓名" value={relation.person_id} required onChange={e => onChange({...relation,person_id:e.target.value})}><option value="">选择已有人员</option>{data.people.filter(p => !excluded.includes(p.id) || p.id === relation.person_id).map(p => <option key={p.id} value={p.id}>{p.name} · {p.affiliation}</option>)}</select></Field> : <strong>{relation.person_id}</strong>}
      <Field label="关系"><Choice value={relation.side} options={sideLabels} required onChange={side => onChange({...relation,side})} /></Field>{onRemove && <button type="button" className="admin-button" onClick={onRemove}>移除关系</button>}</div>
    <fieldset className="edit-roles"><legend>项目角色（至少一项）</legend>{Object.entries(roles).map(([role,label]) => <label key={role}><input type="checkbox" checked={relation.project_roles.includes(role)} onChange={e => onChange({...relation,project_roles:e.target.checked ? [...relation.project_roles,role] : relation.project_roles.filter(item => item !== role)})} />{label}</label>)}</fieldset>
    <Field label="关系备注"><textarea rows={2} value={relation.notes || ""} onChange={e => onChange({...relation,notes:e.target.value})} /></Field>
  </div>;
}

export function PersonForm({record, isNew, onChange}: {record: EditablePerson; isNew: boolean; onChange: (record: EditablePerson) => void}) {
  const change = (key: string, value: string) => onChange({...record,[key]: ["name","affiliation"].includes(key) ? value : value || null});
  return <div className="edit-form-grid">
    <Field label="姓名" hint={isNew ? "同一人员只建立一份档案。" : "姓名作为统一档案标识，联系方式修改会同步到关联事项。"}><input required readOnly={!isNew} value={record.name} onChange={e => change("name",e.target.value)} /></Field>
    <Field label="单位及职位"><input required value={record.affiliation} onChange={e => change("affiliation",e.target.value)} /></Field>
    <Field label="电话"><input type="tel" value={record.phone || ""} onChange={e => change("phone",e.target.value)} placeholder="保留区号、前导零和加号" /></Field>
    <Field label="微信"><input value={record.wechat || ""} onChange={e => change("wechat",e.target.value)} /></Field>
    <Field label="邮箱"><input type="email" value={record.email || ""} onChange={e => change("email",e.target.value)} /></Field>
  </div>;
}

export type ProgressDraft = EditableEvent & {body: string; location: string; new_contacts: Relation[]};
export function newEvent(date = ""): ProgressDraft { return {date, type:"contact", title:"", summary:"", importance:"normal", participants:[], body:"",location:"", new_contacts:[]}; }
export function progressDraft(record: EditableProgress | null): ProgressDraft {
  if (!record) return newEvent();
  const implicit = Object.values(record.document.participants || {}).flat();
  return {...newEvent(), ...record.event, participants:[...new Set([...record.event.participants || [], ...implicit])], body:record.body, location:record.document.location || "", new_contacts:[]};
}
export function ProgressForm({draft, onChange, data, contacts = [], company = false}: {draft: ProgressDraft; onChange: (value: ProgressDraft) => void; data: DashboardData; contacts?: Relation[]; company?: boolean}) {
  const update = (key: string, value: unknown) => onChange({...draft,[key]:value});
  const missing = company ? [] : draft.participants.filter(id => !contacts.some(relation => relation.person_id === id));
  const selectParticipants = (participants: string[]) => onChange({...draft, participants, new_contacts: participants.filter(id => !contacts.some(relation => relation.person_id === id)).map(id => draft.new_contacts.find(item => item.person_id === id) || {person_id:id,side:"counterparty",project_roles:["participant"],notes:""})});
  return <>
    <div className="edit-form-grid">
      <Field label="实际日期"><input type="date" required value={draft.date} onChange={e => update("date",e.target.value)} /></Field>
      <Field label="事件类型"><Choice value={draft.type} onChange={value => update("type",value)} options={eventTypes} required /></Field>
      <Field label="标题" wide><input required maxLength={40} value={draft.title} onChange={e => update("title",e.target.value)} /><small>{draft.title.length} / 40</small></Field>
      <Field label="进展摘要" wide hint="只填写来源支持的实际进展，区分拟议方案与已达成共识。"><textarea required rows={3} maxLength={200} value={draft.summary} onChange={e => update("summary",e.target.value)} /><small>{draft.summary.length} / 200</small></Field>
      <Field label="重要程度"><Choice value={draft.importance} options={{key:"重要",normal:"普通"}} onChange={value => update("importance",value)} /></Field>
      <Field label="地点（可选）"><input value={draft.location} onChange={e => update("location",e.target.value)} /></Field>
      {company && <><Field label="活动分类"><input required list="company-category-list" value={draft.category || ""} onChange={e => update("category",e.target.value)} /><datalist id="company-category-list">{[...new Set(data.company_events.map(event => event.category))].map(value => <option key={value} value={value} />)}</datalist></Field><Field label="主办方（可选，每行一个）"><LinesInput values={draft.organizers || []} onChange={value => update("organizers",value)} /></Field></>}
    </div>
    <PeoplePicker data={data} selected={draft.participants} onChange={selectParticipants} />
    {missing.length > 0 && <div><h3>新参与人的事项关系</h3><p className="admin-help">这些人员还未关联此事项，将和本次进展一起保存。请核对关系及角色。</p>{missing.map(id => <RelationEditor key={id} data={data} relation={draft.new_contacts.find(item => item.person_id === id) || {person_id:id,side:"counterparty",project_roles:["participant"],notes:""}} onChange={relation => onChange({...draft,new_contacts:[...draft.new_contacts.filter(item => item.person_id !== id),relation]})} />)}</div>}
    <Field label={company ? "完整活动记录（可选）" : "沟通记录"} wide hint="支持 Markdown；会议类型须填写沟通记录。不要粘贴原始逐字稿或私人评论。"><textarea className="edit-body" rows={9} required={draft.type === "meeting"} value={draft.body} onChange={e => update("body",e.target.value)} placeholder="整理后的记录，可按讨论内容、对方意见和已达成共识分段。" /></Field>
  </>;
}

export type ProjectDraft = Record<string, unknown> & {body: string; contacts: Relation[]; initial_event?: ProgressDraft};
export function projectDraft(record: EditableProject | null): ProjectDraft {
  return record ? {...record.metadata, body:record.body, contacts:record.contacts} : {name:"",primary_counterparty_id:"",counterparty_ids:[],new_counterparty:{name:"",kind:"organization"},additional_counterparties:[],record_type:"cooperation",category:[],stage:"initial_contact",relationship:"active",priority:"medium",owner:"待确认",first_contact:"",first_contact_certainty:"confirmed",sourced_by:[],source_certainty:"confirmed",source_note:"",follow_up_status:"proactive_contact",next_action:"",next_action_due:null,body:"# 新事项\n\n## 管理摘要\n\n",contacts:[],initial_event:newEvent()};
}
export function ProjectForm({draft, onChange, data, isNew}: {draft: ProjectDraft; onChange: (draft: ProjectDraft) => void; data: DashboardData; isNew: boolean}) {
  const update = (key: string, value: unknown) => onChange({...draft,[key]:value});
  const text = (key: string) => typeof draft[key] === "string" ? draft[key] as string : "";
  const people = Object.fromEntries(data.people.map(person => [person.id,`${person.name} · ${person.affiliation}`]));
  const primary = text("primary_counterparty_id");
  const newParty = (draft.new_counterparty || {name:"",kind:"organization"}) as {name:string;kind:string};
  const linked = draft.counterparty_ids as string[] || [];
  const sharedPeople = data.counterparties.find(party => party.id === primary)?.related_people || [];
  return <>
    <div className="edit-form-grid">
      <Field label="事项名称"><input required value={text("name")} onChange={e => update("name",e.target.value)} /></Field>
      <Field label="事项类型"><Choice value={text("record_type")} options={recordTypeLabels} onChange={value => onChange({...draft,record_type:value,...(value !== "investment" ? {target_investment_amount_cny:null} : {})})} /></Field>
      <Field label="对接方" hint={isNew ? "选择已有单位或个人，也可以在这里一并新建。" : "归档对接方保持不变，共用信息可在对接方档案中修改。"}><select value={primary} disabled={!isNew} onChange={event => onChange({...draft,primary_counterparty_id:event.target.value,counterparty_ids:event.target.value ? [...new Set([event.target.value,...linked.filter(id => id !== primary)])] : linked.filter(id => id !== primary)})}><option value="">新建对接方</option>{data.counterparties.map(party => <option key={party.id} value={party.id}>{party.short_name || party.name}{party.kind === "person" ? "（个人）" : ""}</option>)}</select></Field>
      {!primary && <><Field label="对接方名称"><input required value={newParty.name} onChange={event => update("new_counterparty",{...newParty,name:event.target.value})} /></Field><Field label="对接方类型"><Choice value={newParty.kind} options={{organization:"机构 / 单位",person:"个人"}} onChange={kind => update("new_counterparty",{...newParty,kind})} /></Field></>}
      <details className="edit-field-wide"><summary>其他参与方（联合项目时填写）</summary><p className="admin-help">同一事项可以关联多家单位或个人，进展与资料只维护一份。</p><div className="edit-roles">{data.counterparties.filter(party => party.id !== primary).map(party => <label key={party.id}><input type="checkbox" checked={linked.includes(party.id)} onChange={event => update("counterparty_ids",event.target.checked ? [...linked,party.id] : linked.filter(id => id !== party.id))} />{party.short_name || party.name}</label>)}</div>{(!data.access || data.access.role==="admin")&&<Field label="新增其他参与方（每行一个，可选）"><LinesInput values={draft.additional_counterparties as string[] || []} onChange={value => update("additional_counterparties",value)} /></Field>}</details>
      <Field label="事项分类（每行一个）"><LinesInput required values={draft.category as string[] || []} onChange={value => update("category",value)} /></Field>
      <Field label="阶段"><Choice value={text("stage")} options={stageLabels} onChange={value => update("stage",value)} /></Field>
      <Field label="跟进状态"><Choice value={text("follow_up_status")} options={followUpStatusLabels} onChange={value => update("follow_up_status",value)} /></Field>
      <Field label="关系策略"><Choice value={text("relationship")} options={relationshipLabels} onChange={value => update("relationship",value)} /></Field>
      <Field label="优先级"><Choice value={text("priority")} options={priorityLabels} onChange={value => update("priority",value)} /></Field>
      <Field label="负责人" hint="负责持续推动此事项的人，可暂不分配。录入者和交流参与人分别记录。"><Choice value={projectOwnerLabel(text("owner")) === "未分配" ? "待确认" : text("owner")} options={{待确认:"未分配",...people}} required onChange={value => update("owner",value)} /></Field>
      {draft.record_type === "investment" && <Field label="目标投资金额（人民币元，可选）"><input type="number" min={1} step={1} value={draft.target_investment_amount_cny as number || ""} onChange={e => update("target_investment_amount_cny",e.target.value ? Number(e.target.value) : null)} /></Field>}
      <Field label="首次接触日期"><input type="date" required={draft.first_contact_certainty !== "unknown"} disabled={draft.first_contact_certainty === "unknown"} value={text("first_contact")} onChange={e => update("first_contact",e.target.value)} /></Field>
      <Field label="首次接触日期依据"><Choice value={text("first_contact_certainty")} options={{confirmed:"有明确依据",provisional:"暂定",unknown:"日期未知"}} onChange={value => onChange({...draft,first_contact_certainty:value,...(value === "unknown" ? {first_contact:null} : {})})} /></Field>
      <Field label="来源依据"><Choice value={text("source_certainty")} options={certaintyLabels} onChange={value => update("source_certainty",value)} /></Field>
      <Field label="来源说明" wide><textarea required rows={2} value={text("source_note")} onChange={e => update("source_note",e.target.value)} /></Field>
      <Field label="下一步" wide hint="仅填写已有明确安排；不要把讨论中的方案写成承诺。"><textarea required rows={2} value={text("next_action")} onChange={e => update("next_action",e.target.value)} /></Field>
      <Field label="下一步期限（可选）"><input type="date" value={text("next_action_due")} onChange={e => update("next_action_due",e.target.value || null)} /></Field>
    </div>
    <PeoplePicker label="对接来源人员" data={data} selected={draft.sourced_by as string[] || []} onChange={ids => update("sourced_by",ids)} />
    <Field label="管理摘要与事项正文" wide hint="保留“管理摘要”标题，修改正文不会自动改写历史进展。支持 Markdown。"><textarea required rows={12} className="edit-body" value={draft.body} onChange={e => update("body",e.target.value)} /></Field>
    <section><h3>事项联系人</h3>{isNew && sharedPeople.length > 0 && <div className="shared-contact-picker"><p className="admin-help">这个对接方已有相关人员，可以选入本事项后核对角色。</p><div className="admin-actions">{sharedPeople.filter(id => !draft.contacts.some(contact => contact.person_id === id)).map(id => <button type="button" className="admin-button" key={id} onClick={() => {const known=data.projects.filter(project => project.counterparty_ids.includes(primary)).flatMap(project => project.contacts).find(contact => contact.person_id === id);update("contacts",[...draft.contacts,{person_id:id,side:known?.side || "counterparty",project_roles:["participant"],notes:""}]);}}>选入 {id}</button>)}</div></div>}<p className="admin-help">联系方式统一保存在人员档案。新增人员请由管理员在人员管理中建立档案；新增事项关系需有该人实际参与的进展记录。</p>
      {draft.contacts.map((relation,index) => <RelationEditor key={`${relation.person_id}-${index}`} data={data} relation={relation} showPerson={isNew} excluded={draft.contacts.map(item => item.person_id)} onChange={value => update("contacts",draft.contacts.map((item,i) => i === index ? value : item))} onRemove={() => update("contacts",draft.contacts.filter((_,i) => i !== index))} />)}
      {isNew && <button type="button" className="admin-button" onClick={() => update("contacts",[...draft.contacts,{person_id:"",side:"counterparty",project_roles:["participant"],notes:""}])}>添加事项联系人</button>}
    </section>
    {isNew && <section><h3>首条实际进展</h3><ProgressForm data={data} draft={draft.initial_event || newEvent()} contacts={draft.contacts} onChange={initial_event => update("initial_event",initial_event)} /></section>}
  </>;
}

export type CounterpartyDraft = {name:string; short_name?:string | null; kind:"organization" | "person"; body:string; people:string[]};
export function CounterpartyForm({draft,data,onChange}: {draft:CounterpartyDraft;data:DashboardData;onChange:(value:CounterpartyDraft) => void}) {
  return <><div className="edit-form-grid"><Field label="对接方名称"><input required value={draft.name} onChange={event => onChange({...draft,name:event.target.value})} /></Field><Field label="简称（可选）"><input value={draft.short_name || ""} onChange={event => onChange({...draft,short_name:event.target.value || null})} /></Field><Field label="对接方类型"><Choice value={draft.kind} options={{organization:"机构 / 单位",person:"个人"}} onChange={kind => onChange({...draft,kind:kind as CounterpartyDraft["kind"]})} /></Field></div><p className="admin-help">单位信息和人员联系方式供关联事项共用。事项中的参与人员会自动显示为相关人员，这里可补充长期联系人。</p><PeoplePicker label="共用联系人" data={data} selected={draft.people} onChange={people => onChange({...draft,people})} /><Field label="对接方备注" wide><textarea rows={5} value={draft.body} onChange={event => onChange({...draft,body:event.target.value})} /></Field></>;
}
