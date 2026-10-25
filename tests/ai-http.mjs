import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Test-process-only transport: production code has no endpoint override or test bypass.
export function aiMockTransport(directory) {
  const output = path.join(directory, "model-output.json"), captured = path.join(directory, "model-requests.jsonl"), preload = path.join(directory, "ai-preload.cjs");
  writeFileSync(output, JSON.stringify({ kind: "clarify", message: "请补充实际日期。" }));
  writeFileSync(preload, `const fs=require('node:fs'); const original=globalThis.fetch;
    globalThis.fetch=async function(url,options){
      if(typeof url==='string' && ['api.openai.com','dashscope.aliyuncs.com'].includes(new URL(url).hostname)) {
        fs.appendFileSync(${JSON.stringify(captured)},JSON.stringify({url,body:JSON.parse(options.body)})+'\\n');
        const output=JSON.parse(fs.readFileSync(${JSON.stringify(output)},'utf8'));
        return Response.json({usage:{prompt_tokens:1200,completion_tokens:300,prompt_tokens_details:{cached_tokens:200}},choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});
      }
      return original(url,options);
    };`);
  return { preload, output, captured };
}

export async function exerciseAi({ directory, request, okay, admin, editor, viewer }) {
  const output = path.join(directory, "model-output.json"), captured = path.join(directory, "model-requests.jsonl");
  const model = value => writeFileSync(output, JSON.stringify(value));
  const project = "project-demo-partnership", restricted = "project-demo-investment";
  const ai = (input, actor = admin, headers) => request("/api/ai", input, actor, headers);
  const initial = await okay(await request("/api/ai?action=settings", null, admin));
  assert.equal((await okay(await ai(null))).settings, undefined, "Assistant status must not include administrator settings");
  for (const member of [editor, viewer]) assert.equal((await request("/api/ai?action=settings", null, member)).status, 403);
  assert.equal(initial.enabled, false); assert.equal(initial.settings.keyConfigured, false);
  assert.equal((await ai({ action: "chat", mode: "summary", message: "总结" })).status, 503);
  assert.equal(existsSync(captured), false);
  const configuration = { action: "configure", ...initial.settings, inputPriceCny: 2, cachedInputPriceCny: 0.5, outputPriceCny: 8, dailyBudgetCny: 20, enabled: true, apiKey: "test-private-provider-key", provider: "qwen-cn", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" };
  assert.equal((await ai(configuration, viewer)).status, 403);
  assert.equal((await ai(configuration, editor)).status, 403);
  assert.equal((await ai(configuration, admin, { "X-BD-CSRF": "fake" })).status, 403);
  assert.equal((await ai(configuration, admin, { Origin: "https://evil.invalid" })).status, 403);
  assert.equal((await ai({ ...configuration, baseUrl: "http://169.254.169.254/v1" })).status, 422);
  assert.equal((await ai({ ...configuration, apiKey: "" })).status, 422);
  let status = await okay(await ai(configuration));
  assert.equal(status.enabled, true); assert.equal(status.settings.keyConfigured, true);
  assert.doesNotMatch(JSON.stringify(status), /test-private-provider-key/);
  assert.doesNotMatch(readFileSync(path.join(directory, ".bd-ai/state.sqlite3")).toString(), /test-private-provider-key/);
  assert.equal((await okay(await ai(null, viewer))).settings, undefined);
  assert.equal((await ai({ ...configuration, revision: "initial" })).status, 409);
  const summarize = { action: "chat", mode: "summary", scope: project, from: "2020-01-01", to: "2030-01-01", message: "总结进展" };
  assert.equal((await ai({ ...summarize, scope: restricted }, viewer)).status, 403);
  assert.equal((await ai({ ...summarize, mode: "record" }, viewer)).status, 403);
  model({ points: [{ text: "整理已有沟通记录。", source_ids: ["source-1"] }] });
  const summary = await okay(await ai(summarize, viewer));
  assert.equal(summary.points[0].sources[0].projectId, project);
  const sent = readFileSync(captured, "utf8");
  assert.doesNotMatch(sent, /星帆创投|宋禾|顾远|project-demo-investment|demo_chenqing|phone|wechat/);
  assert.equal(summary.draft, undefined);
  model({ points: [{ text: "越权虚构", source_ids: [restricted] }] });
  assert.equal((await ai(summarize, viewer)).status, 422);
  const recordInput = { action: "chat", mode: "record", scope: project, message: "2026年10月22日交流，双方准备签署协议，尚未签署。" };
  model({ kind: "clarify", message: "请补充会议的实际日期。" });
  const clarify = await okay(await ai(recordInput, editor));
  assert.equal(clarify.draft, undefined); assert.ok(clarify.conversationId);
  const event = { date: "2026-10-22", type: "meeting", title: "讨论签约安排", summary: "双方准备签署协议，尚未签署。", participants: [], body: "# 交流记录\n\n双方准备签署协议，尚未签署。" };
  model({ kind: "progress", project_id: restricted, event });
  assert.equal((await ai(recordInput, editor)).status, 403);
  model({ kind: "progress", project_id: project, event });
  const before = await okay(await request(`/api/workspace?action=record&kind=project&id=${project}`, null, editor));
  const reply = await okay(await ai({ ...recordInput, conversationId: clarify.conversationId }, editor));
  assert.ok(reply.draft.id); assert.equal(reply.draft.payload.summary, event.summary);
  const previewed = await okay(await request(`/api/workspace?action=record&kind=project&id=${project}`, null, editor));
  assert.deepEqual(previewed, before, "Preview must not write events, files or history");
  const confirmation = { action: "confirm", draftId: reply.draft.id, confirmed: true, payload: { summary: "fake tamper" }, actor: { id: admin.user.id } };
  assert.equal((await ai({ ...confirmation, confirmed: false }, editor)).status, 422);
  assert.equal((await ai(confirmation, admin)).status, 409);
  assert.equal((await ai(confirmation, viewer)).status, 403);
  const concurrent = await Promise.all([ai(confirmation, editor), ai(confirmation, editor)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  for (const response of concurrent) await response.arrayBuffer();
  const saved = await okay(await request(`/api/workspace?action=record&kind=project&id=${project}`, null, editor));
  assert.equal(saved.record.events.length, before.record.events.length + 1);
  assert.equal(saved.record.events.at(-1).summary, event.summary);
  assert.doesNotMatch(JSON.stringify(saved), /fake tamper/);
  const history = await okay(await request(`/api/workspace?action=history&kind=project&id=${project}`, null, admin));
  assert.equal(history.versions[0].actor.id, editor.user.id);

  // Editing between preview and confirmation must not silently merge/overwrite.
  const stale = await okay(await ai(recordInput, editor));
  await okay(await request("/api/workspace", { action: "save", kind: "project", id: project, revision: saved.revision, payload: { ...saved.record.metadata, contacts: saved.record.contacts, body: saved.record.body + "\n另一位成员更新。" } }, editor));
  assert.equal((await ai({ action: "confirm", draftId: stale.draft.id, confirmed: true }, editor)).status, 409);
  assert.equal((await ai({ action: "confirm", draftId: stale.draft.id, confirmed: true }, editor)).status, 409);

  // A conversation correction replaces the previous draft; only the newest preview can be confirmed.
  const old = await okay(await ai(recordInput, editor));
  const revised = await okay(await ai({ ...recordInput, conversationId: old.conversationId, message: "保持尚未签署" }, editor));
  assert.equal((await ai({ action: "confirm", draftId: old.draft.id, confirmed: true }, editor)).status, 409);
  assert.ok(revised.draft);

  // New matter: unknown provenance stays unknown, and preview has no on-disk business effects.
  model({ kind: "project", project: { name: "AI录入测试事项", counterparty_id: "", counterparty_name: "虚构AI测试机构", counterparty_kind: "organization", record_type: "cooperation", category: ["研发合作"], stage: "initial_contact", follow_up_status: "awaiting_response", summary: "交流合作需求，尚未确认方案。", next_action: "未明确", first_contact: "", source_note: "来源未知" }, event: { ...event, participants: [] } });
  const newMatter = await okay(await ai({ ...recordInput, scope: "new" }));
  assert.equal(newMatter.draft.payload.first_contact, null);
  assert.deepEqual(newMatter.draft.payload.sourced_by, []);
  assert.equal(existsSync(path.join(directory, "content/counterparties/虚构AI测试机构")), false);
  const created = await okay(await ai({ action: "confirm", draftId: newMatter.draft.id, confirmed: true }));
  assert.ok(created.id.startsWith("project-"));
  assert.equal((await ai({ action: "confirm", draftId: newMatter.draft.id, confirmed: true })).status, 409);
  const privateView = await okay(await request("/api/workspace?action=workspace", null, viewer));
  assert.doesNotMatch(JSON.stringify(privateView), /虚构AI测试机构|AI录入测试事项/);

  // Selecting OpenAI requires its own key; it cannot reuse the Qwen credential.
  assert.equal((await ai({ ...configuration, ...status.settings, provider: "openai", baseUrl: "https://api.openai.com/v1", model: "configured-openai-text-model", apiKey: "" })).status, 422);
  status = await okay(await ai({ ...configuration, ...status.settings, provider: "openai", baseUrl: "https://api.openai.com/v1", model: "configured-openai-text-model", apiKey: "test-openai-key" }));
  model({ points: [{ text: "整理已有沟通记录。", source_ids: ["source-1"] }] });
  await okay(await ai(summarize));
  const last = JSON.parse(readFileSync(captured, "utf8").trim().split("\n").at(-1));
  assert.equal(last.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(last.body.model, "configured-openai-text-model"); assert.equal(last.body.store, false);
  const usageUrl = "/api/ai?action=usage&from=2020-01-01&to=2030-01-01";
  assert.equal((await request(usageUrl, null, viewer)).status, 403);
  assert.equal((await request(usageUrl, null, editor)).status, 403);
  // Use the workspace's actual current day; counts are recorded at request time, not event dates.
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const usage = await okay(await request(`/api/ai?action=usage&from=${today}&to=${today}`, null, admin));
  assert.ok(usage.rows.some(row => row.owner === editor.user.id && row.provider === "qwen-cn"));
  assert.ok(usage.rows.some(row => row.provider === "openai"));
  for (const row of usage.rows) {
    assert.equal(row.inputTokens, row.requests * 1200); assert.equal(row.outputTokens, row.requests * 300);
    assert.equal(row.cachedTokens, row.requests * 200); assert.equal(row.unknownUsage, 0);
    assert.ok(Math.abs(row.estimatedCny - row.requests * 0.0045) < 1e-10);
  }
  assert.doesNotMatch(JSON.stringify(usage), /test-private-provider-key|test-openai-key|讨论签约安排|尚未签署/);
  status = await okay(await ai({ action: "configure", ...status.settings, enabled: false }));
  const callCount = readFileSync(captured, "utf8").length;
  assert.equal((await ai(summarize)).status, 503);
  assert.equal((await ai({ action: "confirm", draftId: revised.draft.id, confirmed: true }, editor)).status, 503);
  assert.equal(readFileSync(captured, "utf8").length, callCount);
  assert.equal(status.enabled, false);
}
