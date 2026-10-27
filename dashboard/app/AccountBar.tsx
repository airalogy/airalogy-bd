"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import PendingChangesLink from "./PendingChangesLink";
import { usePathname, useRouter } from "next/navigation";
import { BrandIdentity, BrandLogo } from "./Branding";
import { teamRequest, type TeamUser } from "./lib/team-client";
import type { DashboardData } from "./lib/types";

export default function AccountBar({ user, workspace }: { user: TeamUser | null; workspace?: DashboardData["workspace"] }) {
  const router = useRouter(), pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && menu.current) menu.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  async function logout() {
    try { await teamRequest("auth_logout", {}, user?.csrf || ""); router.replace("/login"); router.refresh(); }
    catch (err) { setError((err as Error).message); }
  }
  return <>
    <header className="app-header">
      <div className="app-header-inner">
        <Link className="app-brand" href="/" aria-label="返回工作台">{workspace?<><BrandLogo/><span><strong>{workspace.short_name}</strong><small>{workspace.workspace_title}</small></span></>:<BrandIdentity/>}</Link>
        <nav className="app-navigation" aria-label="全局导航">
          <Link href="/" aria-current={pathname==="/"?"page":undefined}>工作台</Link>
          {(!user||user.role==="admin")&&<Link href="/admin" aria-current={pathname==="/admin"?"page":undefined}>管理中心</Link>}
        </nav>
        {user?<div className="app-account-actions"><PendingChangesLink key={user.id}/><details className="app-account" ref={menu} onKeyDown={event=>{if(event.key==="Escape"&&menu.current){menu.current.open=false;menu.current.querySelector("summary")?.focus();}}}>
          <summary aria-label={`${user.name}，账号菜单`} className={pathname==="/account"?"is-current":undefined}><span className="app-avatar" aria-hidden="true">{Array.from(user.name)[0]}</span><span className="app-account-name">{user.name}<small>{{admin:"管理员",editor:"编辑成员",viewer:"只读成员"}[user.role]}</small></span><span className="app-account-chevron" aria-hidden="true">⌄</span></summary>
          <div className="app-account-menu"><Link href="/account" onClick={()=>{if(menu.current)menu.current.open=false;}}>我的账号</Link><Link href="/account#ai-tools" onClick={()=>{if(menu.current)menu.current.open=false;}}>AI 工具连接</Link><button type="button" onClick={()=>void logout()}>退出登录</button></div>
        </details></div>:<span className="app-local-label">本机工作区</span>}
      </div>
    </header>
    {error&&<p className="admin-alert" role="alert">{error}</p>}
  </>;
}
