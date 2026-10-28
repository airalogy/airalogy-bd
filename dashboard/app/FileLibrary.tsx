"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { Field, PeoplePicker } from "./RecordForms";
import AgreementDateFields from "./AgreementDateFields";
import AgreementDates from "./AgreementDates";
import type { DashboardData } from "./lib/types";
import type { RecordTarget, SavedResponse } from "./lib/workspace-types";
import { agreementTypes, fileCategories, fileStatuses, fileUses, fileRequest, fileUrl, fileTypeLabel, matchesFileFilter, type AgreementType, type FileFilter, type FileListing, type LibraryFile, type FileUsage, type FileVersion } from "./lib/file-library";

export type FileTarget = { projectId?: string; eventId?: string; counterpartyId?: string; agreementType?: AgreementType; category?: LibraryFile["category"]; usageKind?: FileUsage["kind"]; fileId?: string };
type EditMode = "view" | "import" | "version" | "metadata" | "usage" | "dates";
const accept = ".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.md,.csv,.zip";
const sizeLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;


function AgreementDateForm({version, number, busy, onDirty, onSave, onCancel}: {
  version: FileVersion; number: number; busy: boolean; onDirty: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<void>; onCancel: () => void;
}) {
  const [dates, setDates] = useState({agreement_date:version.agreement_date || "", signing_completed_date:version.signing_completed_date || ""});
  return <form className="files-form" onSubmit={event => {event.preventDefault();void onSave({version_id:version.id, ...dates});}}>
    <h3>协议日期 · v{number}</h3><p className="admin-help">{version.filename}</p>
    <fieldset disabled={busy} className="edit-fields"><AgreementDateFields value={dates} onChange={value => {setDates({agreement_date:value.agreement_date || "", signing_completed_date:value.signing_completed_date || ""});onDirty();}} /></fieldset>
    <div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="admin-button admin-primary" disabled={busy}>{busy ? "正在保存…" : "保存协议日期"}</button></div>
  </form>;
}

