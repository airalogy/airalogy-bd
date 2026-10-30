import assert from "node:assert/strict";
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..",import.meta.url));
const fixture = path.join(root,"fixtures/demo/content");
const script = path.join(root,"scripts/workspace_service.py");
const cache = process.env.BD_TEST_CACHE || path.join(root,".uv-cache");
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(),"bd-edit-test-"));
  const content = path.join(directory,"content");
  cpSync(fixture,content,{recursive:true});
  const call = (request) => {
    const result = spawnSync("uv",["run","--cache-dir",cache,"--locked",script,"--content-dir",content],{input:JSON.stringify(request),encoding:"utf8",maxBuffer:12_000_000});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  const ok = (request) => {const response=call(request);assert.equal(response.ok,true,JSON.stringify(response));return response.result;};
  const read = (relative) => readFileSync(path.join(content,relative),"utf8");
  const write = (relative,text) => {mkdirSync(path.dirname(path.join(content,relative)),{recursive:true});writeFileSync(path.join(content,relative),text);};
  return {directory,content,call,ok,read,write,close:()=>rmSync(directory,{recursive:true,force:true})};
}
function editPerson(workspace,id,change) {
  const current=workspace.ok({action:"record",kind:"person",id});
  return workspace.ok({action:"save",kind:"person",id,revision:current.revision,payload:{...current.record,...change}});
}

test("validated saves leave exact recoverable versions and person restoration preserves other profiles",() => {
  const w=setup();
  try {
    const baseline=w.ok({action:"workspace"});
    const originalPeople=w.read("people.yaml");
    const originalRepoFiles=w.read("counterparties/示例合作/matters/合作对接/README.md");
    const before=w.ok({action:"record",kind:"person",id:"陈青"});
    const saved=editPerson(w,"陈青",{phone:"001-00000001",wechat:"edited-demo"});
    assert.notEqual(saved.status.version,baseline.status.version);
    assert.equal(w.read("counterparties/示例合作/matters/合作对接/README.md"),originalRepoFiles);
    const after=w.ok({action:"record",kind:"person",id:"陈青"});
    assert.equal(after.record.phone,"001-00000001");
    const change=w.ok({action:"compare",kind:"person",id:"陈青",version:saved.status.version,mode:"change"});
    assert.ok(change.changes.some(item=>item.label === "电话" && item.before === before.record.phone && item.after === "001-00000001"));
    assert.equal(change.can_restore,false);
    // Unchanged identity, affiliation and unrelated people keep their existing source text.
    assert.ok(w.read("people.yaml").includes("id: 林岚"));
    editPerson(w,"林岚",{wechat:"retain-other-person"});
    const comparison=w.ok({action:"compare",kind:"person",id:"陈青",version:baseline.status.version});
    assert.equal(comparison.can_restore,true);
    assert.ok(comparison.changes.some(item=>item.label === "电话" && item.after === "001-00000001"));
    w.ok({action:"restore",kind:"person",id:"陈青",version:baseline.status.version,revision:comparison.revision});
    assert.equal(w.ok({action:"record",kind:"person",id:"陈青"}).record.phone,before.record.phone);
    assert.equal(w.ok({action:"record",kind:"person",id:"林岚"}).record.wechat,"retain-other-person");
    // Rebuilding generated data never loses the independent history repository.
    rmSync(path.join(w.content,"generated/dashboard.json"));
    assert.ok(w.ok({action:"workspace"}).data);
    assert.notEqual(w.read("people.yaml"),originalPeople);
    const history=w.ok({action:"history",kind:"person",id:"陈青"});
    assert.ok(history.versions.some(item=>item.origin === "restore"));
    assert.ok(history.versions.some(item=>item.origin === "form"));
  } finally {w.close();}
});

