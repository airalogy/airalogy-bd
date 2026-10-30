import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('..',import.meta.url));
const cache=process.env.BD_TEST_CACHE||path.join(root,'.uv-cache');
function setup(){
 const dir=mkdtempSync(path.join(tmpdir(),'bd-qa-')),content=path.join(dir,'content');cpSync(path.join(root,'fixtures/demo/content'),content,{recursive:true});
 const call=(input)=>{const r=spawnSync('uv',['run','--locked','--cache-dir',cache,path.join(root,'scripts/workspace_service.py'),'--content-dir',content],{input:JSON.stringify({action:'qa',...input}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const ok=(input)=>{const r=call(input);assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
 const read=(id='')=>ok({operation:'read',id});
 const write=(id,payload)=>ok({operation:'save',id,revision:read(id).revision,payload});
 const act=(operation,id,extra={})=>ok({operation,id,revision:read(id).revision,...extra});
 return {dir,content,call,ok,read,write,act,close:()=>rmSync(dir,{recursive:true,force:true})};
}
const payload={question:'产品与同类方案有什么区别？',aliases:['你们的竞争优势是什么？'],category:'competition',short_answer:'通用的数据记录能力。',body:'## 产品特点\n\n- 可配置协议\n- 结构化记录',data_as_of:'2026-10-30',sources:[{project_id:'project-demo-investment'}],files:[]};
test('investment Q&A keeps recommended answers stable and restores working revisions without rewriting meetings',()=>{
 const w=setup();try{
 const meeting=readFileSync(path.join(w.content,'counterparties/星帆创投/matters/融资对接/events.yaml'),'utf8');
 const saved=w.write('',payload),id=saved.id;assert.match(id,/^qa-[a-f0-9]{32}$/);assert.equal(w.read(id).record.status,'draft');
 const version=saved.status.version;w.act('publish',id);const approved=w.read(id).record.recommended;
 const staleRevision=w.read(id).revision;
 w.write(id,{...payload,short_answer:'优化后的产品回答。'});const next=w.read(id);assert.deepEqual(next.record.recommended,approved);assert.equal(next.record.has_changes,true);
 assert.equal(w.call({operation:'save',id,revision:staleRevision,payload}).code,'conflict');
 w.act('mark_stale',id);assert.equal(w.read(id).record.status,'needs_update');
 w.act('restore',id,{version});assert.equal(w.read(id).record.draft.short_answer,payload.short_answer);assert.deepEqual(w.read(id).record.recommended,approved);
 assert.ok(w.ok({operation:'history',id}).versions.length>=5);assert.equal(w.ok({operation:'version',id,version}).record.draft.body,payload.body);
 assert.equal(w.ok({operation:'list',query:'竞争优势'}).total,1);
 w.act('archive',id);assert.equal(w.ok({operation:'list'}).total,0);assert.equal(w.ok({operation:'list',state:'archived'}).total,1);
 assert.equal(w.call({operation:'save',id,revision:w.read(id).revision,payload}).code,'conflict');w.act('unarchive',id);
 assert.equal(readFileSync(path.join(w.content,'counterparties/星帆创投/matters/融资对接/events.yaml'),'utf8'),meeting);
 const dashboard=w.ok({action:'workspace'}).data;assert.ok(!JSON.stringify(dashboard).includes(payload.question));
 }finally{w.close();}
});
test('investment Q&A rejects duplicate aliases, malformed fields and unauthorized references before writes',()=>{
 const w=setup();try{
 w.write('',payload);
 for(const candidate of [{...payload,question:' 你们的竞争优势是什么？ ',aliases:[]},{...payload,category:[]},{...payload,data_as_of:'2026-02-30'},{...payload,sources:[{project_id:'missing'}]},{...payload,files:[{file_id:'missing',version_id:'missing'}]},{...payload,body:'x'.repeat(8001)}]){
 const r=w.call({operation:'save',revision:w.read().revision,payload:candidate});assert.equal(r.ok,false);assert.notEqual(r.code,'internal',JSON.stringify(r));
 }
 assert.equal(w.ok({operation:'list'}).total,1);
 const duplicateTarget=w.ok({operation:'list'}).items[0].id;w.act('archive',duplicateTarget);w.write('',payload);assert.equal(w.call({operation:'unarchive',id:duplicateTarget,revision:w.read(duplicateTarget).revision}).code,'duplicate');
 const noanswer=w.write('',{...payload,question:'融资用途？',aliases:[],short_answer:''});assert.equal(w.call({operation:'publish',id:noanswer.id,revision:w.read(noanswer.id).revision}).code,'invalid');
 assert.equal(w.call({operation:'read',id:'../../people.yaml'}).code,'invalid');
 const file=path.join(w.content,`investment-qa/${noanswer.id}/draft.md`);writeFileSync(file,readFileSync(file,'utf8').replace('category: competition','category: invalid'));
 const r=spawnSync('uv',['run','--locked','--cache-dir',cache,path.join(root,'scripts/validate.py'),'--content-dir',w.content],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/问答分类/);
 writeFileSync(file,"invalid frontmatter");const invalid=w.ok({action:"workspace"});assert.ok(invalid.status.errors.length>0);assert.ok(w.ok({action:"history"}).versions.some(v=>!v.valid));
 }finally{w.close();}
});
