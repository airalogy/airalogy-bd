"use client";

import {useEffect, useState} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {workspaceRequest} from "./lib/workspace-client";
import {SettingsPanelHeader} from "./SettingsUI";

type Target = {kind:"project"|"progress";id:string;project_id?:string};
type Operation = {operation:"archive"|"restore";at:string;actor:{id:string;name:string}};
type Item = Target & {title:string;matter_name:string;archived:boolean;parent_archived:boolean;revision:string;
  participant_names?:string[];supplements?:{id:string;title:string;date:string;author:{name:string};body:string}[];
  counts:{progress:number;attachments:number;supplements:number};history:Operation[];
  record?:{body?:string;event?:{date:string;summary:string;participants:string[]};events?:{id:string;date:string;title:string;summary:string}[]}};
const targetOf = (item:Target):Target => ({kind:item.kind,id:item.id,project_id:item.project_id});
function at(value:string, timezone:string) {return new Intl.DateTimeFormat("zh-CN",{timeZone:timezone,dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}

export function RecycleDialog({target,mode="archive",timezone,onClose,onChanged}:{target:Target;mode?:"archive"|"restore"|"read";timezone:string;onClose:()=>void;onChanged:()=>Promise<void>}) {
  const [item,setItem]=useState<Item|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[requestId,setRequestId]=useState("");
  const load = async () => {setItem(null);setError("");try {setItem(await workspaceRequest<Item>("recycle",{...target,operation:mode==="read"?"read":"preview"}));setRequestId(crypto.randomUUID());} catch(e){setError((e as Error).message);}};
  useEffect(()=>{const controller=new AbortController();void workspaceRequest<Item>("recycle",{kind:target.kind,id:target.id,project_id:target.project_id,operation:mode==="read"?"read":"preview"},false,controller.signal).then(value=>{if(!controller.signal.aborted){setItem(value);setRequestId(crypto.randomUUID());}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[target.kind,target.id,target.project_id,mode]);
  const save=async()=>{if(!item)return;setBusy(true);setError("");try {await workspaceRequest("recycle",{...target,operation:mode,revision:item.revision,request_id:requestId,confirmed:true},true);await onChanged();onClose();} catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const title=mode==="archive"?"移入回收站":mode==="restore"?"恢复记录":"回收站记录";
  const blocked=item&&(item.parent_archived||(mode==="archive"&&item.archived)||(mode==="restore"&&!item.archived));
  return <Dialog.Root open onOpenChange={open=>{if(!open&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="record-dialog-overlay"/><Dialog.Content className="record-dialog recycle-dialog" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}}>
    <header className="record-dialog-head"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{mode==="read"?"原始资料和回收站操作记录。":"仅管理员可操作，原始资料和修改历史会完整保留。"}</Dialog.Description></div><Dialog.Close asChild><button type="button" disabled={busy} className="close-button" aria-label="关闭回收站操作">×</button></Dialog.Close></header>
    <div className="record-dialog-scroll">
      {error&&<div className="admin-alert" role="alert">{error}<button className="supplement-text-action" type="button" disabled={busy} onClick={()=>void load()}>重新读取并核对</button></div>}
      {!item&&!error&&<p role="status">正在读取记录…</p>}
      {item&&<><p className="recycle-kind">{item.kind==="project"?"事项":`沟通进展 · ${item.matter_name}`}</p><h3>{item.title}</h3>
        <dl className="recycle-counts"><div><dt>沟通进展</dt><dd>{item.counts.progress} 条</dd></div><div><dt>关联资料</dt><dd>{item.counts.attachments} 份</dd></div><div><dt>会后补充</dt><dd>{item.counts.supplements} 条</dd></div></dl>
        {mode!=="read"&&<p>{mode==="archive"?"移入后不再显示在正常列表、动态日历和统计中。共享人员、对接方和附件不会删除，可在管理中心的回收站恢复。":"恢复后重新显示在正常列表。单独移入回收站的其他进展会保持原有状态。"}</p>}
        {item.parent_archived&&<p className="admin-notice">所属事项也在回收站中，请先恢复事项。</p>}
        {mode==="archive"&&item.archived&&<p role="status">这条记录已经在回收站中。</p>}
        {mode==="restore"&&!item.archived&&<p role="status">这条记录已经恢复。</p>}
        {item.record&&<section className="recycle-preview"><h4>原始内容</h4>{item.record.event&&<p>{item.record.event.date} · {item.participant_names?.join("、")}</p>}<div className="markdown-record"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.record.body||item.record.event?.summary||"暂无正文"}</ReactMarkdown></div>{item.record.events?.map(e=><div key={e.id}><h4>{e.date} · {e.title}</h4><p>{e.summary}</p></div>)}</section>}
        {item.supplements?.map(s=><details key={s.id} className="recycle-preview"><summary>{s.title||"会后补充"} · {s.date} · {s.author.name}</summary><div className="markdown-record"><ReactMarkdown remarkPlugins={[remarkGfm]}>{s.body}</ReactMarkdown></div></details>)}
        {item.history.length>0&&<details className="recycle-history" open={mode==="read"}><summary>回收站操作记录 · {item.history.length} 次</summary><ol>{item.history.map((h,i)=><li key={i}><strong>{h.operation==="archive"?"移入回收站":"恢复"}</strong><span>{h.actor.name}</span><time dateTime={h.at}>{at(h.at,timezone)}</time></li>)}</ol></details>}
        <div className="admin-actions recycle-actions"><button type="button" className="admin-button" disabled={busy} onClick={onClose}>{mode==="read"?"关闭":"取消"}</button>{mode!=="read"&&<button type="button" className={`admin-button ${mode==="archive"?"recycle-danger":"admin-primary"}`} disabled={busy||!!blocked||!requestId} onClick={()=>void save()}>{busy?"处理中…":mode==="archive"?"确认移入回收站":"确认恢复"}</button>}</div>
      </>}
    </div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export default function RecycleBin({timezone}:{timezone:string}) {
  const [items,setItems]=useState<Item[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true),[showRestored,setShowRestored]=useState(false),[selected,setSelected]=useState<{item:Item;mode:"read"|"restore"}|null>(null);
  const load=async()=>{setLoading(true);setError("");try{setItems((await workspaceRequest<{items:Item[]}>("recycle")).items);}catch(e){setError((e as Error).message);}finally{setLoading(false);}};
  useEffect(()=>{const controller=new AbortController();void workspaceRequest<{items:Item[]}>("recycle",{},false,controller.signal).then(r=>{if(!controller.signal.aborted)setItems(r.items);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[]);
  const visible=items.filter(item=>item.archived||showRestored);
  return <section className="panel admin-center-panel recycle-bin"><SettingsPanelHeader title="回收站" description="管理移入回收站的事项与沟通进展，可查看原文并恢复。" actions={<button type="button" className="admin-button" disabled={loading} onClick={()=>void load()}>刷新</button>}/>
    <p className="admin-help">此处不会永久删除资料。合作暂停或终止请调整事项状态，仍需保留在业务记录中。</p><label className="recycle-filter"><input type="checkbox" checked={showRestored} onChange={e=>setShowRestored(e.target.checked)}/>同时显示已恢复的记录</label>
    {error&&<p role="alert" className="admin-alert">{error}</p>}{loading&&<p role="status">正在读取回收站…</p>}{!loading&&!error&&!visible.length&&<p className="supplement-empty">回收站为空</p>}
    <div className="recycle-list">{visible.map(item=>{const last=item.history.at(-1)!;return <article key={`${item.kind}:${item.project_id}:${item.id}`} className="recycle-item"><div><span className="recycle-kind">{item.kind==="project"?"事项":"沟通进展"} · {item.archived?"在回收站":"已恢复"}</span><h3>{item.title}</h3>{item.kind==="progress"&&<p>{item.matter_name}</p>}<p className="admin-help">{last.actor.name} · {last.operation==="archive"?"移入":"恢复"}于 {at(last.at,timezone)}</p>{item.parent_archived&&<p className="admin-help">请先恢复所属事项</p>}</div><div className="recycle-item-actions"><button type="button" className="admin-button" onClick={()=>setSelected({item,mode:"read"})}>查看记录</button>{item.archived&&<button type="button" className="admin-button" disabled={item.parent_archived} onClick={()=>setSelected({item,mode:"restore"})}>恢复</button>}</div></article>;})}</div>
    {selected&&<RecycleDialog key={`${selected.mode}:${selected.item.kind}:${selected.item.id}`} target={targetOf(selected.item)} mode={selected.mode} timezone={timezone} onClose={()=>setSelected(null)} onChanged={load}/>}
  </section>;
}
