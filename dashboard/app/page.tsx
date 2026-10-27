import LiveDashboard from "./LiveDashboard";
import RecoveryDashboard from "./RecoveryDashboard";
import { loadDashboardData } from "./lib/server-data";
import {currentSession,serverMode} from "./lib/server-auth";
import {redirect} from "next/navigation";
import Link from "next/link";
import AccountBar from "./AccountBar";
import TeamWorkspace from "./TeamWorkspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session=serverMode()?await currentSession():null;
  if(serverMode()&&!session) redirect("/login");
  const dashboardData = await loadDashboardData().catch(() => null);
  if(session&&dashboardData) return <TeamWorkspace data={dashboardData} user={session.user}/>;
  if(session&&session.user.role!=="admin") return <><AccountBar user={session.user}/><main className="page-shell"><h1>资料暂时不可用</h1><p>请联系管理员检查工作区。</p><Link href="/">重新加载</Link></main></>;
  return <><AccountBar user={session?.user || null} workspace={dashboardData?.workspace}/>{dashboardData?<LiveDashboard initialData={dashboardData}/>:<RecoveryDashboard/>}</>;
}
