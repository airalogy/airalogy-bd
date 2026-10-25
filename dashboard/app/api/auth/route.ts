import { invokeWorkspace } from "../../lib/workspace-server";
import { authorizedRequest, boundedBody, denied, privateHeaders, requestSession, serverMode, serviceResponse, trustedRequest } from "../../lib/server-auth";
import { getAuthProvider } from "../../lib/auth-provider";
import { APIError } from "better-auth/api";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const publicActions=["auth_login","auth_invite_info","auth_accept","auth_setup","auth_verify"];

function updatedCookies(request:Request,response:Response) {
  const jar=new Map((request.headers.get("cookie")||"").split(";").filter(Boolean).map(value=>{
    const [key,...rest]=value.trim().split("=");return [key,rest.join("=")];
  }));
  for(const value of response.headers.getSetCookie()) {
    const [key,...rest]=value.split(";")[0].split("=");
    if(/Max-Age=0(?:;|$)/i.test(value))jar.delete(key);else jar.set(key,rest.join("="));
  }
  return [...jar].map(([key,value])=>`${key}=${value}`).join("; ");
}
async function authentication(input:Record<string,unknown>,request:Request) {
  const provider=await getAuthProvider();
  let route="",body:Record<string,unknown>={};
  if(input.action==="auth_accept") {
    const created=await provider.accept(input.token,input.password);
    route="/sign-in/email";body={email:created.email,password:input.password,rememberMe:true};
  } else if(input.action==="auth_login") {
    route="/sign-in/email";body={email:String(input.email||"").trim().toLowerCase(),password:input.password,rememberMe:true};
  } else if(input.action==="auth_verify") {
    route="/two-factor/verify-totp";body={code:input.code,trustDevice:false};
  } else if(input.action==="auth_setup") {
    const session=await provider.providerSession(requestSession(request));
    const member=session && provider.member(session.user.memberId);
    if(!session || !member?.active || member.credential_revision!==session.user.credentialRevision || member.revision!==session.session.permissionRevision || session.user.twoFactorEnabled) return denied("请重新登录后设置验证器。",401);
    const pending=provider.db.prepare("SELECT 1 FROM ba_two_factor WHERE userId=?").get(session.user.id);
    route=pending?"/two-factor/get-totp-uri":"/two-factor/enable";
    body={password:input.password,method:"totp"};
  } else if(input.action==="auth_logout") route="/sign-out";
  else return denied();
  const response=await provider.handle(route,body,request);
  const data=await response.json();
  if(!response.ok) return Response.json({ok:false,code:response.status===429?"rate_limited":"unauthenticated",error:response.status===429?"尝试次数过多，请稍后重试。":"账号信息或验证码不正确；邀请失效时请联系管理员。"},{status:response.status,headers:privateHeaders});
  const headers=new Headers(privateHeaders);
  for(const value of response.headers.getSetCookie()) headers.append("Set-Cookie",value);
  let result:Record<string,unknown>;
  if(input.action==="auth_verify") {
    const cookie=updatedCookies(request,response);
    const verified=await invokeWorkspace({action:"auth_session"},cookie);
    if(!verified.ok)return serviceResponse(verified);
    const identity=verified.result as {id:string};
    provider.audit(identity.id,"account.login");
    result={user:verified.result};
  } else if(input.action==="auth_setup") {
    result={otp_uri:data.totpURI,secret:new URL(data.totpURI).searchParams.get("secret")};
  } else if(input.action==="auth_logout") result={signed_out:true};
  else result={step:data.twoFactorRedirect?"verify":"setup"};
  return Response.json({ok:true,result},{headers});
}
export async function GET(request:Request) {
  if(!serverMode() || !trustedRequest(request)) return denied();
  return serviceResponse(await invokeWorkspace({action:"auth_session"},requestSession(request)));
}
export async function POST(request:Request) {
  if(!serverMode() || !trustedRequest(request,true) || !request.headers.get("content-type")?.startsWith("application/json")) return denied();
  try {
    const input=JSON.parse(new TextDecoder().decode(await boundedBody(request,16000)));
    if(!input || ![...publicActions,"auth_logout","team_list","team_invite","team_update","team_reset","team_audit"].includes(input.action)) return denied();
    if(!publicActions.includes(input.action)) {
      const access=await authorizedRequest(request,true);
      if(access instanceof Response) return access;
    }
    if(input.action==="auth_invite_info" || input.action.startsWith("team_")) return serviceResponse(await invokeWorkspace(input,requestSession(request)));
    return await authentication(input,request);
  } catch(error) {
    const status=error instanceof RangeError?413:error instanceof APIError?(typeof error.statusCode==="number"?error.statusCode:400):400;
    return Response.json({ok:false,code:status===401?"unauthenticated":"invalid",error:status===401?"邀请或登录已失效，请重试或联系管理员。":"账号操作未完成，请检查输入后重试。"},{status,headers:privateHeaders});
  }
}
