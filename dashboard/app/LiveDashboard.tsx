"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Dashboard from "./Dashboard";
import HistoricalWorkspace from "./HistoricalWorkspace";
import type { DashboardData } from "./lib/types";
import { workspaceRequest } from "./lib/workspace-client";
import type { WorkspaceResponse, WorkspaceStatus, HistoricalSnapshot, Version, BackupStatus } from "./lib/workspace-types";

export default function LiveDashboard({ initialData }: {initialData: DashboardData}) {
  const [snapshot,setSnapshot] = useState<HistoricalSnapshot|null>(null);
  const [compareVersion,setCompareVersion] = useState<Version|null>(null);
  const [backup,setBackup] = useState<BackupStatus|null>(null);
  const refreshBackup = useCallback(async()=>{try{setBackup(await workspaceRequest<BackupStatus>("backup_status"));}catch{/* The dedicated page reports connection failures. */}},[]);
  const canBackup=!initialData.access || initialData.access.role==="admin";
  useEffect(()=>{if(!canBackup)return;const controller=new AbortController();workspaceRequest<BackupStatus>("backup_status",{},false,controller.signal).then(setBackup).catch(()=>{});const timer=setInterval(()=>void refreshBackup(),30000);return()=>{controller.abort();clearInterval(timer);};},[refreshBackup,canBackup]);
  const [data, setData] = useState(initialData);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [error, setError] = useState("");
  const revision = useRef("");
  const observedAt = useRef("");
  const refresh = useCallback(async () => {
    try {
      const result = await workspaceRequest<WorkspaceResponse>("workspace");
      if (result.status.observed_at >= observedAt.current && (result.status.revision !== revision.current || result.status.observed_at !== observedAt.current)) {
        observedAt.current = result.status.observed_at;
        revision.current = result.status.revision;
        setStatus(result.status);
        if (result.data) setData(result.data);
      }
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "无法读取最新资料。"); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest<WorkspaceResponse>("workspace", {}, false, controller.signal).then(result => {
      if (result.status.observed_at < observedAt.current) return;
      observedAt.current = result.status.observed_at;
      revision.current = result.status.revision;
      setStatus(result.status); if (result.data) setData(result.data);setError("");
    }).catch(err => {if (!controller.signal.aborted) setError(err.message);});
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { controller.abort();clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  if(snapshot) return <HistoricalWorkspace snapshot={snapshot} onCompare={()=>{setCompareVersion(snapshot.version);setSnapshot(null);}} onExit={()=>{setCompareVersion(null);setSnapshot(null);void refresh();}}/>;
  return <Dashboard key={compareVersion?.version || "current"} data={data} workspaceStatus={status} workspaceError={error} onWorkspaceRefresh={refresh} onBrowseHistory={setSnapshot} initialHistoryVersion={compareVersion} backupStatus={backup} />;
}
