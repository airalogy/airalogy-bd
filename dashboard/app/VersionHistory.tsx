"use client";
import { useCallback, useEffect, useState } from "react";
import type { DashboardData } from "./lib/types";
import type { Comparison, HistoryResponse, RecordKind, RecordTarget, SavedResponse, Version, HistoricalSnapshot } from "./lib/workspace-types";
import { workspaceRequest } from "./lib/workspace-client";
import { readable } from "./RecordForms";

const originLabels:Record<string,string> = {qa_save:"问答修订",qa_publish:"推荐确认",qa_mark_stale:"问答待更新",qa_archive:"问答归档",qa_unarchive:"恢复问答",qa_restore:"恢复问答修订稿",migration:"资料整理",attachment:"附件资料",baseline:"开始留存",form:"表单保存",external:"文件修改",restore:"恢复内容",git:"已有版本",checkpoint:"手动留存",before_save:"保存前留存",recovery:"中断恢复"};
type CatalogRecord = {kind:RecordKind; id:string; name:string};
type VersionComparison = Comparison & {records?:CatalogRecord[]};

export default function VersionHistory({data, initialTarget, onRestored, onBrowse, initialVersion}: {data:DashboardData; initialTarget:RecordTarget | null; onRestored:(result:SavedResponse) => void; onBrowse?:(snapshot:HistoricalSnapshot)=>void; initialVersion?:Version|null}) {
  const [asOf,setAsOf] = useState(()=>new Intl.DateTimeFormat("en-CA",{timeZone:data.workspace.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));
  const [kind,setKind] = useState<RecordKind | "">(initialTarget?.kind || "");
  const [identity,setIdentity] = useState(initialTarget?.id || "");
  const [history,setHistory] = useState<HistoryResponse | null>(null);
  const [selected,setSelected] = useState<Version | null>(initialVersion || null);
  const [comparison,setComparison] = useState<VersionComparison | null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const [query,setQuery] = useState("");
  const [confirmRestore,setConfirmRestore] = useState<"record" | "workspace" | null>(null);
  const [mode,setMode] = useState<"current" | "change">("current");
  const currentRecords:CatalogRecord[] = [...data.counterparties.map(item => ({kind:"counterparty" as const,id:item.id,name:item.name})),...(data.files || []).map(item => ({kind:"file" as const,id:item.id,name:item.title})),...data.projects.map(item => ({kind:"project" as const,id:item.id,name:item.name})),...data.people.map(item => ({kind:"person" as const,id:item.id,name:item.name})),...data.company_events.map(item => ({kind:"company" as const,id:item.id,name:item.title}))];
  const records = [...new Map([...currentRecords,...comparison?.records || []].map(item => [item.kind + ":" + item.id,item])).values()].filter(item => item.kind === kind);
  const refresh = useCallback(async () => {
    try { setHistory(await workspaceRequest<HistoryResponse>("history",{kind,id:identity})); setError(""); }
    catch (err) {setError((err as Error).message);}
  }, [kind,identity]);
  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest<HistoryResponse>("history",{kind,id:identity},false,controller.signal).then(setHistory).catch(err => {if(!controller.signal.aborted) setError(err.message);});
    return () => controller.abort();
  }, [kind,identity]);
  const compare = async (version:Version, targetKind = kind, id = identity, comparisonMode = mode) => {
    setBusy(true);setSelected(version);setComparison(null);setError("");setNotice("");setConfirmRestore(null);
    setMode(comparisonMode);
    try { setComparison(await workspaceRequest<VersionComparison>("compare",{kind:targetKind,id,version:version.version,mode:comparisonMode})); }
    catch (err) {setError((err as Error).message);} finally {setBusy(false);}
  };
  useEffect(()=>{
    if(!initialVersion)return;
    const controller=new AbortController();
    workspaceRequest<VersionComparison>("compare",{kind:"",id:"",version:initialVersion.version,mode:"current"},false,controller.signal).then(setComparison).catch(err=>{if(!controller.signal.aborted)setError(err.message);});
    return()=>controller.abort();
  },[initialVersion]);
  const browse=async(version?:Version)=>{
    if(!onBrowse)return;setBusy(true);setError("");
    try{onBrowse(await workspaceRequest<HistoricalSnapshot>("historical",version ? {version:version.version} : {date:asOf}));}catch(err){setError((err as Error).message);}finally{setBusy(false);}
  };
  const changeKind = (value:RecordKind | "") => {setKind(value);setIdentity("");setSelected(null);setComparison(null);};
  const changeRecord = (id:string) => {setIdentity(id);if (selected) void compare(selected,kind,id);};
  const restore = async (wholeWorkspace = false) => {
    if (!selected || !comparison?.can_restore || (!wholeWorkspace && (!kind || !identity))) return;
    setConfirmRestore(null);
    setBusy(true);setError("");
    try {
      const result = await workspaceRequest<SavedResponse>("restore",{kind:wholeWorkspace ? "workspace" : kind,id:wholeWorkspace ? "" : identity,version:selected.version,revision:comparison.revision},true);
      setNotice(result.message);setComparison(null);setSelected(null);onRestored(result);await refresh();
    } catch (err) {setError((err as Error).message);setComparison(null);} finally {setBusy(false);}
  };
  const checkpoint = async () => {
    setBusy(true);
    try {await workspaceRequest("checkpoint",{origin:"checkpoint",label:"手动留存当前资料"},true);setNotice("当前资料已留存；内容没有变化时沿用已有版本。");await refresh();} catch (err) {setError((err as Error).message);} finally {setBusy(false);}
  };
  const loadMore = async () => {
    if (!history) return;setBusy(true);
    try {const next = await workspaceRequest<HistoryResponse>("history",{kind,id:identity,offset:history.versions.length});setHistory({...next,versions:[...history.versions,...next.versions]});} catch(err) {setError((err as Error).message);} finally {setBusy(false);}
  };
  const versions = history?.versions.filter(version => `${version.label} ${originLabels[version.origin] || ""}`.toLowerCase().includes(query.toLowerCase())) || [];
  return <section className="panel version-history" aria-labelledby="version-title">
    <div className="section-heading page-heading"><div><div className="eyebrow">可恢复版本</div><h1 id="version-title">修改历史</h1><p>查看资料改动，比较资料版本与当前内容，再恢复选定记录。</p></div><div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={() => void checkpoint()}>留存当前版本</button><button type="button" className="admin-button" disabled={busy} onClick={() => void refresh()}>刷新历史</button></div></div>
    {onBrowse && <form className="history-browse" onSubmit={event=>{event.preventDefault();void browse();}}><label className="edit-field"><span>按日期回看整个工作台</span><input required type="date" value={asOf} onChange={event=>setAsOf(event.target.value)}/></label><button className="admin-button admin-primary" disabled={busy || !asOf}>浏览当天的资料</button><p className="admin-help">显示所选日期结束前最后留存的版本，时区：{data.workspace.timezone}。按保存时间回看；后来补录的交流不会出现在更早的版本中。</p></form>}
    <p className="admin-help">表单保存会自动留存版本。直接编辑文件时，工作台运行中会自动记录；关闭后请使用配套编辑命令留存修改前后版本。尚未留存的中间修改无法回溯。</p>
    <div className="history-filters"><label className="edit-field"><span>资料类型</span><select value={kind} onChange={e => changeKind(e.target.value as RecordKind | "")}><option value="">全部资料</option><option value="project">事项</option><option value="counterparty">对接方</option><option value="person">人员</option><option value="company">公司动态</option><option value="file">事项资料</option></select></label>
      <label className="edit-field"><span>选择记录</span><select disabled={!kind} value={identity} onChange={e => changeRecord(e.target.value)}><option value="">全部记录</option>{records.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="edit-field"><span>搜索版本</span><input type="search" placeholder="修改说明" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {error && <div role="alert" className="admin-alert">{error}</div>}{notice && <div role="status" className="admin-notice">{notice}</div>}
    <div className="history-layout"><aside className="version-list" aria-label="资料版本列表">{versions.map(version => <button type="button" key={version.version} aria-pressed={selected?.version === version.version} onClick={() => void compare(version)} disabled={busy}><time>{new Date(version.at).toLocaleString(data.workspace.locale,{timeZone:data.workspace.timezone,hour12:false})}</time><strong>{version.label}</strong><small>{originLabels[version.origin] || version.origin}{!version.valid && " · 格式待修正"}</small></button>)}{history?.has_more && <button type="button" className="admin-button" disabled={busy} onClick={() => void loadMore()}>加载更早版本</button>}{!history && !error && <p>正在读取历史…</p>}{history && !versions.length && <p>暂无符合条件的版本。</p>}</aside>
      <div className="version-preview">{busy && selected && <p role="status">正在比较资料…</p>}{!selected && <div className="panel-empty-state">选择一个版本，查看改动。</div>}{selected && comparison && <>
        <h2>{selected.label}</h2>{selected.actor && <p className="admin-help">操作人：{selected.actor.name}</p>}{onBrowse && <button type="button" className="admin-button" disabled={busy} onClick={()=>void browse(selected)}>浏览此版本的完整资料</button>}<div className="admin-tabs" aria-label="版本比较方式"><button type="button" aria-pressed={mode === "current"} disabled={busy} onClick={() => void compare(selected,kind,identity,"current")}>对比当前内容</button><button type="button" aria-pressed={mode === "change"} disabled={busy} onClick={() => void compare(selected,kind,identity,"change")}>查看这次改动</button></div><p className="admin-help">{mode === "current" ? "左侧为所选资料版本，右侧为当前内容。" : "左侧为这次保存前，右侧为这次保存后的内容。"}</p>
        {!kind || !identity ? <><p className="admin-help">下面展示该版本与当前资料的差异。恢复时可先选择一条事项、人员、公司动态或事项资料。</p><label className="edit-field"><span>选择要比较及恢复的资料</span><select value="" onChange={e => {const target = comparison.records?.find(item => item.kind + ":" + item.id === e.target.value);if(target){setKind(target.kind);setIdentity(target.id);void compare(selected,target.kind,target.id);}}}><option value="">请选择</option>{comparison.records?.map(item => <option value={item.kind + ":" + item.id} key={item.kind + ":" + item.id}>{item.kind === "counterparty" ? "对接方" : item.kind === "person" ? "人员" : item.kind === "project" ? "事项" : item.kind === "file" ? "事项资料" : "公司动态"} · {item.name}</option>)}</select></label><details className="restore-whole"><summary>恢复完整资料版本</summary><p>将回退全部事项、人员、公司动态和事项资料索引；附件原件继续保留。适用于资料格式损坏或需要整体撤回的情况；当前完整资料会先留存。</p><button type="button" className="admin-button" disabled={busy || !comparison.can_restore} onClick={() => setConfirmRestore("workspace")}>恢复全部资料到所选版本</button>{comparison.errors.length > 0 && <p>所选版本校验未通过，不能恢复。</p>}</details></> : <>
          {mode === "current" && <div className="restore-summary"><strong>恢复范围：{records.find(item => item.id === identity)?.name || identity}</strong><p>{kind === "counterparty" ? "只恢复对接方信息和共用联系人，不回退其事项进展。" : kind === "person" ? "只恢复这位人员的档案，不回退同一文件中的其他人员。" : kind === "project" ? "恢复此事项的信息、联系人、进展和沟通记录。" : kind === "file" ? "恢复这份资料的信息、版本列表和使用记录。附件原件继续保留，当前记录会先留存。" : "只恢复这条公司动态及其完整记录。"}</p>{!comparison.historical_exists && <p>所选版本中还没有这条资料；恢复将撤销这条资料的创建。</p>}
            <button type="button" className="admin-button admin-primary" disabled={busy || !comparison.can_restore} onClick={() => setConfirmRestore("record")}>恢复这条资料到所选版本</button></div>
          }
          {comparison.errors.length > 0 && <div className="admin-alert"><strong>此版本暂不能直接恢复</strong><ul>{comparison.errors.map((error,index) => <li key={index}>{error}</li>)}</ul></div>}
        </>}
        {mode === "change" && <p className="admin-help">恢复前请先<button type="button" className="admin-button" onClick={() => void compare(selected,kind,identity,"current")}>预览恢复到此版本</button>，查看对当前资料的影响。</p>}
        {confirmRestore && <section className="admin-confirm" role="alertdialog" aria-labelledby="restore-confirm-title"><h3 id="restore-confirm-title">确认恢复{confirmRestore === "workspace" ? "全部资料" : "所选资料"}</h3><p>{confirmRestore === "workspace" ? "将回退所有事项、人员、公司动态和事项资料索引；附件原件继续保留。" : `将恢复${records.find(item => item.id === identity)?.name || "所选资料"}到这个版本。`}当前内容会先留存，恢复也会形成新版本。</p><div className="admin-actions"><button type="button" className="admin-button" onClick={() => setConfirmRestore(null)}>取消恢复</button><button type="button" className="admin-button admin-primary" onClick={() => void restore(confirmRestore === "workspace")}>确认恢复</button></div></section>}
        {!comparison.changes.length && <p>所选版本与当前内容一致。</p>}
        {comparison.changes.map((change,index) => <section key={index} className="version-change"><h3>{change.label}</h3><div className="version-change-values"><div><span>{mode === "change" ? "保存前" : "所选资料版本"}</span><pre>{readable(change.before)}</pre></div><div><span>{mode === "change" ? "保存后" : "当前内容"}</span><pre>{readable(change.after)}</pre></div></div></section>)}
      </>}</div>
    </div>
  </section>;
}
