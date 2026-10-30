import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function exerciseRemotePeople({directory,request,okay,web,rpc,call,newDraft,admin,editor,writable,readonly}) {
  const people=()=>readFileSync(path.join(directory,'content/people.yaml'),'utf8');
  const changes=name=>({date:'2026-10-30',type:'meeting',title:'外部工具补充参与人',summary:'讨论示例合作需求。',body:'讨论示例合作需求。',participants:[name],new_people:[{name,affiliation:'示例实验室',phone:'001-321'}],new_contacts:[{person_id:name,side:'counterparty',project_roles:['participant'],notes:'本次交流参与人'}]});
  const before=people();
  const staged=await newDraft(writable.token,{changes:changes('程冬')});
  assert.equal(people(),before,'Draft creation must not persist profiles');
  const review=await okay(await request('/api/remote?action=drafts',null,editor));
  const item=review.drafts.find(item=>item.id===staged.draft.draftId);
  assert.equal(item.changes.find(change=>change.field==='new_people').after[0].name,'程冬');
  assert.equal(item.changes.find(change=>change.field==='new_contacts').after[0].person_id,'程冬');
  assert.equal((await web('confirm',{draftId:staged.draft.draftId,confirmed:true},admin)).status,409);
  assert.ok((await (await rpc('tools/call',{name:'save_progress',arguments:staged.args},writable.token)).json()).error,'Editors never gain direct saves');
  assert.ok((await (await rpc('tools/call',{name:'submit_draft',arguments:staged.args},readonly.token)).json()).error);
  await okay(await web('confirm',{draftId:staged.draft.draftId,confirmed:true},editor));
  assert.match(people(),/程冬/);
  const saved=people();
  assert.equal((await call('submit_draft',staged.args,writable.token)).status,'saved');
  assert.equal(people(),saved,'Retry must return the receipt without duplicating the profile');
  const dashboard=await okay(await request('/api/workspace?action=workspace',null,editor));
  assert.equal(dashboard.data.people.find(person=>person.id==='程冬').phone,'001-321');
  const rejected=await newDraft(writable.token,{changes:changes('程未存')});
  await okay(await web('reject',{draftId:rejected.draft.draftId},editor));
  assert.equal(people(),saved,'Rejected drafts must leave no profile');
  const current=await call('read_matter',{matter_id:'project-demo-partnership'},writable.token);
  const hidden=await call('submit_draft',{...staged.args,request_id:randomUUID(),revision:current.revision,changes:changes('宋禾')},writable.token,true);
  assert.equal(hidden.code,'duplicate');
  assert.doesNotMatch(JSON.stringify(hidden),/星帆|投资经理|songhe|example\.invalid/);
  // A profile may appear after draft preparation without changing the matter revision.
  const raced=await newDraft(writable.token,{changes:changes('程同名')});
  const person=await okay(await request('/api/workspace?action=record&kind=person&id=',null,admin));
  await okay(await request('/api/workspace',{action:'save',kind:'person',id:'',revision:person.revision,payload:{name:'程同名',affiliation:'另一机构',phone:'001-999',wechat:null,email:null}},admin));
  const racedSnapshot=people();
  const conflict=await web('confirm',{draftId:raced.draft.draftId,confirmed:true},editor);
  assert.equal(conflict.status,409);
  assert.doesNotMatch(await conflict.text(),/另一机构|001-999/);
  assert.equal(people(),racedSnapshot,'Confirmation must recheck the profile and never overwrite it');
  await okay(await web('reject',{draftId:raced.draft.draftId},editor));
}
