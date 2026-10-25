import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { invokeWorkspace } from "../../lib/workspace-server";
import { authorizedRequest, serverMode, serviceResponse, boundedBody } from "../../lib/server-auth";
import { revealFile } from "../../lib/reveal-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 50 * 1024 * 1024;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function failure(message: string, status = 403) { return Response.json({ ok: false, code: status === 413 ? "too_large" : "invalid", error: message }, { status, headers }); }
const json = serviceResponse;

export async function GET(request: Request) {
  const access = await authorizedRequest(request);
  if (access instanceof Response) return access;
  const invoke = (input: Record<string, unknown>) => invokeWorkspace(input, access.session);
  const query = new URL(request.url).searchParams, action = query.get("action");
  if (action === "list") return json(await invoke({ action: "files" }));
  if (action !== "download" && action !== "backup") return failure("未知资料操作。", 400);
  const result = await invoke({ action: action === "backup" ? "backup_download" : "file_download", id: query.get("id"), version_id: query.get("version_id"), snapshot: query.get("snapshot") });
  if (!result.ok) return json(result);
  const file = result.result as { path: string; filename: string; size: number };
  const extension = file.filename.split(".").pop()?.toLowerCase();
  const previewTypes: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
  const inline = query.get("preview") === "1" && extension && extension in previewTypes;
  const filename = encodeURIComponent(file.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
  return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, { headers: {
    ...headers, "Content-Type": inline ? previewTypes[extension!] : "application/octet-stream",
    "Content-Length": String(file.size), "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
    "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'", "Cross-Origin-Resource-Policy": "same-origin",
  } });
}

export async function POST(request: Request) {
  const access = await authorizedRequest(request, true);
  if (access instanceof Response) return access;
  const invoke = (input: Record<string, unknown>) => invokeWorkspace(input, access.session);
  try {
    const type = request.headers.get("content-type") || "";
    if (type.startsWith("multipart/form-data")) {
      const raw = await boundedBody(request, MAX_BYTES + 128 * 1024);
      const form = await new Response(raw, { headers: { "Content-Type": type } }).formData();
      const file = form.get("file"), metadata = form.get("metadata");
      if (!(file instanceof File) || typeof metadata !== "string" || metadata.length > 64000) return failure("请选择文件并填写资料信息。", 400);
      if (!file.size || file.size > MAX_BYTES) return failure("单个文件须为非空文件，且不超过 50 MB。", 413);
      const input = JSON.parse(metadata);
      return json(await invoke({ action: "file_save", operation: "upload", id: input.id, revision: input.revision, payload: { ...input.payload, filename: file.name, data: Buffer.from(await file.arrayBuffer()).toString("base64") } }));
    }
    if (!type.startsWith("application/json")) return failure("无法读取本次操作。", 400);
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1_000_000)));
    if (input.action === "file_reveal") {
      if (serverMode()) return failure("服务器上的文件请使用下载或预览。");
      const location = await invoke({ action: "file_location", id: input.id, version_id: input.version_id, record_id: input.record_id });
      if (!location.ok) return json(location);
      return json(await revealFile((location.result as { path: string }).path));
    }
    if (!["file_save", "file_backup"].includes(input.action) || input.operation === "upload") return failure("未知资料操作。", 400);
    return json(await invoke(input));
  } catch (error) {
    return failure(error instanceof RangeError ? "单次上传不能超过 50 MB。" : "无法读取本次文件或表单，请重试。", error instanceof RangeError ? 413 : 400);
  }
}
