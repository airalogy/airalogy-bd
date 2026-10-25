"use client";
import Dashboard from "./Dashboard";
import type {HistoricalSnapshot} from "./lib/workspace-types";
export default function HistoricalWorkspace({snapshot,onExit,onCompare}:{snapshot:HistoricalSnapshot;onExit:()=>void;onCompare:()=>void}) {
  return <><div className="historical-banner" role="status"><div><strong>正在浏览历史资料 · 只读</strong><p>{snapshot.date ? `截至 ${snapshot.date} 的最后留存版本` : snapshot.version.label} · 实际保存于 {new Date(snapshot.version.at).toLocaleString(snapshot.data.workspace.locale,{timeZone:snapshot.timezone,hour12:false})}</p></div><div className="admin-actions"><button className="admin-button" onClick={onCompare}>比较与恢复</button><button className="admin-button admin-primary" onClick={onExit}>返回当前资料</button></div></div><Dashboard key={snapshot.version.version} data={snapshot.data} workspaceStatus={null} workspaceError="" onWorkspaceRefresh={async()=>{}} readOnly historicalVersion={snapshot.version.version}/></>;
}
