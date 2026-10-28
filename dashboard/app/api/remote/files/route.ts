import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { invokeWorkspace } from "../../../lib/workspace-server";
import { authorizedRequest, privateHeaders, serviceResponse } from "../../../lib/server-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const access = await authorizedRequest(request);
  if (access instanceof Response) return access;
  const query = new URL(request.url).searchParams;
  const result = await invokeWorkspace({action:"remote_browser",operation:"attachment",draftId:query.get("draft_id"),uploadId:query.get("upload_id")}, access.session);
  if (!result.ok) return serviceResponse(result);
  const file = result.result as {path:string;filename:string;size:number};
  const name = encodeURIComponent(file.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
  return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, {headers:{...privateHeaders,
    "Content-Type":"application/octet-stream", "Content-Length":String(file.size), "Content-Disposition":`attachment; filename*=UTF-8''${name}`,
    "Content-Security-Policy":"sandbox; default-src 'none'; frame-ancestors 'self'", "Cross-Origin-Resource-Policy":"same-origin"}});
}
