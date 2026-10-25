import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../dashboard/app/lib/weekly-report.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const {
  adjacentReportWeek, buildWeeklyReport, weekForDate, previousWeek, validReportPeriod, workspaceToday,
  weeklyReportToText, weeklyReportToHtml, weeklyReportToMarkdown, weeklyReportFilename,
} = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));

const period = { from: "2026-09-21", to: "2026-09-27" };
const event = (id, date, participants = ["甲"], importance = "normal") => ({
  id, date, participants, importance, title: id, summary: id + "进展",
});
const data = {
  workspace: { short_name: "虚构公司", timezone: "Asia/Shanghai" },
  updated_at: "2026-09-30",
  people: [{ id: "甲", name: "甲", phone: "private-contact-value" }],
  projects: [
    { id: "coop", name: "同名事项", record_type: "cooperation", summary: "FUTURE_SUMMARY", next_action: "FUTURE_ACTION", stage: "signed", events: [
      event("before", "2026-09-20"), event("monday", "2026-09-21"),
      event("midweek", "2026-09-23"), event("sunday", "2026-09-27", ["乙"], "key"),
      event("later", "2026-09-28"),
    ] },
    { id: "invest", name: "同名事项", record_type: "investment", events: [event("investment", "2026-09-22", [])] },
    { id: "resource", name: "其他事项", record_type: "resource", events: [event("old-resource", "2026-09-19")] },
  ],
  company_events: [event("company", "2026-09-24"), event("company-later", "2026-09-28")],
};
test("weekly report includes inclusive boundaries and ordinary events, separates categories and leaves data untouched", () => {
  const original = JSON.stringify(data);
  const report = buildWeeklyReport(data, period);
  assert.equal(report.eventCount, 5);
  assert.equal(report.projectCount, 2);
  assert.equal(report.companyEventCount, 1);
  assert.deepEqual(report.sections.map(s => s.kind), ["cooperation", "investment", "company"]);
  assert.deepEqual(report.sections[0].groups[0].events.map(e => e.id), ["monday", "midweek", "sunday"]);
  assert.equal(JSON.stringify(data), original);
  for (const serialize of [weeklyReportToText, weeklyReportToMarkdown, weeklyReportToHtml]) {
    const text = serialize(report);
    for (const future of ["FUTURE_SUMMARY", "FUTURE_ACTION", "private-contact-value", "company-later", "old-resource"]) assert.ok(!text.includes(future), future);
    assert.ok(text.includes("monday"));
    assert.ok(text.includes("investment"));
    assert.ok(text.includes("company"));
  }
});
test("personal weekly report uses event attendance only, including company activities", () => {
  const report = buildWeeklyReport(data, period, "甲");
  assert.equal(report.eventCount, 3);
  assert.equal(report.projectCount, 1);
  assert.equal(report.companyEventCount, 1);
  assert.deepEqual(report.sections[0].groups[0].events.map(e => e.id), ["monday", "midweek"]);
  assert.equal(buildWeeklyReport(data, period, "不存在").eventCount, 0);
});
test("calendar weeks are Monday to Sunday across month/year and timezone boundaries", () => {
  assert.deepEqual(weekForDate("2026-09-27"), period);
  assert.deepEqual(weekForDate("2026-09-28"), { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(weekForDate("2026-01-01"), { from: "2025-12-29", to: "2026-01-04" });
  assert.deepEqual(previousWeek("2026-09-30"), period);
  assert.equal(workspaceToday("Asia/Shanghai", new Date("2026-09-27T17:00:00Z")), "2026-09-28");
  assert.equal(workspaceToday("America/Los_Angeles", new Date("2026-09-28T01:00:00Z")), "2026-09-27");
  assert.equal(validReportPeriod({ from: "2026-02-29", to: "2026-03-01" }), false);
  assert.equal(validReportPeriod({ from: "2024-02-29", to: "2024-02-29" }), true);
  assert.equal(validReportPeriod({ from: "", to: period.to }), false);
  assert.equal(validReportPeriod({ from: period.to, to: period.from }), false);
  assert.throws(() => weekForDate("invalid"), /日期无效/);
  assert.throws(() => buildWeeklyReport(data, { from: period.to, to: period.from }), /有效/);
});
test("empty weeks remain explicit, and exports escape content without external resources", () => {
  const empty = buildWeeklyReport(data, { from: "2026-10-05", to: "2026-10-11" });
  assert.equal(empty.eventCount, 0);
  assert.deepEqual(empty.sections, []);
  assert.match(weeklyReportToText(empty), /所选周期暂无进展记录/);
  const unsafe = structuredClone(data);
  unsafe.company_events[0].title = '<script>alert("x")</script>';
  unsafe.company_events[0].summary = "讨论 A & B 和 [link](example)";
  const report = buildWeeklyReport(unsafe, period);
  const html = weeklyReportToHtml(report);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A &amp; B/);
  assert.doesNotMatch(html, /<script|https?:\/\/|<link/);
  assert.ok(weeklyReportToMarkdown(report).includes("\\[link\\]"));
  assert.match(weeklyReportFilename(report, "docx"), /2026-09-21_2026-09-27\.docx$/);
});

test("week navigation stays relative to the selected week across month and year boundaries", () => {
  const selected = { from: "2026-10-05", to: "2026-10-11" };
  const previous = adjacentReportWeek(selected, -1);
  assert.deepEqual(previous, { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(adjacentReportWeek(previous, -1), period);
  assert.deepEqual(adjacentReportWeek(previous, 1), selected);
  assert.deepEqual(adjacentReportWeek({ from: "2025-12-29", to: "2026-01-04" }, 1), { from: "2026-01-05", to: "2026-01-11" });
  assert.deepEqual(adjacentReportWeek({ from: "2024-02-26", to: "2024-03-03" }, 1), { from: "2024-03-04", to: "2024-03-10" });
  assert.deepEqual(selected, { from: "2026-10-05", to: "2026-10-11" });
});

test("custom ranges navigate from the start date's week and invalid ranges cannot navigate", () => {
  assert.deepEqual(adjacentReportWeek({ from: "2026-10-07", to: "2026-10-16" }, -1), { from: "2026-09-28", to: "2026-10-04" });
  assert.deepEqual(adjacentReportWeek({ from: "2026-10-07", to: "2026-10-16" }, 1), { from: "2026-10-12", to: "2026-10-18" });
  for (const invalid of [{ from: "", to: "" }, { from: "2026-02-29", to: "2026-03-01" }, { from: "2026-10-11", to: "2026-10-05" }]) {
    assert.equal(adjacentReportWeek(invalid, -1), null);
    assert.equal(adjacentReportWeek(invalid, 1), null);
  }
  assert.equal(adjacentReportWeek({ from: "9999-12-27", to: "9999-12-31" }, 1), null);
});

test("exports follow the navigated week while retaining the participant filter", () => {
  const next = adjacentReportWeek(period, 1);
  const report = buildWeeklyReport(data, next, "甲");
  assert.equal(report.eventCount, 2);
  assert.equal(report.companyEventCount, 1);
  for (const serialize of [weeklyReportToText, weeklyReportToMarkdown, weeklyReportToHtml]) {
    const text = serialize(report);
    assert.ok(text.includes("2026-09-28"));
    assert.ok(text.includes("2026-10-04"));
    assert.ok(text.includes("company-later"));
    assert.ok(!text.includes("midweek"));
  }
  assert.match(weeklyReportFilename(report, "docx"), /2026-09-28_2026-10-04\.docx$/);
});
