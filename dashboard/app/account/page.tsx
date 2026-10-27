import { redirect } from "next/navigation";
import AccountSettings from "../AccountSettings";
import { currentSession, publicOrigin, serverMode } from "../lib/server-auth";
import { loadDashboardData } from "../lib/server-data";
export const dynamic = "force-dynamic";
export default async function AccountPage() {
  if (!serverMode()) redirect("/");
  const session = await currentSession();
  if (!session) redirect("/login");
  const data = await loadDashboardData().catch(() => null);
  return <AccountSettings user={session.user} endpoint={`${publicOrigin()}/api/mcp`} workspace={data?.workspace} />;
}
