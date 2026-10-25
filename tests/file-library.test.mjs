import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const cache = process.env.BD_TEST_CACHE || path.join(root, ".uv-cache");
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-files-test-"));
  const content = path.join(directory, "content");
  cpSync(path.join(root, "fixtures/demo/content"), content, { recursive: true });
  const call = request => {
    const result = spawnSync("uv", ["run", "--offline", "--cache-dir", cache, "--locked", path.join(root,"scripts/workspace_service.py"), "--content-dir", content], {input:JSON.stringify(request),encoding:"utf8",maxBuffer:12_000_000});
    assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout);
  };
  const ok = request => {const result=call(request);assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
  const list = () => ok({action:"files"}).files;
  const save = (file,operation,payload={}) => ok({action:"file_save",id:file?.id || "",revision:file?.revision,operation,payload});
  const upload = (data="%PDF-1.4\nfirst bytes", file) => save(file,"upload",{title:"虚构资料",organization:"示例机构",category:"agreement",project_ids:["project-demo-partnership"],home_counterparty_id:"counterparty-917f1872213b3ab5",filename:"保密协议.pdf",data:Buffer.from(data).toString("base64"),status:"draft"});
  return {directory,content,call,ok,list,save,upload,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test("flat archives preserve source names, isolate documents and suffix only different bytes",()=>{
  const w=setup();try {
    const upload=(filename,bytes,file)=>w.save(file,"upload",{title:"同名协议",organization:"示例机构",category:"agreement",agreement_type:"nda",project_ids:["project-demo-partnership"],home_counterparty_id:"counterparty-917f1872213b3ab5",filename,data:Buffer.from(bytes).toString("base64"),status:"draft"});
    upload("协议 20261010.DOCX","first");let file=w.list()[0];
    const first=file.versions[0];
    assert.equal(first.archive_path,"counterparties/示例合作/attachments/agreements/同名协议/协议 20261010.DOCX");
    upload("协议 20261010.DOCX","second",file);file=w.list()[0];
    assert.equal(path.basename(file.versions[1].archive_path),"协议 20261010-v002.DOCX");
    upload("协议 20261010.DOCX","first",file);file=w.list()[0];
    assert.equal(file.versions[2].archive_path,first.archive_path);
    upload("协议 20261012.DOCX","third",file);file=w.list()[0];
    assert.equal(new Set(file.versions.map(v=>path.dirname(v.archive_path))).size,1);
    assert.equal(path.basename(file.versions[3].archive_path),"协议 20261012.DOCX");
    upload("协议 20261010.DOCX","another document");
    const other=w.list().find(f=>f.id!==file.id);
    assert.equal(path.basename(path.dirname(other.versions[0].archive_path)),"同名协议 (2)");
    assert.equal(readFileSync(path.join(w.content,first.archive_path),"utf8"),"first");
    // Missing visible files remain reserved by the index and cannot be overwritten by a new version.
    rmSync(path.join(w.content,first.archive_path));
    upload("协议 20261010.DOCX","fourth",file);file=w.list().find(f=>f.id===file.id);
    assert.match(path.basename(file.versions.at(-1).archive_path),/-v005\.DOCX$/);
    const longName="长".repeat(100)+".docx";
    upload(longName,"long one",file);file=w.list().find(f=>f.id===file.id);
    upload(longName,"long two",file);file=w.list().find(f=>f.id===file.id);
    assert.match(path.basename(file.versions.at(-1).archive_path),/-v007\.docx$/);
    assert.ok(Buffer.byteLength(path.basename(file.versions.at(-1).archive_path))<=240);
    assert.equal(file.versions.at(-1).filename,longName);
  } finally {w.close();}
});

test("NDA type is optional for legacy files and does not change matter stages",()=>{
  const w=setup();try {
    w.upload();let file=w.list()[0];
    // Simulate a previously saved schema-v1 index that predates agreement_type.
    const indexPath=path.join(w.content,"files.yaml");
    writeFileSync(indexPath,readFileSync(indexPath,"utf8").replace(/^\s+agreement_type:.*\n/m,""));
    file=w.list()[0];assert.equal(file.agreement_type,undefined);
    const matterBefore=w.ok({action:"record",kind:"project",id:"project-demo-partnership"}).record;
    w.save(file,"metadata",{agreement_type:"nda"});file=w.list()[0];
    assert.equal(file.agreement_type,"nda");
    assert.equal(w.ok({action:"workspace"}).data.files[0].agreement_type,"nda");
    w.save(file,"upload",{filename:"已签署协议.pdf",data:Buffer.from("signed bytes").toString("base64"),status:"signed"});file=w.list()[0];
    assert.equal(file.agreement_type,"nda");
    assert.deepEqual(w.ok({action:"record",kind:"project",id:"project-demo-partnership"}).record,matterBefore);
    assert.equal(w.call({action:"file_save",id:file.id,revision:file.revision,operation:"metadata",payload:{category:"bp",agreement_type:"nda"}}).ok,false);
    assert.equal(w.call({action:"file_save",id:file.id,revision:file.revision,operation:"metadata",payload:{agreement_type:"invented"}}).ok,false);
    w.save(file,"metadata",{category:"bp"});assert.equal(w.list()[0].agreement_type,"unspecified");
  } finally {w.close();}
});

function legacyPaths(w) {
  w.upload();let file=w.list()[0];
  w.save(file,"usage",{version_id:file.current_version,kind:"sent",date:"2026-10-08",project_id:"project-demo-partnership",people:["陈青"],channel:"微信"});
  file=w.list()[0];
  const version=file.versions[0],old=version.archive_path;
  version.archive_path=path.posix.dirname(old)+"-"+file.id.slice(-8)+"/v001-abcd1234-"+path.posix.basename(old);
  mkdirSync(path.dirname(path.join(w.content,version.archive_path)),{recursive:true});
  renameSync(path.join(w.content,old),path.join(w.content,version.archive_path));
  rmSync(path.join(w.content,path.posix.dirname(old)),{recursive:true});
  file.records[0].archive_path="counterparties/示例合作/attachments/interactions/20261008-sent/sent/abcd1234-保密协议.pdf";
  mkdirSync(path.dirname(path.join(w.content,file.records[0].archive_path)),{recursive:true});
  cpSync(path.join(w.content,version.archive_path),path.join(w.content,file.records[0].archive_path));
  delete file.revision;
  writeFileSync(path.join(w.content,"files.yaml"),JSON.stringify({schema_version:1,files:[file]}));
  return w.list()[0];
}

test("archive naming migration previews, backs up and preserves sent links and historical recovery",()=>{
  const w=setup();try {
    const old=legacyPaths(w), initial=w.ok({action:"workspace"});
    const preview=w.ok({action:"file_normalize_paths",id:old.id});
    assert.equal(preview.file_count,2);
    assert.equal(w.ok({action:"workspace"}).status.version,initial.status.version);
    assert.equal(path.basename(preview.changes[0].to),"保密协议.pdf");
    assert.equal(w.call({action:"file_normalize_paths",id:old.id,apply:true,plan_revision:"stale"}).code,"conflict");
    const applied=w.ok({action:"file_normalize_paths",id:old.id,apply:true,plan_revision:preview.plan_revision});
    assert.ok(applied.backup_id);assert.deepEqual(applied.retained_paths,[]);
    const current=w.list()[0];
    assert.equal(current.id,old.id);assert.equal(current.current_version,old.current_version);
    assert.equal(current.records[0].id,old.records[0].id);assert.equal(current.records[0].version_id,old.records[0].version_id);
    assert.equal(current.records[0].archive_path,undefined);
    assert.equal(new Set(preview.changes.map(change=>change.to)).size,1);
    assert.equal(w.ok({action:"file_location",id:current.id,record_id:current.records[0].id}).path,path.join(realpathSync(w.content),current.versions[0].archive_path));
    for(const change of preview.changes){assert.equal(existsSync(path.join(w.content,change.from)),false);assert.equal(readFileSync(path.join(w.content,change.to),"utf8"),"%PDF-1.4\nfirst bytes");}
    assert.equal(w.ok({action:"file_normalize_paths",id:old.id}).file_count,0);
    assert.equal(readFileSync(w.ok({action:"file_download",id:old.id,version_id:old.current_version,snapshot:initial.status.version}).path,"utf8"),"%PDF-1.4\nfirst bytes");
    const compare=w.ok({action:"compare",kind:"file",id:old.id,version:initial.status.version});
    w.ok({action:"restore",kind:"file",id:old.id,version:initial.status.version,revision:compare.revision});
    assert.equal(w.ok({action:"file_location",id:old.id,version_id:old.current_version}).path,path.join(realpathSync(w.content),old.versions[0].archive_path));
    assert.equal(w.ok({action:"file_location",id:old.id,record_id:old.records[0].id}).path,path.join(realpathSync(w.content),old.versions[0].archive_path));
    assert.equal(readFileSync(path.join(w.content,old.records[0].archive_path),"utf8"),"%PDF-1.4\nfirst bytes");
  } finally {w.close();}
});

test("migration refuses externally edited legacy copies and stale destination previews",()=>{
  const w=setup();try {
    const file=legacyPaths(w), source=path.join(w.content,file.versions[0].archive_path);
    const original=readFileSync(source);
    writeFileSync(source,"user edits");
    assert.equal(w.call({action:"file_normalize_paths",id:file.id}).code,"conflict");
    assert.equal(readFileSync(source,"utf8"),"user edits");
    writeFileSync(source,original);
    const legacyCopy=path.join(w.content,file.records[0].archive_path);
    writeFileSync(legacyCopy,"edited sent copy");
    assert.equal(w.call({action:"file_normalize_paths",id:file.id}).code,"conflict");
    assert.equal(readFileSync(legacyCopy,"utf8"),"edited sent copy");
    writeFileSync(legacyCopy,original);
    const preview=w.ok({action:"file_normalize_paths",id:file.id});
    const destination=path.join(w.content,preview.changes[0].to);
    mkdirSync(path.dirname(destination),{recursive:true});writeFileSync(destination,"unrelated existing file");
    assert.equal(w.call({action:"file_normalize_paths",id:file.id,apply:true,plan_revision:preview.plan_revision}).code,"conflict");
    assert.equal(readFileSync(destination,"utf8"),"unrelated existing file");
    assert.equal(existsSync(source),true);
  } finally {w.close();}
});

test("file locations resolve the sent version after updates without changing history",()=>{
  const w=setup();try {
    w.upload();let file=w.list()[0];const first=file.versions[0];
    w.save(file,"usage",{version_id:first.id,kind:"sent",date:"2026-10-08",project_id:"project-demo-partnership",people:["陈青"],channel:"微信"});
    file=w.list()[0];const sent=file.records[0];
    w.upload("second version",file);file=w.list()[0];
    const before=w.ok({action:"workspace"});
    for(const version of file.versions) assert.equal(w.ok({action:"file_location",id:file.id,version_id:version.id}).path,path.join(realpathSync(w.content),version.archive_path));
    assert.equal(w.ok({action:"file_location",id:file.id,record_id:sent.id}).path,path.join(realpathSync(w.content),first.archive_path));
    assert.equal(w.ok({action:"workspace"}).status.version,before.status.version);
    for(const request of [
      {id:file.id}, {id:file.id,version_id:first.id,record_id:sent.id},
      {id:"../../people.yaml",version_id:first.id}, {id:file.id,version_id:"missing"},
      {id:file.id,record_id:"missing"}, {id:file.id,path:path.join(w.content,"people.yaml")},
    ]) assert.equal(w.call({action:"file_location",...request}).ok,false);
    const visible=path.join(w.content,first.archive_path);
    rmSync(visible);
    assert.equal(w.call({action:"file_location",id:file.id,version_id:first.id}).code,"missing_file");
    assert.equal(w.call({action:"file_location",id:file.id,record_id:sent.id}).code,"missing_file");
    // Opening a folder must not silently recreate or overwrite the user's files.
    assert.equal(existsSync(visible),false);
    symlinkSync(path.join(w.content,"people.yaml"),visible);
    assert.equal(w.call({action:"file_location",id:file.id,version_id:first.id}).code,"unsafe_path");
    assert.equal(w.call({action:"file_location",id:file.id,record_id:sent.id}).code,"unsafe_path");
    rmSync(path.dirname(visible),{recursive:true});
    symlinkSync(w.directory,path.dirname(visible),"dir");
    assert.equal(w.call({action:"file_location",id:file.id,record_id:sent.id}).code,"unsafe_path");
  } finally {w.close();}
});

test("attachment versions and multiple recipients retain the exact sent bytes across updates and recovery",()=>{
  const w=setup();try {
    const first=w.upload();let file=w.list()[0];const v1=file.versions[0];
    assert.equal(v1.archive_path.split("/")[3],"agreements");
    assert.equal(v1.filename,"保密协议.pdf");
    w.save(file,"usage",{version_id:v1.id,kind:"sent",date:"2026-10-08",project_id:"project-demo-partnership",event_id:"",people:["陈青","林岚"],channel:"邮件",note:"虚构发送记录"});
    file=w.list()[0];w.upload("%PDF-1.4\nsecond bytes",file);file=w.list()[0];
    assert.equal(file.records[0].version_id,v1.id);assert.equal(file.records[0].people.length,2);
    assert.notEqual(file.current_version,v1.id);
    assert.equal(file.records[0].archive_path,undefined);
    assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/attachments/interactions")),false);
    const historical=w.ok({action:"historical",version:first.status.version});
    assert.equal(historical.data.files[0].versions.length,1);
    assert.equal(w.call({action:"file_download",id:file.id,version_id:file.current_version,snapshot:first.status.version}).code,"not_found");
    const oldDownload=w.ok({action:"file_download",id:file.id,version_id:v1.id,snapshot:first.status.version});
    assert.equal(readFileSync(oldDownload.path,"utf8"),"%PDF-1.4\nfirst bytes");
    const original=w.ok({action:"file_download",id:file.id,version_id:v1.id});assert.equal(readFileSync(original.path,"utf8"),"%PDF-1.4\nfirst bytes");
    assert.equal(readFileSync(w.ok({action:"file_location",id:file.id,record_id:file.records[0].id}).path,"utf8"),"%PDF-1.4\nfirst bytes");
    w.save(file,"select_version",{version_id:v1.id});file=w.list()[0];assert.equal(file.versions.length,2);assert.equal(file.current_version,v1.id);
    w.save(file,"archive");file=w.list()[0];assert.equal(file.archived,true);w.save(file,"unarchive");
    const history=w.ok({action:"history",kind:"file",id:file.id});assert.ok(history.versions.length>=5);
    const compare=w.ok({action:"compare",kind:"file",id:file.id,version:first.status.version});assert.equal(compare.can_restore,true);
    assert.ok(compare.changes.some(change=>change.label.includes("2026-10-08 · 实际发送")));
    assert.equal(compare.changes.some(change=>change.label.includes("use-")),false);
    w.ok({action:"restore",kind:"file",id:file.id,version:first.status.version,revision:compare.revision});assert.equal(w.list()[0].records.length,0);
    assert.equal(readFileSync(original.path,"utf8"),"%PDF-1.4\nfirst bytes");
  } finally {w.close();}
});

test("meeting, sent and received records reuse version files without adding disk copies",()=>{
  const w=setup();try {
    w.upload();let file=w.list()[0];const version=file.versions[0];
    const archive=path.join(w.content,"counterparties/示例合作/attachments");
    const paths=readdirSync(archive,{recursive:true}).sort();
    for(const kind of ["meeting","sent","received"]) {
      w.save(file,"usage",{version_id:version.id,kind,date:"2026-10-08",project_id:"project-demo-partnership",people:["陈青"],channel:"微信"});
      file=w.list()[0];
    }
    assert.equal(file.records.length,3);
    for(const record of file.records) {
      assert.equal(record.archive_path,undefined);
      assert.equal(w.ok({action:"file_location",id:file.id,record_id:record.id}).path,path.join(realpathSync(w.content),version.archive_path));
    }
    w.save(file,"usage",{...file.records[1],record_id:file.records[1].id,note:"更正发送说明"});file=w.list()[0];
    assert.equal(file.records.length,3);
    assert.deepEqual(readdirSync(archive,{recursive:true}).sort(),paths);
    assert.equal(readFileSync(path.join(w.content,version.archive_path),"utf8"),"%PDF-1.4\nfirst bytes");
  } finally {w.close();}
});

test("invalid and stale file edits cannot alter the index or immutable originals",()=>{
  const w=setup();try {
    w.upload();const file=w.list()[0], version=file.versions[0];
    w.save(file,"metadata",{title:"新的名称"});
    assert.equal(w.call({action:"file_save",id:file.id,revision:file.revision,operation:"archive"}).code,"conflict");
    const current=w.list()[0], original=readFileSync(path.join(w.content,"files.yaml"),"utf8");
    for(const payload of [
      {kind:"sent",version_id:version.id,date:"2026-10-08",project_id:"project-demo-partnership",people:[],channel:"邮件"},
      {kind:"sent",version_id:"missing",date:"2026-10-08",project_id:"project-demo-partnership",people:["陈青"],channel:"邮件"},
      {kind:"meeting",version_id:version.id,date:"2026-02-30",project_id:"project-demo-partnership",people:[]},
      {kind:"meeting",version_id:version.id,date:"2026-10-08",project_id:"project-demo-partnership",event_id:"missing",people:[]},
    ]) assert.equal(w.call({action:"file_save",id:file.id,revision:current.revision,operation:"usage",payload}).ok,false);
    assert.equal(readFileSync(path.join(w.content,"files.yaml"),"utf8"),original);
    assert.equal(w.call({action:"file_download",id:"../../people.yaml",version_id:version.id}).ok,false);
    const originalFile=w.ok({action:"file_download",id:file.id,version_id:version.id}).path;
    rmSync(originalFile);symlinkSync(path.join(w.content,"people.yaml"),originalFile);
    assert.equal(w.call({action:"file_download",id:file.id,version_id:version.id}).code,"unsafe_path");
    writeFileSync(path.join(w.content,"files.yaml"),"schema_version: 1\nfiles: [{}]\n");
    assert.equal(w.call({action:"files"}).ok,false);
  } finally {w.close();}
});

test("a complete backup restores files, prior versions and history into a new workspace",()=>{
  const w=setup();const destination=w.directory+"-restored";try {
    w.upload();let file=w.list()[0];
    w.save(file,"usage",{version_id:file.current_version,kind:"sent",date:"2026-10-08",project_id:"project-demo-partnership",people:["陈青"],channel:"微信"});file=w.list()[0];
    w.upload("%PDF-1.4\nsecond bytes",file);file=w.list()[0];w.save(file,"archive");
    const backup=w.ok({action:"file_backup"}),download=w.ok({action:"backup_download",id:backup.id});
    w.ok({action:"restore_backup",archive:download.path,destination});
    const invoke=request=>{
      const child=spawnSync("uv",["run","--offline","--cache-dir",cache,"--locked",path.join(root,"scripts/workspace_service.py"),"--content-dir",path.join(destination,"content")],{input:JSON.stringify(request),encoding:"utf8"});assert.equal(child.status,0,child.stderr);const response=JSON.parse(child.stdout);assert.equal(response.ok,true,child.stdout);return response.result;
    };
    const restored=invoke({action:"files"}).files[0];assert.equal(restored.archived,true);assert.equal(restored.versions.length,2);
    assert.equal(restored.records[0].archive_path,undefined);
    assert.equal(readFileSync(invoke({action:"file_location",id:restored.id,record_id:restored.records[0].id}).path,"utf8"),"%PDF-1.4\nfirst bytes");
    for(const [index,expected] of ["%PDF-1.4\nfirst bytes","%PDF-1.4\nsecond bytes"].entries()) {
      const result=invoke({action:"file_download",id:restored.id,version_id:restored.versions[index].id});assert.equal(readFileSync(result.path,"utf8"),expected);
    }
    assert.ok(invoke({action:"history",kind:"file",id:restored.id}).versions.length>=3);
    assert.equal(w.call({action:"restore_backup",archive:download.path,destination}).ok,false);
    writeFileSync(path.join(destination,"do-not-overwrite.txt"),"keep");
    assert.equal(w.call({action:"restore_backup",archive:download.path,destination}).ok,false);
    assert.equal(readFileSync(path.join(destination,"do-not-overwrite.txt"),"utf8"),"keep");
  } finally {w.close();rmSync(destination,{recursive:true,force:true});}
});


test("tampered backups fail before creating a restored workspace",()=>{
  const w=setup();const destination=w.directory+"-invalid";try {
    w.upload();const backup=w.ok({action:"file_backup"}),download=w.ok({action:"backup_download",id:backup.id});
    const tampered=path.join(w.directory,"tampered.zip");
    const result=spawnSync("python3",["-c",`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as output:
 for item in source.infolist():
  data=source.read(item)
  if "/.objects/" in item.filename: data=b"changed bytes"
  output.writestr(item,data)
`,download.path,tampered],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);
    const response=w.call({action:"restore_backup",archive:tampered,destination});assert.equal(response.ok,false);assert.match(response.error,/校验失败/);assert.equal(existsSync(destination),false);
  } finally {w.close();rmSync(destination,{recursive:true,force:true});}
});


test("shared files have one home beside the matter, and cannot access unrelated files",()=>{
  const w=setup();const outside=mkdtempSync(path.join(tmpdir(),"bd-unrelated-"));try {
    writeFileSync(path.join(outside,"unrelated.txt"),"company files stay outside");
    const listing=w.ok({action:"files"});
    assert.equal(listing.workspace_directory,realpathSync(w.directory));
    assert.equal(listing.directory_pattern,"content/counterparties/<对接方>/attachments/");
    w.upload();let file=w.list()[0];const version=file.versions[0];
    assert.ok(version.archive_path.startsWith("counterparties/示例合作/attachments/agreements/"));
    assert.equal(existsSync(path.join(w.directory,"attachments")),false);
    w.save(file,"metadata",{project_ids:["project-demo-partnership","project-demo-investment"]});file=w.list()[0];
    w.save(file,"usage",{version_id:version.id,kind:"meeting",date:"2026-10-08",project_id:"project-demo-investment",people:[]});file=w.list()[0];
    assert.equal(file.project_ids.length,2);assert.equal(w.list().length,1);
    assert.equal(file.records[0].archive_path,undefined);
    assert.equal(existsSync(path.join(w.content,"counterparties/星帆创投/attachments")),false);
    assert.equal(w.call({action:"file_save",id:file.id,revision:file.revision,operation:"metadata",payload:{home_counterparty_id:"counterparty-13414ee5502c4f23"}}).ok,false);
    assert.equal(w.call({action:"file_save",id:file.id,revision:file.revision,operation:"metadata",payload:{project_ids:["project-demo-investment"]}}).ok,false);
    const archive=path.join(w.content,"counterparties/示例合作/attachments");
    rmSync(archive,{recursive:true});symlinkSync(outside,archive,"dir");
    assert.equal(w.call({action:"file_download",id:file.id,version_id:version.id}).code,"unsafe_path");
    assert.equal(w.call({action:"file_backup"}).ok,false);
    assert.equal(readFileSync(path.join(outside,"unrelated.txt"),"utf8"),"company files stay outside");
  } finally {w.close();rmSync(outside,{recursive:true,force:true});}
});

test("Markdown attachments are not business records or text history, and are ignored by source Git",()=>{
  const w=setup();try {
    w.save(null,"upload",{title:"外部笔记",organization:"示例机构",category:"other",project_ids:["project-demo-partnership"],home_counterparty_id:"counterparty-917f1872213b3ab5",filename:"notes.md",data:Buffer.from("[外部链接](missing.pdf)\n--- not metadata").toString("base64")});
    const file=w.list()[0], version=file.versions[0];
    const before=w.ok({action:"workspace"});assert.equal(before.status.errors.length,0);
    writeFileSync(path.join(w.content,version.archive_path),"外部修改的展示副本");
    const after=w.ok({action:"workspace"});assert.equal(after.status.version,before.status.version);assert.equal(after.status.errors.length,0);
    assert.match(readFileSync(w.ok({action:"file_download",id:file.id,version_id:version.id}).path,"utf8"),/missing.pdf/);
    const validate=spawnSync("uv",["run","--offline","--cache-dir",cache,"--locked",path.join(root,"scripts/validate.py"),"--content-dir",w.content],{encoding:"utf8"});assert.equal(validate.status,0,validate.stderr);
    writeFileSync(path.join(w.directory,".gitignore"),"/content/counterparties/*/attachments/\n");
    assert.equal(spawnSync("git",["init",w.directory],{encoding:"utf8"}).status,0);
    const ignored=spawnSync("git",["-C",w.directory,"check-ignore",path.join(w.content,version.archive_path)],{encoding:"utf8"});assert.equal(ignored.status,0,ignored.stderr);
  } finally {w.close();}
});

test("restoring before matter creation keeps its archives, including across complete backup recovery",()=>{
  const w=setup();const destination=w.directory+"-orphan-restore";try {
    const baseline=w.ok({action:"workspace"});
    const existing=w.ok({action:"record",kind:"project",id:"project-demo-partnership"});
    const create=w.ok({action:"record",kind:"project",id:""});
    const project=w.ok({action:"save",kind:"project",id:"",revision:create.revision,payload:{...existing.record.metadata,name:"待回溯事项",body:"# 待回溯事项\n\n## 管理摘要\n\n虚构测试。",contacts:[{person_id:"林岚",side:"internal",project_roles:["project_owner"],notes:"测试"}],initial_event:{date:"2026-01-28",type:"contact",title:"虚构接触",summary:"虚构测试。",importance:"normal",participants:["林岚"],body:"",new_contacts:[]}}});
    const imported=w.save(null,"upload",{title:"历史文件",organization:"示例机构",category:"other",project_ids:[project.id],home_counterparty_id:existing.record.metadata.primary_counterparty_id,filename:"archive.txt",data:Buffer.from("retained historical bytes").toString("base64")});
    const file=w.list()[0],version=file.versions[0];
    const compare=w.ok({action:"compare",kind:"workspace",id:"",version:baseline.status.version});assert.equal(compare.can_restore,true);
    w.ok({action:"restore",kind:"workspace",id:"",version:baseline.status.version,revision:compare.revision});
    assert.equal(w.list().length,0);assert.equal(existsSync(path.join(w.content,"counterparties/示例合作/matters/待回溯事项/README.md")),false);
    assert.equal(readFileSync(path.join(w.content,version.archive_path),"utf8"),"retained historical bytes");
    const validate=spawnSync("uv",["run","--offline","--cache-dir",cache,"--locked",path.join(root,"scripts/validate.py"),"--content-dir",w.content],{encoding:"utf8"});assert.equal(validate.status,0,validate.stderr);
    const backup=w.ok({action:"file_backup"}),download=w.ok({action:"backup_download",id:backup.id});
    w.ok({action:"restore_backup",archive:download.path,destination});
    const invoke=request=>{const result=spawnSync("uv",["run","--offline","--cache-dir",cache,"--locked",path.join(root,"scripts/workspace_service.py"),"--content-dir",path.join(destination,"content")],{input:JSON.stringify(request),encoding:"utf8"});assert.equal(result.status,0,result.stderr);const response=JSON.parse(result.stdout);assert.equal(response.ok,true,result.stdout);return response.result;};
    const forward=invoke({action:"compare",kind:"workspace",id:"",version:imported.status.version});assert.equal(forward.can_restore,true);
    invoke({action:"restore",kind:"workspace",id:"",version:imported.status.version,revision:forward.revision});
    assert.equal(readFileSync(invoke({action:"file_download",id:file.id,version_id:version.id}).path,"utf8"),"retained historical bytes");
  } finally {w.close();rmSync(destination,{recursive:true,force:true});}
});


test("investment cooperation archives round-trip through versions and history without changing matter progress",()=>{
  const w=setup();try {
    const matterBefore=w.ok({action:"record",kind:"project",id:"project-demo-partnership"}).record;
    w.save(undefined,"upload",{title:"投资合作协议",organization:"示例机构",category:"agreement",agreement_type:"investment_cooperation",project_ids:["project-demo-partnership"],home_counterparty_id:"counterparty-917f1872213b3ab5",filename:"协议草案.pdf",data:Buffer.from("draft agreement bytes").toString("base64"),status:"draft"});
    let file=w.list()[0];
    assert.equal(file.agreement_type,"investment_cooperation");
    const initial=w.ok({action:"workspace"});
    w.save(file,"upload",{filename:"签署件.pdf",data:Buffer.from("signed agreement bytes").toString("base64"),status:"signed"});
    file=w.list()[0];
    assert.equal(file.agreement_type,"investment_cooperation");
    assert.equal(file.versions.length,2);
    assert.equal(file.versions[0].status,"draft");
    assert.equal(file.versions[1].status,"signed");
    const version=file.versions[1];
    assert.equal(readFileSync(w.ok({action:"file_download",id:file.id,version_id:version.id}).path,"utf8"),"signed agreement bytes");
    assert.equal(w.ok({action:"historical",version:initial.status.version}).data.files[0].agreement_type,"investment_cooperation");
    const fingerprint=version.sha256;
    w.save(file,"metadata",{notes:"已签署归档"});file=w.list()[0];
    assert.equal(file.versions[1].sha256,fingerprint);
    assert.deepEqual(w.ok({action:"record",kind:"project",id:"project-demo-partnership"}).record,matterBefore);
    assert.equal(w.call({action:"file_save",id:file.id,revision:file.revision,operation:"metadata",payload:{category:"presentation",agreement_type:"investment_cooperation"}}).ok,false);
  } finally {w.close();}
});
