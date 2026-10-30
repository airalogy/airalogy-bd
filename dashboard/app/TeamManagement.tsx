"use client";
import * as Dialog from "@radix-ui/react-dialog";
import {useCallback,useEffect,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import Link from "next/link";
import {teamRequest,type TeamUser} from "./lib/team-client";
import type {Project} from "./lib/types";
import {workspaceRequest} from "./lib/workspace-client";
import type {WorkspaceResponse} from "./lib/workspace-types";
import {SettingsIcon,SettingsPanelHeader,SettingsStatus} from "./SettingsUI";

type MemberList={users:TeamUser[];remote_enabled:boolean};
import AuditEntries, {type Audit} from "./AuditEntries";
const roleNames={admin:"管理员",editor:"编辑成员",viewer:"只读成员"};
const roleHelp={admin:"管理全部资料、成员权限和系统设置。",editor:"修改获授权事项和附件、补充进展，并随进展新增人员。",viewer:"查看和导出获授权资料，不能修改。"};
const statusNames={active:"已启用",email:"待验证邮箱",setup:"待绑定验证器",invited:"待接受邀请",expired:"邀请已过期",disabled:"已停用"};
const isInvitation=(member:TeamUser)=>member.status==="invited"||member.status==="expired";

export default function TeamManagement({user,projects,timezone}:{user:TeamUser;projects:Pick<Project,"id"|"name">[];timezone:string}) {
  const router=useRouter();
  const [members,setMembers]=useState<TeamUser[]>([]),[loading,setLoading]=useState(true);
  const [memberSearch,setMemberSearch]=useState(""),[statusFilter,setStatusFilter]=useState("all");
  const [projectChoices,setProjectChoices]=useState(projects),[projectSearch,setProjectSearch]=useState("");
  const [editorOpen,setEditorOpen]=useState(false),[selected,setSelected]=useState<TeamUser|null>(null);
  const [email,setEmail]=useState(""),[name,setName]=useState("");
  const [role,setRole]=useState<TeamUser["role"]>("viewer"),[all,setAll]=useState(false),[ids,setIds]=useState<string[]>([]);
  const [qaAllowed,setQaAllowed]=useState(false),[qaCanPublish,setQaCanPublish]=useState(false);
  const [remoteAllowed,setRemoteAllowed]=useState(false),[remoteEnabled,setRemoteEnabled]=useState(false);
  const [active,setActive]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[formError,setFormError]=useState(""),[notice,setNotice]=useState("");
  const [link,setLink]=useState(""),[linkExpires,setLinkExpires]=useState<number|null>(null);
  const [auditScope,setAuditScope]=useState("members"),[auditNext,setAuditNext]=useState<number|null>(null);
  const [audit,setAudit]=useState<Audit[]>([]),[auditLoaded,setAuditLoaded]=useState(false),[auditBusy,setAuditBusy]=useState(false);
  const opener=useRef<HTMLButtonElement|null>(null),inviteButton=useRef<HTMLButtonElement|null>(null);
  const formAlert=useRef<HTMLParagraphElement|null>(null);
  const pendingInvitations=members.some(member=>member.status==="invited");
  const expiryText=(seconds:number)=>new Intl.DateTimeFormat("zh-CN",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(seconds*1000));
  const visibleProjects=projectChoices.filter(project=>project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase()));
  const visibleMembers=members.filter(member=>{
    const search=memberSearch.trim().toLocaleLowerCase();
    const matches=[member.name,member.username,member.email].some(value=>value?.toLocaleLowerCase().includes(search));
    return matches&&(statusFilter==="all"||(statusFilter==="pending"?["invited","expired","email","setup"].includes(member.status||""):member.status===statusFilter));
  });
  const fullAccess=role==="admin"||all;
  const effectiveRemoteAllowed=role==="admin"||remoteAllowed;
  const effectiveQaPublish=role==="admin"||(role==="editor"&&qaAllowed&&qaCanPublish);
  const dirty=selected?effectiveQaPublish!==!!selected.qa_can_publish||(role==="admin"||qaAllowed)!==!!selected.qa_allowed||effectiveRemoteAllowed!==!!selected.remote_allowed||role!==selected.role||all!==selected.all_projects||active!==!!selected.active||JSON.stringify([...ids].sort())!==JSON.stringify([...selected.project_ids].sort()):!!name||!!email||qaAllowed||qaCanPublish||remoteAllowed||role!=="viewer"||all||ids.length>0;
  const refresh=useCallback(async()=>{const result=await teamRequest<MemberList>("team_list",{},user.csrf);setMembers(result.users);setRemoteEnabled(result.remote_enabled);},[user.csrf]);
  useEffect(()=>{let cancelled=false;teamRequest<MemberList>("team_list",{},user.csrf).then(result=>{if(!cancelled){setMembers(result.users);setRemoteEnabled(result.remote_enabled);}}).catch(err=>{if(!cancelled)setError(err.message);}).finally(()=>{if(!cancelled)setLoading(false);});return()=>{cancelled=true;};},[user.csrf]);
  useEffect(()=>{const controller=new AbortController();workspaceRequest<WorkspaceResponse>("workspace",{},false,controller.signal).then(result=>{if(result.data)setProjectChoices(result.data.projects);}).catch(err=>{if(!controller.signal.aborted)setError(err.message);});return()=>controller.abort();},[]);
  useEffect(()=>{if(!pendingInvitations)return;const timer=window.setInterval(()=>{void refresh().catch(err=>setError(err.message));},60000);return()=>window.clearInterval(timer);},[pendingInvitations,refresh]);
  useEffect(()=>{if(formError&&editorOpen){formAlert.current?.focus();formAlert.current?.scrollIntoView({block:"nearest"});}},[formError,editorOpen]);
  function select(member:TeamUser|null,button:HTMLButtonElement){
    opener.current=button;setSelected(member);setQaCanPublish(member?.role==="editor"&&!!member?.qa_can_publish);setQaAllowed(member?.role!=="admin"&&!!member?.qa_allowed);setRemoteAllowed(member?.role!=="admin"&&!!member?.remote_allowed);setEmail(member?.email||"");setName(member?.name||"");setRole(member?.role||"viewer");setAll(member?.all_projects||false);setIds(member?.project_ids||[]);setProjectSearch("");setActive(member?!!member.active:true);setFormError("");setError("");setNotice("");setEditorOpen(true);
  }
  function closeEditor(){if(!busy&&(!dirty||window.confirm("放弃尚未保存的成员设置？")))setEditorOpen(false);}
  function showLink(result:{token:string;expires:number}){setLinkExpires(result.expires);setLink(`${window.location.origin}/join#${result.token}`);setNotice("邀请链接已生成，请单独交给该成员。");}
  async function save(event:React.FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setFormError("");setNotice("");
    try{
      const payload={email,name,qa_allowed:role==="admin"||qaAllowed,qa_can_publish:effectiveQaPublish,remote_allowed:effectiveRemoteAllowed,...(selected?{remote_allowed_before:!!selected.remote_allowed}:{}),role,all_projects:all,project_ids:ids,active,id:selected?.id,revision:selected?.revision};
      if(selected){
        await teamRequest("team_update",payload,user.csrf);setNotice(isInvitation(selected)?"邀请权限已更新；原邀请链接和到期时间保持不变。":active?"权限已更新，该成员需要重新登录并按需生成新的工具凭据。":"账号已停用，已有记录和历史已保留。");
        if(selected.id===user.id){router.replace("/login");router.refresh();return;}
      }else showLink(await teamRequest("team_invite",payload,user.csrf));
      try{await refresh();if(auditLoaded)await loadAudit();}catch(err){setError(`已保存，但成员列表未能刷新：${(err as Error).message}`);}
      setEditorOpen(false);
    }catch(err){setFormError((err as Error).message);}finally{setBusy(false);}
  }
  async function reset(member:TeamUser){
    if(!window.confirm(isInvitation(member)?`重新邀请 ${member.name}？旧链接将立即失效，新链接 48 小时内有效，原有身份和权限保留。`:`重新签发 ${member.name} 的登录邀请？现有登录会立即失效，原密码和验证器将需要重新设置。`))return;
    setBusy(true);setError("");try{showLink(await teamRequest("team_reset",{id:member.id},user.csrf));await refresh();if(auditLoaded)await loadAudit();}catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  async function copyLink(){try{await navigator.clipboard.writeText(link);setNotice("邀请链接已复制，请通过微信或邮件等渠道单独交给本人。");}catch{setNotice("无法自动复制，请选中邀请链接后手动复制。");}}
  async function loadAudit(more=false,scope=auditScope){setAuditBusy(true);try{const result=await teamRequest<{entries:Audit[];next_before:number|null}>("team_audit",{scope,...(more&&auditNext?{before:auditNext}:{})},user.csrf);setAudit(old=>more?[...old,...result.entries]:result.entries);setAuditNext(result.next_before);setAuditLoaded(true);}catch(err){setError((err as Error).message);}finally{setAuditBusy(false);}}
  return <section className="team-management">
    <section className="panel admin-center-panel member-panel">
      <SettingsPanelHeader title="成员与权限" description="设置成员角色、事项范围、投资问答库和外部 AI 工具权限。" actions={<button ref={inviteButton} type="button" className="admin-button admin-primary" disabled={busy} onClick={event=>select(null,event.currentTarget)}><SettingsIcon name="plus"/>邀请新成员</button>}/>
      {error&&<p className="admin-alert" role="alert">{error}</p>}{notice&&<p className="admin-notice" role="status">{notice}</p>}
      {link&&<section className="invitation-result" aria-label="生成的邀请链接"><div className="invitation-result-heading"><strong>一次性邀请链接</strong><button className="settings-text-button" type="button" onClick={()=>{setLink("");setLinkExpires(null);}}>收起</button></div><div className="invitation-copy"><label className="sr-only" htmlFor="member-invitation-link">邀请链接</label><input id="member-invitation-link" readOnly value={link} onFocus={e=>e.target.select()}/><button type="button" className="admin-button" onClick={()=>void copyLink()}>复制链接</button></div><p className="admin-help">{linkExpires&&<>有效至 <time dateTime={new Date(linkExpires*1000).toISOString()}>{expiryText(linkExpires)}</time>（{timezone}），</>}仅可使用一次。由本人填写邮箱、设置密码和身份验证器。</p></section>}
      <div className="member-toolbar"><label className="settings-search"><SettingsIcon name="search"/><span className="sr-only">搜索成员</span><input type="search" placeholder="搜索姓名、用户名或邮箱" value={memberSearch} onChange={event=>setMemberSearch(event.target.value)}/></label><label className="member-status-filter"><span className="sr-only">成员状态</span><select value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="active">已启用</option><option value="pending">待激活</option><option value="disabled">已停用</option></select></label><span className="member-count">{members.length} 名成员</span></div>
      {loading?<p className="settings-empty" role="status">正在读取成员…</p>:<div className="member-list">{visibleMembers.map(member=><article className="member-row" key={member.id}>
        <div className="member-identity"><span className="member-avatar" aria-hidden="true">{Array.from(member.name)[0]}</span><div><div className="member-name"><strong>{member.name}</strong>{member.id===user.id&&<span className="member-self">你</span>}<SettingsStatus tone={member.status==="active"?"success":member.status==="expired"?"warning":"neutral"}>{member.status?statusNames[member.status]:member.active?"已启用":"已停用"}</SettingsStatus></div><p>{member.username||"尚未设置用户名"}</p><p className="member-email">{member.email||"邮箱待本人填写"}</p>{!!member.invitation_expires&&<p className={member.status==="expired"?"team-invitation-expired":""}>{member.status==="expired"?"已于":"邀请将于"} <time dateTime={new Date(member.invitation_expires*1000).toISOString()}>{expiryText(member.invitation_expires)}</time> 到期</p>}</div></div>
        <div className="member-permissions"><span className="member-role">{roleNames[member.role]}</span><p>{member.role==="admin"||member.all_projects?"全部事项":member.project_ids.length?`指定事项 · ${member.project_ids.length} 项`:"尚未分配事项"}</p><small>{member.role==="admin"||member.all_projects?"自动包含新增事项":"新增事项需另行授权"}</small><small>投资问答库 · {member.role==="admin"||member.qa_can_publish?"可编辑并确认推荐回答":member.qa_allowed?(member.role==="editor"?"可编辑修订稿":"仅查看推荐回答"):"未允许"}</small><small className="member-tool-access">外部 AI 工具 · {member.role==="admin"?(remoteEnabled?"管理员默认允许":"管理员默认允许，功能待开启"):member.remote_allowed?(remoteEnabled?"已允许":"已允许，功能待开启"):"未允许"}</small></div>
        <div className="member-actions"><button type="button" className="admin-button" disabled={busy} onClick={event=>select(member,event.currentTarget)}>调整权限</button>{member.id!==user.id&&<button type="button" disabled={busy} className="settings-text-button" onClick={()=>void reset(member)}>{isInvitation(member)?"重新邀请":"重置登录"}</button>}</div>
      </article>)}{!visibleMembers.length&&<p className="settings-empty">{members.length?"没有符合条件的成员，试试其他关键词或状态。":"尚无成员，可通过邀请链接加入团队。"}</p>}</div>}
      <p className="member-policy-note">停用账号会撤销登录访问，保留已有业务记录和操作历史。编辑成员可随获授权事项的进展新增人员；已有人员档案维护、事项创建、全局历史和备份由管理员管理。</p>
    </section>
    <details className="settings-disclosure member-audit" onToggle={event=>{if(event.currentTarget.open&&!auditLoaded&&!auditBusy)void loadAudit();}}><summary><span>操作记录<small>查看操作人、目标成员与具体变更</small></span></summary><div className="settings-disclosure-body"><div className="settings-row-heading audit-toolbar"><label>记录范围<select value={auditScope} disabled={auditBusy} onChange={event=>{const scope=event.target.value;setAuditScope(scope);setAudit([]);setAuditNext(null);void loadAudit(false,scope);}}><option value="members">成员与权限</option><option value="all">全部操作</option></select></label><button type="button" className="admin-button" disabled={auditBusy} onClick={()=>void loadAudit()}>{auditBusy?"读取中…":"刷新记录"}</button></div>{auditScope==="all"&&<p className="admin-help">“开始”仅表示操作已发起，需结合后续完成或失败记录判断结果。</p>}<AuditEntries entries={audit} timezone={timezone}/>{auditLoaded&&!audit.length&&!auditBusy&&<p className="settings-empty">暂无操作记录。</p>}{auditNext!==null&&<button type="button" disabled={auditBusy} className="admin-button" onClick={()=>void loadAudit(true)}>加载更早记录</button>}</div></details>
    <Dialog.Root open={editorOpen} onOpenChange={open=>{if(!open)closeEditor();}}><Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay"/><Dialog.Content className="admin-dialog member-dialog" onInteractOutside={event=>event.preventDefault()} onEscapeKeyDown={event=>{event.preventDefault();closeEditor();}} onCloseAutoFocus={event=>{event.preventDefault();(opener.current?.isConnected?opener.current:inviteButton.current)?.focus();}}>
      <header className="admin-dialog-head"><div><Dialog.Title>{selected?`调整 ${selected.name} 的权限`:"邀请新成员"}</Dialog.Title><Dialog.Description>{selected?"调整角色和访问范围，保存后生效。":"填写基本资料并分配权限，再把邀请链接交给本人。"}</Dialog.Description></div><button type="button" className="close-button" aria-label="关闭成员设置" disabled={busy} onClick={closeEditor}>×</button></header>
      <form className="team-form" onSubmit={save}><div className="admin-dialog-scroll">{formError&&<p ref={formAlert} className="admin-alert" role="alert" tabIndex={-1}>{formError}</p>}<fieldset disabled={busy} className="member-form-fields">
        {!selected&&<section className="settings-form-section"><h3>基本资料</h3><div className="edit-form-grid"><label>姓名<input required maxLength={100} autoComplete="name" value={name} onChange={e=>setName(e.target.value)}/></label><label><span>邮箱 <span className="field-optional">选填</span></span><input type="email" autoComplete="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/></label></div><p className="admin-help">邮箱留空时由本人激活时填写；已填写的邮箱会绑定到本次邀请。</p></section>}
        <section className="settings-form-section"><h3>角色与访问范围</h3><label>成员角色<select aria-describedby="team-role-help" value={role} onChange={e=>{const nextRole=e.target.value as TeamUser["role"];if(role==="admin"||nextRole==="admin"){setRemoteAllowed(false);setQaAllowed(false);}setQaCanPublish(false);setRole(nextRole);}}>{Object.entries(roleNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><span id="team-role-help" className="admin-help">{roleHelp[role]}</span></label>
        {role!=="admin"?<><fieldset className="team-scope-options"><legend>可访问的事项</legend><label className={`team-scope-option${!all?" is-selected":""}`}><input type="radio" name="matter-scope" checked={!all} onChange={()=>setAll(false)}/><span><strong>指定事项</strong><span>仅限勾选项，新增事项需另行授权。</span></span></label><label className={`team-scope-option${all?" is-selected":""}`}><input type="radio" name="matter-scope" checked={all} onChange={()=>setAll(true)}/><span><strong>全部事项</strong><span>自动包含当前和以后新增的事项。</span></span></label></fieldset>
          {all?<p className="admin-help">同时可查看公司动态及共享的人员、对接方资料。</p>:<div className="team-project-picker"><label className="settings-search"><SettingsIcon name="search"/><span className="sr-only">搜索事项</span><input type="search" placeholder="搜索事项名称" value={projectSearch} onChange={e=>setProjectSearch(e.target.value)}/></label><div className="team-selection-toolbar"><span role="status">已选 {ids.length} 项</span><div><button type="button" className="settings-text-button" disabled={!visibleProjects.length} onClick={()=>setIds(current=>[...new Set([...current,...visibleProjects.map(project=>project.id)])])}>{projectSearch.trim()?"选中搜索结果":"选中当前全部"}</button><button type="button" className="settings-text-button" disabled={!ids.length} onClick={()=>setIds([])}>清空</button></div></div><div className="team-project-list">{visibleProjects.map(project=><label className="team-check" key={project.id}><input type="checkbox" checked={ids.includes(project.id)} onChange={e=>setIds(e.target.checked?[...ids,project.id]:ids.filter(id=>id!==project.id))}/>{project.name}</label>)}{!visibleProjects.length&&<p className="admin-help">{projectChoices.length?"没有匹配的事项。":"暂无事项，可在新增后分配。"}</p>}</div><p className="admin-help">批量选择只包含现有事项。跨事项附件需具备其全部关联事项的权限。</p></div>}</>:<p className="admin-help">管理员始终管理全部事项，自动包含以后新增的事项。</p>}
        </section>
        <section className="settings-form-section"><h3>投资问答库</h3>{role==="admin"?<p className="admin-help">管理员可查看、编辑、确认推荐版本及归档问答。</p>:<>
          <label className="team-check"><input type="checkbox" checked={qaAllowed} onChange={e=>{setQaAllowed(e.target.checked);if(!e.target.checked)setQaCanPublish(false);}}/><span>允许访问投资问答库<span className="admin-help">独立于事项范围，允许查看所有已确认的推荐回答。{role==="editor"?"编辑成员还可新增问答、完善修订稿并查看版本历史。":"只读成员不能查看未确认的回答或进行修改。"}来源会议及文件仍按原事项权限开放。</span></span></label>
          {role==="editor"&&qaAllowed&&<label className="team-check"><input type="checkbox" checked={qaCanPublish} onChange={e=>setQaCanPublish(e.target.checked)}/><span>可确认投资问答的推荐回答<span className="admin-help">可确认自己或其他成员的修订稿，供获授权团队成员使用。记录确认人及时间；不授予归档、账号管理或系统配置权限。</span></span></label>}
        </>}</section>
        <section className="settings-form-section member-external-ai"><h3>外部 AI 工具</h3>{role==="admin"?<p className="admin-notice">管理员默认允许连接外部 AI 工具，无需单独授权。改为普通成员后默认不允许，可按需重新勾选。</p>:<label className="team-scope-option"><input type="checkbox" checked={remoteAllowed} onChange={e=>setRemoteAllowed(e.target.checked)} aria-describedby="member-external-ai-help"/><span><strong>允许连接外部 AI 工具</strong><span>通过支持 MCP 的 AI 客户端连接工作台。</span></span></label>}<p id="member-external-ai-help" className="admin-help">{role==="admin"?"连接默认提交草稿；管理员可在创建连接时主动选择“允许直接保存进展及附件”。":role==="viewer"?"只读成员仅可查询获授权事项，不能提交修改草稿。":"仅可查询获授权事项、提交修改草稿；修改需本人在网站确认后保存。"}本人激活账号后，在“我的账号 → AI 工具连接”生成个人凭据。</p>{!remoteEnabled&&<p className="admin-notice">工作区暂未开启外部工具接入，可以先保存成员权限；管理员在 <Link href="/admin?section=ai#external-ai" target="_blank" rel="noopener noreferrer">AI 设置</Link> 开启后才能连接。</p>}</section>
        {selected&&isInvitation(selected)&&<p className="admin-help">成员尚未接受邀请，可先调整权限；账号仍需本人完成激活。</p>}
        {selected&&!isInvitation(selected)&&<label className="team-check member-active"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>启用账号</label>}
        <section className="team-permission-summary" aria-labelledby="team-permission-summary-title"><h3 id="team-permission-summary-title">权限预览</h3>{selected&&!active&&!isInvitation(selected)?<p>保存后账号将停用，不能访问工作台；已有记录和历史保留。</p>:<><dl><div><dt>可操作</dt><dd>{roleHelp[role]}</dd></div><div><dt>可访问</dt><dd>{fullAccess?"全部事项":ids.length?`已选的 ${ids.length} 个事项`:"尚未分配事项"}</dd></div><div><dt>以后新增事项</dt><dd>{fullAccess?"自动获得访问权限":"需要管理员另行授权"}</dd></div><div><dt>投资问答库</dt><dd>{effectiveQaPublish?"可编辑并确认推荐回答":qaAllowed?(role==="editor"?"可编辑修订稿，不能确认推荐回答":"仅查看推荐回答"):"未允许访问"}</dd></div><div><dt>外部 AI 工具</dt><dd>{role==="admin"?"管理员允许连接 · 每个连接单独选择权限":effectiveRemoteAllowed?(role==="viewer"?"允许连接 · 仅查询":"允许连接 · 查询和提交草稿"):"未允许连接"}</dd></div></dl>{!fullAccess&&!ids.length&&<p className="admin-help">可以激活账号，但暂时不能查看业务事项。</p>}</>}</section>
      </fieldset></div><footer className="admin-dialog-footer"><span>{selected?(isInvitation(selected)?"保留原邀请链接及其到期时间。":"保存后，现有登录、工具凭据与草稿将失效。"):"邀请链接有效期 48 小时，仅可使用一次。"}</span><div className="admin-actions"><button type="button" className="admin-button" disabled={busy} onClick={closeEditor}>取消</button><button className="admin-button admin-primary" type="submit" disabled={busy}>{busy?"正在保存…":selected?"保存权限":"生成邀请链接"}</button></div></footer></form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
