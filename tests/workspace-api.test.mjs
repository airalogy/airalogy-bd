import assert from "node:assert/strict";
import {cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import net from "node:net";
import http from "node:http";
import test from "node:test";

const root=fileURLToPath(new URL("..",import.meta.url));
const runtime=process.env.BD_TEST_RUNTIME || path.join(root,".airalogy-bd");
const cache=process.env.BD_TEST_CACHE || path.join(root,".uv-cache");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=12000) {const start=Date.now();while(Date.now()-start<timeout){if(check())return;await delay(150);}assert.fail("Expected observable state did not arrive");}

test("local HTTP saves enforce origin and CSRF, and the watcher archives direct edits",async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"bd-api-test-"));
  const content=path.join(directory,"content");
  cpSync(path.join(root,"fixtures/demo/content"),content,{recursive:true});
  symlinkSync(runtime,path.join(directory,".airalogy-bd"),"dir");
  symlinkSync(cache,path.join(directory,".uv-cache"),"dir");
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,[path.join(root,"bin/bd.mjs"),"start","--port",String(port)],{cwd:directory,stdio:["ignore","pipe","pipe"]});
  let output="";server.stdout.on("data",chunk=>output+=chunk);server.stderr.on("data",chunk=>output+=chunk);
  try {
    await until(()=>output.includes("Ready"));
    const request=async(action,params={})=>{const url=new URL(base+"/api/workspace");url.searchParams.set("action",action);for(const [key,value]of Object.entries(params))url.searchParams.set(key,String(value));const response=await fetch(url);assert.equal(response.status,200);return (await response.json()).result;};
    const initial=await request("workspace");assert.ok(initial.csrf.length>20);
    const historical=await request("historical",{version:initial.status.version});assert.equal(historical.version.version,initial.status.version);assert.equal(historical.data.people.length,initial.data.people.length);
    assert.equal((await fetch(base+"/api/workspace?action=backup_config")).status,403);
    const backupStatus=await request("backup_status");assert.equal(backupStatus.config.enabled,false);
    assert.equal((await fetch(base+"/api/workspace",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify({action:"backup_now"})})).status,403);
    const upload = async (headers = {}) => {
      const form = new FormData();
      form.set("metadata",JSON.stringify({payload:{title:"虚构上传",organization:"示例机构",category:"presentation",project_ids:["project-demo-partnership"],home_counterparty_id:"counterparty-917f1872213b3ab5",status:"unspecified"}}));
      form.set("file",new File(["%PDF-1.4\nexact uploaded bytes"],"讨论材料.pdf",{type:"application/pdf"}));
      return fetch(base+"/api/files",{method:"POST",headers,body:form});
    };
    assert.equal((await upload({Origin:base})).status,403);
    assert.equal((await upload({Origin:"https://untrusted.example","X-BD-CSRF":initial.csrf})).status,403);
    const uploaded=await upload({Origin:base,"X-BD-CSRF":initial.csrf});assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).ok,true);
    const fileIndex=await (await fetch(base+"/api/files?action=list")).json();const file=fileIndex.result.files[0];
    assert.equal(file.records.length,0);assert.equal(file.versions[0].status,"unspecified");
    const fileUrl=base+"/api/files?"+new URLSearchParams({action:"download",id:file.id,version_id:file.versions[0].id});
    const binary=await fetch(fileUrl);assert.equal(binary.status,200);assert.equal(await binary.text(),"%PDF-1.4\nexact uploaded bytes");assert.match(binary.headers.get("content-disposition"),/^attachment;/);
    const filePreview=await fetch(fileUrl+"&preview=1");assert.equal(filePreview.headers.get("content-type"),"application/pdf");assert.match(filePreview.headers.get("content-security-policy"),/sandbox/);await filePreview.arrayBuffer();
    assert.equal((await fetch(fileUrl,{headers:{"Sec-Fetch-Site":"cross-site"}})).status,403);
    assert.equal((await fetch(base+"/api/files?action=download&id=../../people.yaml&version_id=invalid")).status,404);
    const oversized=await new Promise((resolve,reject)=>{const request=http.request({hostname:"127.0.0.1",port,path:"/api/files",method:"POST",headers:{Origin:base,"X-BD-CSRF":initial.csrf,"Content-Type":"multipart/form-data; boundary=test","Content-Length":60*1024*1024}},response=>{response.resume();response.on("end",()=>resolve(response.statusCode));});request.on("error",reject);request.end(Buffer.alloc(60*1024*1024));});assert.equal(oversized,413);
    const person=await request("record",{kind:"person",id:"陈青"});
    const body=JSON.stringify({action:"save",kind:"person",id:"陈青",revision:person.revision,payload:{...person.record,phone:"000-123456"}});
    const send=async(headers,raw=body)=>fetch(base+"/api/workspace",{method:"POST",headers:{"Content-Type":"application/json",...headers},body:raw});
    assert.equal((await send({"X-BD-CSRF":initial.csrf})).status,403);
    assert.equal((await send({Origin:"https://untrusted.example","X-BD-CSRF":initial.csrf})).status,403);
    assert.equal((await send({Origin:base})).status,403);
    const badHost=await new Promise((resolve,reject)=>{const request=http.get({hostname:"127.0.0.1",port,path:"/api/workspace?action=workspace",headers:{Host:"untrusted.example"}},response=>{response.resume();response.on("end",()=>resolve(response.statusCode));});request.on("error",reject);});assert.equal(badHost,403);
    assert.equal((await send({Origin:base,"X-BD-CSRF":initial.csrf},"not-json")).status,400);
    assert.equal((await send({Origin:base,"X-BD-CSRF":initial.csrf}," ".repeat(1_000_001))).status,413);
    const saved=await send({Origin:base,"X-BD-CSRF":initial.csrf});assert.equal(saved.status,200);assert.equal((await saved.json()).ok,true);
    assert.equal((await request("record",{kind:"person",id:"陈青"})).record.phone,"000-123456");
    const statusDir=path.join(directory,".bd-history",readdirSync(path.join(directory,".bd-history"))[0]);
    const peoplePath=path.join(content,"people.yaml");
    writeFileSync(peoplePath,readFileSync(peoplePath,"utf8").replace("demo_chenqing","watcher_demo"));
    // No HTTP or explicit checkpoint call here: this state must come from the watcher.
    await until(()=>JSON.parse(readFileSync(path.join(content,"generated/dashboard.json"),"utf8")).people.find(person=>person.id==="陈青").wechat === "watcher_demo");
    assert.equal(JSON.parse(readFileSync(path.join(statusDir,"state.json"),"utf8")).errors.length,0);
    const validData=readFileSync(path.join(content,"generated/dashboard.json"),"utf8");
    writeFileSync(peoplePath,"people: [broken");
    await until(()=>JSON.parse(readFileSync(path.join(statusDir,"state.json"),"utf8")).errors.length>0);
    assert.equal(readFileSync(path.join(content,"generated/dashboard.json"),"utf8"),validData);
    const history=await request("history");assert.ok(history.versions.some(version=>version.origin==="external"&&!version.valid));
    rmSync(path.join(content,"generated/dashboard.json"));
    const recovery=await fetch(base);const recoveryHtml=await recovery.text();
    assert.equal(recovery.status,200);assert.ok(recoveryHtml.includes("资料恢复"));assert.ok(recoveryHtml.includes("修改历史"));
    const preview=await request("compare",{kind:"",id:"",version:initial.status.version});assert.equal(preview.can_restore,true);
    const restored=await send({Origin:base,"X-BD-CSRF":initial.csrf},JSON.stringify({action:"restore",kind:"workspace",id:"",version:initial.status.version,revision:preview.revision}));assert.equal(restored.status,200);
    assert.ok((await (await fetch(base)).text()).includes("业务与融资进展"));
  } finally {
    server.kill("SIGTERM");
    await Promise.race([new Promise(resolve=>server.once("close",resolve)),delay(5000)]);
    if(server.exitCode===null)server.kill("SIGKILL");
    rmSync(directory,{recursive:true,force:true});
  }
});
