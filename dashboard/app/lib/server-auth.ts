import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies, headers as pageHeaders } from "next/headers";
import { invokeWorkspace, isLocalRequest } from "./workspace-server";

export type TeamUser = {id:string;name:string;email:string|null;email_verified?:boolean;username?:string|null;status?:"active"|"email"|"setup"|"invited"|"expired"|"disabled";invitation_expires?:number|null;remote_allowed?:boolean;qa_allowed?:boolean;qa_can_publish?:boolean;role:"admin"|"editor"|"viewer";all_projects:boolean;project_ids:string[];active:boolean;revision:string;csrf:string;expires:number};
export const serverMode = () => {
  if(process.env.BD_MODE && !["local","server"].includes(process.env.BD_MODE)) throw new Error("工作台运行模式配置无效。");
  return process.env.BD_MODE === "server";
};
export function publicOrigin() {
  const url = new URL(process.env.BD_PUBLIC_URL || "");
  const localTest = process.env.BD_ALLOW_INSECURE_LOOPBACK === "1" && url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if ((!localTest && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("请配置有效的 HTTPS 访问地址。");
  return url.origin;
}
export function requestSession(request:Request) {
  return request.headers.get("cookie") || "";
}
export function trustedRequest(request:Request, mutate=false) {
  if(request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    const origin = request.headers.get("origin");
    if(serverMode()) {
      const expected = publicOrigin();
      return request.headers.get("host") === new URL(expected).host && (!mutate || !!origin) && (!origin || origin === expected);
    }
    return isLocalRequest(request) && (!mutate || !!origin) && (!origin || (new URL(origin).host === request.headers.get("host") && isLocalRequest(new Request(origin))));
  } catch { return false; }
}
export const privateHeaders = {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer"};
export function serviceResponse(result:Record<string,unknown>) {
  const statuses:Record<string,number> = {unauthenticated:401,forbidden:403,conflict:409,attachment_conflict:409,duplicate:409,not_found:404,unavailable:503,rate_limited:429,too_large:413};
  return Response.json(result,{status:result.ok ? 200 : statuses[String(result.code)] || 422,headers:privateHeaders});
}
export function denied(message="此请求未获授权。", status=403) {
  return Response.json({ok:false,code:status===401 ? "unauthenticated":"forbidden",error:message},{status,headers:privateHeaders});
}
export async function authorizedRequest(request:Request, mutate=false):Promise<{session:string;user?:TeamUser}|Response> {
  if(!trustedRequest(request,mutate)) return denied();
  let expected = process.env.BD_CSRF_TOKEN || "";
  let session = "";
  let user:TeamUser|undefined;
  if(serverMode()) {
    session=requestSession(request);
    const response=await invokeWorkspace({action:"auth_session"},session);
    if(!response.ok) return serviceResponse(response);
    user=response.result as TeamUser;
    expected=user.csrf;
  }
  if(mutate) {
    const token=request.headers.get("x-bd-csrf") || "";
    if(!expected || Buffer.byteLength(expected)!==Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(expected),Buffer.from(token))) return denied();
  }
  return {session,user};
}
export async function currentSession() {
  if(!serverMode()) return null;
  const headers=await pageHeaders();
  if(headers.get("host") !== new URL(publicOrigin()).host) return null;
  const token=(await cookies()).toString();
  const result=await invokeWorkspace({action:"auth_session"},token);
  return result.ok ? {token,user:result.result as TeamUser} : null;
}
export async function boundedBody(request:Request, maximum:number) {
  if(Number(request.headers.get("content-length"))>maximum) throw new RangeError();
  const reader=request.body?.getReader();
  if(!reader) return new Uint8Array();
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum){await reader.cancel();throw new RangeError();}chunks.push(value);}}
  finally {reader.releaseLock();}
  return new Uint8Array(Buffer.concat(chunks));
}
