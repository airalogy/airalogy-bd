import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";
import {httpFetch} from "./http-client.mjs";

export async function exerciseAttachmentHttp({directory,base,request,okay,admin,editor,viewer,publicOrigin,publicHost}) {
  const matter="project-demo-partnership",restricted="project-demo-investment";
  const db=new DatabaseSync(path.join(directory,".bd-auth/accounts.sqlite3"));
  const clear=()=>db.prepare("DELETE FROM remote_attempts").run();
  const web=(operation,input={},member=admin)=>request("/api/remote",{operation,...input},member);
  const configure=async enabled=>{const status=await okay(await request("/api/remote?action=settings",null,admin));return okay(await web("configure",{enabled,revision:status.revision}));};
  const rpc=async(name,args,token)=>{clear();return request("/api/mcp",{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}},null,{Authorization:`Bearer ${token}`,Accept:"application/json, text/event-stream"});};
  const call=async(name,args,token,error=false)=>{const response=await rpc(name,args,token);assert.equal(response.status,200,await response.clone().text());const result=(await response.json()).result;assert.equal(result.isError,error,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const files=async (member=admin)=>(await okay(await request("/api/files?action=list",null,member))).files;
  const stage=async(bytes,token)=>{const value=await call("prepare_upload",{matter_id:matter,filename:"协议附件.pdf",size:Buffer.byteLength(bytes),sha256:createHash("sha256").update(bytes).digest("hex")},token);assert.equal(value.ready,false);assert.equal(value.upload_path,"/api/mcp/uploads");return value;};
  const upload=(staged,bytes,token,extra={})=>{const form=new FormData();form.set("upload_id",staged.upload_id);form.set("file",new File([bytes],staged.filename));return httpFetch(base+"/api/mcp/uploads",{method:"POST",headers:{Host:publicHost,Authorization:`Bearer ${token}`,...extra},body:form});};
  const args=async(token,attachments)=>({matter_id:matter,revision:(await call("read_matter",{matter_id:matter},token)).revision,request_id:randomUUID(),operation:"add_progress",changes:{date:"2026-10-28",type:"agreement",title:"含附件的进展",summary:"仅记录明确事实",importance:"normal"},attachments});
  const newFile=staged=>({mode:"upload",upload_id:staged.upload_id,title:"远程保密协议",category:"agreement",agreement_type:"nda",status:"draft",agreement_date:"2026-10-20"});
  try {
    await configure(true);await okay(await web("grant",{memberId:editor.user.id,allowed:true}));await okay(await web("grant",{memberId:viewer.user.id,allowed:true}));
    const issue=async(member,accessMode)=>okay(await web("issue",{label:"附件测试",days:1,accessMode},member));
    const editorToken=await issue(editor,"draft"),second=await issue(editor,"draft"),readToken=await issue(viewer,"read"),direct=await issue(admin,"direct");
    assert.ok((await (await rpc("prepare_upload",{},readToken.token)).json()).error);
    const staged=await stage("remote PDF bytes",editorToken.token);
    assert.equal((await upload(staged,"remote PDF bytes",readToken.token)).status,403);
    assert.equal((await upload(staged,"remote PDF bytes",second.token)).status,403);
    assert.equal((await upload(staged,"wrong bytes",editorToken.token)).status,422);
    assert.equal((await upload(staged,"remote PDF bytes",editorToken.token,{Origin:"https://evil.invalid"})).status,403);
    assert.equal((await upload(staged,"remote PDF bytes","invalid")).status,401);
    assert.equal((await okay(await upload(staged,"remote PDF bytes",editorToken.token))).ready,true);
    assert.equal((await okay(await upload(staged,"remote PDF bytes",editorToken.token))).ready,true);
    assert.equal((await call("upload_status",{upload_id:staged.upload_id},editorToken.token)).ready,true);
    assert.equal((await call("upload_status",{upload_id:staged.upload_id},second.token,true)).code,"forbidden");
    const extra={matter_id:restricted,filename:"private.pdf",size:1,sha256:createHash("sha256").update("x").digest("hex")};
    assert.equal((await call("prepare_upload",extra,editorToken.token,true)).code,"forbidden");
    assert.equal((await call("prepare_upload",{...extra,matter_id:matter,size:52428801},editorToken.token,true)).code,"too_large");
    const before=await okay(await request("/api/workspace?action=workspace",null,admin));
    const draftArgs=await args(editorToken.token,[newFile(staged)]);
    const draft=await call("submit_draft",draftArgs,editorToken.token);assert.equal(draft.status,"pending");
    assert.equal((await okay(await request("/api/workspace?action=workspace",null,admin))).status.version,before.status.version);
    assert.equal((await call("submit_draft",{...draftArgs,request_id:randomUUID()},editorToken.token,true)).code,"conflict");
    const list=await okay(await request("/api/remote?action=drafts",null,editor));const review=list.drafts.find(d=>d.id===draft.draftId);
    assert.equal(review.attachments[0].filename,staged.filename);assert.equal(review.attachments[0].signing_completed_date,"");
    const download=`/api/remote/files?${new URLSearchParams({draft_id:draft.draftId,upload_id:staged.upload_id})}`;
    assert.equal(await (await request(download,null,editor)).text(),"remote PDF bytes");
    assert.equal((await request(download,null,admin)).status,409);assert.equal((await request(download,null,null,{Authorization:`Bearer ${editorToken.token}`})).status,401);
    const saved=await okay(await web("confirm",{draftId:draft.draftId,confirmed:true},editor));
    assert.equal((await web("confirm",{draftId:draft.draftId,confirmed:true},editor)).status,409);
    const file=(await files()).find(f=>f.id===saved.attachments[0].file_id);assert.equal(file.records[0].event_id,saved.id);assert.equal(file.records[0].kind,"reference");
    assert.equal(file.versions[0].status,"draft");assert.equal(file.versions[0].signing_completed_date,undefined);
    const query=await call("list_files",{matter_id:matter,query:"远程保密"},editorToken.token);assert.equal(query.files[0].file_id,file.id);assert.doesNotMatch(JSON.stringify(query),/archive_path|workspace_directory/);
    const details=await call("read_file",{matter_id:matter,file_id:file.id},editorToken.token);assert.equal(details.versions[0].version_id,file.current_version);
    const secret=(await files()).find(f=>f.project_ids.includes(restricted));assert.equal((await call("read_file",{matter_id:matter,file_id:secret.id},editorToken.token,true)).code,"forbidden");
    assert.equal((await call("submit_draft",await args(editorToken.token,[{mode:"existing",file_id:secret.id,version_id:secret.current_version,revision:secret.revision}]),editorToken.token,true)).code,"forbidden");
    // Direct save returns one receipt for the combined progress/file write, including retries.
    const signed=await stage("signed PDF bytes",direct.token);await okay(await upload(signed,"signed PDF bytes",direct.token));
    const directArgs=await args(direct.token,[{mode:"version",upload_id:signed.upload_id,file_id:file.id,revision:file.revision,status:"signed",agreement_date:"2026-10-20",signing_completed_date:"2026-10-28"}]);
    const result=await call("save_progress",directArgs,direct.token);assert.equal(result.status,"saved");assert.deepEqual(await call("save_progress",directArgs,direct.token),result);
    let updated=(await files()).find(f=>f.id===file.id);assert.equal(updated.versions.length,2);assert.equal(updated.records[0].version_id,file.current_version);assert.equal(updated.versions[1].signing_completed_date,"2026-10-28");
    const current=await call("read_progress",{matter_id:matter,progress_id:result.progress_id},direct.token);assert.equal(current.attachments[0].version_id,updated.current_version);
    // Same person on web cannot borrow an unconfirmed tool upload; browser and tool scopes differ.
    const spare=await stage("spare",editorToken.token);await okay(await upload(spare,"spare",editorToken.token));
    const opened=await okay(await request(`/api/workspace?action=record&kind=progress&id=&project_id=${matter}`,null,editor));
    const saveRequest={action:"save",kind:"progress",id:"",project_id:matter,revision:opened.revision,payload:{date:"2026-10-28",type:"other",title:"网页附件测试",summary:"测试",importance:"normal",participants:[],body:"",location:""},attachments:[newFile(spare)]};
    assert.equal((await request("/api/workspace",saveRequest,editor)).status,403);
    // Web uploads use the same combined save, with session/CSRF and matter checks.
    const browserUpload=(member,project=matter,headers={})=>{const form=new FormData();form.set("project_id",project);form.set("file",new File(["web file bytes"],"网页附件.txt"));return httpFetch(base+"/api/uploads",{method:"POST",headers:{Host:publicHost,Origin:publicOrigin,Cookie:member.cookie,"X-BD-CSRF":member.user.csrf,...headers},body:form});};
    assert.equal((await browserUpload(viewer)).status,403);assert.equal((await browserUpload(editor,restricted)).status,403);assert.equal((await browserUpload(editor,matter,{"X-BD-CSRF":"wrong"})).status,403);
    const webFile=await okay(await browserUpload(editor));
    assert.equal((await request("/api/workspace",{...saveRequest,attachments:[{mode:"upload",upload_id:webFile.upload_id,title:"网页附件",category:"other"}]},admin)).status,403);
    const webSaved=await okay(await request("/api/workspace",{...saveRequest,attachments:[{mode:"upload",upload_id:webFile.upload_id,title:"网页附件",category:"other"}]},editor));assert.equal(webSaved.attachments.length,1);
    // A file newly shared with a restricted matter invalidates the pending review too.
    updated=(await files()).find(f=>f.id===file.id);
    const sharedDraft=await call("submit_draft",await args(editorToken.token,[{mode:"existing",file_id:file.id,revision:updated.revision,version_id:file.current_version}]),editorToken.token);
    await okay(await request("/api/files",{action:"file_save",operation:"metadata",id:file.id,revision:updated.revision,payload:{project_ids:[matter,restricted]}},admin));
    assert.equal((await okay(await request("/api/remote?action=drafts",null,editor))).drafts.some(d=>d.id===sharedDraft.draftId),false);
    assert.equal((await web("confirm",{draftId:sharedDraft.draftId,confirmed:true},editor)).status,403);
    // Revocation immediately prevents bytes or metadata access, including uploads in flight.
    await okay(await web("revoke",{tokenId:editorToken.id},editor));
    assert.equal((await upload(spare,"spare",editorToken.token)).status,401);
    await configure(false);
  } finally {db.close();}
}
