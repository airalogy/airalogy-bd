import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

export async function exerciseRecycle({request,okay,admin,editor,viewer,call,rpc,direct,clearRate}) {
  clearRate();
  const target={kind:"progress",id:"2026-01-15-solution-meeting",project_id:"project-demo-partnership"};
  const query=new URLSearchParams({action:"recycle",operation:"preview",...target});
  for(const member of [editor,viewer]) {
    assert.equal((await request("/api/workspace?action=recycle",null,member)).status,403);
    assert.equal((await request("/api/workspace?"+query,null,member)).status,403);
    assert.equal((await request("/api/workspace",{action:"recycle",operation:"archive",...target},member)).status,403);
    assert.equal((await request("/api/workspace",{action:"recycle",operation:"restore",...target},member)).status,403);
    const page=await request("/admin?section=recycle",null,member);
    assert.equal(new URL(page.url).pathname,"/");
    assert.doesNotMatch(await page.text(),/管理中心|确认移入回收站/);
  }
  assert.equal((await request("/api/workspace?action=recycle")).status,401);
  const preview=await okay(await request("/api/workspace?"+query,null,admin));
  const args={matter_id:target.project_id,progress_id:target.id};
  const before=await call("read_progress",args,direct.token);
  const archive={action:"recycle",operation:"archive",...target,revision:preview.revision,confirmed:true,request_id:randomUUID()};
  assert.equal((await request("/api/workspace",archive,admin,{"X-BD-CSRF":"wrong"})).status,403);
  assert.equal((await request("/api/workspace?"+query.toString().replace("operation=preview","operation=archive"),null,admin)).status,403);
  await okay(await request("/api/workspace",archive,admin));
  assert.equal((await okay(await request("/api/workspace",archive,admin))).replayed,true);
  const workspace=await okay(await request("/api/workspace?action=workspace",null,editor));
  assert.ok(!workspace.data.projects.find(p=>p.id===target.project_id).events.some(e=>e.id===target.id));
  for(const member of [admin,editor,viewer]) {
    const response=await request("/api/workspace?"+new URLSearchParams({action:"record",...target}),null,member);
    assert.equal((await response.json()).code,"archived");
  }
  await call("read_progress",args,direct.token,true);
  await call("read_meeting_supplements",{matter_id:target.project_id,meeting_id:target.id},direct.token,true);
  const tools=(await (await rpc("tools/list",{},direct.token)).json()).result.tools.map(t=>t.name);
  assert.ok(!tools.some(name=>/recycle|archive_progress|delete_matter/.test(name)));
  const listing=await okay(await request("/api/workspace?action=recycle",null,admin));
  const item=listing.items.find(i=>i.id===target.id);
  assert.equal(item.history.at(-1).actor.id,admin.user.id);
  await okay(await request("/api/workspace",{...archive,operation:"restore",revision:item.revision,request_id:randomUUID()},admin));
  const after=await call("read_progress",args,direct.token);
  assert.deepEqual(after.fields,before.fields);
  assert.deepEqual(after.attachments,before.attachments);
  clearRate();
}
