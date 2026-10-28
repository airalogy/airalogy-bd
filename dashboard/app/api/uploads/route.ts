import { invokeWorkspace } from "../../lib/workspace-server";
import { authorizedRequest, boundedBody, denied, privateHeaders, serviceResponse } from "../../lib/server-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const access = await authorizedRequest(request, true);
  if (access instanceof Response) return access;
  if (access.user?.role === "viewer") return denied();
  try {
    const type = request.headers.get("content-type") || "";
    if (type.startsWith("multipart/form-data")) {
      const raw = await boundedBody(request, 50 * 1024 * 1024 + 128 * 1024);
      const form = await new Response(raw, {headers:{"Content-Type":type}}).formData();
      const file = form.get("file"), project = form.get("project_id");
      if (!(file instanceof File) || !file.size || file.size > 50 * 1024 * 1024 || typeof project !== "string") return denied("请选择有效文件和事项。", 400);
      return serviceResponse(await invokeWorkspace({action:"upload_stage", project_id:project, filename:file.name, data:Buffer.from(await file.arrayBuffer()).toString("base64")}, access.session));
    }
    if (!type.startsWith("application/json")) return denied();
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 2000)));
    if (input.action !== "upload_discard") return denied();
    return serviceResponse(await invokeWorkspace({action:"upload_discard", upload_id:input.upload_id}, access.session));
  } catch (error) {
    return Response.json({ok:false,code:error instanceof RangeError?"too_large":"invalid",error:"上传未完成，请检查文件大小和格式后重试。"},{status:error instanceof RangeError?413:400,headers:privateHeaders});
  }
}
