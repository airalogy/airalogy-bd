import { invokeWorkspace } from "../../lib/workspace-server";
import { authorizedRequest, boundedBody, denied, serviceResponse, serverMode, privateHeaders } from "../../lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const access=await authorizedRequest(request);
  if(access instanceof Response) return access;
  const parameters=Object.fromEntries(new URL(request.url).searchParams);
  if(!["workspace","record","history","compare","historical","backup_status"].includes(parameters.action)) return denied();
  const result=await invokeWorkspace(parameters,access.session);
  if(result.ok && parameters.action==="workspace" && !serverMode()) (result.result as Record<string,unknown>).csrf=process.env.BD_CSRF_TOKEN || "";
  return serviceResponse(result);
}
export async function POST(request:Request) {
  const access=await authorizedRequest(request,true);
  if(access instanceof Response) return access;
  if(!request.headers.get("content-type")?.startsWith("application/json")) return denied();
  try {
    const input=JSON.parse(new TextDecoder().decode(await boundedBody(request,1_000_000)));
    if(!["save","restore","checkpoint","backup_config","backup_now"].includes(input.action)) return denied();
    return serviceResponse(await invokeWorkspace(input,access.session));
  } catch(error) {return Response.json({ok:false,code:error instanceof RangeError?"too_large":"invalid",error:"无法读取本次保存内容，或内容超过大小限制。"},{status:error instanceof RangeError?413:400,headers:privateHeaders});}
}
