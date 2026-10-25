import { redirect } from "next/navigation";
import AccountSettings from "../AccountSettings";
import { currentSession, serverMode } from "../lib/server-auth";
export const dynamic = "force-dynamic";
export default async function AccountPage() {
  if (!serverMode()) redirect("/");
  const session = await currentSession();
  if (!session) redirect("/login");
  return <AccountSettings user={session.user} />;
}
