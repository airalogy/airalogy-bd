import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
const lib = new URL("../dashboard/app/lib/", import.meta.url);
function load(name, overrides = {}, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);
  const source = readFileSync(new URL(`${name}.ts`, lib), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {}; cache.set(name, exports);
  new Function("require", "exports", js)(id => id in overrides ? overrides[id] : id === "server-only" ? {} : id.startsWith("./") ? load(id.slice(2), overrides, cache) : require(id), exports);
  return exports;
}
async function withStore(fn) {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-ai-unit-"));
  const previous = { ...process.env };
  process.env.BD_CONTENT_DIR = path.join(directory, "content");
  process.env.BD_MODE = "server"; process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  const { AiStore } = load("ai-store"); const store = new AiStore();
  try { await fn(store, directory); } finally { store.close(); process.env = previous; rmSync(directory, { recursive: true, force: true }); }
}

test("AI settings default off, encrypt credentials, reject stale updates, and expire actor-bound one-use drafts", async () => withStore(async (store, directory) => {
  assert.equal(store.settings().enabled, false);
  store.configure({ ...store.settings(), enabled: true, revision: "configured", apiKey: "secret-provider-key" }, "initial");
  assert.equal(store.settings().apiKey, "secret-provider-key");
  assert.doesNotMatch(readFileSync(path.join(directory, ".bd-ai/state.sqlite3")).toString(), /secret-provider-key/);
  assert.equal(statSync(path.join(directory, ".bd-ai/state.sqlite3")).mode & 0o777, 0o600);
  assert.throws(() => store.configure({ ...store.settings(), revision: "bad" }, "initial"), /其他管理员/);
  const draft = store.put("draft", "alice", "permission1", { note: "private meeting content" });
  assert.throws(() => store.get(draft.id, "draft", "bob", "permission1"), /已失效/);
  assert.throws(() => store.get(draft.id, "draft", "alice", "permission2"), /已失效/);
  assert.doesNotMatch(readFileSync(path.join(directory, ".bd-ai/state.sqlite3")).toString(), /private meeting content/);
  store.db.prepare("UPDATE transient SET expires=0 WHERE id=?").run(draft.id);
  assert.throws(() => store.get(draft.id, "draft", "alice", "permission1"), /已失效/);
  store.consume(draft.id); assert.throws(() => store.consume(draft.id), /已处理/);
}));

test("AI durable limits count failed/parallel reservations and reset on next workspace day", async () => withStore(async store => {
  store.reserve("alice", 2, "2026-10-22"); store.reserve("bob", 2, "2026-10-22");
  assert.throws(() => store.reserve("alice", 2, "2026-10-22"), /上限/);
  store.reserve("alice", 2, "2026-10-23");
  for (let i = 0; i < 8; i++) store.reserve("alice", 100, "2026-10-23");
  assert.throws(() => store.reserve("alice", 100, "2026-10-23"), /上限/);
}));

test("provider adapter only allows official OpenAI/China Qwen endpoints, never follows redirects", async () => {
  const { providerUrl, completeJson } = load("ai-provider");
  assert.equal(providerUrl("openai", "https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(providerUrl("qwen-cn", "https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"), "https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  for (const url of ["http://127.0.0.1/v1", "https://api.openai.com.evil.com/v1", "https://api.openai.com/v1?secret=1", "https://x:password@api.openai.com/v1", "https://api.openai.com:444/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"]) assert.throws(() => providerUrl("openai", url));
  assert.throws(() => providerUrl("qwen-cn", "https://workspace-id.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"));
  const original = globalThis.fetch;
  try {
    const requests = [];
    globalThis.fetch = async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }); };
    for (const [provider, baseUrl] of [["openai", "https://api.openai.com/v1"], ["qwen-cn", "https://dashscope.aliyuncs.com/compatible-mode/v1"]]) assert.deepEqual(await completeJson({ provider, baseUrl, model: "configured-model", apiKey: "private" }, [{ role: "user", content: "JSON" }]), { ok: true });
    assert.equal(requests[0].body.store, false); assert.equal(requests[0].body.max_completion_tokens, 8000);
    assert.equal(requests[1].body.enable_thinking, false); assert.equal(requests[1].body.max_tokens, 4000);
    assert.equal(requests[0].options.redirect, "error"); assert.equal(requests[1].options.redirect, "error");
    assert.equal(requests[0].body.tools, undefined);
  } finally { globalThis.fetch = original; }
});

