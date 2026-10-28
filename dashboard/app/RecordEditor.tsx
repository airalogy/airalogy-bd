"use client";
import ProgressAttachments from "./ProgressAttachments";
import { discardUpload, prepareProgressFiles, type ProgressFile } from "./lib/progress-files";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import type { DashboardData } from "./lib/types";
import type { EditableCounterparty, EditablePerson, EditableProgress, EditableProject, EditableRecord, RecordResponse, RecordTarget, SavedResponse } from "./lib/workspace-types";
import { WorkspaceError, workspaceRequest } from "./lib/workspace-client";
import { CounterpartyForm, type CounterpartyDraft, fieldLabels, PersonForm, ProjectForm, projectDraft, ProgressForm, progressDraft, readable, type ProjectDraft, type ProgressDraft } from "./RecordForms";

const kindLabels = {counterparty:"对接方档案",file:"事项资料",person:"人员档案",project:"事项信息",progress:"沟通进展",company:"公司动态"};
function draftFor(target: RecordTarget, record: EditableRecord | null) {
  if (target.kind === "counterparty") {const party=record as EditableCounterparty;return {...party.metadata,body:party.body,people:party.people};}
  if (target.kind === "person") return record || {name:"",affiliation:"",phone:null,wechat:null,email:null};
  if (target.kind === "project") return {...projectDraft(record as EditableProject | null),...(!record && target.counterparty_id ? {primary_counterparty_id:target.counterparty_id,counterparty_ids:[target.counterparty_id]} : {})};
  return progressDraft(record as EditableProgress | null);
}
function showRecord(record: EditableRecord | null, kind: string): Record<string, unknown> {
  if (!record) return {};
  if (kind === "counterparty") {const party=record as EditableCounterparty;return {...party.metadata,body:party.body,people:party.people};}
  if (kind === "person") return record as Record<string, unknown>;
  if (kind === "project") { const project = record as EditableProject; return {...project.metadata, body:project.body, contacts:project.contacts}; }
  const progress = record as EditableProgress;
  return {...progress.event,body:progress.body,location:progress.document.location || ""};
}
function renderValue(value: unknown) { return readable(typeof value === "string" ? value : JSON.stringify(value ?? "（未填写）")); }

