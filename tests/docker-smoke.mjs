// Optional deployment integration: docker build -t airalogy-bd:test . && node tests/docker-smoke.mjs
// Creates only disposable, randomly named Docker resources and fictional data.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHmac,randomBytes} from "node:crypto";
import {httpFetch as fetch} from "./http-client.mjs";
const prefix="bd-smoke-"+randomBytes(6).toString("hex");
const image=process.env.BD_TEST_IMAGE||"airalogy-bd:test";
const volumes=[prefix+"-workspace",prefix+"-backups",prefix+"-cache"];
const origin="https://bd.container.test.invalid";
const shared=["--init","--read-only","--tmpfs","/tmp:mode=1777,size=256m","--cap-drop","ALL","--security-opt","no-new-privileges:true","--memory","1536m","-v",volumes[0]+":/workspace","-v",volumes[1]+":/backups","-v",volumes[2]+":/opt/bd/.uv-cache","-e","BD_PUBLIC_URL="+origin,"-e","BD_BACKUP_DIRECTORY=/backups","-e","BETTER_AUTH_SECRET="+randomBytes(32).toString("hex")];
const docker=(args,allowFailure=false)=>{const result=spawnSync("docker",args,{encoding:"utf8",timeout:120000,maxBuffer:4000000});if(!allowFailure)assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let base="",member=null;
const request=(route,body,user=member)=>fetch(base+route,{method:body?"POST":"GET",headers:{Host:new URL(origin).host,...(body?{Origin:origin,"Content-Type":"application/json"}:{}),...(user?{Cookie:user.cookie,"X-BD-CSRF":user.user.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
const okay=async response=>{assert.equal(response.status,200,await response.clone().text());const data=await response.json();assert.equal(data.ok,true,JSON.stringify(data));return data.result;};
function otp(secret){const bits=[...secret].map(x=>"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(x).toString(2).padStart(5,"0")).join("");const key=Buffer.from(bits.match(/.{8}/g).map(x=>parseInt(x,2)));const step=Buffer.alloc(8);step.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hash=createHmac("sha1",key).update(step).digest();return String((hash.readUInt32BE(hash.at(-1)&15)&0x7fffffff)%1000000).padStart(6,"0");}
async function start(content){
  docker(["run","-d","--name",prefix,"-p","127.0.0.1::3000",...shared,image,...(content?["start","--content",content,"--hostname","0.0.0.0","--port","3000"]:[])]);
  base="http://"+docker(["port",prefix,"3000/tcp"]);
  for(let i=0;i<120;i++){try{if((await request("/api/health",null,null)).ok)return;}catch{}await pause(250);}
  throw new Error("Container did not start: "+docker(["logs",prefix],true));
}
try {
  docker(["run","--rm",...shared,image,"init","--id","test-company","--name","容器测试公司"]);
  const invitation=docker(["run","--rm",...shared,image,"account-init","--email","admin@example.invalid","--name","测试管理员"]);
  const token=invitation.match(/\/join#([A-Za-z0-9_-]+)/)?.[1];assert.ok(token);
  await start();
  assert.equal(docker(["exec",prefix,"node","-e","process.stdout.write(String(process.getuid()))"]),"10001");
  assert.equal((await request("/api/workspace?action=workspace",null,null)).status,401);
  async function enroll(token) {
    const accepted=await request("/api/auth",{action:"auth_accept",token,password:"container test password"},null);
    assert.equal((await okay(accepted)).step,"setup");
    const partial={cookie:accepted.headers.getSetCookie().filter(x=>!x.includes("Max-Age=0")).map(x=>x.split(";")[0]).join("; "),user:{csrf:""}};
    assert.equal((await request("/api/workspace?action=workspace",null,partial)).status,401);
    const setup=await okay(await request("/api/auth",{action:"auth_setup",password:"container test password"},partial));
    const activated=await request("/api/auth",{action:"auth_verify",code:otp(setup.secret)},partial);
    return {...await okay(activated),cookie:activated.headers.getSetCookie().filter(x=>!x.includes("Max-Age=0")).map(x=>x.split(";")[0]).join("; "),secret:setup.secret};
  }
  member=await enroll(token);
  const data=await okay(await request("/api/workspace?action=workspace"));
  assert.equal(data.data.workspace.name,"容器测试公司");assert.equal(data.data.projects.length,0);
  const backup=await okay(await request("/api/workspace",{action:"backup_now"}));
  assert.equal(backup.error,"");assert.ok(backup.last_success.size>0);
  docker(["restart",prefix]);
  base="http://"+docker(["port",prefix,"3000/tcp"]);
  for(let i=0;i<120;i++){try{if((await request("/api/health",null,null)).ok)break;}catch{}await pause(250);}
  assert.equal((await okay(await request("/api/auth"))).id,member.user.id);
  docker(["stop",prefix]);docker(["rm",prefix]);
  docker(["run","--rm",...shared,image,"restore-backup","--archive",backup.last_success.path,"--destination","/workspace/restored"]);
  await start("/workspace/restored/content");
  assert.equal((await request("/api/auth")).status,401);
  const password=await request("/api/auth",{action:"auth_login",email:"admin@example.invalid",password:"container test password"},null);
  assert.equal((await okay(password)).step,"verify");
  const pending={cookie:password.headers.getSetCookie().filter(x=>!x.includes("Max-Age=0")).map(x=>x.split(";")[0]).join("; "),user:{csrf:""}};
  const login=await request("/api/auth",{action:"auth_verify",code:otp(member.secret)},pending);
  const loggedIn=await okay(login);
  assert.equal(loggedIn.user.id,member.user.id);
  const recovery=docker(["exec",prefix,"node","/opt/bd/bin/bd.mjs","account-recover","--content","/workspace/restored/content","--email","admin@example.invalid"]);
  assert.match(recovery,/\/join#/);
  const recoveredToken=recovery.match(/\/join#([A-Za-z0-9_-]+)/)[1];
  assert.equal((await okay(await request("/api/auth",{action:"auth_invite_info",token:recoveredToken},null))).email,"admin@example.invalid");
  member=await enroll(recoveredToken);
  assert.equal((await okay(await request("/api/workspace?action=workspace"))).data.workspace.name,"容器测试公司");
  console.log("Container smoke passed: non-root, read-only system, invitation/login, empty private workspace, verified backup, restart persistence, isolated restore, revoked sessions and account recovery.");
} finally {
  docker(["rm","-f",prefix],true);
  for(const volume of volumes)docker(["volume","rm",volume],true);
}