test("provider failures, refusals, truncated JSON and oversize results fail closed without echoing secrets", async () => {
  const { completeJson } = load("ai-provider"), original = globalThis.fetch;
  const settings = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "example", apiKey: "secret-test" };
  try {
    for (const response of [new Response("secret-test", { status: 401 }), Response.json({ choices: [{ finish_reason: "length", message: { content: '{}' } }] }), Response.json({ choices: [{ finish_reason: "stop", message: { refusal: "secret-test", content: '{}' } }] }), Response.json({ choices: [{ finish_reason: "stop", message: { content: 'not-json secret-test' } }] }), new Response("secret-test".repeat(30000))]) {
      globalThis.fetch = async () => response;
      await assert.rejects(completeJson(settings, []), error => !error.message.includes("secret-test"));
    }
    globalThis.fetch = async () => { throw new Error("secret-test network error"); };
    await assert.rejects(completeJson(settings, []), error => !error.message.includes("secret-test"));
  } finally { globalThis.fetch = original; }
});

test("provider usage is recorded even when a paid completion is refused or truncated", async () => {
  const { completeJson } = load("ai-provider"), original = globalThis.fetch;
  const settings = { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "example", apiKey: "fake" };
  try {
    for (const choice of [{ finish_reason: "length", message: { content: '{' } }, { finish_reason: "stop", message: { refusal: "declined", content: null } }]) {
      let reported;
      globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 120, completion_tokens: 40 }, choices: [choice] });
      await assert.rejects(completeJson(settings, [], value => { reported = value; }));
      assert.deepEqual(reported, { inputTokens: 120, outputTokens: 40, cachedTokens: 0 });
    }
  } finally { globalThis.fetch = original; }
});

async function withService(fn) {
  return withStore(async store => {
    store.configure({ ...store.settings(), enabled: true, apiKey: "fake", revision: "r1" }, "initial");
    const data = JSON.parse(readFileSync(new URL("../fixtures/demo/content/generated/dashboard.json", import.meta.url), "utf8"));
    data.projects = data.projects.filter(p => p.id === "project-demo-partnership");
    data.counterparties = data.counterparties.filter(p => p.matter_ids.includes("project-demo-partnership"));
    const state = { calls: 0, revoked: false, changed: false, output: { kind: "clarify", message: "请提供日期。" } };
    const user = { id: "editor", role: "editor", revision: "p1" };
    const service = load("ai-service", {
      "./ai-provider": { providerUrl: load("ai-provider").providerUrl, completeJson: async () => { state.calls++; if (state.afterModel) state.afterModel(); return state.output; } },
      "./workspace-server": { invokeWorkspace: async request => {
        if (request.action === "auth_session") return state.revoked ? { ok: false, code: "unauthenticated", error: "请重新登录" } : { ok: true, result: user };
        if (request.action === "workspace") return { ok: true, result: { status: { revision: state.changed ? "new" : "old", errors: [] }, data } };
        throw new Error(`Unexpected mutation: ${request.action}`);
      } },
    });
    await fn({ store, state, service, access: { session: "verified-cookie", user } });
  });
}

test("AI rejects inaccessible scope and viewer recording before any model request", async () => withService(async ({ store, state, service, access }) => {
  for (const input of [{ mode: "record", scope: "project-demo-investment" }, { mode: "summary", scope: "project-demo-investment" }, { mode: "record", scope: "new" }]) await assert.rejects(service.aiChat(store, access, { ...input, message: "test" }), error => error.code === "forbidden");
  await assert.rejects(service.aiChat(store, { ...access, user: { ...access.user, role: "viewer" } }, { mode: "record", scope: "", message: "test" }), error => error.code === "forbidden");
  assert.equal(state.calls, 0);
}));

test("AI drops in-flight results when member access, content, or administrator settings change", async () => withService(async ({ store, state, service, access }) => {
  const input = { mode: "record", scope: "project-demo-partnership", message: "请录入进展" };
  state.afterModel = () => { state.revoked = true; };
  await assert.rejects(service.aiChat(store, access, input), error => error.code === "unauthenticated");
  state.revoked = false; state.afterModel = () => { state.changed = true; };
  await assert.rejects(service.aiChat(store, access, input), error => error.code === "conflict");
  state.changed = false; state.afterModel = () => store.configure({ ...store.settings(), enabled: false, revision: "off" }, "r1");
  await assert.rejects(service.aiChat(store, access, input), error => error.code === "unavailable");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM transient").get().n, 0);
}));

test("model-supplied arbitrary actions and fabricated citations cannot become writes or links", async () => withService(async ({ store, state, service, access }) => {
  state.output = { kind: "save", action: "team_update", payload: { role: "admin" } };
  await assert.rejects(service.aiChat(store, access, { mode: "record", scope: "", message: "test" }));
  state.output = { points: [{ text: "secret", source_ids: ["https://attacker.invalid"] }] };
  await assert.rejects(service.aiChat(store, access, { mode: "summary", scope: "", from: "2020-01-01", to: "2030-01-01", message: "test" }));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM transient").get().n, 0);
}));

