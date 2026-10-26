"use client";
import {useCallback,useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {teamRequest,type TeamUser} from "./lib/team-client";
import type {Project} from "./lib/types";
import {workspaceRequest} from "./lib/workspace-client";
import type {WorkspaceResponse} from "./lib/workspace-types";
type Audit={id:number;at:number;actor_name:string;action:string;target:string;outcome:string};
const actionNames:Record<string,string>={"account.invite":"邀请成员","account.activate":"激活账号","account.login":"登录","account.permissions":"调整权限","account.reset":"重置登录",save:"保存资料",file_save:"更新附件",restore:"恢复资料",backup_config:"调整备份",backup_now:"立即备份",file_backup:"导出完整备份"};
const roleNames={admin:"管理员",editor:"编辑成员",viewer:"只读成员"};
const roleHelp={admin:"管理全部资料、成员权限和系统设置。",editor:"修改获授权事项和附件、补充进展。",viewer:"查看和导出获授权资料，不能修改。"};
const statusNames={active:"已启用",email:"待验证邮箱",setup:"待绑定验证器",invited:"待接受邀请",expired:"邀请已过期",disabled:"已停用"};
export default function TeamManagement({user,projects,timezone}:{user:TeamUser;projects:Pick<Project,"id"|"name">[];timezone:string}) {
  const router=useRouter();
  const [members,setMembers]=useState<TeamUser[]>([]);
  const [projectChoices,setProjectChoices]=useState(projects);
  const [selected,setSelected]=useState<TeamUser|null>(null);
  const [email,setEmail]=useState("");const [name,setName]=useState("");
  const [role,setRole]=useState<TeamUser["role"]>("viewer");
  const [all,setAll]=useState(false);const [ids,setIds]=useState<string[]>([]);
  const [projectSearch,setProjectSearch]=useState("");
  const [active,setActive]=useState(true);const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");const [notice,setNotice]=useState("");const [link,setLink]=useState("");
  const [audit,setAudit]=useState<Audit[]>([]);
  const [linkExpires,setLinkExpires]=useState<number|null>(null);
  const pendingInvitations=members.some(member=>member.status==="invited");
  const expiryText=(seconds:number)=>new Intl.DateTimeFormat("zh-CN",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(seconds*1000));
  const visibleProjects=projectChoices.filter(project=>project.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase()));
  const fullAccess=role==="admin"||all;
  const refresh=useCallback(async()=>{const result=await teamRequest<{users:TeamUser[]}>("team_list",{},user.csrf);setMembers(result.users);},[user.csrf]);
  useEffect(()=>{let cancelled=false;teamRequest<{users:TeamUser[]}>("team_list",{},user.csrf).then(result=>{if(!cancelled)setMembers(result.users);}).catch(err=>{if(!cancelled)setError(err.message);});return()=>{cancelled=true;};},[user.csrf]);
  useEffect(()=>{const controller=new AbortController();workspaceRequest<WorkspaceResponse>("workspace",{},false,controller.signal).then(result=>{if(result.data)setProjectChoices(result.data.projects);}).catch(err=>{if(!controller.signal.aborted)setError(err.message);});return()=>controller.abort();},[]);
  useEffect(()=>{if(!pendingInvitations)return;const timer=window.setInterval(()=>{void refresh().catch(err=>setError(err.message));},60000);return()=>window.clearInterval(timer);},[pendingInvitations,refresh]);
  function select(member:TeamUser|null){setSelected(member);setEmail(member?.email||"");setName(member?.name||"");setRole(member?.role||"viewer");setAll(member?.all_projects||false);setIds(member?.project_ids||[]);setProjectSearch("");setActive(member?!!member.active:true);setLink("");setLinkExpires(null);setError("");setNotice("");}
  function showLink(result:{token:string;expires:number}){setLinkExpires(result.expires);setLink(`${window.location.origin}/join#${result.token}`);setNotice("请将邀请链接交给该成员。链接 48 小时内有效，仅可使用一次。");}
  async function save(event:React.FormEvent){event.preventDefault();setBusy(true);setError("");setNotice("");try{
    const payload={email,name,role,all_projects:all,project_ids:ids,active,id:selected?.id,revision:selected?.revision};
    if(selected){await teamRequest("team_update",payload,user.csrf);setNotice(active?"权限已更新，该成员需要重新登录。":"权限已更新，账号已停用。如需重新邀请，请生成新的登录邀请。");if(selected.id===user.id){router.replace("/login");router.refresh();return;}setSelected(null);}
    else showLink(await teamRequest("team_invite",payload,user.csrf));
    await refresh();
  }catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  async function reset(member:TeamUser){const pending=member.status==="invited"||member.status==="expired";if(!window.confirm(pending?`重新邀请 ${member.name}？旧链接将立即失效，新链接 48 小时内有效，原有身份和权限保留。`:`重新签发 ${member.name} 的登录邀请？现有登录会立即失效，原密码和验证器将需要重新设置。`))return;setBusy(true);setError("");try{showLink(await teamRequest("team_reset",{id:member.id},user.csrf));await refresh();}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  async function copyLink(){try{await navigator.clipboard.writeText(link);setNotice("邀请链接已复制。请通过微信、邮件等渠道单独交给该成员，由本人填写邮箱、设置用户名、密码和验证器。");}catch{setNotice("无法自动复制，请选中邀请链接后手动复制。");}}
  async function loadAudit(more=false){try{const result=await teamRequest<{entries:Audit[]}>("team_audit",more&&audit.length?{before:audit.at(-1)!.id}:{},user.csrf);setAudit(old=>more?[...old,...result.entries]:result.entries);}catch(err){setError((err as Error).message);}}
  return <section className="team-management"><h2>成员与权限</h2><p>角色决定能做什么，访问范围决定能看到哪些事项。人员总库的维护、事项创建、全局历史和备份由管理员管理。</p><p>移除成员时停用其账号，立即撤销登录访问，保留已有业务记录和操作历史。</p>
    {error&&<p className="admin-alert" role="alert">{error}</p>}{notice&&<p className="admin-notice" role="status">{notice}</p>}
    {link&&<div className="invitation-result"><label>一次性邀请链接<input readOnly value={link} onFocus={e=>e.target.select()}/></label><button type="button" className="admin-button" onClick={()=>void copyLink()}>复制邀请链接</button><p className="admin-help">{linkExpires&&<>到期时间：<time dateTime={new Date(linkExpires*1000).toISOString()}>{expiryText(linkExpires)}</time>（{timezone}）。</>}链接 48 小时内有效，仅可使用一次。邀请链接不会自动通过邮件发送；无需提供临时密码，请由成员本人完成设置。</p></div>}
    <div className="team-grid"><section className="panel"><h2>成员</h2><button className="admin-button" disabled={busy} onClick={()=>select(null)}>邀请新成员</button>{members.map(member=><article className="team-member" key={member.id}><strong>{member.name}</strong><span>{member.username?`用户名：${member.username} · `:""}{member.email||"邮箱待本人填写"} · {roleNames[member.role]} · <span className={member.status==="expired"?"team-invitation-expired":undefined}>{member.status?statusNames[member.status]:member.active?"已启用":"已停用"}</span></span>{member.invitation_expires&&<span className="team-member-scope">{member.status==="expired"?"已于":"邀请将于"} <time dateTime={new Date(member.invitation_expires*1000).toISOString()}>{expiryText(member.invitation_expires)}</time> 到期（{timezone}）</span>}<span className="team-member-scope">{member.role==="admin"||member.all_projects?"全部事项 · 自动包含新增事项":member.project_ids.length?`指定事项 · ${member.project_ids.length} 项 · 新增事项需另行授权`:"尚未分配事项"}</span><div><button className="admin-button" disabled={busy} onClick={()=>select(member)}>调整权限</button>{member.id!==user.id&&<button disabled={busy} className="admin-button" onClick={()=>void reset(member)}>{member.status==="invited"||member.status==="expired"?"重新邀请":"重新签发登录邀请"}</button>}</div></article>)}</section>
    <section className="panel"><h2>{selected?`调整 ${selected.name} 的权限`:"新建成员并邀请"}</h2>{!selected&&<p>填写姓名并分配权限，再把生成的链接交给本人。邮箱可以不填，由对方激活时补充。</p>}<form className="team-form" onSubmit={save}><fieldset disabled={busy}>
      {!selected&&<><label>姓名<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><label>邮箱（选填）<input type="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)}/><span className="admin-help">不知道对方邮箱可以留空；填写后，该邀请将使用指定邮箱。</span></label></>}
      <label>成员角色<select aria-describedby="team-role-help" value={role} onChange={e=>setRole(e.target.value as TeamUser["role"])}>{Object.entries(roleNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><span id="team-role-help" className="admin-help">{roleHelp[role]}</span></label>
      {role!=="admin"?<>
        <fieldset className="team-scope-options"><legend>事项访问范围</legend>
          <label className={`team-scope-option${!all?" is-selected":""}`}><input type="radio" name="matter-scope" checked={!all} onChange={()=>setAll(false)}/><span><strong>指定事项</strong><span>仅限勾选的事项。以后新增事项需另行授权。</span></span></label>
          <label className={`team-scope-option${all?" is-selected":""}`}><input type="radio" name="matter-scope" checked={all} onChange={()=>setAll(true)}/><span><strong>全部事项</strong><span>自动包含当前和以后新增的事项，无需逐项授权。</span></span></label>
        </fieldset>
        {all?<p className="admin-help">同时可查看公司动态及共享的人员、对接方资料。</p>:<fieldset className="team-project-picker"><legend>选择可访问的事项</legend>
          <label className="team-search-label">搜索事项<input type="search" placeholder="按事项名称搜索" value={projectSearch} onChange={e=>setProjectSearch(e.target.value)}/></label>
          <div className="team-selection-toolbar"><span role="status">已选 {ids.length} 项</span><div><button type="button" className="admin-button" disabled={!visibleProjects.length} onClick={()=>setIds(current=>[...new Set([...current,...visibleProjects.map(project=>project.id)])])}>{projectSearch.trim()?"选中搜索结果":"选中当前全部"}</button><button type="button" className="admin-button" disabled={!ids.length} onClick={()=>setIds([])}>清空选择</button></div></div>
          <div className="team-project-list">{visibleProjects.map(project=><label className="team-check" key={project.id}><input type="checkbox" checked={ids.includes(project.id)} onChange={e=>setIds(e.target.checked?[...ids,project.id]:ids.filter(id=>id!==project.id))}/>{project.name}</label>)}{!visibleProjects.length&&<p className="admin-help">{projectChoices.length?"没有找到匹配的事项。":"暂无可选事项；新增事项后可在此分配。"}</p>}</div>
          <p className="admin-help">“选中当前全部”只勾选现有事项，以后新增的事项仍需另行授权。跨事项附件需要具备其全部关联事项的权限。</p>
        </fieldset>}
      </>:<p className="admin-notice">管理员始终管理全部事项，自动包含以后新增的事项。</p>}
      {selected&&<label className="team-check"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>启用账号</label>}
      <section className="team-permission-summary" aria-labelledby="team-permission-summary-title"><h3 id="team-permission-summary-title">权限预览</h3>{selected&&!active?<p>保存后，账号将处于停用状态，不能访问工作台；业务记录和历史仍会保留。</p>:<><dl><div><dt>可操作</dt><dd>{roleHelp[role]}</dd></div><div><dt>可访问</dt><dd>{fullAccess?"全部事项":ids.length?`已选的 ${ids.length} 个事项`:"尚未分配事项"}</dd></div><div><dt>以后新增事项</dt><dd>{fullAccess?"自动获得访问权限":"需要管理员另行授权"}</dd></div></dl>{!fullAccess&&!ids.length&&<p className="admin-help">可以完成账号激活，但暂时不能查看业务事项。</p>}</>}</section>
      <button className="admin-button admin-primary" type="submit">{busy?"正在保存…":selected?"保存权限":"生成邀请链接"}</button>
    </fieldset></form></section></div>
    <section className="panel"><h2>操作记录</h2><button className="admin-button" onClick={()=>void loadAudit()}>查看 / 刷新</button><p>操作账号记录实际录入者，与业务记录中的会议参与人分别维护。“开始”后没有完成记录的操作，需要检查执行结果。</p><div className="team-audit">{audit.map(item=><p key={item.id}><time>{new Date(item.at*1000).toLocaleString("zh-CN")}</time> · {item.actor_name} · {actionNames[item.action]||"账号操作"} · {{started:"开始",success:"完成",failed:"失败"}[item.outcome]||item.outcome} {item.target}</p>)}</div>{audit.length>=100&&<button className="admin-button" onClick={()=>void loadAudit(true)}>更早记录</button>}</section>
  </section>;
}