export default function RecordEditor({target, data, onTargetChange, onClose, onSaved, onSavedWithFiles}: {target: RecordTarget; data: DashboardData; onTargetChange:(target:RecordTarget) => void; onClose: () => void; onSaved: (result: SavedResponse) => void; onSavedWithFiles?: (result: SavedResponse) => Promise<void>}) {
  const [loaded, setLoaded] = useState<RecordResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attachments,setAttachments] = useState<ProgressFile[]>([]);
  const stagedIds = useRef(new Set<string>());
  useEffect(()=>{const ids=stagedIds.current;return ()=>{for(const id of ids) void discardUpload(id).catch(()=>{});};},[]);
  const [latest, setLatest] = useState<RecordResponse | null>(null);
  const [conflict, setConflict] = useState(false);
  const [decision,setDecision] = useState<"close" | "reload" | "overwrite" | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const attachAfterSave = useRef(false);
  useEffect(() => {if (error) errorRef.current?.scrollIntoView({block:"nearest"});}, [error]);
  const title = `${target.id ? "编辑" : "新增"}${kindLabels[target.kind]}`;
  useEffect(() => {
    let cancelled = false;
    if (target.kind === "progress" && !target.project_id) return;
    workspaceRequest<RecordResponse>("record", target).then(result => {
      if (cancelled) return;
      if (target.id && !result.record) { setError("这条资料已不存在，请刷新列表。"); return; }
      setLoaded(result); setDraft(draftFor(target,result.record) as Record<string, unknown>);
    }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [target]);
  const change = (value: unknown) => { setDraft(value as Record<string,unknown>); setDirty(true); };
  const close = () => { if (busy) return;if (dirty) setDecision("close"); else onClose(); };
  const save = async (revision = loaded?.revision) => {
    if (!draft || !revision || busy) return;
    setBusy(true); setError(""); setDetails([]);
    try {
      const files = await prepareProgressFiles(attachments, target.project_id || "", (key,uploaded)=>{stagedIds.current.add(uploaded.upload_id);setAttachments(items=>items.map(item=>item.key===key?{...item,uploaded}:item));});
      const result = await workspaceRequest<SavedResponse>("save", {...target, revision, payload:draft, ...(files.length?{attachments:files}:{})}, true);
      stagedIds.current.clear();
      setDirty(false); if (attachAfterSave.current && onSavedWithFiles) await onSavedWithFiles(result); else onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存未完成。");
      if (err instanceof WorkspaceError) {
        if (err.code === "conflict") { setConflict(true); setLatest(null); }
        else if (Array.isArray(err.details)) setDetails(err.details);
      }
    } finally { setBusy(false); }
  };
  const compareLatest = async () => {
    setBusy(true);
    try { setLatest(await workspaceRequest<RecordResponse>("record",target)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const openedValues = showRecord(loaded?.record || null,target.kind);
  const latestValues = showRecord(latest?.record || null,target.kind);
  const conflictFields = latest && draft ? [...new Set([...Object.keys(openedValues),...Object.keys(latestValues),...Object.keys(draft)])].filter(key => !["id","initial_event","new_contacts"].includes(key) && JSON.stringify(openedValues[key]) !== JSON.stringify(latestValues[key])) : [];
  const project = data.projects.find(item => item.id === target.project_id);
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}><Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay" /><Dialog.Content className="admin-dialog" aria-describedby={undefined} onEscapeKeyDown={event => { event.preventDefault(); close(); }} onInteractOutside={event => event.preventDefault()}
    onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => { event.preventDefault(); openerRef.current?.focus(); }}>
    <div className="admin-dialog-head"><div><Dialog.Title asChild><h2>{title}</h2></Dialog.Title><p>{project?.name || "保存后自动留存版本，可在修改历史中比较和恢复。"}</p></div><button type="button" className="close-button" aria-label={`关闭${title}`} disabled={busy} onClick={close}>×</button></div>
    <form onSubmit={event => { event.preventDefault(); if (!conflict && !decision) {attachAfterSave.current=false;void save();} }}>
        {decision && <section className="admin-confirm" role="alertdialog" aria-labelledby="edit-confirm-title"><h3 id="edit-confirm-title">{decision === "close" ? "放弃本次草稿？" : decision === "reload" ? "载入最新内容？" : "按当前草稿保存？"}</h3><p>{decision === "close" ? "本次未保存的输入会丢失，已保存资料不会改变。" : decision === "reload" ? "最新资料会替换当前草稿，你可以在此基础上继续编辑。" : "已比较最新资料。保存前会保留最新版本，然后按当前草稿更新这条资料。"}</p><div className="admin-actions"><button type="button" className="admin-button" onClick={() => setDecision(null)}>继续编辑</button><button type="button" className="admin-button admin-primary" onClick={() => {const choice=decision;setDecision(null);if(choice === "close") onClose();else if(choice === "reload" && latest){setLoaded(latest);setDraft(draftFor(target,latest.record) as Record<string,unknown>);setConflict(false);setLatest(null);setDirty(false);setError("");}else if(choice === "overwrite" && latest) void save(latest.revision);}}>{decision === "close" ? "放弃草稿并关闭" : decision === "reload" ? "确认载入最新内容" : "确认按草稿保存"}</button></div></section>}
      <div className="admin-dialog-scroll">
        {error && <div ref={errorRef} role="alert" className="admin-alert"><p>{error}</p>{details.length > 0 && <ul>{details.map((detail,index) => <li key={index}>{detail}</li>)}</ul>}</div>}
        {conflict && <section className="edit-conflict"><h3>资料发生了变化，草稿已保留</h3><button type="button" className="admin-button" disabled={busy} onClick={() => void compareLatest()}>比较最新内容</button>
          {latest && <><div className="edit-conflict-table"><table><thead><tr><th>字段</th><th>打开时</th><th>最新资料</th><th>我的草稿</th></tr></thead><tbody>{conflictFields.map(key => <tr key={key}><th>{fieldLabels[key] || key}</th><td><pre>{renderValue(openedValues[key])}</pre></td><td><pre>{renderValue(latestValues[key])}</pre></td><td><pre>{renderValue(draft?.[key])}</pre></td></tr>)}</tbody></table>{!conflictFields.length && <p>相关进展或联系人已变化，请重新载入最新资料。</p>}</div>
            <div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={() => setDecision("reload")}>载入最新内容重新编辑</button>
              {latest.record && conflictFields.length > 0 && <button type="button" className="admin-button" disabled={busy} onClick={() => setDecision("overwrite")}>按我的草稿保存</button>}</div></>}
        </section>}
        {target.kind === "progress" && !target.project_id ? <label className="edit-field"><span>选择事项</span><select value="" aria-label="新增进展的事项" onChange={event => onTargetChange({...target,project_id:event.target.value})}><option value="">请选择事项</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label> : !loaded && !error && <p>正在读取资料…</p>}

        {draft && <fieldset key={loaded?.revision} disabled={busy || !!decision} className="edit-fields">
          {target.kind === "counterparty" && <CounterpartyForm draft={draft as CounterpartyDraft} data={data} onChange={change} />}
          {target.kind === "person" && <PersonForm record={draft as EditablePerson} isNew={!target.id} onChange={change} />}
          {target.kind === "project" && <ProjectForm draft={draft as ProjectDraft} data={data} isNew={!target.id} onChange={change} />}
          {(target.kind === "progress" || target.kind === "company") && <ProgressForm draft={draft as ProgressDraft} data={data} company={target.kind === "company"} contacts={project?.contacts.map(contact => ({person_id:contact.person_id,side:contact.side,project_roles:contact.project_roles,notes:contact.notes})) || []} onChange={change} />}
          {target.kind==="progress"&&target.project_id&&<ProgressAttachments matter={target.project_id} eventId={target.id} items={attachments} onChange={items=>{setAttachments(items);setDirty(true);}}/>}
        </fieldset>}
      </div>
      <div className="admin-dialog-footer"><span>保存前校验资料，保存后留存可恢复版本。</span><div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={close}>取消</button><>{onSavedWithFiles && target.kind === "project" && <button type="button" className="admin-button" disabled={!draft || busy || conflict} onClick={() => {attachAfterSave.current=true;void save();}}>保存并关联资料</button>}</><button type="submit" className="admin-button admin-primary" disabled={!draft || busy || conflict}>{busy ? "正在保存…" : attachments.length ? "保存进展与附件" : "保存并留存版本"}</button></div></div>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
