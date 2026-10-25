"use client";
import {useCallback,useEffect,useState} from "react";
import {teamRequest,type TeamUser} from "./lib/team-client";
import type {Project} from "./lib/types";
import {workspaceRequest} from "./lib/workspace-client";
import type {WorkspaceResponse} from "./lib/workspace-types";
type Audit={id:number;at:number;actor_name:string;action:string;target:string;outcome:string};
const actionNames:Record<string,string>={"account.invite":"邀请成员","account.activate":"激活账号","account.login":"登录","account.permissions":"调整权限","account.reset":"重置登录",save:"保存资料",file_save:"更新附件",restore:"恢复资料",backup_config:"调整备份",backup_now:"立即备份",file_backup:"导出完整备份"};
const roleNames={admin:"管理员",editor:"编辑成员",viewer:"只读成员"};
export default function TeamManagement({user,projects}:{user:TeamUser;projects:Pick<Project,"id"|"name">[]}) {
  const [members,setMembers]=useState<TeamUser[]>([]);
  const [projectChoices,setProjectChoices]=useState(projects);
  const [selected,setSelected]=useState<TeamUser|null>(null);
  const [email,setEmail]=useState("");const [name,setName]=useState("");
  const [role,setRole]=useState<TeamUser["role"]>("viewer");
  const [all,setAll]=useState(false);const [ids,setIds]=useState<string[]>([]);
  const [active,setActive]=useState(true);const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");const [notice,setNotice]=useState("");const [link,setLink]=useState("");
  const [audit,setAudit]=useState<Audit[]>([]);
  const refresh=useCallback(async()=>{const result=await teamRequest<{users:TeamUser[]}>("team_list",{},user.csrf);setMembers(result.users);},[user.csrf]);
  useEffect(()=>{let cancelled=false;teamRequest<{users:TeamUser[]}>("team_list",{},user.csrf).then(result=>{if(!cancelled)setMembers(result.users);}).catch(err=>{if(!cancelled)setError(err.message);});return()=>{cancelled=true;};},[user.csrf]);
  useEffect(()=>{const controller=new AbortController();workspaceRequest<WorkspaceResponse>("workspace",{},false,controller.signal).then(result=>{if(result.data)setProjectChoices(result.data.projects);}).catch(err=>{if(!controller.signal.aborted)setError(err.message);});return()=>controller.abort();},[]);
  function select(member:TeamUser|null){setSelected(member);setEmail(member?.email||"");setName(member?.name||"");setRole(member?.role||"viewer");setAll(member?.all_projects||false);setIds(member?.project_ids||[]);setActive(member?!!member.active:true);setLink("");setError("");setNotice("");}
  function showLink(result:{token:string}){setLink(`${window.location.origin}/join#${result.token}`);setNotice("请将邀请链接交给该成员。链接 48 小时内有效，仅可使用一次。");}
  async function save(event:React.FormEvent){event.preventDefault();setBusy(true);setError("");setNotice("");try{
    const payload={email,name,role,all_projects:all,project_ids:ids,active,id:selected?.id,revision:selected?.revision};
    if(selected){await teamRequest("team_update",payload,user.csrf);setNotice("权限已更新，该成员需要重新登录。");if(selected.id===user.id){window.location.assign("/login");return;}setSelected(null);}
    else showLink(await teamRequest("team_invite",payload,user.csrf));
    await refresh();
  }catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  async function reset(member:TeamUser){if(!window.confirm(`重新签发 ${member.name} 的登录邀请？现有登录会立即失效，原密码和验证器将需要重新设置。`))return;setBusy(true);setError("");try{showLink(await teamRequest("team_reset",{id:member.id},user.csrf));await refresh();}catch(err){setError((err as Error).message);}finally{setBusy(false);}}
  async function loadAudit(more=false){try{const result=await teamRequest<{entries:Audit[]}>("team_audit",more&&audit.length?{before:audit.at(-1)!.id}:{},user.csrf);setAudit(old=>more?[...old,...result.entries]:result.entries);}catch(err){setError((err as Error).message);}}
  return <section className="team-management"><h2>成员与权限</h2><p>管理员可管理全部资料。编辑成员可修改获授权的事项和附件、补充进展；只读成员可浏览及导出获授权资料。人员总库、事项创建、全局历史和备份由管理员管理。</p><p>移除成员时停用其账号，立即撤销登录访问，保留已有业务记录和操作历史。</p>
    {error&&<p className="admin-alert" role="alert">{error}</p>}{notice&&<p className="admin-notice" role="status">{notice}</p>}
    {link&&<label>邀请链接<input readOnly value={link} onFocus={e=>e.target.select()}/></label>}
    <div className="team-grid"><section className="panel"><h2>成员</h2><button className="admin-button" onClick={()=>select(null)}>邀请新成员</button>{members.map(member=><article className="team-member" key={member.id}><strong>{member.name}</strong><span>{member.email} · {roleNames[member.role]} · {member.active?"已启用":"待激活或已停用"}</span><div><button className="admin-button" onClick={()=>select(member)}>调整权限</button>{member.id!==user.id&&<button disabled={busy} className="admin-button" onClick={()=>void reset(member)}>重新签发登录邀请</button>}</div></article>)}</section>
    <section className="panel"><h2>{selected?`调整 ${selected.name} 的权限`:"邀请成员"}</h2><form className="team-form" onSubmit={save}><fieldset disabled={busy}>
      {!selected&&<><label>姓名<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><label>邮箱<input required type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label></>}
      <label>角色<select value={role} onChange={e=>setRole(e.target.value as TeamUser["role"])}>{Object.entries(roleNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {role!=="admin"&&<><label className="team-check"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>全部事项（包括未来新增事项）</label>{!all&&<fieldset><legend>可访问的事项</legend>{projectChoices.map(project=><label className="team-check" key={project.id}><input type="checkbox" checked={ids.includes(project.id)} onChange={e=>setIds(e.target.checked?[...ids,project.id]:ids.filter(id=>id!==project.id))}/>{project.name}</label>)}<p>未选择事项时，该成员不能查看业务事项。跨事项附件需要同时拥有全部关联事项的权限。</p></fieldset>}</>}
      {selected&&<label className="team-check"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>启用账号</label>}
      <button className="admin-button admin-primary" type="submit">{busy?"正在保存…":selected?"保存权限":"生成邀请链接"}</button>
    </fieldset></form></section></div>
    <section className="panel"><h2>操作记录</h2><button className="admin-button" onClick={()=>void loadAudit()}>查看 / 刷新</button><p>操作账号记录实际录入者，与业务记录中的会议参与人分别维护。“开始”后没有完成记录的操作，需要检查执行结果。</p><div className="team-audit">{audit.map(item=><p key={item.id}><time>{new Date(item.at*1000).toLocaleString("zh-CN")}</time> · {item.actor_name} · {actionNames[item.action]||"账号操作"} · {{started:"开始",success:"完成",failed:"失败"}[item.outcome]||item.outcome} {item.target}</p>)}</div>{audit.length>=100&&<button className="admin-button" onClick={()=>void loadAudit(true)}>更早记录</button>}</section>
  </section>;
}