test("invalid input and stale editors cannot overwrite source files",()=>{
  const w=setup();
  try {
    const opened=w.ok({action:"record",kind:"person",id:"陈青"});
    const original=w.read("people.yaml");
    const invalid=w.call({action:"save",kind:"person",id:"陈青",revision:opened.revision,payload:{...opened.record,email:"not-an-email"}});
    assert.equal(invalid.code,"validation");
    assert.equal(w.read("people.yaml"),original);
    w.write("people.yaml",original.replace("demo_chenqing","external-editor"));
    const conflict=w.call({action:"save",kind:"person",id:"陈青",revision:opened.revision,payload:{...opened.record,phone:"002-123"}});
    assert.equal(conflict.code,"conflict");
    assert.equal(w.ok({action:"record",kind:"person",id:"陈青"}).record.wechat,"external-editor");
    assert.equal(w.ok({action:"history",kind:"person",id:"陈青"}).versions[0].origin,"external");
    // An unrelated person's changes do not invalidate this person's form.
    const stable=w.ok({action:"record",kind:"person",id:"陈青"});
    editPerson(w,"林岚",{phone:"003-0000"});
    w.ok({action:"save",kind:"person",id:"陈青",revision:stable.revision,payload:{...stable.record,phone:"002-123"}});
  } finally {w.close();}
});

test("project and meeting edits synchronize files, contacts, actual dates and history",()=>{
  const w=setup();
  try {
    const baseline=w.ok({action:"workspace"});
    const projectId="project-demo-partnership";
    const opened=w.ok({action:"record",kind:"project",id:projectId});
    const body=opened.record.body.replace("正在确认合作范围与验证计划。","正在核对虚构验证条件。");
    w.ok({action:"save",kind:"project",id:projectId,revision:opened.revision,payload:{...opened.record.metadata,body,contacts:opened.record.contacts}});
    const progress=w.ok({action:"record",kind:"progress",id:"",project_id:projectId});
    const payload={date:"2026-01-24",type:"meeting",title:"虚构会议",summary:"讨论虚构验证条件，尚未达成承诺。",importance:"normal",participants:["林岚","顾远"],body:"# 虚构会议\n\n讨论虚构验证条件。",location:"线上",new_contacts:[{person_id:"顾远",side:"advisor",project_roles:["introducer"],notes:"参与此次虚构交流"}]};
    const saved=w.ok({action:"save",kind:"progress",id:"",project_id:projectId,revision:progress.revision,payload});
    assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/合作对接/meetings/20260124.md")),true);
    const meeting=w.ok({action:"record",kind:"progress",id:saved.id,project_id:projectId});
    assert.deepEqual(meeting.record.event.participants,["林岚","顾远"]);
    w.ok({action:"save",kind:"progress",id:saved.id,project_id:projectId,revision:meeting.revision,payload:{...payload,new_contacts:[],date:"2026-01-25"}});
    assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/合作对接/meetings/20260124.md")),false);
    assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/合作对接/meetings/20260125.md")),true);
    const updated=w.ok({action:"workspace"}).data.projects.find(item=>item.id===projectId);
    assert.equal(updated.last_activity,"2026-01-25");
    assert.ok(updated.contacts.some(item=>item.person_id==="顾远"));
    const comparison=w.ok({action:"compare",kind:"project",id:projectId,version:baseline.status.version});
    assert.equal(comparison.can_restore,true);
    w.ok({action:"restore",kind:"project",id:projectId,version:baseline.status.version,revision:comparison.revision});
    assert.equal(w.ok({action:"record",kind:"project",id:projectId}).record.body,opened.record.body);
    assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/合作对接/meetings/20260125.md")),false);
  } finally {w.close();}
});

