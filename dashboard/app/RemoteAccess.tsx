"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {SettingsPanelHeader,SettingsStatus} from "./SettingsUI";
import type { TeamUser } from "./lib/team-client";
import { stageLabels, followUpStatusLabels } from "./lib/labels";

type Token = { id: string; owner: string; label: string; can_draft: boolean; expires: number };
type Member = { id: string; name: string; role: string; active: boolean; granted: boolean };
type Status = { enabled: boolean; granted: boolean; revision: string; tokens: Token[]; members?: Member[] };
type Draft = { id: string; matterName: string; counterparty: string; progressTitle: string; progressDate: string; operation: string; expires: number; changes: { field: string; label: string; before: unknown; after: unknown }[] };
const operations: Record<string, string> = { add_progress: "新增进展", update_progress: "修改进展", update_matter: "修改事项" };
function display(field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "（空）";
  if (typeof value === "string" && field === "stage") return stageLabels[value] || value;
  if (typeof value === "string" && field === "follow_up_status") return followUpStatusLabels[value as keyof typeof followUpStatusLabels] || value;
  if (typeof value === "string" && field === "importance") return value === "key" ? "关键进展" : "普通进展";
  if (typeof value === "string" && field === "type") return ({ contact: "联系沟通", meeting: "会议", proposal: "方案", agreement: "协议", administrative: "行政手续", decision: "决定", payment: "付款", milestone: "里程碑", status_change: "状态变化", other: "其他" } as Record<string, string>)[value] || value;
  return Array.isArray(value) ? value.join("、") || "（无）" : String(value);
}
const when = (value: number) => new Date(value * 1000).toLocaleString("zh-CN");

