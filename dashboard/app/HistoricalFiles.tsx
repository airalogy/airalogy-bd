"use client";
import * as Dialog from "@radix-ui/react-dialog";
import type {DashboardData} from "./lib/types";
import type {FileTarget} from "./FileLibrary";
import {fileTypeLabel,fileStatuses,fileUses} from "./lib/file-library";
export default function HistoricalFiles({data,target,version,onClose}:{data:DashboardData;target:FileTarget;version:string;onClose:()=>void}) {
  const files=(data.files || []).filter(item=>!item.archived && (!target.agreementType || item.agreement_type === target.agreementType) && (!target.projectId || item.project_ids.includes(target.projectId)) && (!target.counterpartyId || item.home_counterparty_id===target.counterpartyId) && (!target.eventId || item.records.some(record=>record.event_id===target.eventId)));
  return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className="drawer-layer"/><Dialog.Content className="project-drawer" aria-describedby="historical-files-description">
    <div className="drawer-head"><Dialog.Title>历史资料</Dialog.Title><Dialog.Close className="close-button" aria-label="关闭历史资料">×</Dialog.Close></div>
    <Dialog.Description id="historical-files-description">只显示此版本中已归档的文件和使用记录。附件仍需保留在本机才能打开。</Dialog.Description>
    {!files.length && <p className="panel-empty-state">此版本中暂无符合范围的资料。</p>}
    {files.map(file=><section className="backup-result" key={file.id}><h2>{file.title}</h2><p>{file.organization} · {fileTypeLabel(file)}</p><p>{file.notes}</p>
      {file.versions.map(item=><div className="historical-file" key={item.id}><a className="admin-button" href={`/api/files?${new URLSearchParams({action:"download",id:file.id,version_id:item.id,snapshot:version})}`}>{item.filename}</a><small>{fileStatuses[item.status]} · {new Date(item.created_at).toLocaleString(data.workspace.locale,{timeZone:data.workspace.timezone})}</small><p>{item.note}</p></div>)}
      {file.records.map(record=><p key={record.id}>{record.date} · {fileUses[record.kind]} · {file.versions.find(item=>item.id===record.version_id)?.filename} · {record.people.join("、")} {record.channel} {record.note}</p>)}
    </section>)}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