test("new people, companies and projects can be created without inventing next steps",()=>{
  const w=setup();
  try {
    const empty=w.ok({action:"record",kind:"person",id:""});
    const profile={name:"新示例人",affiliation:"虚构机构研究员",phone:null,wechat:null,email:null};
    w.ok({action:"save",kind:"person",id:"",revision:empty.revision,payload:profile});
    const duplicate=w.call({action:"save",kind:"person",id:"",revision:empty.revision,payload:profile});
    assert.equal(duplicate.code,"duplicate");
    const company=w.ok({action:"record",kind:"company",id:""});
    const companyDraft={date:"2026-01-26",type:"milestone",title:"虚构行业活动",summary:"参加虚构行业活动。",importance:"normal",participants:["新示例人"],category:"industry-event",organizers:["示例主办方"],body:"# 虚构行业活动\n\n仅用于测试。"};
    const saved=w.ok({action:"save",kind:"company",id:"",revision:company.revision,payload:companyDraft});
    assert.ok(existsSync(path.join(w.content,"company/records/20260126.md")));
    const companyLoaded=w.ok({action:"record",kind:"company",id:saved.id});
    w.ok({action:"save",kind:"company",id:saved.id,revision:companyLoaded.revision,payload:{...companyDraft,date:"2026-01-27"}});
    assert.equal(existsSync(path.join(w.content,"company/records/20260126.md")),false);
    assert.equal(existsSync(path.join(w.content,"company/records/20260127.md")),true);
    const existing=w.ok({action:"record",kind:"project",id:"project-demo-partnership"});
    const create=w.ok({action:"record",kind:"project",id:""});
    const payload={...existing.record.metadata,name:"新增虚构事项",body:"# 新增虚构事项\n\n## 管理摘要\n\n仅用于测试。",contacts:[{person_id:"新示例人",side:"counterparty",project_roles:["business_contact"],notes:"虚构关系"}],initial_event:{date:"2026-01-27",type:"contact",title:"虚构首次联系",summary:"建立虚构联系。",importance:"normal",participants:["新示例人"],body:"",new_contacts:[]}};
    const newProject=w.ok({action:"save",kind:"project",id:"",revision:create.revision,payload});
    assert.match(newProject.id,/^project-/);
    assert.ok(w.read("counterparties/示例合作/matters/新增虚构事项/README.md").includes("管理摘要"));
    assert.equal(w.ok({action:"workspace"}).status.errors.length,0);
  } finally {w.close();}
});

test("creating a participant during progress entry preserves the open revision and still detects concurrent progress edits",()=>{
  const w=setup();
  try {
    const project_id="project-demo-partnership";
    const open=w.ok({action:"record",kind:"progress",id:"",project_id});
    const empty=w.ok({action:"record",kind:"person",id:""});
    const profile={name:"许沐",affiliation:"示例实验室研究员",phone:"001-234",wechat:null,email:null};
    w.ok({action:"save",kind:"person",id:"",revision:empty.revision,payload:profile});
    assert.equal(w.ok({action:"record",kind:"progress",id:"",project_id}).revision,open.revision);
    const payload={date:"2026-10-30",type:"meeting",title:"新增人员的交流",summary:"讨论部署需求。",importance:"normal",participants:["许沐"],body:"## 交流记录\n\n讨论部署需求。",location:"线上",new_contacts:[{person_id:"许沐",side:"counterparty",project_roles:["participant"],notes:""}]};
    const saved=w.ok({action:"save",kind:"progress",id:"",project_id,revision:open.revision,payload});
    const read=w.ok({action:"record",kind:"progress",id:saved.id,project_id}).record;
    assert.deepEqual(read.event.participants,["许沐"]);
    assert.equal(read.body,payload.body);
    assert.equal(read.document.location,payload.location);
    const contacts=w.ok({action:"record",kind:"project",id:project_id}).record.contacts;
    assert.ok(contacts.some(item=>item.person_id==="许沐"&&item.side==="counterparty"));
    const duplicate=w.call({action:"save",kind:"person",id:"",revision:empty.revision,payload:{...profile,affiliation:"不应覆盖原档案"}});
    assert.equal(duplicate.code,"duplicate");
    assert.equal(w.ok({action:"record",kind:"person",id:"许沐"}).record.affiliation,profile.affiliation);
    // Another person can be saved independently, but must not refresh away a real conflict.
    w.ok({action:"save",kind:"person",id:"",revision:empty.revision,payload:{...profile,name:"许晗"}});
    const stale=w.call({action:"save",kind:"progress",id:"",project_id,revision:open.revision,payload:{...payload,title:"保留待比较的草稿"}});
    assert.equal(stale.code,"conflict");
    assert.equal(w.ok({action:"workspace"}).status.errors.length,0);
  } finally {w.close();}
});