function FileForm({ data, file, mode, target, busy, onDirty, onSave, onCancel }: {
  data: DashboardData; file?: LibraryFile; mode: EditMode; target: FileTarget; busy: boolean;
  onDirty: () => void; onSave: (payload: Record<string, unknown>, upload?: File) => Promise<void>; onCancel: () => void;
}) {
  const project = data.projects.find(item => item.id === target.projectId);
  const [title, setTitle] = useState(file?.title || "");
  const [category, setCategory] = useState<LibraryFile["category"]>(file?.category || target.category || (target.agreementType ? "agreement" : "other"));
  const [agreementType, setAgreementType] = useState<keyof typeof agreementTypes>(file?.agreement_type || (!file ? target.agreementType || "unspecified" : "unspecified"));
  const [projects, setProjects] = useState<string[]>(file?.project_ids || (project ? [project.id] : data.counterparties.find(item => item.id === target.counterpartyId)?.matter_ids.length === 1 ? data.counterparties.find(item => item.id === target.counterpartyId)!.matter_ids : []));
  const [homeParty, setHomeParty] = useState(file?.home_counterparty_id || target.counterpartyId || project?.primary_counterparty_id || "");
  const [notes, setNotes] = useState(file?.notes || "");
  const [upload, setUpload] = useState<File>();
  const [status, setStatus] = useState<FileVersion["status"]>("unspecified");
  const [note, setNote] = useState("");
  const [dates, setDates] = useState<Pick<FileVersion, "agreement_date" | "signing_completed_date">>({});
  const [error, setError] = useState("");
  return <form className="files-form" onChange={onDirty} onSubmit={event => {
    event.preventDefault(); setError("");
    if (!homeParty) { setError("请选择归档对接方。"); return; }
    if (!data.projects.some(item => projects.includes(item.id) && item.counterparty_ids.includes(homeParty))) {setError("至少选择一个与归档对接方有关的事项。");return;}
    if (!projects.length) { setError("至少选择一个关联事项。"); return; }
    if (mode !== "metadata" && (!upload || !upload.size || upload.size > 50 * 1024 * 1024)) { setError("请选择非空文件，单个文件不能超过 50 MB。"); return; }
    void onSave({ title, organization:data.counterparties.find(party => party.id === homeParty)?.name || "", category, agreement_type: category === "agreement" ? agreementType : "unspecified", project_ids: projects, home_counterparty_id: homeParty, notes, status, note, ...(category === "agreement" && mode !== "metadata" ? dates : {}) }, upload);
  }}>
    <h3>{mode === "version" ? `导入新版本 · ${file?.title}` : mode === "metadata" ? "修改资料信息" : "导入事项资料"}</h3>
    <fieldset disabled={busy} className="edit-fields">
      {mode !== "version" && <>
        <Field label="资料名称"><input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} /></Field>
        <Field label="资料分类"><select value={category} onChange={event => {setCategory(event.target.value as LibraryFile["category"]);setAgreementType("unspecified");}}>{Object.entries(fileCategories).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        {category === "agreement" && <Field label="协议类型"><select value={agreementType} onChange={event => setAgreementType(event.target.value as keyof typeof agreementTypes)}>{Object.entries(agreementTypes).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
        <Field label="归档对接方" hint="文件保存在此对接方的文件夹内，可关联多个事项。导入后归档位置保持不变。"><select required value={homeParty} disabled={!!file} onChange={event => {const id=event.target.value;setHomeParty(id);const matters=data.projects.filter(item => item.counterparty_ids.includes(id));if(matters.length === 1 && !projects.includes(matters[0].id))setProjects([...projects,matters[0].id]);}}><option value="">请选择归档对接方</option>{data.counterparties.filter(item => item.matter_ids.length > 0).map(item => <option key={item.id} value={item.id}>{item.short_name || item.name}</option>)}</select></Field>
        <fieldset className="files-project-picker"><legend>关联事项（可多选）</legend>{data.projects.map(item => <label key={item.id}><input type="checkbox" checked={projects.includes(item.id)} onChange={event => setProjects(event.target.checked ? [...projects,item.id] : projects.filter(id => id !== item.id))} />{item.name}</label>)}</fieldset>
        <Field label="资料备注" wide><textarea rows={2} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} /></Field>
      </>}
      {mode !== "metadata" && <>
        <Field label="选择归档文件" wide hint="支持 PDF、Office 文档、图片、文本、ZIP；单个文件不超过 50 MB。"><input type="file" accept={accept} required onChange={event => { const chosen=event.target.files?.[0];setUpload(chosen);if(chosen && !title) setTitle(chosen.name.replace(/\.[^.]+$/, "")); }} /></Field>
        <Field label="此版本的文件状态"><select value={status} onChange={event => setStatus(event.target.value as FileVersion["status"])}>{Object.entries(fileStatuses).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="版本说明"><input maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="例如：补充研发里程碑" /></Field>
        {category === "agreement" && <AgreementDateFields value={dates} onChange={setDates} />}
        <p className="admin-help edit-field-wide">归档后保留此版本原件。会议使用、实际发送和对方提供的情况，可在归档后单独记录。</p>
      </>}
    </fieldset>
    {error && <p className="admin-alert" role="alert">{error}</p>}
    <div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="admin-button admin-primary" disabled={busy}>{busy ? "正在保存…" : mode === "metadata" ? "保存资料信息" : "导入并留存版本"}</button></div>
  </form>;
}

function UsageForm({ data, file, target, original, busy, onDirty, onSave, onCancel }: {
  data: DashboardData; file: LibraryFile; target: FileTarget; original?: FileUsage; busy: boolean;
  onDirty: () => void; onSave: (payload: Record<string, unknown>) => Promise<void>; onCancel: () => void;
}) {
  const initialProject = original?.project_id || target.projectId || file.project_ids[0];
  const initialEvent = data.projects.find(item => item.id === initialProject)?.events.find(item => item.id === target.eventId);
  const [draft, setDraft] = useState({ version_id: original?.version_id || file.current_version, kind: original?.kind || target.usageKind || "meeting", date: original?.date || initialEvent?.date || "", project_id: initialProject, event_id: original?.event_id || target.eventId || "", people: original?.people || [] as string[], channel: original?.channel || "", note: original?.note || "" });
  const project = data.projects.find(item => item.id === draft.project_id);
  const change = (value: Partial<typeof draft>) => { setDraft({...draft,...value});onDirty(); };
  return <form className="files-form" onSubmit={event => {event.preventDefault();void onSave({...draft, ...(original ? {record_id:original.id} : {})});}}>
    <h3>{original ? "更正使用记录" : "记录资料使用"} · {file.title}</h3>
    <p className="admin-help">这里只记录已经发生的使用或发送情况，不会替你发送文件。</p>
    <fieldset disabled={busy} className="edit-fields">
      <Field label="具体文件版本"><select value={draft.version_id} onChange={event => change({version_id:event.target.value})}>{file.versions.map((version,index) => <option key={version.id} value={version.id}>v{index+1} · {fileStatuses[version.status]} · {version.filename}</option>)}</select></Field>
      <Field label="使用情况"><select value={draft.kind} onChange={event => change({kind:event.target.value as FileUsage["kind"]})}>{Object.entries(fileUses).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="实际日期"><input type="date" required value={draft.date} onChange={event => change({date:event.target.value})} /></Field>
      <Field label="关联事项"><select value={draft.project_id} onChange={event => change({project_id:event.target.value,event_id:""})}>{data.projects.filter(item => file.project_ids.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="关联交流（可选）" wide><select value={draft.event_id} onChange={event => {const selected=project?.events.find(item => item.id === event.target.value);change({event_id:event.target.value,...(!draft.date && selected ? {date:selected.date} : {})});}}><option value="">不关联具体交流</option>{[...project?.events || []].sort((a,b) => b.date.localeCompare(a.date)).map(item => <option key={item.id} value={item.id}>{item.date} · {item.title}</option>)}</select></Field>
      <div className="edit-field-wide"><PeoplePicker data={data} selected={draft.people} onChange={people => change({people})} label={draft.kind === "sent" ? "收件人" : draft.kind === "received" ? "提供人" : "相关人员"} /></div>
      <Field label="渠道" hint={draft.kind === "meeting" ? "可选，例如现场展示" : "例如邮件、微信；须填写实际渠道"}><input required={draft.kind !== "meeting"} maxLength={100} value={draft.channel} onChange={event => change({channel:event.target.value})} /></Field>
      <Field label="使用说明" wide><textarea maxLength={1000} rows={3} value={draft.note} onChange={event => change({note:event.target.value})} /></Field>
    </fieldset>
    <div className="admin-actions"><button type="button" className="admin-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="admin-button admin-primary" disabled={busy}>{busy ? "正在保存…" : "保存使用记录"}</button></div>
  </form>;
}

export default function FileLibraryDialog({ data, target, onClose, onChanged, onHistory }: {
  data: DashboardData; target: FileTarget; onClose: () => void; onChanged: () => Promise<void>; onHistory: (target: RecordTarget) => void;
}) {
  const canEdit=!data.access || data.access.role!=="viewer";
  const canAdmin=!data.access || data.access.role==="admin";
  const local=!data.access?.server;
  const [listing, setListing] = useState<FileListing>();
  const [selected, setSelected] = useState(target.fileId || "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FileFilter>(target.agreementType || target.category || "all");
  const [trash, setTrash] = useState(Boolean(data.files?.find(item => item.id === target.fileId)?.archived));
  const [eventOnly, setEventOnly] = useState(true);
  const [mode, setMode] = useState<EditMode>("view");
  const [usageId, setUsageId] = useState("");
  const [dateVersionId, setDateVersionId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [confirmation, setConfirmation] = useState<{title:string; detail:string; action:() => void} | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const file = listing?.files.find(item => item.id === selected);
  const dateVersion = file?.versions.find(version => version.id === dateVersionId);
  const project = data.projects.find(item => item.id === target.projectId);
  const event = project?.events.find(item => item.id === target.eventId);
  const party = data.counterparties.find(item => item.id === target.counterpartyId);
  const refresh = async () => { const next=await fileRequest<FileListing>();setListing(next);return next; };
  useEffect(() => {
    let cancelled=false;
    fileRequest<FileListing>().then(value => {if(!cancelled)setListing(value);}).catch(err => {if(!cancelled)setError(err.message);});
    return () => {cancelled=true;};
  }, []);
  const navigate = (action: () => void) => { if(busy)return;if(dirty)setPending(() => action);else action(); };
  const changeMode = (next: EditMode) => { setMode(next);setUsageId("");setDirty(false);setError(""); };
  const cancel = () => navigate(() => changeMode("view"));
  const save = async (operation: string, payload: Record<string,unknown> = {}, upload?: File) => {
    setBusy(true);setError("");setNotice("");
    try {
      const result = await fileRequest<SavedResponse>({action:"file_save",operation,id:mode === "import" ? "" : file?.id,revision:mode === "import" ? undefined : file?.revision,payload},upload);
      const next = await refresh();await onChanged();setSelected(result.id);setDirty(false);setNotice(result.message);
      const saved = next.files.find(item => item.id === result.id);
      if (saved && !matchesFileFilter(saved,filter,query)) {setFilter("all");setQuery("");}
      setMode(mode === "import" && (target.eventId || target.usageKind) ? "usage" : "view");setUsageId("");
      if(operation === "archive" || operation === "unarchive") setTrash(operation === "archive");
      if(operation === "usage" && target.eventId) setEventOnly(true);
    } catch(err) {setError(err instanceof Error ? err.message : "保存未完成。");} finally {setBusy(false);}
  };
  const backup = async () => {
    setBusy(true);setError("");
    try {const result=await fileRequest<{id:string}>({action:"file_backup"});const link=document.createElement("a");link.href=`/api/files?action=backup&id=${result.id}`;link.download="BD工作台完整备份.zip";document.body.append(link);link.click();link.remove();setNotice("完整备份已生成，包含业务资料、附件原件和工作台自动修改历史。");}
    catch(err){setError(err instanceof Error ? err.message : "备份未完成。");}finally{setBusy(false);}
  };
  const reveal = async (target: { version_id: string } | { record_id: string }) => {
    if (!file || busy) return;
    setBusy(true);setError("");setNotice("");
    try {
      const result = await fileRequest<{message:string}>({action:"file_reveal",id:file.id,...target});
      setNotice(result.message);
    } catch(err) {setError(err instanceof Error ? err.message : "未能打开所在文件夹。");} finally {setBusy(false);}
  };
  const partyName = (item:LibraryFile) => {const owner=data.counterparties.find(party => party.id === item.home_counterparty_id);return owner?.short_name || owner?.name || item.organization;};
  const visible = listing?.files.filter(item => item.archived === trash && (!target.projectId || item.project_ids.includes(target.projectId)) && (!party || item.home_counterparty_id === party.id || item.project_ids.some(id => party.matter_ids.includes(id))) && (!target.eventId || !eventOnly || item.records.some(record => record.event_id === target.eventId && record.project_id === target.projectId)) && matchesFileFilter(item,filter,query,partyName(item))) || [];
  return <Dialog.Root open onOpenChange={open => {if(!open)navigate(onClose);}}><Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay" /><Dialog.Content className="admin-dialog files-dialog" aria-describedby="files-description"
    onOpenAutoFocus={() => {opener.current=document.activeElement instanceof HTMLElement ? document.activeElement : null;}}
    onCloseAutoFocus={event => {event.preventDefault();if(opener.current?.isConnected) opener.current.focus();}}
    onEscapeKeyDown={event => {event.preventDefault();if(pending)setPending(null);else if(confirmation)setConfirmation(null);else navigate(onClose);}}
    onInteractOutside={event => event.preventDefault()}>
    <header className="admin-dialog-head"><div><Dialog.Title>{!project && !party && filter === "nda" ? "全部 NDA" : "事项资料"}{project ? ` · ${project.name}` : party ? ` · ${party.short_name || party.name}` : ""}</Dialog.Title><Dialog.Description id="files-description">{event ? `${event.date} · ${event.title}` : "协议、交流材料与发送记录，按具体版本归档。"}</Dialog.Description></div><button type="button" className="close-button" aria-label="关闭事项资料" disabled={busy} onClick={() => navigate(onClose)}>×</button></header>
    {pending && <section className="admin-confirm" role="alertdialog" aria-label="放弃资料草稿"><h3>放弃本次未保存的输入？</h3><div className="admin-actions"><button className="admin-button" onClick={() => setPending(null)}>继续填写</button><button className="admin-button" onClick={() => {const action=pending;setPending(null);setDirty(false);action();}}>放弃草稿并继续</button></div></section>}
    {confirmation && <section className="admin-confirm" role="alertdialog" aria-label={confirmation.title}><h3>{confirmation.title}</h3><p>{confirmation.detail}</p><div className="admin-actions"><button className="admin-button" onClick={() => setConfirmation(null)}>取消操作</button><button className="admin-button admin-primary" onClick={() => {const action=confirmation.action;setConfirmation(null);action();}}>确认操作</button></div></section>}
    <div className="files-toolbar"><div className="admin-actions">{canEdit && <button type="button" className="admin-button admin-primary" disabled={busy || !listing} onClick={() => navigate(() => {setSelected("");changeMode("import");})}>导入资料</button>}<button type="button" className="admin-button" disabled={busy} onClick={() => navigate(() => {changeMode("view");void refresh().catch(err => setError(err.message));})}>刷新</button></div>{canAdmin && <button type="button" className="admin-button" disabled={busy || dirty} onClick={() => void backup()}>备份全部资料</button>}</div>
    {target.category === "bp" && <p className="admin-help">BP 发送状态按本事项的“实际发送”记录汇总。导入或选择 BP 后，点击“记录使用 / 发送”，选择当时发送的版本并填写日期、收件人和渠道。仅导入文件或会议展示不算已发送。</p>}
    {error && <div role="alert" className="admin-alert">{error}</div>}{notice && <div role="status" className="admin-notice">{notice}</div>}
    <div className="files-layout"><aside className="files-sidebar"><input aria-label="搜索事项资料" type="search" placeholder="文件、名称、机构" value={query} onChange={event => setQuery(event.target.value)} /><div className="files-scope"><button aria-pressed={!trash} onClick={() => navigate(() => {setTrash(false);setSelected("");changeMode("view");})}>在用资料</button><button aria-pressed={trash} onClick={() => navigate(() => {setTrash(true);setSelected("");changeMode("view");})}>回收站</button></div>
      <label className="files-event-scope">文件类型<select aria-label="按文件类型筛选" value={filter} onChange={event => navigate(() => {setFilter(event.target.value as FileFilter);setSelected("");changeMode("view");setNotice("");})}><option value="all">全部类型</option>{Object.entries(agreementTypes).filter(([value]) => value !== "unspecified").map(([value,label]) => <option key={value} value={value}>{label}</option>)}{Object.entries(fileCategories).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <>{event && <label className="files-event-scope">显示范围<select aria-label="资料显示范围" value={eventOnly ? "event" : "project"} onChange={event => navigate(() => {setEventOnly(event.target.value === "event");setSelected("");changeMode("view");})}><option value="event">本次交流资料</option><option value="project">本事项全部资料</option></select></label>}</><div className="files-list">{visible.map(item => <button key={item.id} aria-pressed={item.id === selected} onClick={() => navigate(() => {setSelected(item.id);changeMode("view");setNotice("");})}><strong>{item.title}</strong><span>{partyName(item)} · {fileTypeLabel(item)}</span><small>{item.versions.length} 个版本 · {item.records.filter(record => record.kind === "sent").length} 次发送</small></button>)}{!visible.length && <p className="admin-help">{!listing ? "正在读取资料…" : target.eventId && eventOnly ? "这次交流暂无关联资料。可导入文件，或切换到‘本事项全部资料’，选择已有文件记录使用情况。" : trash ? "回收站为空。" : filter === "nda" ? "暂无符合条件的 NDA。可导入保密协议，或修改已有协议的类型。" : "暂无符合条件的资料，可调整筛选或导入资料。"}</p>}</div>
    </aside><div className="files-detail" aria-busy={busy}>
      {(mode === "import" || mode === "version" || mode === "metadata") ? <FileForm key={`${mode}-${selected}`} data={data} target={{...target,agreementType:filter in agreementTypes ? filter as AgreementType : undefined}} file={mode === "import" ? undefined : file} mode={mode} busy={busy} onDirty={() => setDirty(true)} onCancel={cancel} onSave={(payload,upload) => save(mode === "metadata" ? "metadata" : "upload",payload,upload)} />
      : mode === "usage" && file ? <UsageForm key={`${file.id}-${usageId}`} data={data} file={file} target={target} original={file.records.find(record => record.id === usageId)} busy={busy} onDirty={() => setDirty(true)} onCancel={cancel} onSave={payload => save("usage",payload)} />
      : mode === "dates" && file && dateVersion ? <AgreementDateForm key={`${file.id}-${dateVersion.id}`} version={dateVersion} number={file.versions.indexOf(dateVersion)+1} busy={busy} onDirty={() => setDirty(true)} onCancel={cancel} onSave={payload => save("agreement_dates",payload)} />
      : file ? <>
        <div className="files-title"><div><span className="eyebrow">{fileTypeLabel(file)} · {file.archived ? "回收站" : "在用资料"}</span><h3>{file.title}</h3><p>{partyName(file)}</p></div></div>
        {canEdit && <div className="admin-actions files-detail-actions">{canEdit && !file.archived && <><button className="admin-button" disabled={busy} onClick={() => changeMode("version")}>导入新版本</button><button className="admin-button" disabled={busy} onClick={() => changeMode("usage")}>记录使用 / 发送</button><button className="admin-button" disabled={busy} onClick={() => changeMode("metadata")}>修改信息</button></>}{canAdmin && <button className="admin-button" disabled={busy} onClick={() => {onClose();onHistory({kind:"file",id:file.id});}}>修改历史</button>}<button className="admin-button" disabled={busy} onClick={() => setConfirmation({title:file.archived ? "恢复这份资料？" : "移入回收站？",detail:file.archived ? "恢复后可继续关联交流和记录发送。" : "文件原件、所有版本和使用记录都会保留，可随时恢复。",action:() => {void save(file.archived ? "unarchive" : "archive");}})}>{file.archived ? "恢复资料" : "移入回收站"}</button></div>}
        {file.notes && <p className="files-notes">{file.notes}</p>}<p className="admin-help">归档对接方：{data.counterparties.find(item => item.id === file.home_counterparty_id)?.name || file.home_counterparty_id}</p><p className="admin-help">关联事项：{file.project_ids.map(id => data.projects.find(item => item.id === id)?.name || id).join("、")}</p>
        <section className="files-section"><h4>文件版本</h4>{[...file.versions].reverse().map(version => <article className="file-version" key={version.id}><div><strong>v{file.versions.indexOf(version)+1} · {fileStatuses[version.status]} {version.id === file.current_version && <span className="file-current">当前版本</span>}</strong><p>{version.filename}</p><small>归档于 {new Date(version.created_at).toLocaleString(data.workspace.locale,{timeZone:data.workspace.timezone})} · {sizeLabel(version.size)}</small>{version.note && <p>{version.note}</p>}{file.category === "agreement" && <AgreementDates version={version} />}</div><div className="admin-actions">{canEdit && !file.archived && file.category === "agreement" && <button type="button" className="admin-button" disabled={busy} onClick={() => {setDateVersionId(version.id);changeMode("dates");}}>填写 / 更正日期</button>}<a className="admin-button" href={fileUrl(file,version)} download>下载</a>{local && <button type="button" className="admin-button" disabled={busy} onClick={() => void reveal({version_id:version.id})}>打开所在文件夹</button>}{/\.(pdf|png|jpe?g)$/i.test(version.filename) && <a className="admin-button" href={fileUrl(file,version,true)} target="_blank" rel="noreferrer">预览</a>}{canEdit && !file.archived && version.id !== file.current_version && <button className="admin-button" disabled={busy} onClick={() => setConfirmation({title:`恢复为 v${file.versions.indexOf(version)+1}？`,detail:"其他文件版本继续保留，已有发送记录仍指向当时的版本。",action:() => {void save("select_version",{version_id:version.id});}})}>设为当前版本</button>}</div></article>)}</section>
        <section className="files-section"><h4>使用与发送记录</h4>{!file.records.length && <p className="admin-help">暂无使用记录。导入文件不会自动标记为已发送。</p>}{[...file.records].sort((a,b) => b.date.localeCompare(a.date)).map(record => {const relatedProject=data.projects.find(item => item.id === record.project_id);const relatedEvent=relatedProject?.events.find(item => item.id === record.event_id);const version=file.versions.find(item => item.id === record.version_id)!;return <article className="file-usage" key={record.id}><div><strong>{record.date} · {fileUses[record.kind]} · v{file.versions.indexOf(version)+1}</strong><p>{record.people.map(id => data.people.find(person => person.id === id)?.name || id).join("、") || "未指定人员"}{record.channel ? ` · ${record.channel}` : ""}</p><small>{relatedProject?.name}{relatedEvent ? ` · ${relatedEvent.title}` : ""}</small>{record.note && <p>{record.note}</p>}</div><div className="admin-actions"><a className="admin-button" href={fileUrl(file,version)} download>下载当时版本</a>{local && <button type="button" className="admin-button" disabled={busy} onClick={() => void reveal({record_id:record.id})}>打开所在文件夹</button>}{canEdit && !file.archived && <><button className="admin-button" disabled={busy} onClick={() => {setUsageId(record.id);setMode("usage");}}>更正记录</button><button className="admin-button" disabled={busy} onClick={() => setConfirmation({title:"移除这条使用记录？",detail:"仅移除这条记录，文件原件继续保留；修改历史中可回溯。",action:() => {void save("usage_remove",{record_id:record.id});}})}>移除记录</button></>}</div></article>;})}</section>
      </> : <div className="files-empty"><h3>把交流资料与进展放在一起</h3><p>选择一份资料查看版本和发送情况，或导入第一份资料。</p><p>同一份资料可关联多个事项，发送记录始终对应具体版本。</p></div>}
    </div></div>
    {listing && <footer className="files-footer"><details><summary>归档与备份说明</summary>{local?<p>工作区根目录：{listing.workspace_directory}</p>:<p>资料保存在公司服务器，可下载到自己的电脑。完整备份由管理员管理。</p>}<p>附件随对接方保存：{listing.directory_pattern}</p><p>业务记录、附件和自动修改历史统一保存在这个工作区内。备份仅包含工作台管理的资料。</p><p>每个对接方的档案、事项和附件放在同一个文件夹内。同一资料关联多个事项时，只在归档对接方内保存文件。</p><p>同一份资料的各版本放在同一个文件夹内，默认保留原文件名；同名且内容不同时追加版本后缀。NDA 的签署状态单独记录，不会改变关联事项的推进阶段。</p><p>目录中的文件是归档副本。更新内容请导入新版本；原有主版本可以继续在原目录编辑。完整备份包含附件原件、业务记录和工作台自动修改历史，原仓库 Git 历史由原仓库单独备份。</p></details></footer>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
