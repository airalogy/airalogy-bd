import { authorizedRequest, boundedBody, denied, serverMode, serviceResponse } from "../../lib/server-auth";
import { invokeWorkspace } from "../../lib/workspace-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!serverMode()) return denied("远程接入仅在团队模式中提供。", 404);
  const access = await authorizedRequest(request);
  if (access instanceof Response) return access;
  const operation = new URL(request.url).searchParams.get("action") || "status";
  if (!["status", "settings", "drafts", "pending"].includes(operation)) return denied();
  return serviceResponse(await invokeWorkspace({ action: "remote_browser", operation }, access.session));
}
export async function POST(request: Request) {
  if (!serverMode()) return denied("远程接入仅在团队模式中提供。", 404);
  const access = await authorizedRequest(request, true);
  if (access instanceof Response) return access;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return denied();
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4000)));
    if (!input || typeof input !== "object" || !["configure", "grant", "issue", "revoke", "confirm", "reject"].includes(input.operation)) return denied();
    return serviceResponse(await invokeWorkspace({ ...input, action: "remote_browser" }, access.session));
  } catch (error) {
    return serviceResponse({ ok: false, code: error instanceof RangeError ? "too_large" : "invalid", error: "远程管理请求格式无效。" });
  }
}
