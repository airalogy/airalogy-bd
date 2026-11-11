import {exerciseRecycle} from "./recycle-http.mjs";
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {createHmac,randomBytes} from "node:crypto";
import {cpSync,existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import net from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {httpFetch as fetch} from "./http-client.mjs";
const root=fileURLToPath(new URL("..",import.meta.url));
const cache=process.env.BD_TEST_CACHE||path.join(root,".uv-cache");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function otp(secret,offset=0) {
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits=[...secret.replace(/=/g,"")].map(x=>alphabet.indexOf(x).toString(2).padStart(5,"0")).join("");
  const key=Buffer.from(bits.match(/.{8}/g).map(x=>parseInt(x,2)));
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offset));
  const digest=createHmac("sha1",key).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1)&15)&0x7fffffff)%1000000).padStart(6,"0");
}
const project="project-demo-partnership";

test("recycle bin HTTP enforces roles, CSRF, readback, restoration and MCP boundaries",async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"bd-team-http-"));
  const content=path.join(directory,"content");
  cpSync(path.join(root,"fixtures/demo/content"),content,{recursive:true});
  symlinkSync(process.env.BD_TEST_RUNTIME||path.join(root,".airalogy-bd"),path.join(directory,".airalogy-bd"),"dir");
  symlinkSync(cache,path.join(directory,".uv-cache"),"dir");
  const local=request=>{
    const result=spawnSync("uv",["run","--locked","--cache-dir",cache,path.join(root,"scripts/workspace_service.py"),"--content-dir",content],{input:JSON.stringify(request),encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);const response=JSON.parse(result.stdout);assert.equal(response.ok,true,JSON.stringify(response));return response.result;
  };
  const invitation=local({action:"account_init",email:"admin@example.invalid",name:"管理员"});
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const publicOrigin="https://bd.test.invalid", publicHost="bd.test.invalid";
  const logo=path.join(directory,"company-logo.png");
  const logoBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R5sAAAAASUVORK5CYII=","base64");
  writeFileSync(logo,logoBytes);
  const server=spawn(process.execPath,[path.join(root,"bin/bd.mjs"),"start","--port",String(port)],{cwd:directory,env:{...process.env,BD_MODE:"server",BD_PUBLIC_URL:publicOrigin,BETTER_AUTH_SECRET:randomBytes(32).toString("hex"),BD_BRAND_NAME:"示例团队 BD",BD_BRAND_LOGO_FILE:logo},stdio:["ignore","pipe","pipe"]});
  let output="";server.stdout.on("data",chunk=>output+=chunk);server.stderr.on("data",chunk=>output+=chunk);
  const request=async(route,body,member,headers={})=>fetch(base+route,{method:body?"POST":"GET",headers:{Host:publicHost,"X-Real-IP":member?.ip||"192.0.2.1",...(body?{"Content-Type":"application/json",Origin:publicOrigin}:{}),...(member?{Cookie:member.cookie,"X-BD-CSRF":member.user.csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  const okay=async response=>{assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.ok,true,JSON.stringify(body));return body.result;};
  const cookieJar=(response,existing="")=>{
    const jar=new Map(existing.split(";").filter(Boolean).map(value=>{const [key,...rest]=value.trim().split("=");return [key,rest.join("=")];}));
    for(const value of response.headers.getSetCookie()) {const [key,...rest]=value.split(";")[0].split("=");if(/Max-Age=0(?:;|$)/i.test(value))jar.delete(key);else jar.set(key,rest.join("="));}
    return [...jar].map(([key,value])=>`${key}=${value}`).join("; ");
  };
  let clientNumber=10;
  const join=async(token,providedEmail)=>{
    const ip=`192.0.2.${clientNumber++}`;
    const info=await okay(await request("/api/auth",{action:"auth_invite_info",token}));
    assert.equal(info.secret,undefined);
    const email=info.email||providedEmail;
    const chosen=info.username||email.trim().split("@")[0].replace(/[^a-z0-9._]/gi,"_");
    const accepted=await request("/api/auth",{action:"auth_accept",token,email,username:chosen,password:"member secure password",role:"admin",mfaVerified:true},null,{"X-Real-IP":ip});
    assert.equal((await okay(accepted)).step,"setup");
    const partial={cookie:cookieJar(accepted),user:{csrf:""},ip};
    assert.equal((await request("/api/workspace?action=workspace",null,partial)).status,401);
    assert.equal((await request("/api/files?action=list",null,partial)).status,401);
    const setup=await okay(await request("/api/auth",{action:"auth_setup",password:"member secure password"},partial));
    const response=await request("/api/auth",{action:"auth_verify",code:otp(setup.secret)},partial);
    const session=await okay(response);const cookie=response.headers.get("set-cookie");
    assert.match(cookie,/HttpOnly/);assert.match(cookie,/; Secure/);assert.match(cookie,/__Secure-bd.session_token=/);assert.match(cookie,/SameSite=Lax/i);assert.equal(session.session_token,undefined);
    assert.equal((await request("/api/workspace?action=workspace",null,partial)).status,401);
    assert.equal(session.user.username,chosen.toLowerCase());
    return {...session,cookie:cookieJar(response,partial.cookie),secret:setup.secret,email:email.trim().toLowerCase(),ip};
  };
  try {
    for(let count=0;count<160&&!output.includes("Ready");count++)await delay(100);
    assert.ok(output.includes("Ready"),output);
    const admin=await join(invitation.token);
    const invite=async(role,email)=>okay(await request("/api/auth",{action:"team_invite",email,name:role,role,all_projects:false,project_ids:[project]},admin));
    const viewer=await join((await invite("viewer","viewer@example.invalid")).token);
    const editor=await join((await invite("editor","editor@example.invalid")).token);
    const web=(operation,input={})=>request("/api/remote",{...input,operation},admin);
    const status=await okay(await request("/api/remote?action=settings",null,admin));
    await okay(await web("configure",{enabled:true,revision:status.revision}));
    const direct=await okay(await web("issue",{label:"Recycle boundary test",accessMode:"direct"}));
    const rpc=(method,params={},token)=>request("/api/mcp",{jsonrpc:"2.0",id:1,method,params},null,{Authorization:`Bearer ${token}`,Accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-11-25"});
    const call=async(name,args,token,expected=false)=>{
      const response=await rpc("tools/call",{name,arguments:args},token);
      assert.equal(response.status,200,await response.clone().text());
      const result=(await response.json()).result;
      assert.equal(result.isError,expected,JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    await exerciseRecycle({request,okay,admin,editor,viewer,call,rpc,direct,clearRate:()=>{}});
  } finally {
    server.kill("SIGTERM");await Promise.race([new Promise(resolve=>server.once("close",resolve)),delay(6000)]);
    if(server.exitCode===null)server.kill("SIGKILL");rmSync(directory,{recursive:true,force:true});
  }
});
