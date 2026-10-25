"use client";
import { redirect } from "next/navigation";
import { workspaceRequest } from "./workspace-client";
import type { WorkspaceResponse } from "./workspace-types";

export async function aiRequest<T>(input?: Record<string, unknown>, action?: "settings"): Promise<T> {
  const csrf = input ? (await workspaceRequest<WorkspaceResponse>("workspace")).csrf : "";
  const response = await fetch(action ? `/api/ai?action=${action}` : "/api/ai", { method: input ? "POST" : "GET", cache: "no-store", ...(input ? { headers: { "Content-Type": "application/json", "X-BD-CSRF": csrf }, body: JSON.stringify(input) } : {}) });
  const result = await response.json();
  if (response.status === 401) redirect("/login");
  if (!response.ok || !result.ok) throw new Error(result.error || "AI 请求未完成。");
  return result.result;
}
export { initialDates } from "./ai-dates";
