import assert from "node:assert/strict";
import {cpSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
const root=fileURLToPath(new URL("..",import.meta.url));
const matter="project-demo-partnership",other="project-demo-investment";
function setup(){
  const directory=mkdtempSync(path.join(tmpdir(),"bd-progress-files-")),content=path.join(directory,"content");
  cpSync(path.join(root,"fixtures/demo/content"),content,{recursive:true});
  const call=request=>{const r=spawnSync("uv",["run","--offline","--cache-dir",process.env.BD_TEST_CACHE||path.join(root,".uv-cache"),"--locked",path.join(root,"scripts/workspace_service.py"),"--content-dir",content],{input:JSON.stringify(request),encoding:"utf8",maxBuffer:12_000_000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const ok=request=>{const r=call(request);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
  const stage=(bytes="signed sample",project_id=matter)=>ok({action:"upload_stage",project_id,filename:"保密协议.pdf",data:Buffer.from(bytes).toString("base64")});
  const files=()=>ok({action:"files"}).files;
  const save=(attachments,id="",payload={})=>({action:"save",kind:"progress",project_id:matter,id,revision:ok({action:"record",kind:"progress",project_id:matter,id}).revision,payload:{date:"2026-10-28",type:"agreement",title:"协议进展",summary:"记录确认的协议情况",importance:"normal",participants:[],body:"",location:"",...payload},attachments});
  const attachment=upload=>({mode:"upload",upload_id:upload.upload_id,title:"测试保密协议",category:"agreement",agreement_type:"nda",status:"signed",agreement_date:"2026-10-20",signing_completed_date:"2026-10-28"});
  return{directory,content,call,ok,stage,files,save,attachment,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test("progress, uploaded agreement and version-specific reference commit together; stages stay literal",()=>{
  const w=setup();try{
    const before=w.ok({action:"workspace"});const upload=w.stage();
    assert.equal(w.files().length,0);assert.equal(w.ok({action:"workspace"}).status.version,before.status.version);
    const request=w.save([w.attachment(upload)]);const preview=w.ok({...request,action:"preview"});assert.equal(preview.attachments[0].filename,"保密协议.pdf");assert.equal(w.files().length,0);
    const result=w.ok(request);const file=w.files()[0];
    assert.equal(file.versions.length,1);assert.equal(file.versions[0].agreement_date,"2026-10-20");assert.equal(file.versions[0].signing_completed_date,"2026-10-28");
    assert.equal(file.records[0].kind,"reference");assert.equal(file.records[0].event_id,result.id);assert.equal(file.records[0].version_id,file.current_version);
    assert.equal(w.ok({action:"record",kind:"project",id:matter}).record.metadata.stage,before.data.projects.find(p=>p.id===matter).stage);
    assert.equal(readFileSync(w.ok({action:"file_download",id:file.id,version_id:file.current_version}).path,"utf8"),"signed sample");
    assert.equal(w.ok({action:"record",kind:"progress",id:result.id,project_id:matter}).record.attachments[0].file_id,file.id);
    assert.equal(w.call(request).code,"conflict");assert.equal(w.files().length,1);
  }finally{w.close();}
});
test("validation failures, wrong matter uploads and stale file revisions cannot partially save",()=>{
  const w=setup();try{
    const initial=w.ok({action:"workspace"});const upload=w.stage();
    assert.equal(w.call(w.save([w.attachment(upload)],"",{date:"invalid"})).ok,false);
    assert.equal(w.call(w.save([w.attachment(w.stage("wrong",other))])).code,"forbidden");
    assert.equal(w.call(w.save([{...w.attachment(upload),signing_completed_date:"2026-02-30"}])).ok,false);
    assert.equal(w.call(w.save([w.attachment(upload),w.attachment(upload)])).ok,false);
    assert.equal(w.ok({action:"workspace"}).status.version,initial.status.version);assert.equal(w.files().length,0);
    const result=w.ok(w.save([w.attachment(upload)])),file=w.files()[0];
    const existing={mode:"existing",file_id:file.id,version_id:file.current_version,revision:file.revision};
    w.ok({action:"file_save",operation:"metadata",id:file.id,revision:file.revision,payload:{notes:"changed"}});
    const before=w.ok({action:"workspace"});assert.equal(w.call(w.save([existing])).code,"attachment_conflict");assert.equal(w.ok({action:"workspace"}).status.version,before.status.version);
    assert.equal(w.ok({action:"record",kind:"progress",id:result.id,project_id:matter}).record.attachments.length,1);
  }finally{w.close();}
});
test("existing versions are reused; new versions preserve old references; single-progress restore only adjusts its references",()=>{
  const w=setup();try{
    const created=w.ok(w.save([w.attachment(w.stage("first"))]));let file=w.files()[0];const first=file.current_version;
    const next=w.ok(w.save([{mode:"version",upload_id:w.stage("second").upload_id,file_id:file.id,revision:file.revision,status:"draft"}],created.id));
    file=w.files()[0];assert.equal(file.versions.length,2);assert.equal(file.records.length,2);assert.equal(file.versions[0].status,"signed");assert.equal(file.versions[1].status,"draft");
    assert.equal(file.versions[1].signing_completed_date,undefined);
    w.ok(w.save([{mode:"existing",file_id:file.id,version_id:first,revision:file.revision}]));
    assert.equal(w.files()[0].versions.length,2);assert.equal(w.files()[0].records.length,3);
    const compare=w.ok({action:"compare",kind:"progress",id:created.id,project_id:matter,version:created.status.version});assert.equal(compare.can_restore,true);
    w.ok({action:"restore",kind:"progress",id:created.id,project_id:matter,version:created.status.version,revision:compare.revision});
    file=w.files()[0];assert.equal(file.versions.length,2);assert.equal(file.records.length,2);assert.equal(file.records.filter(r=>r.event_id===created.id).length,1);
    assert.equal(file.records.find(r=>r.event_id===created.id).version_id,first);
    assert.equal(readFileSync(w.ok({action:"file_download",id:file.id,version_id:next.attachments[0].version_id}).path,"utf8"),"second");
  }finally{w.close();}
});
test("staging rejects unsafe names, oversized files, expired or changed bytes, and invalid attachment shapes",()=>{
  const w=setup();try{
    for(const filename of ["../secret.pdf","a.exe","dir/a.pdf"])assert.equal(w.call({action:"upload_stage",project_id:matter,filename,data:Buffer.from("x").toString("base64")}).ok,false);
    const upload=w.stage();const store=path.join(w.directory,".bd-history",readdirSync(path.join(w.directory,".bd-history"))[0],"uploads");
    writeFileSync(path.join(store,upload.upload_id+".bin"),"altered");assert.equal(w.call(w.save([w.attachment(upload)])).code,"conflict");
    const expired=w.stage();const meta=path.join(store,expired.upload_id+".json"),value=JSON.parse(readFileSync(meta));value.expires=1;writeFileSync(meta,JSON.stringify(value));
    assert.equal(w.call(w.save([w.attachment(expired)])).code,"upload_expired");
    for(const attachments of [{},"bad",[null],[{mode:"upload",path:"/etc/passwd"}]])assert.equal(w.call(w.save(attachments)).ok,false);
    assert.equal(w.files().length,0);
  }finally{w.close();}
});
