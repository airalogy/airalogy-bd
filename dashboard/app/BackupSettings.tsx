"use client";
import {useEffect, useState} from "react";
import {workspaceRequest} from "./lib/workspace-client";
import type {BackupStatus} from "./lib/workspace-types";

function BackupIcon({kind}: {kind: "archive" | "check" | "folder" | "chevron"}) {
  return <svg className="backup-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "archive" && <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 14v6h14v-6"/></>}
    {kind === "check" && <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>}
    {kind === "folder" && <path d="M3 7V5h7l2 2h9v13H3V7Z"/>}
    {kind === "chevron" && <path d="m9 5 7 7-7 7"/>}
  </svg>;
}

export default function BackupSettings({timezone,onChanged}: {timezone:string;onChanged:()=>void}) {
  const [status,setStatus] = useState<BackupStatus|null>(null);
  const [directory,setDirectory] = useState("");
  const [enabled,setEnabled] = useState(false);
  const [interval,setIntervalMinutes] = useState(60);
  const [oss,setOss] = useState(false);
  const [retention,setRetention] = useState(0);
  const [pending,setPending] = useState<"save" | "backup" | null>(null);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const busy = pending !== null;

  useEffect(() => {
    const controller = new AbortController();
    workspaceRequest<BackupStatus>("backup_status",{},false,controller.signal).then(result => {
      setStatus(result);setDirectory(result.config.directory);setEnabled(result.config.enabled);setIntervalMinutes(result.config.interval_minutes);setOss(result.config.oss_enabled);setRetention(result.config.retention_days);
    }).catch(err => {if (!controller.signal.aborted) setError(err.message);});
    const timer = setInterval(() => {
      workspaceRequest<BackupStatus>("backup_status",{},false,controller.signal).then(next => setStatus(current => current ? {
        ...current,last_success:next.last_success,error:next.error,last_attempt:next.last_attempt,last_local_success:next.last_local_success,in_progress:next.in_progress,cleanup_error:next.cleanup_error,
      } : next)).catch(() => {});
    },20000);
    return () => {controller.abort();clearInterval(timer);};
  },[]);

  const save = async () => {
    if (!status) return;
    setPending("save");setError("");setNotice("");
    try {
      const result = await workspaceRequest<BackupStatus>("backup_config",{revision:status.revision,config:{enabled,directory,interval_minutes:interval,oss_enabled:oss,retention_days:retention}},true);
      setStatus(result);setDirectory(result.config.directory);setNotice("备份设置已保存。");onChanged();
    } catch (err) {setError((err as Error).message);} finally {setPending(null);}
  };
  const backup = async () => {
    setPending("backup");setError("");setNotice("");
    try {
      const result = await workspaceRequest<BackupStatus>("backup_now",{},true);
      setStatus(result);setNotice(result.error ? "" : result.in_progress ? "已有备份正在进行，请稍后查看结果。" : "备份已完成，文件校验通过。");onChanged();
    } catch (err) {setError((err as Error).message);} finally {setPending(null);}
  };
  const cancel = () => {
    if (!status) return;
    setDirectory(status.config.directory);setEnabled(status.config.enabled);setIntervalMinutes(status.config.interval_minutes);setOss(status.config.oss_enabled);setRetention(status.config.retention_days);setError("");setNotice("");
  };
  const changed = !!status && (enabled !== status.config.enabled || directory !== status.config.directory || interval !== status.config.interval_minutes || oss !== status.config.oss_enabled || retention !== status.config.retention_days);
  const latest = status?.last_success;
  const folderName = latest?.directory.split(/[\\/]/).filter(Boolean).at(-1);
  const size = latest ? (latest.size < 1024 * 1024 ? `${Math.max(1,Math.round(latest.size / 1024))} KB` : `${(latest.size / 1024 / 1024).toFixed(2)} MB`) : "";

  return <section className="panel backup-settings" aria-labelledby="backup-title">
    <header className="backup-header">
      <div><h1 id="backup-title">备份</h1><p>为业务资料、附件、账号权限和操作历史保留独立副本。</p></div>
      <button type="button" className="admin-button admin-primary backup-now" disabled={!status || changed || busy || status.in_progress} onClick={() => void backup()} title={changed ? "请先保存或取消设置修改" : undefined}>
        {pending === "backup" ? <span className="backup-spinner" aria-hidden="true"/> : <BackupIcon kind="archive"/>}
        {pending === "backup" ? "正在备份…" : "立即备份"}
      </button>
    </header>
    {!status && !error && <p className="backup-loading" role="status">正在读取备份状态…</p>}
    {status && <>
      <section className="backup-overview" aria-label="最近备份">
        <div className="backup-overview-main">
          <span className={`backup-status-icon${latest ? " is-complete" : ""}`}><BackupIcon kind={latest ? "check" : "archive"}/></span>
          <div className="backup-last-copy">
            <h2>{latest ? "最近成功备份" : "还没有备份"}</h2>
            {latest ? <><time dateTime={latest.at}>{new Date(latest.at).toLocaleString("zh-CN",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})}</time><p><span className="backup-verified">已校验</span><span aria-hidden="true">·</span><span>{size}</span></p></> : <p>点击“立即备份”，保留第一份完整副本。</p>}
          </div>
          <span className={`backup-state-pill${status.error ? " needs-attention" : status.config.enabled ? " is-enabled" : ""}`}><span aria-hidden="true"/>{status.error ? "备份需处理" : status.config.enabled ? "自动备份已开启" : "自动备份未开启"}</span>
        </div>
        {latest && <details className="backup-file-details">
          <summary><span><BackupIcon kind="folder"/><span>保存于 <strong>{folderName}</strong></span></span><span className="backup-details-action">查看文件信息<BackupIcon kind="chevron"/></span></summary>
          <dl><dt>备份文件</dt><dd>{latest.path.split(/[\\/]/).at(-1)}</dd><dt>所在文件夹</dt><dd>{latest.directory}</dd>{latest.oss&&<><dt>OSS 私有副本</dt><dd>{latest.oss.bucket} / {latest.oss.key}</dd></>}</dl>
        </details>}
      </section>
      {status.error && <div className="admin-alert" role="alert"><strong>最近备份未完成</strong><p>{status.error}</p><p>已有备份仍然保留。请检查目录、空间或 OSS 配置后重试。</p></div>}
      {status.error&&status.last_local_success&&<p>最近本地副本已保留：{status.last_local_success.path}。该副本不代表 OSS 已备份成功。</p>}
      {status.cleanup_error&&<p className="admin-alert">{status.cleanup_error}</p>}
      {status.in_progress&&<p role="status">备份正在进行，可继续处理业务资料。</p>}
      {error && <p className="admin-alert" role="alert">{error}</p>}
      {notice && !changed && <p className="admin-notice" role="status">{notice}</p>}
      <form className="backup-preferences" onSubmit={event => {event.preventDefault();void save();}}>
        <fieldset disabled={busy}>
          <div className="backup-auto-row">
            <div><h2 id="backup-auto-title">自动备份</h2><p id="backup-auto-description">仅在资料有变化时创建新备份。</p></div>
            <label className="backup-switch"><input type="checkbox" role="switch" aria-labelledby="backup-auto-title" aria-describedby="backup-auto-description" checked={enabled} onChange={event => setEnabled(event.target.checked)}/><span aria-hidden="true"/></label>
          </div>
          <div className="backup-config-grid">
            <label className="edit-field"><span>备份文件夹</span><div className="backup-directory-input"><BackupIcon kind="folder"/><input required readOnly={status.server} value={directory} onChange={event => setDirectory(event.target.value)} placeholder="填写完整文件夹路径" autoComplete="off" spellCheck={false}/></div></label>
            <label className="edit-field"><span>备份频率</span><select value={interval} onChange={event => setIntervalMinutes(Number(event.target.value))}><option value={60}>每小时一次</option><option value={1440}>每 24 小时一次</option></select></label>
          </div>
          <label className="team-check"><input type="checkbox" checked={oss} disabled={!status.oss_configured&&!oss} onChange={e=>setOss(e.target.checked)}/>同步到私有 OSS</label>
          {!status.oss_configured&&<p>服务器维护人员配置 OSS 后即可启用。访问凭据不会在页面中保存或显示。</p>}
          <label className="edit-field"><span>本地副本保留期</span><select value={retention} onChange={e=>setRetention(Number(e.target.value))}>{[0,7,30,90,365].map(days=><option key={days} value={days}>{days?`${days} 天`:"不自动清理"}</option>)}</select></label>
          <p className="backup-schedule-note">{status.server?"服务器持续运行期间自动检查；资料变化后按设置频率备份。服务器目录由部署配置管理。":"关闭工作台期间暂停，重新打开后检查补做。"} OSS 保留期由存储空间生命周期规则管理。</p>
          {changed && <div className="backup-save-bar"><span>设置尚未保存</span><div className="admin-actions"><button type="button" className="admin-button" onClick={cancel}>取消修改</button><button type="submit" className="admin-button admin-primary">{pending === "save" ? "正在保存…" : "保存设置"}</button></div></div>}
        </fieldset>
      </form>
      <details className="backup-guide"><summary><BackupIcon kind="chevron"/>备份内容与恢复说明</summary><div>
        <p><strong>备份内容</strong>业务文字、全部附件版本和工作台修改历史；已启用的团队账号、权限及操作记录也包含在内，登录会话和待使用邀请不包含在内。独立内容仓库已有的 Git 历史也一并保留。</p>
        <p><strong>恢复方式</strong>完整备份恢复到新文件夹，不覆盖当前工作区。单条资料的回溯和恢复可在“修改历史”中操作。</p>
        <p><strong>保存策略</strong>仅在新备份成功后，按保留期清理本工作区生成的过期本地副本；最新副本始终保留。OSS 保存服务器之外的副本，也可另行下载至自己的电脑。若资料属于更大的父级仓库，请另行备份该仓库。</p>
      </div></details>
    </>}
    {!status && error && <p className="admin-alert" role="alert">{error}</p>}
  </section>;
}