export default function RemoteAccess({ user, mode, endpoint = "" }: { user: TeamUser; mode: "settings" | "connection" | "drafts"; endpoint?: string }) {
  const manage = mode === "settings";
  const [status, setStatus] = useState<Status | null>(null), [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(""), [label, setLabel] = useState("我的 Codex"), [days, setDays] = useState(7), [canDraft, setCanDraft] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const request = useCallback(async <T,>(action: string, input?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(input ? "/api/remote" : `/api/remote?action=${action}`, {
      cache: "no-store", ...(input ? { method: "POST", headers: { "Content-Type": "application/json", "X-BD-CSRF": user.csrf }, body: JSON.stringify({ ...input, operation: action }) } : {}),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || "操作未完成，请刷新后重试。");
    return body.result;
  }, [user.csrf]);
  const load = useCallback(async () => {
    const latest = await request<Status>(manage ? "settings" : "status");
    const pending = mode === "drafts" && latest.enabled && latest.granted ? (await request<{ drafts: Draft[] }>("drafts")).drafts : [];
    return { latest, pending };
  }, [manage, mode, request]);
  const apply = useCallback(({ latest, pending }: { latest: Status; pending: Draft[] }) => {
    setStatus(latest); setDrafts(pending); setChecked({});
  }, []);
  async function reload() { apply(await load()); }
  useEffect(() => { void load().then(apply).catch(err => setError((err as Error).message)); }, [load, apply]);
  useEffect(() => {
    if (mode !== "drafts" || !drafts.length) return;
    const anchor = window.location.hash.slice(1);
    if (drafts.some(draft => anchor === `draft-${draft.id}`)) document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, [mode, drafts]);
  async function act(action: string, input: Record<string, unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request<{ token?: string }>(action, input);
      if (result.token) setSecret(result.token);
      setNotice(message); await reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section id={manage?"external-ai":mode==="connection"?"ai-tools":undefined} className="panel admin-center-panel remote-access">
    <SettingsPanelHeader title={manage?"外部 AI 工具":mode==="connection"?"AI 工具连接":"修改草稿"} description={manage?"允许成员通过 Codex 等外部工具访问工作台，与内置 AI 的模型配置和费用独立。":mode==="connection"?"连接自己的 AI 工具，查询获授权事项或提交修改草稿。":"核对外部 AI 工具提交的内容，由你确认后正式保存。"} actions={mode==="connection"?<Link className="admin-button" href="/remote">查看待确认修改</Link>:undefined}/>
    {error && <p className="admin-alert" role="alert">{error}</p>}
    {notice && <p className="admin-notice" role="status">{notice}</p>}
    {!status ? <p>正在读取接入状态…</p> : <>
      {mode !== "drafts" && <div className="remote-state"><div><SettingsStatus tone={status.enabled?"success":"neutral"}>{status.enabled?"工作区已开启":"工作区未开启"}</SettingsStatus><p className="admin-help">{manage?"成员权限统一在“成员与权限”中分配。":status.granted?"你的账号已获授权，访问范围与事项权限一致。":"你的账号尚未获授权，请联系管理员调整成员权限。"}</p></div>{manage&&<button className="admin-button" disabled={busy} onClick={()=>{if(status.enabled&&!window.confirm("关闭外部 AI 工具接入？全部个人凭据和待确认草稿将失效，成员授权设置保留。"))return;void act("configure",{enabled:!status.enabled,revision:status.revision},status.enabled?"已关闭，旧凭据和草稿已失效。":"已开启，已获授权的成员可自行连接工具。");}}>{status.enabled?"关闭外部工具接入":"开启外部工具接入"}</button>}</div>}
      {manage && <p className="admin-help">在 <Link href="/admin?section=members">成员与权限</Link> 邀请或编辑成员时分配权限。关闭全局开关会撤销全部凭据和草稿，保留成员授权；重新开启后，由成员生成新凭据。</p>}
      {mode === "connection" && <>
        <p className="admin-help">返回给外部工具的业务资料会进入你所使用的模型上下文，请按公司要求选择模型。这里不自动读取附件和联系方式，模型费用由对应工具账号承担。</p>
        {!status.enabled || !status.granted ? <p className="settings-empty">{!status.enabled?"工作区尚未开启外部工具接入。":"请联系管理员允许你的账号连接外部 AI 工具。"}</p> : <>
          <form onSubmit={event => { event.preventDefault(); void act("issue", { label, days, canDraft }, "凭据已生成，仅显示这一次。请保存在自己的电脑中。"); }}>
            <div className="remote-form"><label>凭据名称<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
              <label>有效天数<input type="number" min={1} max={30} required value={days} onChange={e => setDays(Number(e.target.value))} /></label>
              {user.role !== "viewer" && <label className="remote-draft-option"><input type="checkbox" checked={canDraft} onChange={e => setCanDraft(e.target.checked)} />允许提交草稿（仍需本人确认）</label>}</div>
            <button className="admin-button" disabled={busy || !!secret}>生成个人凭据</button>
          </form>
          {secret && <div className="admin-notice"><p>仅本次显示，请勿发送到聊天、提交到代码仓库或与他人共用。</p>
            <label>个人凭据<textarea readOnly value={secret} spellCheck={false} autoComplete="off" /></label>
            <button className="admin-button" onClick={() => setSecret("")}>已妥善保存，隐藏凭据</button></div>}
          <details className="remote-guide"><summary>连接 Codex</summary>
            <p>在自己的电脑上，将凭据保存到环境变量 AIRALOGY_BD_TOKEN，并让启动 Codex 的进程能够读取它。配置中的变量名不是凭据本身。</p>
            <pre>{`[mcp_servers.airalogy_bd]\nurl = "${endpoint}"\nbearer_token_env_var = "AIRALOGY_BD_TOKEN"`}</pre>
            <p>在 Codex 的 MCP 设置中添加上述连接并重新连接。接入凭据不能用于网页登录；如需续期，请生成新凭据并撤销旧凭据。</p>
          </details>
        </>}
      </>}
      {mode !== "drafts" && <>
      <h3>{manage ? "全部个人凭据" : "我的凭据"}</h3>
      {!status.tokens.length && <p className="settings-empty">暂无凭据。</p>}
      <ul className="remote-items">{status.tokens.map(token => <li key={token.id}><div><strong>{token.label}</strong>{manage && <span> · {status.members?.find(member => member.id === token.owner)?.name || "成员"}</span>}<p>{token.can_draft ? "查询和提交草稿" : "仅查询"} · {when(token.expires)} 到期</p></div>
        <button className="admin-button" disabled={busy} onClick={() => void act("revoke", { tokenId: token.id }, "凭据及其待确认草稿已撤销。")}>撤销</button></li>)}</ul>
      </>}
      {mode === "drafts" && <>
        <p className="admin-help">个人连接与凭据在 <Link href="/account#ai-tools">我的账号 → AI 工具连接</Link> 管理。</p>
        {(!status.enabled || !status.granted) && <p className="admin-notice">{!status.enabled?"工作区尚未开启外部工具接入。":"你的账号尚未获授权使用外部工具。"}</p>}
        <button className="admin-button" disabled={busy} onClick={() => { setError(""); void reload().catch(err => setError((err as Error).message)); }}>刷新草稿</button>
        {!drafts.length && <p>暂无可确认的修改。外部工具提交草稿后在这里核对；草稿最长保留 24 小时，权限变化、凭据失效或关闭功能会使草稿失效。</p>}
        {drafts.map(draft => <article key={draft.id} id={`draft-${draft.id}`} className="ai-draft">
          <h3>{draft.counterparty} · {draft.matterName} · {operations[draft.operation]}</h3>
          {draft.progressTitle && <p>进展：{draft.progressDate} · {draft.progressTitle}</p>}<p>有效至 {when(draft.expires)}</p>
          <div className="remote-diff">{draft.changes.map(change => <div key={change.field}><h4>{change.label}</h4><div className="remote-diff-pair">
            <section><h5>修改前</h5><pre>{display(change.field, change.before)}</pre></section><section><h5>{draft.operation === "add_progress" ? "新增内容" : "修改后"}</h5><pre>{display(change.field, change.after)}</pre></section>
          </div></div>)}</div>
          <label><input type="checkbox" checked={!!checked[draft.id]} onChange={e => setChecked({ ...checked, [draft.id]: e.target.checked })} /> 我已核对事项、日期、事实状态和全部修改内容</label>
          <div className="admin-actions"><button className="admin-button admin-primary" disabled={busy || !checked[draft.id]} onClick={() => void act("confirm", { draftId: draft.id, confirmed: true }, "已保存。工作台已更新，并保留修改记录；需要恢复时请联系管理员。")}>确认并正式保存</button>
            <button className="admin-button" disabled={busy} onClick={() => void act("reject", { draftId: draft.id }, "已驳回草稿，业务资料未更改。")}>驳回草稿</button></div>
        </article>)}
        <p className="admin-help">如提示记录已变化，请先检查最新内容，再让 Codex 重新读取并提交草稿。如操作中断，请先查看工作台，避免重复录入。</p>
      </>}
    </>}
  </section>;
}
