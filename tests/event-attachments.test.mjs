import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import test from "node:test";
import ts from "typescript";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

const require = createRequire(import.meta.url);
async function compile(relative, dependencies = {}) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}});
  const exports = {};
  new Function("require", "exports", outputText)(name => dependencies[name] || require(name), exports);
  return exports;
}
const library = await compile("../dashboard/app/lib/file-library.ts", {"./workspace-client": {}});
const {default: Attachments} = await compile("../dashboard/app/EventAttachments.tsx", {"./lib/file-library": library});
const version = (id, filename) => ({id, filename, size: 2048, status: "unspecified"});
const file = {
  id: "poster", title: "会议海报", category: "other", archived: false,
  project_ids: ["a", "b"], current_version: "new",
  versions: [version("old", "原版海报.PNG"), version("new", "修订海报.png")],
  records: [
    {project_id: "a", event_id: "meeting", version_id: "old"},
    {project_id: "a", event_id: "meeting", version_id: "old"},
    {project_id: "b", event_id: "meeting", version_id: "new"},
  ],
};

test("inline attachments show exactly the versions used by this matter and event, without duplicate cards", () => {
  const linked = library.fileVersionsForEvent([file, {...file, id: "archived", archived: true}], "a", "meeting");
  assert.deepEqual(linked.map(item => [item.file.id, item.version.id, item.number]), [["poster", "old", 1]]);
  const html = renderToStaticMarkup(createElement(Attachments, {files: [file], matter: "a", event: "meeting", snapshot: "local:old/version"}));
  assert.equal((html.match(/<li /g) || []).length, 1);
  assert.match(html, /原版海报.PNG/);
  assert.match(html, /放大查看/);
  assert.match(html, /<img[^>]+preview=1&amp;snapshot=local%3Aold%2Fversion/);
  assert.match(html, /href="[^\"]+version_id=old&amp;snapshot=local%3Aold%2Fversion" download/);
  assert.doesNotMatch(html, /version_id=new|修订海报/);
  assert.equal(renderToStaticMarkup(createElement(Attachments, {files: [file], matter: "a", event: "unrelated"})), "");
});

test("PDF offers preview and download while Office documents remain downloadable", () => {
  const document = (id, filename) => ({...file, id, title: filename, versions: [version("doc", filename)], current_version: "doc", records: [{project_id: "a", event_id: "meeting", version_id: "doc"}]});
  const html = renderToStaticMarkup(createElement(Attachments, {files: [document("pdf", "协议.pdf"), document("word", "介绍.docx")], matter: "a", event: "meeting"}));
  assert.match(html, /id=pdf&amp;version_id=doc&amp;preview=1" target="_blank"/);
  assert.doesNotMatch(html, /id=word[^\"]*preview=1/);
  assert.equal((html.match(/ download=/g) || []).length, 2);
  assert.doesNotMatch(html, /<img/);
});
