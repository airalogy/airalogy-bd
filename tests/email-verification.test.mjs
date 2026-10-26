import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {createHmac,randomBytes} from "node:crypto";
import {cpSync,existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import net from "node:net";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {httpFetch as fetch} from "./http-client.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const cache=process.env.BD_TEST_CACHE||path.join(root,".uv-cache");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const password="member secure password";
function otp(secret) {
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits=[...secret.replace(/=/g,"")].map(x=>alphabet.indexOf(x).toString(2).padStart(5,"0")).join("");
  const key=Buffer.from(bits.match(/.{8}/g).map(x=>parseInt(x,2)));
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const digest=createHmac("sha1",key).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1)&15)&0x7fffffff)%1000000).padStart(6,"0");
}
function cookies(response,existing="") {
  const jar=new Map(existing.split(";").filter(Boolean).map(value=>{const [key,...rest]=value.trim().split("=");return [key,rest.join("=")];}));
  for(const value of response.headers.getSetCookie()) {const [key,...rest]=value.split(";")[0].split("=");if(/Max-Age=0(?:;|$)/i.test(value))jar.delete(key);else jar.set(key,rest.join("="));}
  return [...jar].map(([key,value])=>`${key}=${value}`).join("; ");
}

test("optional email verification preserves offline login and enforces ownership without bypassing MFA",{timeout:180000},async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"bd-email-http-")),content=path.join(directory,"content");
  cpSync(path.join(root,"fixtures/demo/content"),content,{recursive:true});
  symlinkSync(process.env.BD_TEST_RUNTIME||path.join(root,".airalogy-bd"),path.join(directory,".airalogy-bd"),"dir");
  symlinkSync(cache,path.join(directory,".uv-cache"),"dir");
  const captured=path.join(directory,"mail.jsonl"),failMail=path.join(directory,"fail-mail"),preload=path.join(directory,"mail-preload.cjs"),loader=path.join(directory,"mail-loader.mjs"),mock=path.join(directory,"mail-mock.mjs");
  // Patch only the isolated test process; production has no alternate transport or bypass flag.
  writeFileSync(mock,`import fs from 'node:fs';export default {createTransport(options){
      if(options.secure!==true||options.tls.rejectUnauthorized!==true||options.logger!==false)throw Error('Unsafe SMTP settings');
      return {async sendMail(message){if(fs.existsSync(${JSON.stringify(failMail)}))throw Error('smtp-private-diagnostic');
        fs.appendFileSync(${JSON.stringify(captured)},JSON.stringify(message)+'\\n');return {accepted:[message.to]};}};
    }};`);
  writeFileSync(loader,`export function resolve(id,context,next){return id==='nodemailer'?{url:${JSON.stringify(new URL('file://'+mock).href)},shortCircuit:true}:next(id,context);}`);
  writeFileSync(preload,`require('node:module').register(${JSON.stringify(new URL('file://'+loader).href)});`);
  const local=(input,env={})=>{
    const result=spawnSync("uv",["run","--locked","--cache-dir",cache,path.join(root,"scripts/workspace_service.py"),"--content-dir",content],{input:JSON.stringify(input),encoding:"utf8",env:{...process.env,...env}});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  const initial=local({action:"account_init",email:"admin@example.invalid",name:"管理员"});assert.equal(initial.ok,true);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`,origin="https://email.test.invalid",secret=randomBytes(32).toString("hex");
  let server,output="",ip=1;
  const start=async(required)=>{
    output="";
    server=spawn(process.execPath,[path.join(root,"bin/bd.mjs"),"start","--port",String(port)],{cwd:directory,env:{...process.env,
      NODE_OPTIONS:`--require ${preload}`,BD_MODE:"server",BD_PUBLIC_URL:origin,BETTER_AUTH_SECRET:secret,
      BD_REQUIRE_EMAIL_VERIFICATION:required?"1":"0",BD_SMTP_HOST:required?"smtp.example.invalid":"",BD_SMTP_PORT:"465",BD_SMTP_USER:"test-smtp",BD_SMTP_PASSWORD:"test-smtp-password",BD_MAIL_FROM:"no-reply@example.invalid",
    },stdio:["ignore","pipe","pipe"]});
    server.stdout.on("data",chunk=>output+=chunk);server.stderr.on("data",chunk=>output+=chunk);
    for(let i=0;i<160&&!output.includes("Ready")&&server.exitCode===null;i++)await delay(100);
    assert.ok(output.includes("Ready"),output);
  };
  const stop=async()=>{if(server&&server.exitCode===null){const done=new Promise(resolve=>server.once("close",resolve));server.kill("SIGTERM");await done;}};
  const request=(body,member,headers={},route="/api/auth")=>fetch(base+route,{method:"POST",headers:{Host:new URL(origin).host,Origin:origin,"Content-Type":"application/json","X-Real-IP":`192.0.2.${ip++}`,...(member?{Cookie:member.cookie,"X-BD-CSRF":member.user?.csrf||""}:{}),...headers},body:JSON.stringify(body)});
  const workspace=(member)=>fetch(base+"/api/workspace?action=workspace",{headers:{Host:new URL(origin).host,...(member?{Cookie:member.cookie}:{})}});
  const okay=async(response)=>{assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.ok,true);return body.result;};
  const messages=()=>existsSync(captured)?readFileSync(captured,"utf8").trim().split("\n").map(JSON.parse):[];
  const mailCode=()=>messages().at(-1).text.match(/\d{6}/)[0];
  let db;
  const clearCooldown=(email)=>db.prepare("DELETE FROM ba_verification WHERE identifier=?").run(`bd-email-send-${email}`);
  try {
    await start(false);
    const accepted=await request({action:"auth_accept",token:initial.result.token,username:"admin",password});
    assert.equal((await okay(accepted)).step,"setup");
    const partial={cookie:cookies(accepted)};
    const setup=await okay(await request({action:"auth_setup",password},partial));
    const verified=await request({action:"auth_verify",code:otp(setup.secret)},partial);
    let admin={...await okay(verified),cookie:cookies(verified,partial.cookie)};
    assert.equal(admin.user.email_verified,false);assert.equal(messages().length,0);
    assert.equal((await workspace(admin)).status,200);
    const remoteStatus=await okay(await fetch(base+"/api/remote?action=settings",{headers:{Host:new URL(origin).host,Cookie:admin.cookie}}));
    await okay(await request({operation:"configure",enabled:true,revision:remoteStatus.revision},admin,{},"/api/remote"));
    await okay(await request({operation:"grant",memberId:admin.user.id,allowed:true},admin,{},"/api/remote"));
    const remote=await okay(await request({operation:"issue",label:"Email policy test",canDraft:false,days:1},admin,{},"/api/remote"));
    const remoteCall=()=>request({jsonrpc:"2.0",id:1,method:"tools/list"},null,{Authorization:`Bearer ${remote.token}`,Accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-11-25"},"/api/mcp");
    assert.equal((await remoteCall()).status,200);
    assert.equal((await request({action:"auth_email_verify",identifier:"admin",code:"000000"})).status,403);
    db=new DatabaseSync(path.join(directory,".bd-auth/accounts.sqlite3"));
    const oldToken=db.prepare("SELECT token FROM ba_session WHERE mfaVerified=1").get().token;
    await stop();await start(true);
    assert.equal((await workspace(admin)).status,401,"Old browser sessions must obey the newly enabled policy\n"+output);
    assert.equal((await remoteCall()).status,401,"Previously issued remote credentials must obey email verification too");
    assert.equal(local({action:"auth_session"},{BD_MODE:"server",BD_REQUEST_WEB:"1",BD_SESSION:oldToken,BD_REQUIRE_EMAIL_VERIFICATION:"1"}).ok,false,"The data service must enforce the policy too");
    assert.equal((await request({action:"auth_login",identifier:"ADMIN",password:"incorrect password"})).status,401);
    assert.equal(messages().length,0);
    const challenge=await request({action:"auth_login",identifier:"ADMIN",password});
    assert.deepEqual(await okay(challenge),{step:"email",email_sent:true});
    assert.equal(challenge.headers.getSetCookie().length,0);
    assert.equal(messages().length,1,output);assert.equal(messages()[0].to,"admin@example.invalid");
    const code=mailCode();
    const stored=db.prepare("SELECT value FROM ba_verification WHERE identifier=?").get("email-verification-otp-admin@example.invalid");
    assert.ok(stored);assert.ok(!stored.value.includes(code));
    assert.equal((await request({action:"auth_login",identifier:"admin@example.invalid",password})).status,429,"Aliases and new IPs cannot bypass the account resend cooldown");
    assert.equal(messages().length,1);
    assert.equal((await request({action:"auth_email_verify",identifier:"admin",code},null,{Origin:"https://evil.invalid"})).status,403);
    assert.notEqual((await request({action:"auth_email_verify",identifier:"admin",code:code==="000000"?"111111":"000000"})).status,200);
    const verifiedEmail=await request({action:"auth_email_verify",identifier:"admin",code});
    assert.deepEqual(await okay(verifiedEmail),{email_verified:true});assert.equal(verifiedEmail.headers.getSetCookie().length,0);
    assert.notEqual((await request({action:"auth_email_verify",identifier:"admin",code})).status,200,"Codes are single use");
    assert.equal((await workspace()).status,401,"Email alone must never grant business access");
    const login=await request({action:"auth_login",identifier:"admin",password});assert.equal((await okay(login)).step,"verify");
    const mfa={cookie:cookies(login)};assert.equal((await workspace(mfa)).status,401);
    const logged=await request({action:"auth_verify",code:otp(setup.secret)},mfa);
    const identity=admin.user.id;admin={...await okay(logged),cookie:cookies(logged,mfa.cookie)};
    assert.equal(admin.user.id,identity);assert.equal(admin.user.email_verified,true);assert.equal((await workspace(admin)).status,200);
    assert.equal((await remoteCall()).status,200,"Email verification preserves remote grants and account identity");
    for(const route of ["/api/identity/sign-in/email-otp","/api/identity/email-otp/send-verification-otp","/api/identity/email-otp/request-email-change"]){
      assert.equal((await fetch(base+route,{method:"POST",headers:{Host:new URL(origin).host,Origin:origin,"Content-Type":"application/json"},body:"{}"})).status,404);
    }
    const invitation=await okay(await request({action:"team_invite",name:"成员",role:"viewer",project_ids:[]},admin));
    assert.equal((await okay(await request({action:"auth_invite_info",token:invitation.token}))).email,null);
    writeFileSync(failMail,"fail");
    const failedSend=await request({action:"auth_accept",token:invitation.token,email:"member@example.invalid",username:"member",password});
    assert.deepEqual(await okay(failedSend),{step:"email",email_sent:false});assert.equal(messages().length,1);
    const pendingMembers=await okay(await request({action:"team_list"},admin));
    assert.equal(pendingMembers.users.find(member=>member.email==="member@example.invalid").status,"email");
    assert.equal((await request({action:"auth_accept",token:invitation.token,username:"member",password})).status,401);
    rmSync(failMail);clearCooldown("member@example.invalid");
    assert.equal((await okay(await request({action:"auth_login",identifier:"member",password}))).step,"email");
    let memberCode=mailCode();
    db.prepare("UPDATE ba_verification SET expiresAt=? WHERE identifier=?").run("2000-01-01T00:00:00.000Z","email-verification-otp-member@example.invalid");
    assert.notEqual((await request({action:"auth_email_verify",identifier:"member",code:memberCode})).status,200,"Expired codes are rejected");
    clearCooldown("member@example.invalid");await okay(await request({action:"auth_login",identifier:"member",password}));memberCode=mailCode();
    for(let i=0;i<5;i++)assert.notEqual((await request({action:"auth_email_verify",identifier:"member",code:memberCode==="000000"?"111111":"000000"})).status,200);
    assert.notEqual((await request({action:"auth_email_verify",identifier:"member",code:memberCode})).status,200,"Exhausted codes remain invalid even from another IP");
    clearCooldown("member@example.invalid");await okay(await request({action:"auth_login",identifier:"member",password}));memberCode=mailCode();
    const memberId=db.prepare("SELECT id FROM users WHERE email=?").get("member@example.invalid").id;
    const replacement=await okay(await request({action:"team_reset",id:memberId},admin));
    assert.notEqual((await request({action:"auth_email_verify",identifier:"member",code:memberCode})).status,200);
    const recovered=await okay(await request({action:"auth_accept",token:replacement.token,username:"member",password}));assert.equal(recovered.step,"email");
    assert.notEqual((await request({action:"auth_email_verify",identifier:"member",code:memberCode})).status,200,"Recovery does not accept codes issued to earlier credentials");
    await okay(await request({action:"auth_email_verify",identifier:"member",code:mailCode()}));
    assert.ok(!output.includes("smtp-private-diagnostic"));assert.ok(!output.includes("test-smtp-password"));
    for(const message of messages())assert.ok(!output.includes(message.text.match(/\d{6}/)[0]));
    await stop();await start(false);
    db.prepare("UPDATE ba_user SET emailVerified=0 WHERE memberId=?").run(identity);
    const ordinary=await okay(await request({action:"auth_login",identifier:"admin",password}));assert.equal(ordinary.step,"verify","Disabling verification restores password + TOTP without mail");
  } finally {await stop();db?.close();rmSync(directory,{recursive:true,force:true});}
});

test("SMTP configuration defaults off, rejects incomplete settings and requires encrypted transport",()=>{
  const result=spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`
    import assert from 'node:assert/strict';
    import {requireEmailVerification,smtpConfiguration,verificationMailer} from './dashboard/app/lib/email-delivery.ts';
    assert.equal(requireEmailVerification({BD_MODE:'server'}),false);
    assert.equal(requireEmailVerification({BD_MODE:'local',BD_REQUIRE_EMAIL_VERIFICATION:'1'}),false);
    assert.equal(requireEmailVerification({BD_MODE:'server',BD_REQUIRE_EMAIL_VERIFICATION:'1'}),true);
    assert.throws(()=>requireEmailVerification({BD_REQUIRE_EMAIL_VERIFICATION:'yes'}));
    assert.throws(()=>smtpConfiguration({}));
    const config={BD_SMTP_HOST:'smtp.example.invalid',BD_SMTP_USER:'test',BD_SMTP_PASSWORD:'test',BD_MAIL_FROM:'no-reply@example.invalid'};
    const implicit=smtpConfiguration(config);assert.equal(implicit.options.secure,true);assert.equal(implicit.options.tls.rejectUnauthorized,true);
    const starttls=smtpConfiguration({...config,BD_SMTP_PORT:'587'});assert.equal(starttls.options.secure,false);assert.equal(starttls.options.requireTLS,true);
    for(const port of ['0','-1','65536','abc','1.5'])assert.throws(()=>smtpConfiguration({...config,BD_SMTP_PORT:port}));
    assert.throws(()=>smtpConfiguration({...config,BD_MAIL_FROM:'a@example.invalid,b@example.invalid'}));
    assert.equal(typeof verificationMailer(config),'function');
  `],{cwd:root,encoding:"utf8"});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