test("token metering uses reported counts, includes cache once and rejects malformed usage", () => {
  const { parseTokenUsage, estimateCost } = load("ai-meter");
  assert.deepEqual(parseTokenUsage({ prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 100 } }), { inputTokens: 1200, outputTokens: 300, cachedTokens: 200 });
  for (const usage of [null, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: "5", completion_tokens: 2 }, { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6 } }]) assert.equal(parseTokenUsage(usage), null);
  const usage = { inputTokens: 1200, outputTokens: 300, cachedTokens: 200 };
  assert.equal(estimateCost(usage, { inputPriceCny: 2, cachedInputPriceCny: 0.5, outputPriceCny: 8 }), 0.0045);
  assert.equal(estimateCost(usage, { inputPriceCny: 2, cachedInputPriceCny: null, outputPriceCny: 8 }), 0.0048);
  assert.equal(estimateCost(usage, { inputPriceCny: null, cachedInputPriceCny: null, outputPriceCny: 8 }), null);
});

test("cost ledger freezes prices, attributes actual tokens to a member/model, and marks unreported usage", async () => withStore(async store => {
  const settings = { ...store.settings(), enabled: true, apiKey: "fake", inputPriceCny: 2, cachedInputPriceCny: 0.5, outputPriceCny: 8, dailyBudgetCny: 10 };
  const id = store.reserve("alice", 100, "2026-10-22", { settings, member: "Alice", inputBound: 2000 });
  assert.throws(() => store.reserve("alice", 100, "2026-10-22", { settings, member: "Alice", inputBound: 2000 }), /正在处理/);
  store.configure({ ...settings, inputPriceCny: 100, revision: "new-price" }, "initial");
  store.reportUsage(id, { inputTokens: 1200, outputTokens: 300, cachedTokens: 200 });
  store.finishRequest(id, "success");
  let rows = store.usageReport("2026-10-22", "2026-10-22").rows;
  assert.equal(rows[0].inputTokens, 1200); assert.equal(rows[0].outputTokens, 300); assert.equal(rows[0].cachedTokens, 200);
  assert.equal(rows[0].estimatedCny, 0.0045); assert.equal(rows[0].member, "Alice"); assert.equal(rows[0].model, settings.model);
  const unknown = store.reserve("bob", 100, "2026-10-22", { settings, member: "Bob", inputBound: 2000 });
  store.finishRequest(unknown, "failed");
  rows = store.usageReport("2026-10-22", "2026-10-22").rows;
  const bob = rows.find(row => row.owner === "bob");
  assert.equal(bob.unknownUsage, 1); assert.equal(bob.unpriced, 1); assert.equal(bob.failures, 1);
  assert.equal(bob.heldTokens, 6000); assert.ok(bob.heldCny > 0);
}));

test("daily token and CNY budgets reserve concurrent and unknown requests before network access", async () => withStore(async store => {
  const settings = { ...store.settings(), dailyTokenLimit: 6000, inputPriceCny: 1, outputPriceCny: 1, dailyBudgetCny: 0.006 };
  const args = { settings, member: "Member", inputBound: 1000 };
  const id = store.reserve("alice", 100, "2026-10-22", args);
  assert.throws(() => store.reserve("bob", 100, "2026-10-22", args), /Token/);
  store.reportUsage(id, { inputTokens: 100, outputTokens: 100, cachedTokens: 0 }); store.finishRequest(id, "success");
  const next = store.reserve("bob", 100, "2026-10-22", args); store.finishRequest(next, "failed");
  assert.throws(() => store.reserve("charlie", 100, "2026-10-22", args), /Token/);
  assert.throws(() => store.reserve("charlie", 100, "2026-10-22", { ...args, settings: { ...settings, dailyTokenLimit: null, dailyBudgetCny: 0.006 } }), /费用额度/);
  const free = store.reserve("alice", 100, "2026-10-23", args); assert.ok(free);
}));

test("usage statistics are denied to non-admin accounts regardless of matter access", async () => withService(async ({ store, service, access }) => {
  assert.throws(() => service.aiUsage(store, access, "2026-10-01", "2026-10-31"), error => error.code === "forbidden");
  assert.deepEqual(service.aiUsage(store, { ...access, user: { ...access.user, role: "admin" } }, "2026-10-01", "2026-10-31").rows, []);
}));
