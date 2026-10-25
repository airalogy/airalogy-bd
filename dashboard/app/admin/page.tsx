import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import AdminCenter from "../AdminCenter";
import { initialDates } from "../lib/ai-dates";
import { currentSession, serverMode, trustedRequest } from "../lib/server-auth";
import { loadDashboardData } from "../lib/server-data";

export const dynamic = "force-dynamic";

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const team = serverMode();
  const session = team ? await currentSession() : null;
  if (team && !session) redirect("/login");
  if (session && session.user.role !== "admin") redirect("/");
  // Local mode deliberately has one owner, but the management page is still loopback-only.
  if (!team && !trustedRequest(new Request("http://localhost/admin", { headers: await headers() }))) notFound();
  const data = await loadDashboardData().catch(() => null);
  if (team && data?.access && data.access.role !== "admin") redirect("/");
  const { section } = await searchParams;
  const timezone = data?.workspace.timezone || "Asia/Shanghai";
  return <AdminCenter user={session?.user || null} projects={data?.projects.map(({ id, name }) => ({ id, name })) || []}
    timezone={timezone} dates={initialDates(timezone)} unavailable={!data} initialSection={section} />;
}
