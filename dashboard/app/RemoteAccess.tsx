"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

export default function RemoteAccess({ user, manage = false, endpoint = "" }: { user: TeamUser; manage?: boolean; endpoint?: string }) {
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
    const pending = !manage && latest.enabled && latest.granted ? (await request<{ drafts: Draft[] }>("drafts")).drafts : [];
    return { latest, pending };
  }, [manage, request]);
  const apply = useCallback(({ latest, pending }: { latest: Status; pending: Draft[] }) => {
    setStatus(latest); setDrafts(pending); setChecked({});
  }, []);
  async function reload() { apply(await load()); }
  useEffect(() => { void load().then(apply).catch(err => setError((err as Error).message)); }, [load, apply]);
  async function act(action: string, input: Record<string, unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request<{ token?: string }>(action, input);
      if (result.token) setSecret(result.token);
      setNotice(message); await reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel admin-center-panel remote-access">
    <h2>{manage ? "Codex 远程接入" : "我的远程接入"}</h2>
    <p>远程助手可查询获授权事项和提交修改草稿。草稿由本人在本页面核对并确认后保存。</p>
    {error && <p className="admin-alert" role="alert">{error}</p>}
    {notice && <p className="admin-notice" role="status">{notice}</p>}
    {!status ? <p>正在读取接入状态…</p> : <>
      <p>当前状态：<strong>{status.enabled ? "已开启" : "已关闭"}</strong></p>
      {manage ? <>
        <p className="admin-help">按账号授权。关闭接入将撤销全部凭据和待确认草稿；重新开启后需重新生成凭据。</p>
        <button className="admin-button" disabled={busy} onClick={() => void act("configure", { enabled: !status.enabled, revision: status.revision }, status.enabled ? "已关闭，旧凭据和草稿已失效。" : "已开启。请为需要使用的成员授权。")}>{status.enabled ? "关闭远程接入并撤销凭据" : "开启远程接入"}</button>
        <h3>成员授权</h3>
        <ul className="remote-items">{status.members?.map(member => <li key={member.id}><span>{member.name} · {{ admin: "管理员", editor: "编辑成员", viewer: "只读成员" }[member.role]}{!member.active && " · 未启用"}</span>
          <button className="admin-button" disabled={busy || (!member.active && !member.granted)} onClick={() => void act("grant", { memberId: member.id, allowed: !member.granted }, member.granted ? "已取消授权，该成员的凭据与草稿已失效。" : "成员可登录后自行生成凭据。")}>{member.granted ? "取消远程授权" : "允许远程接入"}</button></li>)}</ul>
        <p><Link className="admin-button" href="/remote">管理我自己的凭据和草稿</Link></p>
      </> : <>
        <p className="admin-help">返回给 Codex 的业务资料会进入你所使用的模型上下文。请按公司要求使用模型；这里不自动读取附件和联系方式。Codex 的模型费用由对应账号承担。</p>
        {!status.enabled || !status.granted ? <p>请联系管理员开启功能并授权你的账号。</p> : <>
          <form onSubmit={event => { event.preventDefault(); void act("issue", { label, days, canDraft }, "凭据已生成，仅显示这一次。请保存在自己的电脑中。"); }}>
            <div className="remote-form"><label>凭据名称<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
              <label>有效天数<input type="number" min={1} max={30} required value={days} onChange={e => setDays(Number(e.target.value))} /></label>
              {user.role !== "viewer" && <label><input type="checkbox" checked={canDraft} onChange={e => setCanDraft(e.target.checked)} />允许提交草稿（仍需本人确认）</label>}</div>
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
      <h3>{manage ? "全部个人凭据" : "我的凭据"}</h3>
      {!status.tokens.length && <p>暂无凭据。</p>}
      <ul className="remote-items">{status.tokens.map(token => <li key={token.id}><div><strong>{token.label}</strong>{manage && <span> · {status.members?.find(member => member.id === token.owner)?.name || "成员"}</span>}<p>{token.can_draft ? "查询和提交草稿" : "仅查询"} · {when(token.expires)} 到期</p></div>
        <button className="admin-button" disabled={busy} onClick={() => void act("revoke", { tokenId: token.id }, "凭据及其待确认草稿已撤销。")}>撤销</button></li>)}</ul>
      {!manage && <>
        <h3>我的待确认草稿</h3>
        <button className="admin-button" disabled={busy} onClick={() => { setError(""); void reload().catch(err => setError((err as Error).message)); }}>刷新草稿</button>
        {!drafts.length && <p>暂无可确认的草稿。草稿最长保留 24 小时；权限变化、凭据失效或关闭功能后不可确认。</p>}
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
