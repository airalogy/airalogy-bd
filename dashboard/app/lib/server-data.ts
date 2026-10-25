import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DashboardData } from "./types";
import { currentSession, serverMode } from "./server-auth";
import { invokeWorkspace } from "./workspace-server";

function dashboardDataFile() {
  const configuredPath = process.env.BD_DATA_FILE;
  if (!configuredPath) {
    throw new Error(
      "缺少 BD_DATA_FILE。请通过 bd dev、bd build 或 bd start 启动工作台。",
    );
  }
  return path.resolve(configuredPath);
}

export async function loadDashboardData(): Promise<DashboardData> {
  if (serverMode()) {
    const session=await currentSession();
    if (!session) throw new Error("请登录后读取资料。");
    const response=await invokeWorkspace({action:"workspace"},session.token);
    const result=response.result as {data:DashboardData|null}|undefined;
    if(!response.ok || !result?.data) throw new Error("暂时无法读取资料。");
    return result.data;
  }
  const source = await readFile(dashboardDataFile(), "utf8");
  return JSON.parse(source) as DashboardData;
}
