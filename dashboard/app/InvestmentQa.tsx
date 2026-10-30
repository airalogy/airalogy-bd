"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {workspaceRequest,WorkspaceError} from "./lib/workspace-client";
import type {DashboardData} from "./lib/types";
import {SettingsPanelHeader} from "./SettingsUI";

export const qaCategories:Record<string,string>={product:"产品",competition:"竞争与优势",market:"市场",business:"商业模式",finance:"经营与财务",fundraising:"融资计划",team:"团队",other:"其他"};
const statusLabels:Record<string,string>={draft:"待完善",ready:"已有推荐回答",needs_update:"推荐回答待更新"};
export type QaSource={project_id:string;event_id?:string;matter_name?:string;event_title?:string;date?:string};
type QaFile={file_id:string;version_id:string;title?:string;filename?:string};
type Answer={question:string;aliases:string[];category:string;short_answer:string;body:string;data_as_of:string;sources:QaSource[];files:QaFile[];restricted_references?:boolean;updated_at?:string;updated_by?:{name:string};approved_at?:string;approved_by?:{name:string}};
type Question={id:string;question:string;category:string;status:string;archived:boolean;has_changes:boolean;revision:string;draft:Answer|null;recommended:Answer|null;updated_at:string};
type ReadResult={record:Question|null;revision:string;can_edit:boolean;can_publish:boolean};
type ListResult={items:Question[];total:number;next_offset:number|null;can_edit:boolean;can_publish:boolean};
type HistoryEntry={version:string;at:string;label:string;actor?:{name:string};valid:boolean};
const blank=():Answer=>({question:"",aliases:[],category:"other",short_answer:"",body:"",data_as_of:"",sources:[],files:[]});
const fields=(value:Answer):Answer=>({question:value.question,aliases:value.aliases,category:value.category,short_answer:value.short_answer,body:value.body,data_as_of:value.data_as_of,sources:value.sources.map(({project_id,event_id})=>({project_id,...(event_id?{event_id}:{})})),files:value.files.map(({file_id,version_id})=>({file_id,version_id}))});
const request=<T,>(operation:string,input:Record<string,unknown>={},mutate=false,signal?:AbortSignal)=>workspaceRequest<T>("qa",{operation,...input},mutate,signal);
const when=(value:string,timezone:string)=>value?new Intl.DateTimeFormat("zh-CN",{timeZone:timezone,dateStyle:"medium",timeStyle:"short"}).format(new Date(value)):"";
function Markdown({text}:{text:string}){return <div className="markdown-record qa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{text}</ReactMarkdown></div>;}

function AnswerView({value,onSource}:{value:Answer;onSource:(source:QaSource)=>void}){
  return <div className="qa-answer">
    {!!value.aliases.length&&<p className="qa-meta">常见问法：{value.aliases.join("；")}</p>}
    <section className="qa-short"><h3>简短回答</h3>{value.short_answer?<p>{value.short_answer}</p>:<p className="qa-meta">尚未填写回答。</p>}</section>
    {value.body&&<section><h3>详细回答</h3><Markdown text={value.body}/></section>}
    {value.data_as_of&&<p className="qa-meta">数据截至 {value.data_as_of}</p>}
    {(value.sources.length>0||value.files.length>0||value.restricted_references)&&<section className="qa-references"><h3>来源与参考资料</h3>
      {value.sources.map(source=><button className="qa-source" type="button" key={`${source.project_id}:${source.event_id||""}`} onClick={()=>onSource(source)}>{source.matter_name||source.project_id}{source.event_title&&` · ${source.date} ${source.event_title}`}</button>)}
      {value.files.map(file=><a className="qa-source" key={`${file.file_id}:${file.version_id}`} href={`/api/files?${new URLSearchParams({action:"download",id:file.file_id,version_id:file.version_id})}`} download>{file.title} · {file.filename}</a>)}
      {value.restricted_references&&<p className="admin-help">部分来源当前不可访问，其关联关系仍保留。</p>}
    </section>}
  </div>;
}

function Editor({loaded,data,source,onClose,onSaved,onExisting}:{loaded:ReadResult;data:DashboardData;source?:QaSource|null;onClose:()=>void;onSaved:(id:string)=>Promise<void>;onExisting:(id:string)=>void}){
  const initial=fields(loaded.record?.draft||blank());
  if(source&&!initial.sources.some(s=>s.project_id===source.project_id&&s.event_id===source.event_id))initial.sources.push({project_id:source.project_id,...(source.event_id?{event_id:source.event_id}:{})});
  const [value,setValue]=useState(initial),[aliases,setAliases]=useState(initial.aliases.join("\n"));
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[conflict,setConflict]=useState(false),[latest,setLatest]=useState<ReadResult|null>(null);
  const [revision,setRevision]=useState(loaded.revision),[preview,setPreview]=useState(false),[suggestions,setSuggestions]=useState<Question[]>([]);
  const [matter,setMatter]=useState(""),[event,setEvent]=useState(""),[fileKey,setFileKey]=useState("");
  const [baseline,setBaseline]=useState(JSON.stringify(initial));
  const payload={...value,aliases:aliases.split("\n").map(s=>s.trim()).filter(Boolean)};
  const dirty=JSON.stringify(payload)!==baseline||!!source;
  const selectedMatter=data.projects.find(p=>p.id===matter);
  function close(){if(!busy&&(!dirty||window.confirm("放弃尚未保存的问答修改？")))onClose();}
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();}};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty]);
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{if(value.question.trim())void request<ListResult>("list",{query:value.question.slice(0,300)},false,controller.signal).then(r=>setSuggestions(r.items.filter(q=>q.id!==loaded.record?.id).slice(0,4))).catch(()=>{});else setSuggestions([]);},350);return()=>{clearTimeout(timer);controller.abort();};},[value.question,loaded.record?.id]);
  async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setError("");try{const result=await request<{id:string}>("save",{id:loaded.record?.id||"",revision,payload},true);setBaseline(JSON.stringify(payload));await onSaved(result.id);}catch(err){setError((err as Error).message);setConflict(err instanceof WorkspaceError&&err.code==="conflict");}finally{setBusy(false);}}
  async function compare(){try{setLatest(await request<ReadResult>("read",{id:loaded.record?.id||""}));}catch(err){setError((err as Error).message);}}
  return <Dialog.Root open onOpenChange={open=>{if(!open)close();}}><Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay"/><Dialog.Content className="admin-dialog qa-editor" onInteractOutside={e=>e.preventDefault()} onEscapeKeyDown={e=>{e.preventDefault();close();}}>
    <header className="admin-dialog-head"><div><Dialog.Title>{loaded.record?"修改问答":"新增投资问答"}</Dialog.Title><Dialog.Description>回答面向所有获准访问问答库的成员。仅关联来源不会自动分享原会议或文件。</Dialog.Description></div><button type="button" className="close-button" aria-label="关闭问答编辑" disabled={busy} onClick={close}>×</button></header>
    <form className="team-form" onSubmit={save}><div className="admin-dialog-scroll">
      {error&&<p className="admin-alert" role="alert">{error}</p>}
      {conflict&&<section className="qa-conflict"><button type="button" className="admin-button" onClick={()=>void compare()}>读取最新内容并比较</button>{latest?.record?.draft&&<><h3>最新修订稿</h3><p>{latest.record.draft.question}</p><AnswerView value={latest.record.draft} onSource={()=>{}}/><p className="admin-help">下面的输入仍是你的修改。请逐项核对并合并，再使用最新版本继续保存。</p><button type="button" className="admin-button" onClick={()=>{setRevision(latest.revision);setConflict(false);setLatest(null);setError("");}}>已核对，以最新版本继续修改</button></>}</section>}
      <fieldset disabled={busy}><label>问题<input required maxLength={300} value={value.question} onChange={e=>setValue({...value,question:e.target.value})}/></label>
        {!!suggestions.length&&<div className="qa-suggestions"><strong>已有相近问答</strong>{suggestions.map(q=><button type="button" key={q.id} onClick={()=>{if(!dirty||window.confirm("打开已有问答？当前未保存内容将放弃。"))onExisting(q.id);}}>{q.question}</button>)}</div>}
        <div className="edit-form-grid"><label>分类<select value={value.category} onChange={e=>setValue({...value,category:e.target.value})}>{Object.entries(qaCategories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>数据截至日期 <span className="field-optional">选填</span><input type="date" value={value.data_as_of} onChange={e=>setValue({...value,data_as_of:e.target.value})}/></label></div>
        <label>其他常见问法 <span className="field-optional">每行一条，最多 20 条</span><textarea rows={2} maxLength={6020} value={aliases} onChange={e=>setAliases(e.target.value)}/></label>
        <label>简短回答 <span className="field-optional">用于交流时快速回答</span><textarea rows={4} maxLength={1200} value={value.short_answer} onChange={e=>setValue({...value,short_answer:e.target.value})}/></label>
        <label>详细回答 <span className="field-optional">支持 Markdown，最多 8,000 字</span><textarea rows={9} maxLength={8000} value={value.body} onChange={e=>setValue({...value,body:e.target.value})}/></label>
        <button type="button" className="settings-text-button" aria-expanded={preview} onClick={()=>setPreview(!preview)}>{preview?"收起预览":"预览详细回答"}</button>{preview&&<Markdown text={value.body}/>}
        <section className="settings-form-section"><h3>关联交流</h3><p className="admin-help">来源用于追溯问题；本次编辑不会修改原会议记录中的回答。</p>
          <div className="qa-link-picker"><label>事项<select value={matter} onChange={e=>{setMatter(e.target.value);setEvent("");}}><option value="">选择事项</option>{data.projects.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label>沟通进展<select value={event} onChange={e=>setEvent(e.target.value)} disabled={!matter}><option value="">仅关联事项</option>{selectedMatter?.events.map(e=><option value={e.id} key={e.id}>{e.date} · {e.title}</option>)}</select></label><button type="button" className="admin-button" disabled={!matter||value.sources.length>=30} onClick={()=>{const item={project_id:matter,...(event?{event_id:event}:{})};if(!value.sources.some(s=>s.project_id===matter&&(s.event_id||"")===event))setValue({...value,sources:[...value.sources,item]});}}>添加关联</button></div>
          <ul className="qa-linked">{value.sources.map((s,i)=>{const p=data.projects.find(p=>p.id===s.project_id);return <li key={`${s.project_id}:${s.event_id}`}><span>{p?.name||s.project_id}{s.event_id&&` · ${p?.events.find(e=>e.id===s.event_id)?.title||s.event_id}`}</span><button type="button" className="settings-text-button" onClick={()=>setValue({...value,sources:value.sources.filter((_,n)=>n!==i)})}>移除关联</button></li>;})}</ul>
        </section>
        <section className="settings-form-section"><h3>参考文件</h3><div className="qa-link-picker"><label>已有文件及版本<select value={fileKey} onChange={e=>setFileKey(e.target.value)}><option value="">选择已归档的资料版本</option>{(data.files||[]).filter(f=>!f.archived).flatMap(f=>f.versions.map((v,index)=><option key={`${f.id}:${v.id}`} value={`${f.id}:${v.id}`}>{f.title} · v{index+1} · {v.filename}</option>))}</select></label><button type="button" className="admin-button" disabled={!fileKey||value.files.length>=30} onClick={()=>{const [file_id,version_id]=fileKey.split(":");if(!value.files.some(f=>f.file_id===file_id&&f.version_id===version_id))setValue({...value,files:[...value.files,{file_id,version_id}]});}}>添加文件</button></div>
          <ul className="qa-linked">{value.files.map((ref,i)=>{const f=data.files?.find(f=>f.id===ref.file_id),v=f?.versions.find(v=>v.id===ref.version_id);return <li key={`${ref.file_id}:${ref.version_id}`}><span>{f?.title||ref.file_id} · {v?.filename||ref.version_id}</span><button type="button" className="settings-text-button" onClick={()=>setValue({...value,files:value.files.filter((_,n)=>n!==i)})}>移除关联</button></li>;})}</ul>
        </section>
        {loaded.record?.draft?.restricted_references&&<p className="admin-help">不可访问的来源不会显示，保存时会保留这些关联。</p>}
      </fieldset>
    </div><footer className="admin-dialog-footer"><span>保存修订稿不会替换已确认的推荐回答。</span><div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={close}>取消</button><button type="submit" className="admin-button admin-primary" disabled={busy||conflict}>{busy?"正在保存…":"保存修订稿"}</button></div></footer></form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function History({question,timezone,onClose,onRestore,onSource}:{question:Question;timezone:string;onClose:()=>void;onRestore:(version:string)=>Promise<void>;onSource:(s:QaSource)=>void}){
  const [entries,setEntries]=useState<HistoryEntry[]>([]),[more,setMore]=useState(false),[error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[selected,setSelected]=useState(""),[past,setPast]=useState<Question|null>(null);
  useEffect(()=>{const c=new AbortController();request<{versions:HistoryEntry[];has_more:boolean}>("history",{id:question.id},false,c.signal).then(r=>{setEntries(r.versions);setMore(r.has_more);}).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[question.id]);
  async function inspect(entry:HistoryEntry){setBusy(true);setError("");try{const r=await request<{record:Question|null}>("version",{id:question.id,version:entry.version});setPast(r.record);setSelected(entry.version);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Dialog.Root open onOpenChange={open=>{if(!open&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay"/><Dialog.Content className="admin-dialog qa-history"><header className="admin-dialog-head"><div><Dialog.Title>问答修订历史</Dialog.Title><Dialog.Description>{question.question} · 恢复仅更新修订稿，推荐回答保持不变。</Dialog.Description></div><button className="close-button" aria-label="关闭问答历史" disabled={busy} onClick={onClose}>×</button></header><div className="admin-dialog-scroll">{error&&<p className="admin-alert" role="alert">{error}</p>}
    {loading?<p role="status">正在读取历史…</p>:<ul className="qa-history-list">{entries.map(e=><li key={e.version}><button type="button" className="admin-button" aria-pressed={selected===e.version} disabled={busy||!e.valid} onClick={()=>void inspect(e)}>{when(e.at,timezone)} · {e.label} · {e.actor?.name||"本地维护"}</button></li>)}</ul>}
    {more&&<button className="admin-button" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await request<{versions:HistoryEntry[];has_more:boolean}>("history",{id:question.id,offset:entries.length});setEntries([...entries,...r.versions]);setMore(r.has_more);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>加载更早版本</button>}
    {selected&&(past?<><div className="qa-history-compare"><section><h3>所选历史修订稿</h3><p>{past.draft?.question}</p>{past.draft&&<AnswerView value={past.draft} onSource={onSource}/>}</section><section><h3>当前修订稿</h3><p>{question.draft?.question}</p>{question.draft&&<AnswerView value={question.draft} onSource={onSource}/>}</section></div>{!question.archived&&<button type="button" className="admin-button" disabled={busy} onClick={async()=>{if(!window.confirm("将此历史内容恢复为新的修订稿？推荐回答不会改变。"))return;setBusy(true);try{await onRestore(selected);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>恢复为新修订稿</button>}</>:<p>此版本尚无该问答。</p>)}
  </div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export default function InvestmentQa({data,initialId="",source,onClearSource,onSource}:{data:DashboardData;initialId?:string;source?:QaSource|null;onClearSource:()=>void;onSource:(s:QaSource)=>void}){
  const canEdit=!data.access||data.access.role!=="viewer",canPublish=!data.access||data.access.role==="admin";
  const [query,setQuery]=useState(""),[category,setCategory]=useState(""),[state,setState]=useState("");
  const [listing,setListing]=useState<ListResult|null>(null),[listBusy,setListBusy]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [selected,setSelected]=useState(initialId),[loaded,setLoaded]=useState<ReadResult|null>(null),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false);
  const [editor,setEditor]=useState<ReadResult|null>(null),[history,setHistory]=useState(false),[tab,setTab]=useState<"recommended"|"draft">("recommended");
  const detail=useRef<HTMLElement|null>(null);
  const preferredTab=useRef<"recommended"|"draft"|null>(null);
  const filters=useRef({query,category,state});
  useEffect(()=>{filters.current={query,category,state};},[query,category,state]);
  useEffect(()=>{const c=new AbortController();const timer=setTimeout(()=>{setListBusy(true);request<ListResult>("list",{query,category,state},false,c.signal).then(r=>{setListing(r);setError("");}).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setListBusy(false);});},200);return()=>{clearTimeout(timer);c.abort();};},[query,category,state,refresh]);
  useEffect(()=>{if(!selected)return;const c=new AbortController();request<ReadResult>("read",{id:selected},false,c.signal).then(r=>{setLoaded(r);setTab(preferredTab.current||(r.record?.recommended?"recommended":"draft"));preferredTab.current=null;}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[selected,refresh]);
  function choose(id:string){setSelected(id);setLoaded(null);setError("");setNotice("");historyReplace(id);}
  function historyReplace(id:string){const url=new URL(window.location.href);url.searchParams.set("qa",id);window.history.replaceState(null,"",url);}
  const saved=useCallback(async(id:string,answerTab:"recommended"|"draft"="draft")=>{preferredTab.current=answerTab;setEditor(null);setHistory(false);setSelected(id);setLoaded(null);setNotice("问答已保存，历史版本已保留。");setRefresh(n=>n+1);onClearSource();historyReplace(id);},[onClearSource]);
  async function edit(){setBusy(true);setError("");try{setEditor(await request<ReadResult>("read",{id:selected}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function create(){setBusy(true);setError("");try{setEditor(await request<ReadResult>("read",{id:""}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function act(operation:string,confirmation:string){if(!loaded?.record||!window.confirm(confirmation))return;setBusy(true);setError("");try{await request(operation,{id:selected,revision:loaded.revision},true);await saved(selected,operation==="publish"||operation==="mark_stale"?"recommended":"draft");}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const current=loaded?.record?.id===selected?loaded.record:null,answer=current&&(tab==="draft"?current.draft:current.recommended);
  async function copy(full:boolean){if(!answer)return;try{await navigator.clipboard.writeText(full?[answer.question,answer.short_answer,answer.body,answer.data_as_of&&`数据截至 ${answer.data_as_of}`].filter(Boolean).join("\n\n"):answer.short_answer);setNotice("已复制回答。");}catch{setError("无法自动复制，请选中回答后复制。");}}
  return <section className="qa-library panel"><SettingsPanelHeader title="投资问答" description="积累常见问题，持续打磨团队推荐回答。" actions={canEdit?<button className="admin-button admin-primary" disabled={busy} onClick={()=>void create()}>新增问答</button>:undefined}/>
    {source&&<div className="qa-context"><span>从「{source.matter_name} · {source.event_title}」整理问题。先搜索已有问答，再选择关联或新建。</span><button type="button" className="settings-text-button" onClick={onClearSource}>取消关联</button></div>}
    {error&&<p className="admin-alert" role="alert">{error}<button className="settings-text-button" onClick={()=>setRefresh(n=>n+1)}>刷新</button></p>}{notice&&<p className="admin-notice" role="status">{notice}</p>}
    <div className="qa-filters"><label>搜索<input type="search" placeholder="问题、其他问法或回答内容" value={query} maxLength={300} onChange={e=>setQuery(e.target.value)}/></label><label>分类<select value={category} onChange={e=>setCategory(e.target.value)}><option value="">全部分类</option>{Object.entries(qaCategories).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label><label>回答状态<select value={state} onChange={e=>setState(e.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).map(([k,v])=><option value={k} key={k}>{v}</option>)}{canEdit&&<><option value="changed">有未确认修订</option><option value="archived">已归档</option></>}</select></label></div>
    <div className="qa-layout"><aside className="qa-list" aria-label="问答列表"><p className="qa-meta" role="status">{listBusy?"正在搜索…":`${listing?.total||0} 条问答`}</p>{listing?.items.map(q=><button key={q.id} type="button" className="qa-question" aria-pressed={selected===q.id} onClick={()=>{choose(q.id);detail.current?.scrollIntoView({block:"nearest"});}}><span className="qa-meta">{qaCategories[q.category]} · {q.archived?"已归档":statusLabels[q.status]}</span><strong>{q.question}</strong>{canEdit&&q.has_changes&&q.recommended&&<small>有未确认修订</small>}</button>)}{!listBusy&&!listing?.items.length&&<p className="settings-empty">{query||category||state?"没有找到匹配问答，试试其他问法。":"尚无投资问答。从投资人反复提出的问题开始积累。"}</p>}
      {listing?.next_offset!=null&&<button className="admin-button" disabled={busy||listBusy} onClick={async()=>{setBusy(true);const snapshot={query,category,state};try{const r=await request<ListResult>("list",{...snapshot,offset:listing.next_offset});if(JSON.stringify(filters.current)===JSON.stringify(snapshot))setListing({...r,items:[...listing.items,...r.items]});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>加载更多问答</button>}
    </aside><article ref={detail} className="qa-detail" aria-label="问答详情">{!selected?<div className="qa-empty"><h3>把一次回答，沉淀为团队积累</h3><p>选择左侧问题查看推荐回答、参考资料与修订记录。</p><p>编辑成员可完善修订稿，管理员确认后供团队使用。</p></div>:!current?<p role="status">{error?"问答尚未读取，请刷新后重试。":"正在读取问答…"}</p>:<>
      <header className="qa-detail-header"><span className="qa-meta">{qaCategories[(answer||current).category]} · {current.archived?"已归档":statusLabels[current.status]}</span><h2>{(answer||current).question}</h2><p className="qa-meta">最近修订 {when(current.updated_at,data.workspace.timezone)}{current.draft?.updated_by&&` · ${current.draft.updated_by.name}`}</p></header>
      {canEdit&&<div className="qa-tabs" aria-label="回答版本"><button type="button" aria-pressed={tab==="recommended"} onClick={()=>setTab("recommended")}>推荐回答</button><button type="button" aria-pressed={tab==="draft"} onClick={()=>setTab("draft")}>当前修订稿{current.has_changes?" · 未确认":""}</button></div>}
      {tab==="recommended"&&current.status==="needs_update"&&<p className="admin-notice">此推荐回答已标记待更新，使用前请核实内容及数据日期。</p>}
      {answer?<><div className="qa-actions">{answer.short_answer&&<button className="settings-text-button" onClick={()=>void copy(false)}>复制简短回答</button>}<button className="settings-text-button" onClick={()=>void copy(true)}>复制完整回答</button></div><AnswerView value={answer} onSource={onSource}/>{tab==="recommended"&&answer.approved_at&&<p className="qa-meta">由 {answer.approved_by?.name} 于 {when(answer.approved_at,data.workspace.timezone)} 确认为推荐回答</p>}</>:<p className="settings-empty">尚无已确认的推荐回答。{canEdit?"可在修订稿中继续完善。":"请等待团队完善并确认。"}</p>}
      {canEdit&&<footer className="qa-actions"><button type="button" className="admin-button" disabled={busy||current.archived} onClick={()=>void edit()}>{source?"修改并关联本次交流":"编辑修订稿"}</button><button type="button" className="admin-button" onClick={()=>setHistory(true)}>修订历史</button>
        {canPublish&&!current.archived&&tab==="draft"&&(current.has_changes||current.status==="needs_update")&&<button type="button" className="admin-button admin-primary" disabled={busy||!current.draft?.short_answer} onClick={()=>void act("publish","将当前修订稿确认为推荐回答？所有获准访问问答库的成员都将看到该版本。")}>确认为推荐回答</button>}
        {!current.archived&&current.recommended&&current.status!=="needs_update"&&<button className="settings-text-button" disabled={busy} onClick={()=>void act("mark_stale","将推荐回答标记为待更新，提醒团队使用前核实？")}>标记待更新</button>}
        {canPublish&&<button className="settings-text-button" disabled={busy} onClick={()=>void act(current.archived?"unarchive":"archive",current.archived?"恢复此问答到问答库？":"归档此问答？归档后不再出现在常用列表，历史仍保留。")}>{current.archived?"恢复问答":"归档"}</button>}
      </footer>}
    </>}</article></div>
    {editor&&<Editor loaded={editor} data={data} source={source} onClose={()=>setEditor(null)} onSaved={saved} onExisting={id=>{setEditor(null);choose(id);}}/>}
    {history&&current&&<History question={current} timezone={data.workspace.timezone} onClose={()=>setHistory(false)} onSource={onSource} onRestore={async version=>{await request("restore",{id:selected,revision:loaded!.revision,version},true);await saved(selected);}}/>}
  </section>;
}
