import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {httpFetch} from "./http-client.mjs";

export async function exerciseIntake({directory,base,request,okay,admin,editor,viewer,publicHost}) {
  const db = new DatabaseSync(path.join(directory,".bd-auth/accounts.sqlite3"));
  const web=(operation,input={},member=admin)=>request("/api/remote",{operation,...input},member);
  const rpc=async(method,params,token)=>{db.exec("DELETE FROM remote_attempts");return request("/api/mcp",{jsonrpc:"2.0",id:1,method,params},null,{Authorization:`Bearer ${token}`,Accept:"application/json, text/event-stream"});};
  const raw=(name,args,token)=>rpc("tools/call",{name,arguments:args},token);
  const call=async(name,args,token,error=false)=>{const response=await raw(name,args,token);assert.equal(response.status,200,await response.clone().text());const result=(await response.json()).result;assert.ok(result,JSON.stringify(result));assert.equal(result.isError,error,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const configure=async enabled=>{const s=await okay(await request("/api/remote?action=settings",null,admin));return okay(await web("configure",{enabled,revision:s.revision}));};
  const version=async()=>(await okay(await request("/api/workspace?action=workspace",null,admin))).status.version;
  const operations=(suffix="")=>[
    {ref:"person",kind:"person",changes:{name:"新联系人"+suffix,affiliation:"示例公司经理"}},
    {ref:"party",kind:"counterparty",changes:{name:"新的对接方"+suffix,short_name:"新方"+suffix,people:["@person"],body:"# 对接方\n\n研发合作交流。"}},
    {ref:"matter",kind:"matter",changes:{name:"示例研发合作"+suffix,primary_counterparty_id:"@party",category:["研发合作"],contacts:[{person_id:"@person",side:"counterparty",project_roles:["contact"],notes:""}],body:"# 研发合作\n\n## 管理摘要\n\n双方讨论研发合作方式。\n\n## 当前进展\n\n完成首次方案交流，合作方式待明确。\n\n## 下一步\n\n沟通合作范围。",initial_event:{date:"2026-10-27",type:"meeting",title:"讨论研发合作",summary:"交流研发方向，合作方式待明确。",participants:["@person"],body:"讨论合作内容与知识产权安排。"}}},
  ];
  try {
    await configure(true);
    const issue=async(mode,intake=false,member=admin)=>okay(await web("issue",{label:"Business intake test",accessMode:mode,canIntake:intake},member));
    const old=await issue("direct");
    assert.equal(db.prepare("SELECT can_intake FROM remote_tokens WHERE id=?").get(old.id).can_intake,0);
    db.exec("ALTER TABLE remote_tokens DROP COLUMN can_intake"); // Simulate a credential issued before the upgrade.
    const list=async token=>(await (await rpc("tools/list",{},token)).json()).result.tools.map(t=>t.name);
    assert.ok(!(await list(old.token)).includes("prepare_intake"));
    assert.equal(db.prepare("SELECT can_intake FROM remote_tokens WHERE id=?").get(old.id).can_intake,0);
    assert.equal((await web("issue",{label:"Editor escalation",accessMode:"draft",canIntake:true},editor)).status,422);
    assert.equal((await web("issue",{label:"Read escalation",accessMode:"read",canIntake:true})).status,422);
    assert.equal((await web("allow_intake",{tokenId:old.id,confirmed:true},editor)).status,403);
    assert.equal((await web("allow_intake",{tokenId:old.id})).status,422);
    await okay(await web("allow_intake",{tokenId:old.id,confirmed:true}));
    assert.ok((await list(old.token)).includes("save_intake"));
    const direct=old,draftToken=await issue("draft",true),other=await issue("direct",true);
    assert.ok(!(await list(draftToken.token)).includes("save_intake"));
    const before=await version();const plan=await call("prepare_intake",{operations:operations()},direct.token);
    assert.equal(plan.status,"prepared");assert.equal(await version(),before);
    assert.equal((await call("search_matters",{query:"新的对接方"},direct.token)).matters.length,0);
    assert.equal((await call("submit_intake",{intake_id:plan.intake_id,request_id:randomUUID()},other.token,true)).code,"conflict");
    const bytes="intake attachment bytes", uploadArgs={matter_id:plan.matter_id,intake_id:plan.intake_id,filename:"公司介绍.txt",size:Buffer.byteLength(bytes),sha256:createHash("sha256").update(bytes).digest("hex")};
    assert.equal((await call("prepare_upload",{...uploadArgs,matter_id:"project-demo-investment"},direct.token,true)).code,"forbidden");
    const upload=await call("prepare_upload",uploadArgs,direct.token);
    const form=new FormData();form.set("upload_id",upload.upload_id);form.set("file",new File([bytes],upload.filename));
    await okay(await httpFetch(base+"/api/mcp/uploads",{method:"POST",headers:{Host:publicHost,Authorization:`Bearer ${direct.token}`},body:form}));
    const attachments=[{mode:"upload",upload_id:upload.upload_id,title:"公司介绍",category:"introduction",status:"final"}];
    const input={intake_id:plan.intake_id,request_id:randomUUID(),attachments};
    const saved=await call("save_intake",input,direct.token);
    assert.equal(saved.status,"saved");assert.equal(saved.records.length,3);assert.equal(saved.attachments.length,1);
    assert.deepEqual(await call("save_intake",input,direct.token),saved,"retry returns receipt without creating duplicates");
    assert.equal((await call("save_intake",{...input,attachments:[]},direct.token,true)).code,"conflict");
    const matter=await call("read_matter",{matter_id:saved.matter_id},direct.token);
    assert.equal(matter.record.metadata.first_contact,null);assert.equal(matter.record.metadata.first_contact_certainty,"unknown");
    assert.equal(matter.record.metadata.source_certainty,"unknown");assert.equal(matter.events.length,1);
    assert.equal((await call("read_progress",{matter_id:saved.matter_id,progress_id:saved.progress_id},direct.token)).attachments.length,1);
    assert.equal((await call("search_matters",{query:"新方"},direct.token)).matters[0].id,saved.matter_id);
    assert.equal((await call("search_entities",{kind:"person",query:"新联系人"},direct.token)).entities[0].matter_ids[0],saved.matter_id);
    const history=await okay(await request(`/api/workspace?action=history&kind=project&id=${saved.matter_id}`,null,admin));
    assert.equal(history.versions[0].version,saved.history_version);assert.equal(history.versions[0].actor.id,admin.user.id);
    assert.equal((await call("prepare_intake",{operations:operations()},direct.token,true)).code,"duplicate");
    const latest=await version();
    const invalid=operations("无效");invalid[2].changes.initial_event.date="invalid";
    assert.equal((await call("prepare_intake",{operations:invalid},direct.token,true)).code,"invalid");
    assert.equal(await version(),latest);assert.equal((await call("search_entities",{kind:"person",query:"无效"},direct.token)).entities.length,0);
    const draftPlan=await call("prepare_intake",{operations:operations("草稿")},draftToken.token);
    const draftUpload=await call("prepare_upload",{...uploadArgs,intake_id:draftPlan.intake_id,matter_id:draftPlan.matter_id},draftToken.token);
    const draftForm=new FormData();draftForm.set("upload_id",draftUpload.upload_id);draftForm.set("file",new File([bytes],draftUpload.filename));
    await okay(await httpFetch(base+"/api/mcp/uploads",{method:"POST",headers:{Host:publicHost,Authorization:`Bearer ${draftToken.token}`},body:draftForm}));
    assert.equal((await call("upload_status",{upload_id:draftUpload.upload_id},other.token,true)).code,"forbidden");
    const proposal=await call("submit_intake",{intake_id:draftPlan.intake_id,request_id:randomUUID(),attachments:[{...attachments[0],upload_id:draftUpload.upload_id}]},draftToken.token);
    const download=await request(`/api/remote/files?draft_id=${proposal.draftId}&upload_id=${draftUpload.upload_id}`,null,admin);
    assert.equal(download.status,200);assert.equal(await download.text(),bytes);
    assert.equal(await version(),latest);
    const reviews=(await okay(await request("/api/remote?action=drafts",null,admin))).drafts;
    assert.equal(reviews.find(d=>d.id===proposal.draftId).operation,"intake");
    assert.ok(reviews.find(d=>d.id===proposal.draftId).changes.some(c=>c.label.includes("对接方")));
    assert.equal((await web("confirm",{draftId:proposal.draftId,confirmed:true},viewer)).status,409);
    await okay(await web("confirm",{draftId:proposal.draftId,confirmed:true}));
    assert.equal((await call("search_matters",{query:"示例研发合作草稿"},direct.token)).matters.length,1);
    assert.equal((await call("read_progress",{matter_id:draftPlan.matter_id,progress_id:draftPlan.progress_id},direct.token)).attachments.length,1);
    const person=await call("read_entity",{kind:"person",id:plan.references.person},direct.token);
    const modify=await call("prepare_intake",{operations:[{ref:"person",kind:"person",id:plan.references.person,revision:person.revision,changes:{affiliation:"示例公司负责人"}}]},direct.token);
    const stale=await call("prepare_intake",{operations:operations("冲突")},direct.token);
    const revised=await call("save_intake",{intake_id:modify.intake_id,request_id:randomUUID()},direct.token);
    assert.equal(revised.records[0].created,false);
    assert.equal((await call("save_intake",{intake_id:stale.intake_id,request_id:randomUUID()},direct.token,true)).code,"conflict");
    assert.equal((await call("search_matters",{query:"示例研发合作冲突"},direct.token)).matters.length,0);
    const limited=await issue("draft",false,editor);
    assert.equal((await call("search_entities",{kind:"person",query:"新联系人"},limited.token)).entities.length,0);
    assert.ok(!(await list(limited.token)).includes("read_entity"));
    // No widening after token expiry/revocation; private plans are removed with credentials.
    await okay(await web("revoke",{tokenId:direct.id}));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM remote_intakes WHERE token_id=?").get(direct.id).n,0);
    assert.equal((await raw("prepare_intake",{operations:operations("撤销")},direct.token)).status,401);
    await configure(false);assert.equal(db.prepare("SELECT COUNT(*) n FROM remote_intakes").get().n,0);
  } finally {db.close();}
}
