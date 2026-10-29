import {SettingsStatus} from "./SettingsUI";

type ScopeValue = {all:boolean;projects:{id:string;name:string}[]};
type AuditValue = string | ScopeValue;
export type Audit = {
  id:number;at:number;actor_id:string;actor_name:string;action:string;target:string;outcome:string;
  subject:{id:string;name:string;username:string|null;source:"recorded"|"current"}|null;
  changes:{field:string;label:string;before:AuditValue|null;after:AuditValue}[]|null;
  note:string;
};
const actionNames:Record<string,string>={
  "account.invite":"邀请成员","account.activate":"激活账号","account.login":"登录","account.username":"设置用户名","account.email_verified":"验证邮箱",
  "account.permissions":"调整权限","account.reset":"重新签发登录邀请","remote.grant":"允许外部 AI 工具","remote.ungrant":"取消外部 AI 工具权限",
  "remote.allow_intake":"授权外部工具维护业务档案","remote.prepare_intake":"外部工具准备业务录入","remote.submit_intake":"外部工具提交业务录入草稿","remote.save_intake":"外部工具正式录入业务资料","remote.search_entities":"外部工具查询人员及对接方","remote.read_entity":"外部工具读取业务档案","remote.discard_intake":"外部工具丢弃录入方案",
  "remote.configure":"调整外部 AI 全局开关","remote.issue":"生成个人接入凭据","remote.issue_direct":"生成可直接保存的接入凭据","remote.revoke":"撤销接入凭据",
  "remote.search_matters":"外部工具查询事项","remote.read_matter":"外部工具读取事项","remote.read_progress":"外部工具读取进展",
  "remote.submit_draft":"外部工具提交草稿","remote.confirm":"确认修改草稿","remote.reject":"驳回修改草稿","remote.save_progress":"外部工具直接保存进展",
  save:"保存资料",file_save:"更新附件",restore:"恢复资料",backup_config:"调整备份",backup_now:"立即备份",file_backup:"导出完整备份",
};
const memberActions = new Set(["account.invite","account.permissions","account.reset","remote.grant","remote.ungrant"]);
function valueText(value:AuditValue,withIds=false):string {
  if(typeof value==="string")return value;
  if(value.all)return "全部事项（自动包含新增事项）";
  return value.projects.length?`指定事项：${value.projects.map(project=>withIds?`${project.name}（${project.id}）`:project.name).join("、")}`:"未分配事项";
}
export default function AuditEntries({entries,timezone}:{entries:Audit[];timezone:string}) {
  const date=new Intl.DateTimeFormat("zh-CN",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  return <ol className="team-audit" aria-label="操作记录列表">{entries.map(item=><li className="audit-entry" key={item.id}>
    <div className="audit-entry-heading"><h3>{item.subject?<><strong>{item.subject.name}</strong>{item.subject.username&&<span className="audit-username">@{item.subject.username}</span>}<span className="audit-action">{actionNames[item.action]||item.action}</span></>:actionNames[item.action]||item.action}</h3><SettingsStatus tone={item.outcome==="success"?"success":item.outcome==="failed"?"warning":"neutral"}>{{started:"开始",success:"完成",failed:"失败"}[item.outcome]||item.outcome}</SettingsStatus></div>
    <p className="audit-meta">操作人：{item.actor_name} · <time dateTime={new Date(item.at*1000).toISOString()}>{date.format(new Date(item.at*1000))}</time></p>
    {!!item.changes?.length&&<dl className="audit-changes">{item.changes.map(change=>{
      const sameName=change.before!==null&&typeof change.before!=="string"&&typeof change.after!=="string"&&valueText(change.before)===valueText(change.after);
      return <div key={change.field}><dt>{change.label}</dt><dd>{change.before!==null?<><span className="audit-before">{valueText(change.before,sameName)}</span><span className="audit-arrow" aria-label="变更为">→</span></>:null}<span className="audit-after">{valueText(change.after,sameName)}</span></dd></div>;
    })}</dl>}
    {item.changes===null&&memberActions.has(item.action)&&<p className="audit-note">当时未记录变更明细，无法还原修改前后内容。{!item.subject&&"目标成员已无法关联，请展开记录详情查看编号。"}</p>}
    {item.changes?.length===0&&item.action==="account.permissions"&&<p className="audit-note">角色、事项范围和外部 AI 权限未变化。</p>}
    {item.note&&<p className="audit-note">{item.note}</p>}
    {item.subject?.source==="current"&&<p className="audit-note">成员名称按当前账号显示。</p>}
    <details className="audit-technical"><summary>记录详情</summary><dl><div><dt>记录编号</dt><dd>{item.id}</dd></div><div><dt>操作账号 ID</dt><dd>{item.actor_id}</dd></div>{item.target&&<div><dt>{item.subject?"目标成员 ID":"目标编号"}</dt><dd>{item.target}</dd></div>}{item.changes?.filter(change=>change.field==="scope").map(change=><div key={change.field}><dt>事项名称与编号</dt><dd>{change.before!==null&&<>{valueText(change.before,true)} → </>}{valueText(change.after,true)}</dd></div>)}</dl></details>
  </li>)}</ol>;
}
