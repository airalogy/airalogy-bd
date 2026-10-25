import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('..',import.meta.url));
const cache=process.env.BD_TEST_CACHE || path.join(root,'.uv-cache');
function setup(){
  const directory=realpathSync(mkdtempSync(path.join(tmpdir(),'bd-history-upgrade-test-')));
  const workspace=path.join(directory,'workspace'); const content=path.join(workspace,'content');
  cpSync(path.join(root,'fixtures/demo/content'),content,{recursive:true});
  const call=(request,at)=>{const env={...process.env,...(at ? {GIT_AUTHOR_DATE:at,GIT_COMMITTER_DATE:at} : {})};const result=spawnSync('uv',['run','--cache-dir',cache,'--locked',path.join(root,'scripts/workspace_service.py'),'--content-dir',content],{env,input:JSON.stringify(request),encoding:'utf8',maxBuffer:12_000_000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  const ok=(request,at)=>{const result=call(request,at);assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
  const change=text=>{const file=path.join(content,'people.yaml');writeFileSync(file,readFileSync(file,'utf8').replace(/wechat: .*/,`wechat: ${text}`));};
  const store=()=>path.join(workspace,'.bd-history',readdirSync(path.join(workspace,'.bd-history'))[0]);
  return {directory,workspace,content,call,ok,change,store,close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('as-of browse uses save time and workspace midnight; views do not mutate current files or history',()=>{
  const w=setup();try{
    const first=w.ok({action:'checkpoint'},'2026-01-01T15:59:59Z');
    w.change('after-midnight');const second=w.ok({action:'checkpoint'},'2026-01-01T16:00:00Z');
    const live=w.ok({action:'workspace'});const state=readFileSync(path.join(w.store(),'state.json'),'utf8');
    const old=w.ok({action:'historical',date:'2026-01-01'});
    assert.equal(old.version.version,first.version);assert.notEqual(old.data.people.find(p=>p.id==='陈青').wechat,'after-midnight');
    assert.equal(w.ok({action:'historical',date:'2026-01-02'}).version.version,second.version);
    assert.equal(w.ok({action:'historical',date:'2026-01-15'}).version.version,second.version);
    assert.equal(w.call({action:'historical',date:'2025-12-31'}).code,'not_found');
    assert.equal(w.call({action:'historical',date:'2026-02-30'}).ok,false);
    assert.equal(w.ok({action:'historical',version:first.version}).data.updated_at,old.data.updated_at);
    assert.equal(readFileSync(path.join(w.store(),'state.json'),'utf8'),state);
    assert.equal(w.ok({action:'workspace'}).status.version,live.status.version);
    assert.equal(JSON.parse(readFileSync(path.join(w.content,'generated/dashboard.json'),'utf8')).people.find(p=>p.id==='陈青').wechat,'after-midnight');
  }finally{w.close();}
});
test('invalid saved versions are not silently replaced and current format errors do not prevent browsing older data',()=>{
  const w=setup();try{
    const first=w.ok({action:'checkpoint'},'2026-01-01T00:00:00Z');
    writeFileSync(path.join(w.content,'people.yaml'),'people: [broken');
    w.ok({action:'checkpoint'},'2026-01-04T00:00:00Z');
    assert.equal(w.call({action:'historical',date:'2026-01-04'}).code,'validation');
    assert.equal(w.ok({action:'historical',version:first.version}).data.people.length,4);
    assert.equal(readFileSync(path.join(w.content,'people.yaml'),'utf8'),'people: [broken');
  }finally{w.close();}
});
test('as-of browse includes original repository versions and normalizes timestamp offsets',()=>{
  const w=setup();try{
    const git=(args,at)=>{const result=spawnSync('git',args,{cwd:w.workspace,encoding:'utf8',env:{...process.env,GIT_AUTHOR_DATE:at,GIT_COMMITTER_DATE:at}});assert.equal(result.status,0,result.stderr);};
    git(['init'],'2026-01-01T08:00:00+08:00');git(['config','user.name','Test'],'2026-01-01T08:00:00+08:00');git(['config','user.email','test@example.invalid'],'2026-01-01T08:00:00+08:00');git(['add','content'],'2026-01-01T08:00:00+08:00');git(['-c','commit.gpgsign=false','commit','-m','Initial content'],'2026-01-01T08:00:00+08:00');
    w.change('new-local');w.ok({action:'checkpoint'},'2026-01-01T01:00:00Z');
    const all=w.ok({action:'history'});assert.match(all.versions[0].version,/^local:/);
    assert.match(w.ok({action:'historical',version:all.versions[1].version}).version.version,/^repo:/);
    const backup=w.ok({action:'file_backup'});const exported=w.ok({action:'backup_download',id:backup.id});
    const destination=path.join(w.directory,'restored-git');w.ok({action:'restore_backup',archive:exported.path,destination});
    const result=spawnSync('uv',['run','--cache-dir',cache,'--locked',path.join(root,'scripts/workspace_service.py'),'--content-dir',path.join(destination,'content')],{input:JSON.stringify({action:'historical',version:all.versions[1].version}),encoding:'utf8'});
    assert.equal(JSON.parse(result.stdout).ok,true,result.stdout);
    assert.notEqual(JSON.parse(result.stdout).result.data.people.find(p=>p.id==='陈青').wechat,'new-local');
  }finally{w.close();}
});
test('automatic backup validates destination, records success, suppresses redundant work and restores independently',()=>{
  const w=setup();try{
    w.ok({action:'checkpoint'});let status=w.ok({action:'backup_status'});
    const directory=path.join(w.directory,'backups');
    assert.equal(w.call({action:'backup_config',revision:status.revision,config:{enabled:true,directory:w.content,interval_minutes:60}}).ok,false);
    symlinkSync(w.workspace,path.join(w.directory,'redirect'));
    assert.equal(w.call({action:'backup_config',revision:status.revision,config:{enabled:true,directory:path.join(w.directory,'redirect/backups'),interval_minutes:60}}).ok,false);
    status=w.ok({action:'backup_config',revision:status.revision,config:{enabled:true,directory,interval_minutes:60}});
    const backed=w.ok({action:'backup_tick'});assert.equal(backed.error,'');assert.ok(existsSync(backed.last_success.path));assert.equal(readdirSync(directory).length,1);
    w.ok({action:'backup_tick'});w.change('later');w.ok({action:'backup_tick'});assert.equal(readdirSync(directory).length,1);
    const stateFile=path.join(w.store(),'backup-state.json');const state=JSON.parse(readFileSync(stateFile,'utf8'));state.last_success.at='2026-01-01T00:00:00Z';writeFileSync(stateFile,JSON.stringify(state));
    const later=w.ok({action:'backup_tick'});assert.equal(readdirSync(directory).length,2);assert.notEqual(later.last_success.version,backed.last_success.version);
    const restored=path.join(w.directory,'restored');w.ok({action:'restore_backup',archive:backed.last_success.path,destination:restored});
    assert.notEqual(readFileSync(path.join(restored,'content/people.yaml'),'utf8'),readFileSync(path.join(w.content,'people.yaml'),'utf8'));
    assert.equal(w.call({action:'backup_config',revision:'stale',config:status.config}).code,'conflict');
  }finally{w.close();}
});
test('backup failure is visible without overwriting data or discarding the previous backup',()=>{
  const w=setup();try{
    w.ok({action:'checkpoint'});let status=w.ok({action:'backup_status'});
    const directory=path.join(w.directory,'backups');w.ok({action:'backup_config',revision:status.revision,config:{enabled:true,directory,interval_minutes:60}});
    const previous=w.ok({action:'backup_now'});
    status=w.ok({action:'backup_status'});w.ok({action:'backup_config',revision:status.revision,config:{...status.config,directory:path.join(w.directory,'unavailable/subdir')}});
    writeFileSync(path.join(w.directory,'unavailable'),'a file blocks this directory');
    const before=readFileSync(path.join(w.content,'people.yaml'),'utf8');const failed=w.ok({action:'backup_now'});
    assert.ok(failed.error);assert.equal(failed.last_success.path,previous.last_success.path);assert.ok(existsSync(previous.last_success.path));assert.equal(readFileSync(path.join(w.content,'people.yaml'),'utf8'),before);
    assert.equal(w.ok({action:'workspace'}).status.errors.length,0);
  }finally{w.close();}
});
test('offline edit command captures changes even when the editing command fails',()=>{
  const w=setup();try{
    symlinkSync(cache,path.join(w.workspace,'.uv-cache'));
    const result=spawnSync(process.execPath,[path.join(root,'bin/bd.mjs'),'edit','--label','AI test','--',process.execPath,'-e',`const fs=require('fs');const p='content/people.yaml';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('demo_chenqing','failed-edit-kept'));process.exit(7);`],{cwd:w.workspace,encoding:'utf8'});
    assert.equal(result.status,7,result.stderr);const history=w.ok({action:'history'});
    assert.equal(history.total,2);assert.equal(history.versions[0].label,'AI test：编辑后');
    assert.equal(w.ok({action:'historical',version:history.versions[1].version}).data.people.find(p=>p.id==='陈青').wechat,'demo_chenqing');
    assert.equal(w.ok({action:'workspace'}).data.people.find(p=>p.id==='陈青').wechat,'failed-edit-kept');
  }finally{w.close();}
});
