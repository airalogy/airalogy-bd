"use client";
import Link from "next/link";
import AccountBar from "./AccountBar";
import AiSettings from "./AiSettings";
import AiUsage from "./AiUsage";
import BackupSettings from "./BackupSettings";
import TeamManagement from "./TeamManagement";
import RemoteAccess from "./RemoteAccess";
import {SettingsIcon,SettingsPanelHeader} from "./SettingsUI";
import type {TeamUser} from "./lib/team-client";
import type {Project,DashboardData} from "./lib/types";

const sections={members:{title:"成员与权限",description:"邀请成员 · 分配访问范围"},ai:{title:"AI 设置",description:"内置 AI · 外部工具"},usage:{title:"用量与费用",description:"请求统计 · 费用估算"},backup:{title:"备份",description:"自动备份 · 数据保护"}};
type Section=keyof typeof sections;
export default function AdminCenter({user,projects,timezone,unavailable,initialSection,dates,workspace}:{
  workspace?:DashboardData["workspace"];user:TeamUser|null;projects:Pick<Project,"id"|"name">[];timezone:string;unavailable:boolean;initialSection?:string;dates:{from:string;to:string};
}) {
  const section:Section=initialSection&&Object.hasOwn(sections,initialSection)?initialSection as Section:user?"members":"ai";
  return <>
    <AccountBar user={user} workspace={workspace}/>
    <main className="page-shell admin-center">
      <header className="settings-page-head"><div><h1>管理中心</h1><p>管理团队访问、AI 服务与数据备份。</p></div><span className="settings-access-label"><SettingsIcon name="lock"/>仅管理员可访问</span></header>
      {!user&&<p className="admin-notice">当前为本机单人模式。成员邀请和权限管理在团队模式中提供。</p>}
      {unavailable&&<p className="admin-alert" role="alert">工作区资料暂时不可用，事项列表未能加载，请先检查工作区。</p>}
      <div className="settings-layout">
        <nav className="admin-center-nav" aria-label="管理中心功能">{Object.entries(sections).map(([key,item])=><Link key={key} href={`/admin?section=${key}`} aria-current={section===key?"page":undefined}><SettingsIcon name={key as Section}/><span><strong>{item.title}</strong><small>{item.description}</small></span></Link>)}</nav>
        <div className="settings-content" key={section}>
          {section==="members"&&(user?<TeamManagement user={user} projects={projects} timezone={timezone}/>:<section className="panel admin-center-panel"><SettingsPanelHeader title="成员与权限" description="本机单人模式无需创建账号。"/><p>部署为团队模式后，可在这里邀请成员、停用账号并分配事项权限。</p></section>)}
          {section==="ai"&&<>{user&&<nav className="account-section-nav" aria-label="AI 设置内容"><a href="#builtin-ai">内置 AI 助手</a><a href="#external-ai">外部 AI 工具</a></nav>}<div id="builtin-ai"><AiSettings/></div>{user&&<RemoteAccess user={user} mode="settings"/>}</>}
          {section==="usage"&&<section className="panel admin-center-panel"><SettingsPanelHeader title="用量与费用" description="查看团队 AI 请求、Token 用量和费用估算。"/><AiUsage initialFrom={dates.from} initialTo={dates.to}/></section>}
          {section==="backup"&&<BackupSettings timezone={timezone} onChanged={()=>{}}/>}

        </div>
      </div>
    </main>
  </>;
}
