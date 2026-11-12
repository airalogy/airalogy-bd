"use client";
import { useCallback, useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { workspaceRequest } from "./lib/workspace-client";

type Identity = {id:string;name:string};
type Supplement = {id:string;title:string;date:string;body:string;author:Identity;updated_by:Identity;created_at:string;updated_at:string};
type Listing = {items:Supplement[];revision:string};
type Version = {version:string;at:string;label:string;actor:Identity|null};
type Draft = {id:string;title:string;date:string;body:string;revision:string;request_id:string};
function Markdown({body}:{body:string}) {return <div className="markdown-record"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw,rehypeSanitize]}>{body}</ReactMarkdown></div>;}

function SupplementHistory({item,target,snapshot}:{item:Supplement;target:Record<string,string>;snapshot?:string}) {
  const [versions,setVersions]=useState<Version[]>([]),[record,setRecord]=useState<Supplement|null>(null),[open,setOpen]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false),[more,setMore]=useState(false);
  const sectionId=useId();
  const load=async(offset=0)=>{setBusy(true);setError("");try{const result=await workspaceRequest<{versions:Version[];has_more:boolean}>("supplements",{...target,operation:"history",id:item.id,snapshot,offset});setVersions(old=>offset?[...old,...result.versions]:result.versions);setMore(result.has_more);setOpen(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const select=async(version:string)=>{setBusy(true);setError("");setRecord(null);try{setRecord((await workspaceRequest<{record:Supplement}>("supplements",{...target,operation:"version",id:item.id,snapshot,version})).record);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <><button type="button" className="supplement-text-action" aria-expanded={open} aria-controls={sectionId} disabled={busy} onClick={()=>open?setOpen(false):void load()}>修改历史</button>{error&&<p role="alert" className="admin-alert">{error}</p>}{open&&<div id={sectionId} className="supplement-history"><label>选择历史版本<select defaultValue="" disabled={busy} onChange={e=>void select(e.target.value)}><option value="" disabled>请选择</option>{versions.map(v=><option key={v.version} value={v.version}>{new Date(v.at).toLocaleString("zh-CN")} · {v.actor?.name || "未记录账号"}</option>)}</select></label>{more&&<button type="button" className="supplement-text-action" disabled={busy} onClick={()=>void load(versions.length)}>加载更早版本</button>}{record&&<><p className="admin-help">历史内容 · 补充日期 {record.date} · 作者 {record.author.name}</p>{record.title&&<h4>{record.title}</h4>}<Markdown body={record.body}/></>}</div>}</>;
}

export default function ProgressSupplements({projectId,eventId,canEdit,snapshot,timezone,onChanged}:{projectId:string;eventId:string;canEdit:boolean;snapshot?:string;timezone:string;onChanged:()=>Promise<void>}) {
  const [listing,setListing]=useState<Listing|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft|null>(null),[preview,setPreview]=useState(false);
  const headingId=useId(),formId=useId();
  const target={project_id:projectId,event_id:eventId};
  const load=useCallback(async(signal?:AbortSignal)=>{const result=await workspaceRequest<Listing>("supplements",{operation:"list",project_id:projectId,event_id:eventId,snapshot},false,signal);if(!signal?.aborted)setListing(result);return result;},[projectId,eventId,snapshot]);
  useEffect(()=>{const controller=new AbortController();void workspaceRequest<Listing>("supplements",{operation:"list",project_id:projectId,event_id:eventId,snapshot},false,controller.signal).then(result=>{if(!controller.signal.aborted)setListing(result);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[projectId,eventId,snapshot]);
  const edit=async(item?:Supplement)=>{setBusy(true);setError("");setNotice("");try{
    const current=await workspaceRequest<{revision:string;record?:Supplement}>("supplements",{...target,operation:item?"read":"list",id:item?.id});
    const value=current.record;
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
    const date=["year","month","day"].map(type=>parts.find(p=>p.type===type)?.value).join("-");
    setDraft({id:value?.id||"",title:value?.title||"",date:value?.date||date,body:value?.body||"",revision:current.revision,request_id:crypto.randomUUID()});setPreview(false);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const save=async()=>{if(!draft)return;setBusy(true);setError("");try{await workspaceRequest("supplements",{...target,operation:"save",id:draft.id,revision:draft.revision,request_id:draft.request_id,payload:{title:draft.title,date:draft.date,body:draft.body}},true);setDraft(null);setNotice("补充记录已保存。");await load();await onChanged();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const refreshDraft=async()=>{if(!draft)return;setBusy(true);try{const latest=await workspaceRequest<{revision:string;record?:Supplement}>("supplements",{...target,operation:draft.id?"read":"list",id:draft.id});await load();setDraft({...draft,revision:latest.revision,request_id:crypto.randomUUID()});setError("");setNotice("已读取最新补充，输入内容已保留。请与上方最新正文比较后再保存。");}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="progress-supplements" aria-labelledby={headingId}>
    <header className="supplement-heading"><div><h3 id={headingId}>补充记录{listing&&listing.items.length>0&&<span>{listing.items.length}</span>}</h3><p>补充与本条记录相关的文案、分析或背景资料。新的业务动作请另记进展。</p></div>{canEdit&&!snapshot&&<button type="button" className="admin-button" disabled={busy||!!draft} aria-expanded={!!draft} aria-controls={formId} onClick={()=>void edit()}>添加补充</button>}</header>
    {snapshot&&<p className="admin-help">显示此历史版本保存时的补充内容。</p>}
    {error&&<div role="alert" className="admin-alert">{error}</div>}{notice&&<p role="status" className="admin-notice">{notice}</p>}
    {!listing&&!error&&<p role="status">正在读取补充…</p>}{listing&&!listing.items.length&&!draft&&<p className="supplement-empty">暂无补充记录</p>}
    {listing?.items.map(item=><article key={item.id} className="supplement-item"><div className="supplement-item-heading"><div>{item.title&&<h4>{item.title}</h4>}<p className="supplement-byline"><time dateTime={item.date}>{item.date}</time><span>作者 {item.author.name}</span>{item.updated_at!==item.created_at&&<span>最近编辑 {item.updated_by.name} · {new Date(item.updated_at).toLocaleString("zh-CN",{timeZone:timezone})}</span>}</p></div>{canEdit&&!snapshot&&<button type="button" className="supplement-text-action" disabled={busy||!!draft} onClick={()=>void edit(item)}>编辑补充</button>}</div><Markdown body={item.body}/><SupplementHistory key={`${item.id}:${item.updated_at}`} item={item} target={target} snapshot={snapshot}/></article>)}
    {draft&&error&&<button type="button" className="admin-button" disabled={busy} onClick={()=>void refreshDraft()}>读取最新版本并保留输入</button>}{draft&&<form id={formId} className="supplement-form" onSubmit={e=>{e.preventDefault();void save();}}><h4>{draft.id?"编辑补充":"添加补充"}</h4><fieldset disabled={busy}><div className="supplement-fields"><label>标题（选填）<input autoFocus maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label>补充日期<input type="date" required value={draft.date} onChange={e=>setDraft({...draft,date:e.target.value})}/></label></div><label>正文（Markdown）<textarea rows={8} required maxLength={50000} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label><div className="supplement-form-actions"><button type="button" className="supplement-text-action" aria-expanded={preview} onClick={()=>setPreview(!preview)}>{preview?"收起预览":"预览正文"}</button><span>作者按实际操作账号记录</span></div>{preview&&<Markdown body={draft.body}/>}<div className="admin-actions"><button type="submit" className="admin-button admin-primary">{busy?"保存中…":"保存补充"}</button><button type="button" className="admin-button" onClick={()=>setDraft(null)}>取消</button></div></fieldset></form>}

  </section>;
}
