import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
const root=fileURLToPath(new URL('..',import.meta.url));
mkdirSync(path.join(root,'.airalogy-bd'),{recursive:true});
const temporary=mkdtempSync(path.join(root,'.airalogy-bd','pdf-test-'));
const source=readFileSync(path.join(root,'dashboard/app/RecordPdfDocument.tsx'),'utf8');
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const modulePath=path.join(temporary,'document.mjs');writeFileSync(modulePath,javascript);
const {default:Document,recordPdfFilename}=await import(pathToFileURL(modulePath).href);
rmSync(temporary,{recursive:true,force:true});
const record={workspaceName:'示例工作台',sourceLabel:'合作对接',participants:['甲','乙'],historical:false,event:{id:'m1',date:'2026-11-11',title:'方案讨论',summary:'简要记录',participants:['person-1','person-2'],type:'meeting',importance:'normal',related_document:{path:'meetings/private.md',title:'会议原题',markdown:'## 原会议\n\n- 第一条\n- 第二条\n\n| 项目 | 状态 |\n| --- | --- |\n| 方案 | 讨论中 |\n\n<details><summary>说明</summary>完整内容</details>\n<script>alert(1)</script><img src="x" onerror="alert(2)">'}},phone:'NEVER_EXPORT_PHONE',file_path:'/private/NEVER_EXPORT_PATH'};
const supplement={id:'s1',title:'会后文案',date:'2026-11-12',body:'正文补充内容。',author:{name:'创建者'},updated_by:{name:'编辑者'},created_at:'2026-11-12T00:00:00Z',updated_at:'2026-11-12T01:00:00Z'};
test('record PDF is scoped to selected content with readable metadata and sanitized Markdown',()=>{
 const html=renderToStaticMarkup(createElement(Document,{record}));
 assert.match(html,/方案讨论/);assert.match(html,/参与人：甲、乙/);assert.match(html,/<ul>/);assert.match(html,/<table>/);assert.match(html,/<details open="">/);
 for(const value of ['NEVER_EXPORT','private.md','person-1','会后补充','onerror','<script','添加补充','编辑补充'])assert.ok(!html.includes(value),value);
});
test('supplements are opt-in, independently dated and preserve original content',()=>{
 const before=structuredClone(record);
 const html=renderToStaticMarkup(createElement(Document,{record,supplements:[supplement]}));
 assert.match(html,/会后补充/);assert.match(html,/补充日期：2026-11-12/);assert.match(html,/作者：创建者/);assert.match(html,/最近编辑：编辑者/);assert.match(html,/原会议/);assert.match(html,/正文补充内容/);assert.deepEqual(record,before);
});
test('summary-only and historical records export honestly with a safe default file name',()=>{
 const value={...record,historical:true,event:{...record.event,related_document:undefined,title:'方案/讨论:草稿'}};
 const html=renderToStaticMarkup(createElement(Document,{record:value}));
 assert.match(html,/简要记录/);assert.match(html,/历史版本记录/);assert.equal(recordPdfFilename(value.event),'2026-11-11-方案-讨论-草稿');
});