test("invalid direct file edits are archived and a validated full restore recovers them",()=>{
  const w=setup();
  try {
    const baseline=w.ok({action:"workspace"});
    const before=w.read("people.yaml");
    w.write("people.yaml","people: [\ninvalid");
    const observed=w.ok({action:"workspace"});
    assert.ok(observed.status.errors.length>0);
    assert.deepEqual(observed.data,baseline.data);
    assert.notEqual(observed.status.version,baseline.status.version);
    const comparison=w.ok({action:"compare",kind:"",id:"",version:baseline.status.version});
    assert.equal(comparison.can_restore,true);
    assert.ok(comparison.changes.some(item=>item.label==="people.yaml"));
    w.ok({action:"restore",kind:"workspace",id:"",version:baseline.status.version,revision:comparison.revision});
    assert.equal(w.read("people.yaml"),before);
    assert.equal(w.ok({action:"workspace"}).status.errors.length,0);
  } finally {w.close();}
});

test("undoing newly created records removes their files and leaves a valid workspace",()=>{
  const w=setup();
  try {
    rmSync(path.join(w.content,"company"),{recursive:true});
    const baseline=w.ok({action:"workspace"});
    const fresh=w.ok({action:"record",kind:"company",id:""});
    const company=w.ok({action:"save",kind:"company",id:"",revision:fresh.revision,payload:{date:"2026-01-28",type:"milestone",title:"新增虚构动态",summary:"虚构测试。",importance:"normal",category:"industry-event",participants:["林岚"],body:"# 虚构动态\n\n测试记录。"}});
    const comparison=w.ok({action:"compare",kind:"company",id:company.id,version:baseline.status.version});
    assert.equal(comparison.can_restore,true);
    assert.equal(comparison.historical_exists,false);
    w.ok({action:"restore",kind:"company",id:company.id,version:baseline.status.version,revision:comparison.revision});
    assert.equal(existsSync(path.join(w.content,"company")),false);
    const existing=w.ok({action:"record",kind:"project",id:"project-demo-partnership"});
    const empty=w.ok({action:"record",kind:"project",id:""});
    const project=w.ok({action:"save",kind:"project",id:"",revision:empty.revision,payload:{...existing.record.metadata,name:"待撤回虚构事项",body:"# 待撤回虚构事项\n\n## 管理摘要\n\n虚构测试。",contacts:[{person_id:"林岚",side:"internal",project_roles:["project_owner"],notes:"测试"}],initial_event:{date:"2026-01-28",type:"contact",title:"虚构接触",summary:"虚构测试。",importance:"normal",participants:["林岚"],body:"",new_contacts:[]}}});
    const projectComparison=w.ok({action:"compare",kind:"project",id:project.id,version:baseline.status.version});
    w.ok({action:"restore",kind:"project",id:project.id,version:baseline.status.version,revision:projectComparison.revision});
    assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/待撤回虚构事项")),false);
    const validate=spawnSync("uv",["run","--cache-dir",cache,"--locked",path.join(root,"scripts/validate.py"),"--content-dir",w.content],{encoding:"utf8"});
    assert.equal(validate.status,0,validate.stderr);
  } finally {w.close();}
});

