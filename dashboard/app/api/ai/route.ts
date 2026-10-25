import { authorizedRequest, boundedBody, privateHeaders, serviceResponse } from "../../lib/server-auth";
import { AiStore, AiError } from "../../lib/ai-store";
import { aiStatus, aiSettings, aiChat, configureAi, confirmAi, aiUsage } from "../../lib/ai-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  const known = error instanceof AiError;
  return serviceResponse({ ok: false, code: known ? error.code : "invalid", error: known ? error.message : "AI 请求未完成，请检查输入后重试。" });
}
export async function GET(request: Request) {
  const access = await authorizedRequest(request);
  if (access instanceof Response) return access;
  let store: AiStore | undefined;
  try {
    store = new AiStore();
    const params = new URL(request.url).searchParams, action = params.get("action");
    const result = action === "usage" ? aiUsage(store, access, params.get("from"), params.get("to")) : action === "settings" ? aiSettings(store, access) : aiStatus(store, access);
    return serviceResponse({ ok: true, result });
  }
  catch (error) { return failure(error); } finally { store?.close(); }
}
export async function POST(request: Request) {
  const access = await authorizedRequest(request, true);
  if (access instanceof Response) return access;
  let store: AiStore | undefined;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AiError("请使用有效的请求格式。");
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 20000)));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AiError("请求格式无效。");
    store = new AiStore();
    const result = input.action === "configure" ? await configureAi(store, access, input) : input.action === "chat" ? await aiChat(store, access, input) : input.action === "confirm" ? await confirmAi(store, access, input) : null;
    if (result === null) throw new AiError("未知的 AI 操作。");
    return serviceResponse({ ok: true, result });
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ ok: false, code: "too_large", error: "输入过长，请分段整理。" }, { status: 413, headers: privateHeaders });
    return failure(error);
  } finally { store?.close(); }
}
