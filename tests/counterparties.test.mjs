import assert from "node:assert/strict";
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
const root=fileURLToPath(new URL("..",import.meta.url));
const cache=process.env.BD_TEST_CACHE || path.join(root,".uv-cache");
const qinghe="counterparty-917f1872213b3ab5", xingfan="counterparty-13414ee5502c4f23";
function setup() {
 const directory=mkdtempSync(path.join(tmpdir(),"bd-counterparties-test-")), content=path.join(directory,"content");
 cpSync(path.join(root,"fixtures/demo/content"),content,{recursive:true});
 const call=(request,location=content)=>{const child=spawnSync("uv",["run","--offline","--cache-dir",cache,"--locked",path.join(root,"scripts/workspace_service.py"),"--content-dir",location],{input:JSON.stringify(request),encoding:"utf8",maxBuffer:15_000_000});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
 const ok=(request,location)=>{const response=call(request,location);assert.equal(response.ok,true,JSON.stringify(response));return response.result;};
 const make=(overrides={})=>{const original=ok({action:"record",kind:"project",id:"project-demo-partnership"}),form=ok({action:"record",kind:"project",id:""});return {action:"save",kind:"project",id:"",revision:form.revision,payload:{...original.record.metadata,name:"第二事项",body:"# 第二事项\n\n## 管理摘要\n\n虚构沟通记录。",contacts:[{person_id:"林岚",side:"internal",project_roles:["project_owner"],notes:""}],initial_event:{date:"2026-10-08",type:"contact",title:"虚构首次接触",summary:"用于验证的虚构接触。",importance:"normal",participants:["林岚"],body:"",new_contacts:[]},...overrides}};};
 const editParty=(identity,fields)=>{const record=ok({action:"record",kind:"counterparty",id:identity});return ok({action:"save",kind:"counterparty",id:identity,revision:record.revision,payload:{...record.record.metadata,body:record.record.body,people:record.record.people,...fields}});};
 return {directory,content,call,ok,make,editParty,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test("one counterparty supports separate cooperation and fundraising matters with shared people and files",()=>{
 const w=setup();try {
  const second=w.ok(w.make({record_type:"investment",name:"融资沟通",counterparty_ids:[qinghe,xingfan]}));
  let data=w.ok({action:"workspace"}).data;
  assert.equal(data.projects.length,3);assert.equal(data.counterparties.length,2);
  assert.deepEqual(data.counterparties.find(item=>item.id===qinghe).matter_ids.sort(),["project-demo-partnership",second.id].sort());
  assert.ok(data.counterparties.find(item=>item.id===xingfan).matter_ids.includes(second.id));
  assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/融资沟通/README.md")),true);
  assert.equal(existsSync(path.join(w.content,"counterparties/星帆创投/matters/融资沟通")),false);
  const original=w.ok({action:"record",kind:"project",id:"project-demo-partnership"});
  const common=w.editParty(qinghe,{name:"青禾集团新名称",people:["宋禾"]});
  data=w.ok({action:"workspace"}).data;
  assert.ok(data.projects.filter(item=>item.primary_counterparty_id===qinghe).every(item=>item.counterparties[0]==="青禾集团新名称"));
  assert.ok(data.counterparties.find(item=>item.id===qinghe).related_people.includes("宋禾"));
  assert.deepEqual(w.ok({action:"record",kind:"project",id:"project-demo-partnership"}).record.events,original.record.events);
  const person=w.ok({action:"record",kind:"person",id:"林岚"});w.ok({action:"save",kind:"person",id:"林岚",revision:person.revision,payload:{...person.record,phone:"010-001"}});
  data=w.ok({action:"workspace"}).data;assert.ok(data.projects.filter(item=>item.counterparty_ids.includes(qinghe)).every(item=>item.contacts.find(contact=>contact.id==="林岚").phone==="010-001"));
  const imported=w.ok({action:"file_save",operation:"upload",payload:{title:"共用介绍",organization:"青禾集团新名称",category:"other",home_counterparty_id:qinghe,project_ids:["project-demo-partnership",second.id],filename:"介绍.txt",data:Buffer.from("one canonical copy").toString("base64")}});
  const file=w.ok({action:"files"}).files[0];assert.equal(file.id,imported.id);assert.equal(file.project_ids.length,2);assert.ok(file.versions[0].archive_path.startsWith("counterparties/示例合作/attachments/"));
  assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/融资沟通/attachments")),false);
  w.editParty(qinghe,{short_name:"青禾"});
  const preview=w.ok({action:"compare",kind:"counterparty",id:qinghe,version:common.status.version});assert.equal(preview.can_restore,true);
  w.ok({action:"restore",kind:"counterparty",id:qinghe,version:common.status.version,revision:preview.revision});
  assert.equal(w.ok({action:"workspace"}).data.projects.length,3);
  assert.equal(w.call({action:"save",kind:"counterparty",id:qinghe,revision:preview.revision,payload:{name:"stale"}}).code,"conflict");
 } finally {w.close();}
});

test("a single save creates a personal counterparty and matter atomically, while duplicate names reuse profiles",()=>{
 const w=setup();try {
  const invalid=w.make({primary_counterparty_id:"",counterparty_ids:[],new_counterparty:{name:"虚构个人",kind:"person"},first_contact:"invalid"});
  assert.equal(w.call(invalid).ok,false);assert.equal(existsSync(path.join(w.content,"counterparties/虚构个人")),false);
  const saved=w.ok(w.make({primary_counterparty_id:"",counterparty_ids:[],new_counterparty:{name:"虚构个人",kind:"person"}}));
  let data=w.ok({action:"workspace"}).data;const person=data.counterparties.find(item=>item.name==="虚构个人");
  assert.equal(person.kind,"person");assert.deepEqual(person.matter_ids,[saved.id]);
  w.ok(w.make({name:"第三事项",primary_counterparty_id:"",counterparty_ids:[],new_counterparty:{name:" 虚构个人 ",kind:"person"}}));
  data=w.ok({action:"workspace"}).data;assert.equal(data.counterparties.filter(item=>item.name==="虚构个人").length,1);assert.equal(data.counterparties.find(item=>item.id===person.id).matter_ids.length,2);
  assert.equal(w.call(w.make({name:"../outside",primary_counterparty_id:person.id})).ok,false);
  const project=w.ok({action:"record",kind:"project",id:saved.id});assert.equal(w.call({action:"save",kind:"project",id:saved.id,revision:project.revision,payload:{...project.record.metadata,primary_counterparty_id:qinghe,body:project.record.body,contacts:project.record.contacts}}).ok,false);
 } finally {w.close();}
});

test("unknown first contact stays undated until evidence is supplied",()=>{
 const w=setup();try {
  for(const fields of [
   {first_contact:null,first_contact_certainty:"confirmed"},
   {first_contact:null,first_contact_certainty:"provisional"},
   {first_contact:"2026-10-08",first_contact_certainty:"unknown"},
   {first_contact:"",first_contact_certainty:"unknown"},
  ]) assert.equal(w.call(w.make(fields)).ok,false);
  const saved=w.ok(w.make({first_contact:null,first_contact_certainty:"unknown"}));
  let project=w.ok({action:"workspace"}).data.projects.find(item=>item.id===saved.id);
  assert.equal(project.first_contact,null);assert.equal(project.first_contact_certainty,"unknown");
  assert.equal(project.last_activity,"2026-10-08");
  const current=w.ok({action:"record",kind:"project",id:saved.id});
  w.ok({action:"save",kind:"project",id:saved.id,revision:current.revision,payload:{...current.record.metadata,body:current.record.body,contacts:current.record.contacts,first_contact:"2026-09-01",first_contact_certainty:"confirmed"}});
  project=w.ok({action:"workspace"}).data.projects.find(item=>item.id===saved.id);
  assert.equal(project.first_contact,"2026-09-01");assert.equal(project.first_contact_certainty,"confirmed");
 } finally {w.close();}
});

function makeLegacy(w) {
 const mappings=[["示例合作","合作对接","青禾集团"],["星帆创投","融资对接","星帆创投"]];
 for(const [folder,matter,name] of mappings) {
  const target=path.join(w.content,"projects",folder);cpSync(path.join(w.content,"counterparties",folder,"matters",matter),target,{recursive:true});
  const readme=path.join(target,"README.md");let source=readFileSync(readme,"utf8");
  source=source.replace(/^primary_counterparty_id:.*\n/m,"").replace(/^counterparty_ids:\n(?:[ \t]*- .*\n)+/m,`counterparties:\n  - ${name}\n`);writeFileSync(readme,source);
 }
 rmSync(path.join(w.content,"counterparties"),{recursive:true});
 rmSync(path.join(w.content,"generated"),{recursive:true,force:true});
 return mappings;
}

test("migration retains business bytes and IDs, original Git history, attachments and version 2 backup recovery",()=>{
 const w=setup(),destination=w.directory+"-restored";try {
  makeLegacy(w);
  const oldMatter=readFileSync(path.join(w.content,"projects/示例合作/README.md"),"utf8"), oldEvents=readFileSync(path.join(w.content,"projects/示例合作/events.yaml"),"utf8");
  const git=(...args)=>{const child=spawnSync("git",["-C",w.directory,...args],{encoding:"utf8"});assert.equal(child.status,0,child.stderr);return child.stdout.trim();};
  git("init","--initial-branch=main");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");git("config","commit.gpgsign","false");git("add","content");git("commit","-m","迁移前的原始版本");const original=git("rev-parse","HEAD");
  // Simulate an uncommitted business update and an already imported old-layout file.
  writeFileSync(path.join(w.content,"projects/示例合作/README.md"),oldMatter.replace("## 管理摘要","## 管理摘要\n\n迁移前未提交的进展。"));
  const id="file-"+"a".repeat(32),version="version-"+"b".repeat(32),bytes="original archive bytes";
  const hash=spawnSync(process.execPath,["-e","process.stdout.write(require('node:crypto').createHash('sha256').update('original archive bytes').digest('hex'))"],{encoding:"utf8"}).stdout;
  const archive="projects/示例合作/attachments/materials/original.txt";
  mkdirSync(path.join(w.content,"projects/示例合作/attachments/.objects"),{recursive:true});mkdirSync(path.dirname(path.join(w.content,archive)),{recursive:true});
  writeFileSync(path.join(w.content,archive),bytes);writeFileSync(path.join(w.content,"projects/示例合作/attachments/.objects",hash),bytes);
  writeFileSync(path.join(w.content,"files.yaml"),JSON.stringify({schema_version:1,files:[{id,title:"旧资料",organization:"青禾集团",category:"other",home_project_id:"project-demo-partnership",project_ids:["project-demo-partnership"],notes:"",archived:false,current_version:version,records:[],versions:[{id:version,filename:"original.txt",sha256:hash,size:Buffer.byteLength(bytes),status:"unspecified",note:"",created_at:"2026-10-08T00:00:00Z",archive_path:archive}]}]}));
  const preview=w.ok({action:"migrate_layout"});assert.equal(preview.matters,2);assert.equal(preview.counterparties,2);assert.equal(existsSync(path.join(w.content,"projects/示例合作/README.md")),true);
  const migrated=w.ok({action:"migrate_layout",apply:true});assert.equal(migrated.saved,true);assert.equal(git("rev-parse","HEAD"),original);assert.equal(existsSync(path.join(w.content,"projects")),false);
  assert.equal(readFileSync(path.join(w.content,"counterparties/示例合作/matters/合作对接/events.yaml"),"utf8"),oldEvents);
  assert.match(readFileSync(path.join(w.content,"counterparties/示例合作/matters/合作对接/README.md"),"utf8"),/迁移前未提交的进展/);
  const record=w.ok({action:"record",kind:"project",id:"project-demo-partnership"});assert.equal(record.record.metadata.id,"project-demo-partnership");
  const list=w.ok({action:"files"}).files[0];assert.equal(list.home_counterparty_id,qinghe);assert.equal(readFileSync(w.ok({action:"file_download",id,version_id:version}).path,"utf8"),bytes);
  const history=w.ok({action:"history",kind:"project",id:"project-demo-partnership"});assert.ok(history.versions.some(item=>item.version==="repo:"+original));
  const compare=w.ok({action:"compare",kind:"project",id:"project-demo-partnership",version:"repo:"+original});assert.equal(compare.can_restore,true);
  w.ok({action:"restore",kind:"project",id:"project-demo-partnership",version:"repo:"+original,revision:compare.revision});assert.equal(existsSync(path.join(w.content,"projects")),false);
  assert.equal(w.ok({action:"migrate_layout",apply:true}).saved,false);
  w.ok({action:"restore_backup",archive:migrated.backup,destination});
  assert.equal(existsSync(path.join(destination,"content/projects")),false);
  const restored=w.ok({action:"files"},path.join(destination,"content")).files[0];assert.equal(restored.id,id);assert.equal(readFileSync(w.ok({action:"file_download",id,version_id:version},path.join(destination,"content")).path,"utf8"),bytes);
 } finally {w.close();rmSync(destination,{recursive:true,force:true});}
});
