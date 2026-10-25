import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../dashboard/app/lib/workspace-server.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

async function invokeWithChunks(chunks) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdout.end(); child.emit("close", null); };
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
    final(callback) {
      // Keep real stream decoding behavior while controlling pipe boundaries.
      child.stdout.once("end", () => child.emit("close", 0));
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      callback();
    },
  });
  const exports = {};
  const require = (id) => {
    if (id === "server-only") return {};
    if (id === "./auth-provider") return {verifiedSessionToken: () => {throw new Error("Local transport must not initialize server authentication");}};
    assert.equal(id, "node:child_process");
    return { spawn: () => child };
  };
  const process = { env: {
    BD_SERVICE_FILE: "/fixture/service.py",
    BD_CONTENT_DIR: "/fixture/content",
    BD_CACHE_DIR: "/fixture/cache",
  } };
  new Function("require", "exports", "process", outputText)(require, exports, process);
  return exports.invokeWorkspace({ action: "workspace" });
}

test("workspace responses preserve Chinese and other Unicode across every byte boundary", async () => {
  const expected = { ok: true, result: { summary: "讨论 AI 设计与基因合成、蛋白表达能力的结合。🧬 café" } };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (const width of [bytes.length, 1, 2, 7]) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += width) chunks.push(bytes.subarray(offset, offset + width));
    assert.deepEqual(await invokeWithChunks(chunks), expected, `chunk size ${width}`);
  }
});

test("large workspace responses preserve characters split at a pipe boundary", async () => {
  const prefix = '{"ok":true,"result":{"summary":"';
  const summary = "x".repeat(65536 - Buffer.byteLength(prefix) - 1) + "结合🧬";
  const expected = { ok: true, result: { summary } };
  const bytes = Buffer.from(JSON.stringify(expected));
  assert.deepEqual(await invokeWithChunks([bytes.subarray(0, 65536), bytes.subarray(65536)]), expected);
});

test("invalid service responses still produce a readable error", async () => {
  const result = await invokeWithChunks([Buffer.from("not JSON")]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "service");
});
