"use client";
import {useState} from "react";
import HistoricalWorkspace from "./HistoricalWorkspace";
import VersionHistory from "./VersionHistory";
import {workspaceRequest} from "./lib/workspace-client";
import type {WorkspaceStatus,HistoricalSnapshot,Version} from "./lib/workspace-types";
import type {DashboardData} from "./lib/types";

const empty:DashboardData = {counterparties:[],workspace:{id:"local",name:"本地工作台",short_name:"本地工作台",workspace_title:"资料恢复",description:"",locale:"zh-CN",timezone:"Asia/Shanghai",brand_mark:"BD",privacy_notice:"本机资料"},updated_at:"",people:[],projects:[],company_events:[]};
export default function RecoveryDashboard() {
  const [snapshot,setSnapshot]=useState<HistoricalSnapshot|null>(null);
  const [version,setVersion]=useState<Version|null>(null);
  const [message,setMessage]=useState("尚未找到可显示的有效资料。可以重新检查，或从修改历史恢复。");
  const [busy,setBusy]=useState(false);
  const check=async()=>{setBusy(true);try{const status=await workspaceRequest<WorkspaceStatus>("checkpoint",{force:true,origin:"checkpoint",label:"重新检查当前资料"},true);if(status.errors.length)setMessage(status.errors.join("\n"));else window.location.reload();}catch(error){setMessage((error as Error).message);}finally{setBusy(false);}};
  if(snapshot)return <HistoricalWorkspace snapshot={snapshot} onExit={()=>{setSnapshot(null);setVersion(null);}} onCompare={()=>{setVersion(snapshot.version);setSnapshot(null);}}/>;
  return <main className="page-shell"><div className="admin-alert" role="alert"><p>{message}</p><button type="button" className="admin-button" disabled={busy} onClick={()=>void check()}>{busy?"正在检查…":"重新检查资料"}</button></div><VersionHistory key={version?.version || "all"} initialVersion={version} onBrowse={setSnapshot} data={empty} initialTarget={null} onRestored={()=>window.location.reload()} /></main>;
}
