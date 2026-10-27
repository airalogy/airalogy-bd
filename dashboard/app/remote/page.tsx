import { notFound, redirect } from "next/navigation";
import { currentSession, serverMode } from "../lib/server-auth";
import Link from "next/link";
import AccountBar from "../AccountBar";
import RemoteAccess from "../RemoteAccess";

import { loadDashboardData } from "../lib/server-data";
export const dynamic = "force-dynamic";
export default async function RemotePage() {
  if (!serverMode()) notFound();
  const session = await currentSession();
  if (!session) redirect("/login");
  const data = await loadDashboardData().catch(() => null);
  return <><AccountBar user={session.user} workspace={data?.workspace} /><main className="page-shell admin-center">
    <header className="settings-page-head"><div><h1>待确认修改</h1><p>检查外部工具提出的修改，确认后才会写入业务资料。</p></div><Link className="admin-button" href="/account#ai-tools">AI 工具连接</Link></header>
    <RemoteAccess user={session.user} mode="drafts" />
  </main></>;
}
