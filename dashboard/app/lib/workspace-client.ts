import type { WorkspaceResponse } from "./workspace-types";

export class WorkspaceError extends Error {
  constructor(message: string, public code: string, public details?: unknown) { super(message); }
}

let csrf = "";
export async function workspaceRequest<T>(action: string, input: Record<string, unknown> = {}, mutate = false, signal?: AbortSignal): Promise<T> {
  if (mutate && !csrf) {
    const workspace = await workspaceRequest<WorkspaceResponse>("workspace");
    csrf = workspace.csrf;
  }
  const params = new URLSearchParams({ action });
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const response = await fetch(mutate ? "/api/workspace" : `/api/workspace?${params}`, {
    method: mutate ? "POST" : "GET", cache: "no-store", signal,
    ...(mutate ? { headers: {"Content-Type": "application/json", "X-BD-CSRF": csrf}, body: JSON.stringify({action, ...input}) } : {}),
  });
  const result = await response.json();
  if(response.status===401 && typeof window!=="undefined") window.location.assign("/login");
  if (!response.ok || !result.ok) throw new WorkspaceError(result.error || "操作未完成，请稍后重试。", result.code || "request", result.details);
  if (action === "workspace") csrf = result.result.csrf;
  return result.result as T;
}
