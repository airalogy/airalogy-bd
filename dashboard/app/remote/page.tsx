import { notFound, redirect } from "next/navigation";
import { currentSession, publicOrigin, serverMode } from "../lib/server-auth";
import AccountBar from "../AccountBar";
import RemoteAccess from "../RemoteAccess";

export const dynamic = "force-dynamic";
export default async function RemotePage() {
  if (!serverMode()) notFound();
  const session = await currentSession();
  if (!session) redirect("/login");
  return <><AccountBar user={session.user} management /><main className="page-shell admin-center">
    <RemoteAccess user={session.user} endpoint={`${publicOrigin()}/api/mcp`} />
  </main></>;
}
