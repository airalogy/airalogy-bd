import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source=await readFile(new URL("../dashboard/app/lib/file-library.ts",import.meta.url),"utf8");
const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
const exports={};
new Function("require","exports",outputText)(()=>({}),exports);
const {matchesFileFilter,fileTypeLabel}=exports;

test("NDA filtering spans counterparties and searches its standard label without inferring type from names",()=>{
  const base={category:"agreement",title:"交流文件",organization:"示例机构",notes:"",versions:[{filename:"讨论稿.docx"}]};
  const first={...base,agreement_type:"nda"},second={...first,organization:"另一个机构"},legacy={...base,title:"NDA 草稿"};
  assert.deepEqual([first,second,legacy].filter(item=>matchesFileFilter(item,"nda")),[first,second]);
  for(const query of ["NDA","nda","保密协议","协议","讨论稿"])assert.equal(matchesFileFilter(first,"all",query),true);
  assert.equal(matchesFileFilter(first,"nda","另一个"),false);
  assert.equal(matchesFileFilter(first,"nda","别名","机构别名"),true);
  assert.equal(matchesFileFilter(first,"bp"),false);
  assert.equal(matchesFileFilter(legacy,"agreement"),true);
  assert.equal(fileTypeLabel(legacy),"协议");
});


test("investment cooperation agreements filter and search independently from NDA and signature status",()=>{
  const base={category:"agreement",title:"交流文件",organization:"示例机构",notes:"",versions:[{filename:"协议.pdf",status:"signed"}]};
  const investment={...base,agreement_type:"investment_cooperation"};
  const nda={...base,agreement_type:"nda"};
  const draft={...investment,versions:[{filename:"讨论稿.docx",status:"draft"}]};
  assert.equal(fileTypeLabel(investment),"协议 · 投资合作协议");
  assert.deepEqual([investment,nda,base,draft].filter(item=>matchesFileFilter(item,"investment_cooperation")),[investment,draft]);
  assert.equal(matchesFileFilter(investment,"all","投资合作协议"),true);
  assert.equal(matchesFileFilter(investment,"agreement"),true);
  assert.equal(matchesFileFilter(investment,"nda"),false);
  assert.equal(matchesFileFilter({...investment,category:"presentation"},"investment_cooperation"),false);
});

test("progress links count only active files attached to the same event and matter",()=>{
  const file={id:"one",archived:false,project_ids:["matter-a","matter-b"],records:[{project_id:"matter-a",event_id:"event-a"},{project_id:"matter-a",event_id:"event-a"}]};
  const archived={...file,id:"archived",archived:true};
  const otherMatter={...file,id:"other",records:[{project_id:"matter-b",event_id:"event-a"}]};
  assert.deepEqual(exports.filesForEvent([file,archived,otherMatter],"matter-a","event-a"),[file]);
  assert.deepEqual(exports.filesForEvent([file],"matter-a","event-without-files"),[]);
  assert.deepEqual(exports.filesForEvent([],"matter-a","event-a"),[]);
});

test("signing-date shortcuts default to blank and copy only an explicitly chosen agreement date",()=>{
  const {signingDateMode,chooseSigningDate,changeAgreementDate}=exports;
  assert.equal(signingDateMode({agreement_date:"2026-10-10"}),"unset");
  assert.throws(()=>chooseSigningDate({},"same"),/协议载明日期/);
  const original={agreement_date:"2026-10-10",signing_completed_date:"2026-10-15"};
  assert.equal(signingDateMode(original),"custom");
  const copied=chooseSigningDate(original,"same");
  assert.equal(copied.signing_completed_date,"2026-10-10");
  assert.equal(signingDateMode(copied),"same");
  const corrected=changeAgreementDate(copied,"2026-10-12");
  assert.equal(corrected.signing_completed_date,"2026-10-10");
  assert.equal(signingDateMode(corrected),"custom");
  const cleared=changeAgreementDate(copied,"");
  assert.equal(cleared.signing_completed_date,"2026-10-10");
  assert.equal(signingDateMode(cleared),"custom");
  assert.equal(chooseSigningDate(original,"unset").signing_completed_date,"");
  assert.deepEqual(chooseSigningDate(original,"custom"),original);
  assert.deepEqual(original,{agreement_date:"2026-10-10",signing_completed_date:"2026-10-15"});
});
