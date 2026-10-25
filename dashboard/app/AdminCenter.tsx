"use client";
import Link from "next/link";
import AccountBar from "./AccountBar";
import AiSettings from "./AiSettings";
import AiUsage from "./AiUsage";
import BackupSettings from "./BackupSettings";
import TeamManagement from "./TeamManagement";
import RemoteAccess from "./RemoteAccess";
import type { TeamUser } from "./lib/team-client";
import type { Project } from "./lib/types";

const sections = { members: "成员与权限", ai: "AI 设置", usage: "用量与费用", remote: "远程接入", backup: "备份" };
type Section = keyof typeof sections;
export default function AdminCenter({ user, projects, timezone, unavailable, initialSection, dates }: {
  user: TeamUser | null; projects: Pick<Project, "id" | "name">[]; timezone: string; unavailable: boolean; initialSection?: string; dates: { from: string; to: string };
}) {
  const section: Section = initialSection && Object.hasOwn(sections, initialSection) ? initialSection as Section : user ? "members" : "ai";
  return <>
    {user ? <AccountBar user={user} management /> : <div className="team-bar"><span>本机使用者 · 管理权限</span><Link className="admin-button" href="/">返回工作台</Link></div>}
    <main className="page-shell admin-center">
      <header><div className="eyebrow">仅管理员可访问</div><h1>管理中心</h1><p>管理成员访问权限、AI 服务、使用预算与备份。</p></header>
      {!user && <p className="admin-notice">当前为本机单人模式，由本机使用者管理设置。团队模式启用后，仅管理员账号可以进入本页面。</p>}
      {unavailable && <p className="admin-alert" role="alert">工作区资料暂时不可用，事项列表未能加载，请先检查工作区。</p>}
      <nav className="admin-center-nav" aria-label="管理中心功能">{Object.entries(sections).map(([key, label]) => <Link key={key} href={`/admin?section=${key}`} aria-current={section === key ? "page" : undefined}>{label}</Link>)}</nav>
      {section === "members" && (user ? <TeamManagement user={user} projects={projects} /> : <section className="panel admin-center-panel"><h2>成员与权限</h2><p>成员邀请、停用账号和事项授权在团队模式中提供。本机单人模式无需创建账号。</p></section>)}
      {section === "ai" && <AiSettings />}
      {section === "usage" && <section className="panel admin-center-panel"><h2>AI 用量与费用</h2><AiUsage initialFrom={dates.from} initialTo={dates.to} /></section>}
      {section === "backup" && <BackupSettings timezone={timezone} onChanged={() => {}} />}
      {section === "remote" && (user ? <RemoteAccess user={user} manage /> : <section className="panel admin-center-panel"><h2>Codex 远程接入</h2><p>远程接入仅在配置了账号和 HTTPS 的团队模式中提供。</p></section>)}
    </main>
  </>;
}
