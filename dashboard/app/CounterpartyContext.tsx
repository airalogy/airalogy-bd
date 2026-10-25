"use client";
import type {DashboardData, Project} from "./lib/types";
import type {RecordTarget} from "./lib/workspace-types";
import {recordTypeLabels} from "./lib/labels";
import ContactChannels from "./ContactChannels";

export default function CounterpartyContext({project,data,onSelectProject,onEdit,onFiles,readOnly=false}: {
  readOnly?:boolean; project:Project; data:DashboardData; onSelectProject:(project:Project) => void;
  onEdit:(target:RecordTarget) => void; onFiles:(identity:string) => void;
}) {
  const party=data.counterparties.find(item => item.id === project.primary_counterparty_id);
  if (!party) return null;
  const matters=data.projects.filter(item => item.counterparty_ids.includes(party.id));
  const partners=data.counterparties.filter(item => project.counterparty_ids.includes(item.id) && item.id !== party.id);
  return <section className="counterparty-context" aria-label="对接方与关联事项">
    <div className="counterparty-context-head">
      <div><small>对接方</small><strong>{party.short_name || party.name}</strong></div>
      <div className="admin-actions">
        {!readOnly && <button type="button" className="event-secondary-trigger" onClick={() => onEdit({kind:"counterparty",id:party.id})}>对接方档案</button>}
        <button type="button" className="event-secondary-trigger" onClick={() => onFiles(party.id)}>共用资料</button>
        {!readOnly && <button type="button" className="event-secondary-trigger" onClick={() => onEdit({kind:"project",id:"",counterparty_id:party.id})}>添加另一事项</button>}
      </div>
    </div>
    {readOnly && party.body && <details><summary>对接方档案</summary><p className="historical-body">{party.body}</p></details>}
    {matters.length > 1 && <label className="edit-field"><span>该对接方的事项</span>
      <select value={project.id} onChange={event => {const item=data.projects.find(item => item.id === event.target.value);if(item)onSelectProject(item);}}>
        {matters.map(item => <option key={item.id} value={item.id}>{recordTypeLabels[item.record_type]} · {item.name}</option>)}
      </select>
    </label>}
    {partners.length > 0 && <div className="admin-actions"><small>共同参与：</small>{partners.map(item =>
      readOnly ? <span key={item.id}>{item.short_name || item.name}</span> : <button key={item.id} type="button" className="event-secondary-trigger" onClick={() => onEdit({kind:"counterparty",id:item.id})}>{item.short_name || item.name}</button>
    )}</div>}
    <details><summary>共用联系人 · {party.related_people.length} 人</summary><div className="counterparty-contacts">
      {party.related_people.map(id => {const person=data.people.find(item => item.id === id);return person && <div key={id}>
        {readOnly ? <strong>{person.name}</strong> : <button className="event-secondary-trigger" type="button" onClick={() => onEdit({kind:"person",id})}>{person.name}</button>}<small>{person.affiliation}</small><ContactChannels person={person} />
      </div>;})}
    </div></details>
  </section>;
}
