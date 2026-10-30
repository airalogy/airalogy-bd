"use client";
import { useCallback, useEffect, useState } from "react";
import {qaCategories} from "./InvestmentQa";
import { fileStatuses } from "./lib/file-library";
import Link from "next/link";
import { notifyRemoteDraftsChanged } from "./lib/remote-events";
import {SettingsPanelHeader,SettingsStatus} from "./SettingsUI";
import type { TeamUser } from "./lib/team-client";
import { stageLabels, followUpStatusLabels, roleLabels } from "./lib/labels";

type Token = { id: string; owner: string; label: string; can_draft: boolean; can_save: boolean; can_intake: boolean; can_qa: boolean; expires: number };
type Member = { id: string; name: string; role: string; active: boolean; granted: boolean };
type Status = { qa_allowed:boolean; enabled: boolean; granted: boolean; revision: string; tokens: Token[]; members?: Member[] };
type DraftAttachment = {mode:"upload"|"version"|"existing";file_id:string;version_id:string;upload_id?:string;title:string;filename:string;size:number;version_number:number;status:keyof typeof fileStatuses;agreement_date?:string;signing_completed_date?:string;note?:string};
type Draft = { attachments?:DraftAttachment[]; id: string; matterName: string; counterparty: string; progressTitle: string; progressDate: string; operation: string; expires: number; changes: { field: string; label: string; before: unknown; after: unknown }[] };
type AccessMode = "read" | "draft" | "direct";
const operations: Record<string, string> = { investment_qa: "保存问答修订稿", intake: "业务资料录入", add_progress: "新增进展", update_progress: "修改进展", update_matter: "修改事项" };
function display(field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "（空）";
  if (typeof value === "string" && field === "stage") return stageLabels[value] || value;
  if (typeof value === "string" && field === "follow_up_status") return followUpStatusLabels[value as keyof typeof followUpStatusLabels] || value;
  if (typeof value === "string" && field === "importance") return value === "key" ? "关键进展" : "普通进展";
  if (typeof value === "string" && field === "type") return ({ contact: "联系沟通", meeting: "会议", proposal: "方案", agreement: "协议", administrative: "行政手续", decision: "决定", payment: "付款", milestone: "里程碑", status_change: "状态变化", other: "其他" } as Record<string, string>)[value] || value;
  if (Array.isArray(value) && field === "new_people") return value.length ? value.map(person => [
    `姓名：${person.name}`, `单位及职位：${person.affiliation}`,
    person.phone && `电话：${person.phone}`, person.wechat && `微信：${person.wechat}`, person.email && `邮箱：${person.email}`,
  ].filter(Boolean).join("\n")).join("\n\n") : "（无）";
  if (Array.isArray(value) && field === "new_contacts") return value.length ? value.map(relation => [
    `人员：${relation.person_id}`, `关系：${({internal:"我方",counterparty:"对方",advisor:"顾问 / 引荐"} as Record<string,string>)[relation.side] || relation.side}`,
    `角色：${(relation.project_roles as string[]).map(role => roleLabels[role] || role).join("、")}`, relation.notes && `备注：${relation.notes}`,
  ].filter(Boolean).join("\n")).join("\n\n") : "（无）";
  if (typeof value === "string" && field === "category") return qaCategories[value] || value;
  if (Array.isArray(value) && ["aliases","sources","files"].includes(field)) return value.join("\n") || "（无）";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
const when = (value: number) => new Date(value * 1000).toLocaleString("zh-CN");

export default function RemoteAccess({ user, mode, endpoint = "" }: { user: TeamUser; mode: "settings" | "connection" | "drafts"; endpoint?: string }) {
  const manage = mode === "settings";
  const [status, setStatus] = useState<Status | null>(null), [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState(""), [label, setLabel] = useState("我的 AI 工具"), [days, setDays] = useState(7), [accessMode, setAccessMode] = useState<AccessMode>(user.role === "viewer" ? "read" : "draft");
  const [canQa,setCanQa]=useState(false);
  const [canIntake, setCanIntake] = useState(false);
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
      notifyRemoteDraftsChanged();
      if (result.token) setSecret(result.token);
      setNotice(message); await reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section id={manage?"external-ai":mode==="connection"?"ai-tools":undefined} className="panel admin-center-panel remote-access">
    <SettingsPanelHeader title={manage?"外部 AI 工具":mode==="connection"?"AI 工具连接":"修改草稿"} description={manage?"允许成员通过支持 MCP 的外部 AI 工具访问工作台，与内置 AI 的模型配置和费用独立。":mode==="connection"?"连接自己的 AI 工具，为每个连接设置访问权限和有效期。":"核对外部 AI 工具提交的内容，由你确认后正式保存。"} actions={mode==="connection"?<Link className="admin-button" href="/remote">查看待确认修改</Link>:undefined}/>
    {error && <p className="admin-alert" role="alert">{error}</p>}
    {notice && <p className="admin-notice" role="status">{notice}</p>}
    {!status ? <p>正在读取接入状态…</p> : <>
      {mode !== "drafts" && <div className="remote-state"><div><SettingsStatus tone={status.enabled?"success":"neutral"}>{status.enabled?"工作区已开启":"工作区未开启"}</SettingsStatus><p className="admin-help">{manage?"管理员默认具备接入权限，普通成员在“成员与权限”中单独授权。":user.role==="admin"&&status.granted?"管理员默认具备接入权限，无需为自己单独授权；连接仍需本人生成凭据。":status.granted?"你的账号已获授权，访问范围与事项权限一致。":"你的账号尚未获授权，请联系管理员调整成员权限。"}</p></div>{manage&&<button className="admin-button" disabled={busy} onClick={()=>{if(status.enabled&&!window.confirm("关闭外部 AI 工具接入？全部个人凭据和待确认草稿将失效，成员授权设置保留。"))return;void act("configure",{enabled:!status.enabled,revision:status.revision},status.enabled?"已关闭，旧凭据和草稿已失效。":"已开启，已获授权的成员可自行连接工具。");}}>{status.enabled?"关闭外部工具接入":"开启外部工具接入"}</button>}</div>}
      {manage && <p className="admin-help">在 <Link href="/admin?section=members">成员与权限</Link> 邀请或编辑普通成员时分配权限，管理员无需单独授权。关闭全局开关会撤销全部凭据和草稿，保留成员授权；重新开启后，由成员生成新凭据。</p>}
      {mode === "connection" && <>
        <p className="admin-help">返回给外部工具的业务资料会进入你所使用的模型上下文，请按公司要求选择模型。文件内容不会自动发送给模型，文件元数据可按事项权限查询；只有明确授权业务档案维护的管理员连接可读取完整人员档案，模型费用由对应工具账号承担。</p>
        {!status.enabled || !status.granted ? <p className="settings-empty">{!status.enabled?<>工作区尚未开启外部工具接入。{user.role==="admin"&&<>请前往 <Link href="/admin?section=ai#external-ai">AI 设置</Link> 开启，再回来生成个人凭据。</>}</>:"请联系管理员允许你的账号连接外部 AI 工具。"}</p> : <>
          <form onSubmit={event => { event.preventDefault(); void act("issue", { label, days, accessMode, canQa:status.qa_allowed&&canQa, canIntake: user.role === "admin" && accessMode !== "read" && canIntake }, "凭据已生成，仅显示这一次。请保存在自己的电脑中。"); }}>
            <div className="remote-form"><label>凭据名称<input required maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
              <label>有效期<select value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>1 天</option><option value={7}>7 天（默认）</option><option value={14}>14 天</option><option value={30}>30 天</option></select></label>
              <label className="remote-access-mode">连接权限<select value={accessMode} onChange={e => setAccessMode(e.target.value as AccessMode)} aria-describedby="remote-access-mode-help">
                <option value="read">仅查询</option>
                {user.role !== "viewer" && <option value="draft">提交草稿（默认）</option>}
                {user.role === "admin" && <option value="direct">允许直接保存进展及附件</option>}
              </select><span id="remote-access-mode-help" className="admin-help">{accessMode === "direct" ? "此连接可以直接新增、修改已有事项的进展，并保存关联附件，无需逐条网页确认。主动提交的草稿仍需网页确认；新建事项、直接修改事项信息和维护业务档案需另行勾选授权；不能删除资料或修改账号权限。每次保存留存历史，可在“修改历史”中恢复单条进展。" : accessMode === "draft" ? "可以查询、暂存附件并提交修改草稿，由你在网页核对进展和文件后一并正式保存。" : "只能查询获授权资料，不能提交草稿或保存修改。"}</span></label></div>
            {user.role === "admin" && accessMode !== "read" && <label className="team-check"><input type="checkbox" checked={canIntake} onChange={event => setCanIntake(event.target.checked)} /><span>允许新建事项及维护业务档案<span className="admin-help">可读取完整人员档案，新增、修改人员、对接方和事项，并连同进展及附件一并处理。{accessMode === "direct" ? "此连接可以直接正式保存。" : "正式保存仍需网页确认。"}不包含删除、账号权限或系统配置。</span></span></label>}
            {status.qa_allowed&&<label className="team-check"><input type="checkbox" checked={canQa} onChange={e=>setCanQa(e.target.checked)}/><span>允许访问投资问答库<span className="admin-help">{accessMode==="read"?"仅查询获准查看的问答。":accessMode==="direct"?"可直接保存问答修订稿，推荐回答仍需管理员在网页确认。":"可查询并提交问答修改草稿，由本人在网页确认后保存修订稿。"}仅对当前连接生效，来源资料仍按事项权限访问。</span></span></label>}
            <button className="admin-button" disabled={busy || !!secret}>生成个人凭据</button>
          </form>
          {secret && <div className="admin-notice"><p>仅本次显示，请勿发送到聊天、提交到代码仓库或与他人共用。</p>
            <label>个人凭据<textarea readOnly value={secret} spellCheck={false} autoComplete="off" /></label>
            <button className="admin-button" onClick={() => setSecret("")}>已妥善保存，隐藏凭据</button></div>}
          <details className="remote-guide"><summary>连接外部 AI 工具</summary>
            <p>使用支持远程 MCP（Streamable HTTP）和 Bearer 凭据认证的客户端。能否接入取决于工具的连接能力，与使用哪家模型无关。</p>
            <label>服务地址<input readOnly value={endpoint} aria-label="MCP 服务地址" /></label>
            <p>在工具的 MCP 设置中填写服务地址，并将个人凭据配置为 Bearer Token；具体入口以所用工具为准。请勿将凭据发到模型对话中。</p>
            <details><summary>Codex 配置示例</summary>
            <p>在自己的电脑上，将凭据保存到环境变量 AIRALOGY_BD_TOKEN，并让启动 Codex 的进程能够读取它。配置中的变量名不是凭据本身。</p>
            <pre>{`[mcp_servers.airalogy_bd]\nurl = "${endpoint}"\nbearer_token_env_var = "AIRALOGY_BD_TOKEN"`}</pre>
            <p>在 Codex 的 MCP 设置中添加上述连接并重新连接。</p></details>
            <p>凭据仅供本人使用，不能用于网页登录；如需续期，请生成新凭据并撤销旧凭据。</p>
          </details>
        </>}
      </>}
      {mode !== "drafts" && <>
      <h3>{manage ? "全部个人凭据" : "我的凭据"}</h3>
      {!status.tokens.length && <p className="settings-empty">暂无凭据。</p>}
      <ul className="remote-items">{status.tokens.map(token => <li key={token.id}><div><strong>{token.label}</strong>{manage && <span> · {status.members?.find(member => member.id === token.owner)?.name || "成员"}</span>}<p>{token.can_save ? "直接保存进展及附件 · 可查询和提交草稿" : token.can_draft ? "查询和提交草稿" : "仅查询"}{!!token.can_intake && " · 可新建事项及维护业务档案"}{!!token.can_qa&&" · 投资问答库"} · {when(token.expires)} 到期</p></div>
        {user.role === "admin" && token.owner === user.id && token.can_draft && !token.can_intake && <button className="admin-button" disabled={busy} onClick={() => {if(window.confirm(`允许“${token.label}”读取完整人员档案，新建、修改人员、对接方和事项，并处理进展及附件？${token.can_save ? "此连接可直接正式保存这些修改。" : "正式保存仍需网页确认。"}`)) void act("allow_intake", {tokenId:token.id,confirmed:true}, "此连接已获准维护业务档案。");}}>授权业务档案维护</button>}
        {status.qa_allowed&&token.owner===user.id&&!token.can_qa&&<button className="admin-button" disabled={busy} onClick={()=>{if(window.confirm(`允许“${token.label}”访问投资问答库？${token.can_save?"可直接保存修订稿，推荐回答仍需网页确认。":token.can_draft?"可查询和提交问答修改草稿。":"仅可查询获授权问答。"}`))void act("allow_qa",{tokenId:token.id,confirmed:true},"此连接已获准访问投资问答库。");}}>授权投资问答库</button>}
        <button className="admin-button" disabled={busy} onClick={() => void act("revoke", { tokenId: token.id }, "凭据及其待确认草稿已撤销。")}>撤销</button></li>)}</ul>
      </>}
      {mode === "drafts" && <>
        <p className="admin-help">个人连接与凭据在 <Link href="/account#ai-tools">我的账号 → AI 工具连接</Link> 管理。</p>
        {(!status.enabled || !status.granted) && <p className="admin-notice">{!status.enabled?"工作区尚未开启外部工具接入。":"你的账号尚未获授权使用外部工具。"}</p>}
        <button className="admin-button" disabled={busy} onClick={() => { setError(""); void reload().catch(err => setError((err as Error).message)); }}>刷新草稿</button>
        {!drafts.length && <p>暂无可确认的修改。外部工具提交草稿后在这里核对；草稿最长保留 24 小时，权限变化、凭据失效或关闭功能会使草稿失效。</p>}
        {drafts.map(draft => <article key={draft.id} id={`draft-${draft.id}`} className="ai-draft">
          <h3>{[draft.counterparty,draft.matterName,operations[draft.operation]].filter(Boolean).join(" · ")}</h3>
          {draft.operation==="investment_qa"&&<p className="admin-notice">确认后仅保存问答修订稿，当前推荐回答不会改变。请到投资问答库核对并确认推荐版本。</p>}{draft.progressTitle && <p>{draft.operation==="investment_qa"?"问题：":"进展："}{draft.progressDate} · {draft.progressTitle}</p>}<p>有效至 {when(draft.expires)}</p>
          <div className="remote-diff">{draft.changes.map(change => <div key={change.field}><h4>{change.label}</h4><div className="remote-diff-pair">
            <section><h5>修改前</h5><pre>{display(change.field, change.before)}</pre></section><section><h5>{draft.operation === "add_progress" ? "新增内容" : "修改后"}</h5><pre>{display(change.field, change.after)}</pre></section>
          </div></div>)}</div>
          {!!draft.attachments?.length&&<section><h4>随进展保存的附件</h4><ul className="remote-attachment-list">{draft.attachments.map((file,index)=><li key={index}>
            <strong>{file.title} · v{file.version_number}</strong><p>{file.filename} · {Math.ceil(file.size/1024)} KB · {fileStatuses[file.status]}</p>
            <p>{file.mode==="existing"?"关联已有版本，不复制文件":file.mode==="version"?"追加新版本，保留原版本":"新文件，将归入本事项资料库"}</p>
            {(file.agreement_date||file.signing_completed_date)&&<p>协议载明日期：{file.agreement_date||"未记录"} · 实际签署完成日期：{file.signing_completed_date||"未记录"}</p>}
            {file.note&&<p>{file.note}</p>}
            <a className="admin-button" href={file.upload_id?`/api/remote/files?${new URLSearchParams({draft_id:draft.id,upload_id:file.upload_id})}`:`/api/files?${new URLSearchParams({action:"download",id:file.file_id,version_id:file.version_id})}`} download>下载核对文件</a>
          </li>)}</ul><p className="admin-help">确认后文件与进展一起保存。关联附件不会自动登记为已发送或改变事项阶段。</p></section>}
          <label><input type="checkbox" checked={!!checked[draft.id]} onChange={e => setChecked({ ...checked, [draft.id]: e.target.checked })} /> {draft.operation==="investment_qa"?"我已核对问题、回答、数据日期、来源及全部修改内容":"我已核对事项、日期、事实状态、附件和全部修改内容"}</label>
          <div className="admin-actions"><button className="admin-button admin-primary" disabled={busy || !checked[draft.id]} onClick={() => void act("confirm", { draftId: draft.id, confirmed: true }, "已保存。工作台已更新，并保留修改记录；需要恢复时请联系管理员。")}>{draft.operation==="investment_qa"?"确认并保存修订稿":"确认并正式保存"}</button>
            <button className="admin-button" disabled={busy} onClick={() => void act("reject", { draftId: draft.id }, "已驳回草稿，业务资料未更改。")}>驳回草稿</button></div>
        </article>)}
        <p className="admin-help">如提示记录已变化，请先检查最新内容，再让外部 AI 工具重新读取并提交草稿。如操作中断，请先查看工作台，避免重复录入。</p>
      </>}
    </>}
  </section>;
}
