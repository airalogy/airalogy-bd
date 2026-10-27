"use client";
import LiveDashboard from "./LiveDashboard";
import AccountBar from "./AccountBar";
import type { TeamUser } from "./lib/team-client";
import type {DashboardData} from "./lib/types";
export default function TeamWorkspace({data,user}:{data:DashboardData;user:TeamUser}) {
  return <><AccountBar user={user} workspace={data.workspace} /><LiveDashboard initialData={data}/></>;
}