test("restore previews detect new changes and original Git history remains untouched",()=>{
  const w=setup();
  try {
    const git=(...args)=>{const result=spawnSync("git",["-C",w.directory,...args],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
    git("init","--initial-branch=main");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");git("config","commit.gpgsign","false");git("add","content");git("commit","-m","虚构已有版本");
    const originalHead=git("rev-parse","HEAD");
    const baseline=w.ok({action:"workspace"});
    editPerson(w,"陈青",{phone:"004-123"});
    const history=w.ok({action:"history",kind:"person",id:"陈青"});
    assert.ok(history.versions.some(item=>item.version === "repo:"+originalHead));
    const comparison=w.ok({action:"compare",kind:"person",id:"陈青",version:baseline.status.version});
    editPerson(w,"林岚",{phone:"005-000"});
    const stale=w.call({action:"restore",kind:"person",id:"陈青",version:baseline.status.version,revision:comparison.revision});
    assert.equal(stale.code,"conflict");
    const fresh=w.ok({action:"compare",kind:"person",id:"陈青",version:"repo:"+originalHead});
    w.ok({action:"restore",kind:"person",id:"陈青",version:"repo:"+originalHead,revision:fresh.revision});
    assert.equal(git("rev-parse","HEAD"),originalHead);
    assert.equal(w.ok({action:"record",kind:"person",id:"林岚"}).record.phone,"005-000");
  } finally {w.close();}
});

test("interrupted multi-file transactions recover and unsafe paths are refused",()=>{
  const w=setup();
  try {
    const baseline=w.ok({action:"workspace"});
    const roots=readFileSync(path.join(w.content,"workspace.yaml"),"utf8");
    const people=w.read("people.yaml");
    const hashDirectories=spawnSync("find",[path.join(w.directory,".bd-history"),"-name","state.json"],{encoding:"utf8"}).stdout.trim().split("\n");
    const stateDirectory=path.dirname(hashDirectories[0]);
    writeFileSync(path.join(stateDirectory,"transaction.json"),JSON.stringify({label:"测试中断",changes:{"workspace.yaml":{before:roots,after:roots.replace("澄川创新","虚构新名称")},"people.yaml":{before:people,after:people.replace("demo_chenqing","unfinished")}}}));
    w.write("people.yaml",people.replace("demo_chenqing","unfinished"));
    w.ok({action:"workspace"});
    assert.equal(w.read("people.yaml"),people);
    assert.equal(existsSync(path.join(stateDirectory,"transaction.json")),false);
    // External edits after a crash are never overwritten by automatic recovery.
    writeFileSync(path.join(stateDirectory,"transaction.json"),JSON.stringify({label:"再次中断",changes:{"people.yaml":{before:people,after:people.replace("demo_chenqing","unfinished")}}}));
    w.write("people.yaml",people.replace("demo_chenqing","external-after-crash"));
    assert.equal(w.call({action:"workspace"}).code,"recovery_conflict");
    assert.ok(w.read("people.yaml").includes("external-after-crash"));
    assert.ok(w.ok({action:"history"}).versions.some(version=>version.label === "保存中断后的外部修改"));
    const restore=w.ok({action:"compare",kind:"",id:"",version:baseline.status.version});
    w.ok({action:"restore",kind:"workspace",id:"",version:baseline.status.version,revision:restore.revision});
    assert.equal(w.read("people.yaml"),people);
    assert.equal(existsSync(path.join(stateDirectory,"interrupted-transactions")),true);
    const target=w.ok({action:"record",kind:"project",id:""});
    const original=w.ok({action:"record",kind:"project",id:"project-demo-partnership"});
    const unsafe=w.call({action:"save",kind:"project",id:"",revision:target.revision,payload:{...original.record.metadata,name:"../escape",body:original.record.body,contacts:original.record.contacts}});
    assert.equal(unsafe.ok,false);
    const outside=path.join(w.directory,"outside.yaml");writeFileSync(outside,"private: value");symlinkSync(outside,path.join(w.content,"unsafe.yaml"));
    assert.equal(w.call({action:"workspace"}).code,"unsafe_path");
    assert.equal(readFileSync(outside,"utf8"),"private: value");
  } finally {w.close();}
});
