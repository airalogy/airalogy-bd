import assert from "node:assert/strict";
import {createHmac,randomBytes} from "node:crypto";
import {spawn,spawnSync} from "node:child_process";
import {cpSync,mkdtempSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import net from "node:net";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {httpFetch} from "./http-client.mjs";
import {exerciseIntake} from "./intake-http.mjs";
const root=fileURLToPath(new URL("..",import.meta.url));
const cache=process.env.BD_TEST_CACHE||path.join(root,".uv-cache");
function otp(secret){
 const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",bits=[...secret.replace(/=/g,"")].map(c=>alphabet.indexOf(c).toString(2).padStart(5,"0")).join("");
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const hash=createHmac("sha1",Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)))).update(counter).digest();
 return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1000000).padStart(6,"0");
}
test("MCP business intake preserves explicit scope, atomicity, review, uploads, history and replay protection",async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),"bd-intake-http-")),content=path.join(directory,"content");
 cpSync(path.join(root,"fixtures/demo/content"),content,{recursive:true});symlinkSync(process.env.BD_TEST_RUNTIME||path.join(root,".airalogy-bd"),path.join(directory,".airalogy-bd"),"dir");symlinkSync(cache,path.join(directory,".uv-cache"),"dir");
 const initial=spawnSync("uv",["run","--locked","--cache-dir",cache,path.join(root,"scripts/workspace_service.py"),"--content-dir",content],{input:JSON.stringify({action:"account_init",email:"admin@example.invalid",name:"管理员"}),encoding:"utf8"});
 assert.equal(initial.status,0,initial.stderr);const invitation=JSON.parse(initial.stdout).result;
 const probe=net.createServer();await new Promise(r=>probe.listen(0,"127.0.0.1",r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const base=`http://127.0.0.1:${port}`,publicHost="bd.intake.invalid",origin=`https://${publicHost}`;
 const server=spawn(process.execPath,[path.join(root,"bin/bd.mjs"),"start","--port",String(port)],{cwd:directory,env:{...process.env,BD_MODE:"server",BD_PUBLIC_URL:origin,BETTER_AUTH_SECRET:randomBytes(32).toString("hex")},stdio:["ignore","pipe","pipe"]});
 let output="";server.stdout.on("data",v=>output+=v);server.stderr.on("data",v=>output+=v);
 const request=(route,body,member,headers={})=>httpFetch(base+route,{method:body?"POST":"GET",headers:{Host:publicHost,"X-Real-IP":member?.ip||"192.0.2.1",...(body?{"Content-Type":"application/json",Origin:origin}:{}),...(member?{Cookie:member.cookie,"X-BD-CSRF":member.user.csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const okay=async response=>{assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.ok,true,JSON.stringify(body));return body.result;};
 const cookies=response=>response.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
 let count=10;
 const join=async(token,email)=>{
   const ip=`192.0.2.${count++}`;
   const accepted=await request("/api/auth",{action:"auth_accept",token,email,username:email.split("@")[0],password:"member secure password"},null,{"X-Real-IP":ip});await okay(accepted);
   const pending={cookie:cookies(accepted),user:{csrf:""},ip};
   const setup=await okay(await request("/api/auth",{action:"auth_setup",password:"member secure password"},pending));
   const verified=await request("/api/auth",{action:"auth_verify",code:otp(setup.secret)},pending);return {...await okay(verified),cookie:cookies(verified),ip};
 };
 try{
   for(let i=0;i<160&&!output.includes("Ready");i++)await new Promise(r=>setTimeout(r,100));assert.match(output,/Ready/);
   const admin=await join(invitation.token,"admin@example.invalid");
   const invite=async(role)=>okay(await request("/api/auth",{action:"team_invite",name:role,email:`${role}@example.invalid`,role,all_projects:false,project_ids:["project-demo-partnership"],remote_allowed:true},admin));
   const editor=await join((await invite("editor")).token,"editor@example.invalid"),viewer=await join((await invite("viewer")).token,"viewer@example.invalid");
   await exerciseIntake({directory,base,request,okay,admin,editor,viewer,publicHost});
 }finally{
   server.kill("SIGTERM");await new Promise(r=>server.once("exit",r));rmSync(directory,{recursive:true,force:true});
 }
});
