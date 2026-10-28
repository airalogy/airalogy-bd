import { invokeRemote } from "../../../lib/workspace-server";
import { remoteCredential } from "../../../lib/remote-auth";
import { boundedBody, denied, privateHeaders, serviceResponse } from "../../../lib/server-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const token = remoteCredential(request);
  if (token instanceof Response) return token;
  const access = await invokeRemote({tool:"access",arguments:{}}, token);
  if (!access.ok) return serviceResponse(access);
  if (!(access.result as {canDraft:boolean}).canDraft) return denied();
  try {
    const type = request.headers.get("content-type") || "";
    if (!type.startsWith("multipart/form-data")) return denied("请使用 multipart/form-data 上传实际文件。", 415);
    const raw = await boundedBody(request, 50 * 1024 * 1024 + 128 * 1024);
    const form = await new Response(raw, {headers:{"Content-Type":type}}).formData();
    const file = form.get("file"), id = form.get("upload_id");
    if (!(file instanceof File) || !file.size || file.size > 50 * 1024 * 1024 || typeof id !== "string") return denied("请选择有效文件和上传编号。", 400);
    const response = await invokeRemote({tool:"upload_bytes",arguments:{upload_id:id,filename:file.name,data:Buffer.from(await file.arrayBuffer()).toString("base64")}}, token);
    return serviceResponse(response.ok ? response : {ok:false,code:response.code,error:response.error});
  } catch (error) {
    return Response.json({ok:false,code:error instanceof RangeError?"too_large":"invalid",error:"上传未完成，请检查文件大小和格式后重试。"},{status:error instanceof RangeError?413:400,headers:privateHeaders});
  }
}
