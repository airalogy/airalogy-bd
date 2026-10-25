import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

test("generated dashboard data stays internally consistent", async () => {
  const data = JSON.parse(
    await readFile(
      new URL("../fixtures/demo/content/generated/dashboard.json", import.meta.url),
      "utf8",
    ),
  );

  for (const field of [
    "id",
    "name",
    "short_name",
    "workspace_title",
    "description",
    "locale",
    "timezone",
    "brand_mark",
    "privacy_notice",
  ]) {
    assert.equal(typeof data.workspace[field], "string");
    assert.ok(data.workspace[field].length > 0);
  }
  assert.match(data.workspace.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(data.projects.length > 0);
  assert.ok(data.people.length > 0);
  assert.ok(Array.isArray(data.company_events));

  const projectIds = new Set(data.projects.map((project) => project.id));
  const personIds = new Set(data.people.map((person) => person.id));
  assert.equal(projectIds.size, data.projects.length);
  assert.equal(personIds.size, data.people.length);
  assert.match(data.updated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal("updated" in data.workspace, false);
  const latestBusinessDate = [
    ...data.projects.map((project) => project.last_activity),
    ...data.company_events.map((event) => event.date),
  ].sort().at(-1);
  assert.equal(data.updated_at, latestBusinessDate);
  assert.ok(
    data.projects.every((project) => project.last_activity <= data.updated_at),
  );

  for (const project of data.projects) {
    assert.equal("updated" in project, false);
    assert.ok(["cooperation", "investment", "resource"].includes(project.record_type));
    assert.ok(["active", "dormant", "maintained"].includes(project.relationship));
    assert.ok(
      [
        "active_progress",
        "proactive_contact",
        "awaiting_response",
        "on_hold",
        "closed",
      ].includes(project.follow_up_status),
    );
    assert.ok(Array.isArray(project.sourced_by));
    assert.ok(project.sourced_by.length > 0);
    assert.ok(
      project.sourced_by.every((personId) => personIds.has(personId)),
    );
    assert.deepEqual(
      project.source_people.map((person) => person.id),
      project.sourced_by,
    );
    assert.ok(
      ["confirmed", "provisional", "unknown"].includes(
        project.source_certainty,
      ),
    );
    assert.ok(project.source_note.length > 0);
    if (project.target_investment_amount_cny !== undefined) {
      assert.equal(project.record_type, "investment");
      assert.ok(Number.isInteger(project.target_investment_amount_cny));
      assert.ok(project.target_investment_amount_cny > 0);
    }
    const latestEvent = [...project.events]
      .map((event) => event.date)
      .sort()
      .at(-1);
    assert.equal(project.last_activity, latestEvent);
    assert.ok(project.summary.length > 0);
    for (const event of project.events) {
      assert.ok(Array.isArray(event.participants));
      assert.ok(event.participants.every((personId) => personIds.has(personId)));
      if (event.related_record?.endsWith(".md")) {
        assert.equal(event.related_document?.path, event.related_record);
        assert.ok(event.related_document.title.length > 0);
        assert.ok(event.related_document.markdown.length > 0);
      }
    }
    for (const contact of project.contacts) {
      const participationDates = project.events
        .filter((event) => event.participants.includes(contact.person_id))
        .map((event) => event.date);
      assert.ok(participationDates.length > 0);
      assert.equal(contact.last_activity, participationDates.sort().at(-1));
      const person = data.people.find(
        (candidate) => candidate.id === contact.person_id,
      );
      assert.ok(person);
      assert.ok(
        person.projects.some(
          (participation) => participation.project_id === project.id,
        ),
      );
    }
  }

  for (const person of data.people) {
    assert.equal(
      new Set(person.projects.map((project) => project.project_id)).size,
      person.projects.length,
    );
    assert.ok(
      person.projects.every((project) => projectIds.has(project.project_id)),
    );
  }

  for (const event of data.company_events) {
    assert.equal(typeof event.category, "string");
    assert.ok(event.category.length > 0);
    assert.ok(Array.isArray(event.participants));
    assert.ok(event.participants.length > 0);
    assert.ok(event.participants.every((personId) => personIds.has(personId)));
    if (event.related_record?.endsWith(".md")) {
      assert.equal(event.related_document?.path, event.related_record);
      assert.ok(event.related_document.title.length > 0);
      assert.ok(event.related_document.markdown.length > 0);
    }
  }
});

test("dashboard is reusable and configured for local use only", async () => {
  const [
    dashboard,
    exportDialog,
    labels,
    reportBuilder,
    wordExporter,
    layout,
    serverData,
    globalStyles,
    packageJson,
    cli,
    generatedData,
  ] =
    await Promise.all([
      readFile(new URL("../dashboard/app/Dashboard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/ExportDialog.tsx", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/lib/labels.ts", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/lib/report.ts", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/lib/export-docx.ts", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/lib/server-data.ts", import.meta.url), "utf8"),
      readFile(new URL("../dashboard/app/globals.css", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../bin/bd.mjs", import.meta.url), "utf8"),
      readFile(
        new URL("../fixtures/demo/content/generated/dashboard.json", import.meta.url),
        "utf8",
      ),
    ]);
  const data = JSON.parse(generatedData);

  const roleLabelsBlock = labels.match(
    /export const roleLabels: Record<string, string> = \{([\s\S]*?)\n\};/,
  )?.[1];
  assert.ok(roleLabelsBlock, "roleLabels must remain a shared label map");
  const roleLabelIds = new Set(
    [...roleLabelsBlock.matchAll(/^  ([a-z][a-z0-9_]*):/gm)].map(
      (match) => match[1],
    ),
  );
  const projectRoleIds = new Set(
    data.projects.flatMap((project) =>
      project.contacts.flatMap((contact) => contact.project_roles),
    ),
  );
  for (const roleId of projectRoleIds) {
    assert.ok(roleLabelIds.has(roleId), `missing role label: ${roleId}`);
  }

  assert.match(dashboard, /筛选与查看范围/);
  assert.match(dashboard, /className="filter-hub"/);
  assert.match(dashboard, /className="filter-controls"/);
  assert.match(dashboard, /className="management-summary"/);
  assert.match(dashboard, /className="dashboard-grid"/);
  assert.ok(
    dashboard.indexOf('className="dashboard-grid"') <
      dashboard.indexOf('className="filter-hub"'),
  );
  assert.ok(
    dashboard.indexOf('className="filter-hub"') <
      dashboard.indexOf('id="projects"'),
  );
  assert.doesNotMatch(dashboard, /重点事项，一页看清/);
  assert.doesNotMatch(dashboard, /<nav aria-label="看板导航">/);
  assert.match(dashboard, /全局总览/);
  assert.match(dashboard, /ToggleGroup\.Root/);
  assert.match(dashboard, /setViewMode/);
  assert.match(dashboard, /current === mode \? "all" : mode/);
  assert.match(dashboard, /value \|\| "all"/);
  assert.match(dashboard, /current === projectId \? "all" : projectId/);
  assert.match(dashboard, /再次点击可取消/);
  assert.match(dashboard, /setPriorityFilter/);
  assert.match(dashboard, /setFollowUpFilter/);
  assert.match(dashboard, /active-filter-chip/);
  assert.match(dashboard, /最初对接来源/);
  assert.match(dashboard, /project\.source_people/);
  assert.match(dashboard, /source-note-panel/);
  assert.doesNotMatch(dashboard, /source-copy/);
  assert.doesNotMatch(dashboard, /sourceCertaintyLabels/);
  assert.match(dashboard, /EventHistoryDialog/);
  assert.match(dashboard, /EventRecordDialog/);
  assert.match(dashboard, /ReactMarkdown/);
  assert.match(dashboard, /remarkGfm/);
  assert.match(dashboard, /rehypeRaw/);
  assert.match(dashboard, /rehypeSanitize/);
  assert.match(dashboard, /阅读完整记录/);
  assert.match(dashboard, /data\.company_events/);
  assert.match(dashboard, /includeCompanyEvents/);
  assert.match(dashboard, /公司事件/);
  assert.match(dashboard, /查看全部/);
  assert.match(dashboard, /全部历史/);
  assert.match(dashboard, /近 7 天/);
  assert.match(dashboard, /近 30 天/);
  assert.match(dashboard, /近 90 天/);
  assert.match(dashboard, /type="date"/);
  assert.match(dashboard, /event-history-dialog/);
  assert.match(dashboard, /groupedEvents/);
  assert.match(dashboard, /aria-pressed=\{stageFilter === stage\}/);
  assert.match(dashboard, /按单项筛选当前看板/);
  assert.match(dashboard, /调整事项清单排序/);
  assert.match(dashboard, /最近更新/);
  assert.match(dashboard, /可主动跟进优先/);
  assert.match(dashboard, /高优先级优先/);
  assert.match(dashboard, /最久未更新/);
  assert.match(dashboard, /compareProjects/);
  assert.match(dashboard, /sortedProjects\.map/);
  assert.match(dashboard, /data\.people/);
  assert.match(dashboard, /data\.workspace\.short_name/);
  assert.match(dashboard, /ExportDialog/);
  assert.match(dashboard, /RelationshipBadge/);
  assert.match(dashboard, /relationshipFilter/);
  assert.match(dashboard, /关系策略/);
  assert.match(dashboard, /peopleSortLabels/);
  assert.match(dashboard, /zh-CN-u-co-pinyin/);
  assert.match(dashboard, /comparePeople/);
  assert.match(dashboard, /function SelectField/);
  assert.match(dashboard, /function SearchField/);
  assert.match(dashboard, /<Dialog\.Root\s+open/);
  assert.match(dashboard, /<Dialog\.Overlay className="drawer-layer"/);
  assert.match(dashboard, /<Dialog\.Content asChild aria-describedby=\{undefined\}>/);
  assert.match(dashboard, /<Dialog\.Title asChild>/);
  assert.match(dashboard, /<Dialog\.Close asChild>/);
  assert.doesNotMatch(dashboard, /className="drawer-layer" role="presentation"/);
  assert.match(dashboard, /control-field control-field-/);
  assert.match(dashboard, /className="search-icon"/);
  assert.match(dashboard, /width="15"/);
  assert.match(dashboard, /height="15"/);
  assert.doesNotMatch(dashboard, /<circle/);
  assert.doesNotMatch(dashboard, />⌕</);
  assert.match(dashboard, /最近参与/);
  assert.match(dashboard, /姓名拼音/);
  assert.match(dashboard, /关联事项数/);
  assert.match(dashboard, /ariaLabel="人员排序方式"/);
  assert.match(dashboard, /className={`status-tag \$\{className\}`}/);
  assert.match(globalStyles, /\.status-tag\s*{/);
  assert.match(globalStyles, /\.control-field\s*{/);
  assert.match(globalStyles, /\.control-field-inline\s*{/);
  assert.match(globalStyles, /\.control-field > span:first-child/);
  assert.match(globalStyles, /\.search-box:focus-within/);
  assert.match(globalStyles, /\.search-icon\s*{/);
  assert.match(
    globalStyles,
    /\.filter-controls > \.relationship-control\s*{\s*grid-column: 1 \/ -1;/,
  );
  assert.match(
    globalStyles,
    /\.control-field:not\(:where\(\.scope-control, \.search-control\)\)/,
  );
  assert.doesNotMatch(globalStyles, /\.people-sort > span/);
  assert.match(globalStyles, /background: var\(--tag-background\)/);
  assert.match(globalStyles, /color: var\(--tag-color\)/);
  assert.match(globalStyles, /\.record-type-resource\s*{/);
  assert.match(globalStyles, /\.drawer-layer\s*\{[^}]*z-index: 40;/s);
  assert.match(
    globalStyles,
    /\.project-drawer\s*\{[^}]*position: fixed;[^}]*z-index: 41;/s,
  );
  assert.match(
    globalStyles,
    /\.view-switcher\s*{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/s,
  );
  assert.match(
    globalStyles,
    /@media \(max-width: 760px\)[\s\S]*\.view-switcher\s*{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(globalStyles, /\.relationship-maintained\s*{\s*--tag-background:/);
  assert.match(dashboard, /currentProjects=\{filteredProjects\}/);
  const toolbar = await readFile(new URL("../dashboard/app/ToolbarActions.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /<ToolbarActions/);
  assert.match(toolbar, /label: "事项报告"/);
  assert.match(toolbar, /label: "工作周报"/);
  assert.match(exportDialog, /当前筛选结果/);
  assert.match(exportDialog, /仅合作项目/);
  assert.match(exportDialog, /仅投资人对接/);
  assert.match(exportDialog, /仅资源对接/);
  assert.match(exportDialog, /reportToMarkdown/);
  assert.match(exportDialog, /reportToHtml/);
  assert.match(exportDialog, /createLeadershipDocx/);
  assert.match(exportDialog, /useReactToPrint/);
  assert.match(exportDialog, /打印窗口中选择存储/);
  assert.match(exportDialog, /按事项分组/);
  assert.match(exportDialog, /按时间线/);
  assert.match(exportDialog, /useState<EventOrganization>\("grouped"\)/);
  assert.match(exportDialog, /report\.items\.length > 1/);
  assert.match(exportDialog, /text\/html;charset=utf-8/);
  assert.match(exportDialog, /浏览器离线查看/);
  assert.match(labels, /closed: "本轮已结束"/);
  assert.match(labels, /proactive_contact: "可主动跟进"/);
  assert.match(labels, /maintained: "长期维护"/);
  assert.match(labels, /projectRelationshipLabel/);
  assert.match(labels, /resource: "资源对接"/);
  assert.match(reportBuilder, /relationshipLabel/);
  assert.match(reportBuilder, /投资人对接表/);
  assert.match(reportBuilder, /资源对接表/);
  assert.match(reportBuilder, /分事项进展/);
  assert.match(reportBuilder, /核心事件时间线/);
  assert.match(reportBuilder, /event\.importance === "key"/);
  assert.match(reportBuilder, /<!doctype html>/);
  assert.match(reportBuilder, /<details class="item"/);
  assert.match(reportBuilder, /不依赖外部网络资源/);
  assert.doesNotMatch(reportBuilder, /https?:\/\//);
  assert.match(wordExporter, /Packer\.toBlob/);
  assert.match(wordExporter, /Microsoft YaHei/);
  assert.match(wordExporter, /TableLayoutType\.FIXED/);
  assert.match(wordExporter, /eventTable\(itemEvents, false\)/);
  assert.match(wordExporter, /eventTable\(report\.events, true\)/);
  assert.equal(dashboard.includes(data.workspace.short_name), false);
  assert.equal(layout.includes(data.workspace.short_name), false);
  assert.match(layout, /workspace\.privacy_notice/);
  assert.match(layout, /loadDashboardData/);
  assert.match(serverData, /BD_DATA_FILE/);
  assert.doesNotMatch(serverData, /content\/generated\/dashboard\.json/);
  assert.doesNotMatch(layout, /openGraph|chatgpt\.site|next\/headers/);
  assert.match(packageJson, /"name": "@airalogy\/airalogy-bd"/);
  assert.match(packageJson, /"dev": "node bin\/bd\.mjs dev/);
  assert.match(packageJson, /"@radix-ui\/react-toggle-group"/);
  assert.match(packageJson, /"@radix-ui\/react-dialog"/);
  assert.match(packageJson, /"docx"/);
  assert.match(packageJson, /"react-to-print"/);
  assert.doesNotMatch(packageJson, /vinext|wrangler|cloudflare/);
  assert.match(cli, /--content-dir/);
  assert.match(cli, /BD_DATA_FILE/);
  assert.match(cli, /\.airalogy-bd/);
  assert.match(cli, /dependencyDirectory/);
  assert.match(cli, /lint-dashboard/);
  assert.match(cli, /case "validate"/);
  assert.match(cli, /case "dev"/);
});

test("markdown records render sanitized details and summary elements", () => {
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeRaw, rehypeSanitize],
      },
      "<details><summary>逐字记录</summary>完整内容</details><script>alert(1)</script>",
    ),
  );

  assert.match(html, /<details><summary>逐字记录<\/summary>完整内容<\/details>/);
  assert.doesNotMatch(html, /<script|alert\(1\)/);
});

test("content templates do not invite unsupported follow-up inference", async () => {
  const [
    meetingTemplate,
    companyRecordTemplate,
    projectTemplate,
    readme,
    validator,
  ] =
    await Promise.all([
      readFile(new URL("../templates/meeting.md", import.meta.url), "utf8"),
      readFile(
        new URL("../templates/company-record.md", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../templates/matter.md", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../scripts/validate.py", import.meta.url), "utf8"),
    ]);

  assert.doesNotMatch(meetingTemplate, /^## 后续事项$/m);
  assert.doesNotMatch(meetingTemplate, /^(format|source_type):/m);
  assert.doesNotMatch(companyRecordTemplate, /^## 后续事项$/m);
  assert.doesNotMatch(companyRecordTemplate, /^## 事件结果$/m);
  assert.doesNotMatch(companyRecordTemplate, /^(format|source_type):/m);
  assert.match(projectTemplate, /不自行补充负责人、期限或后续事项/);
  assert.match(
    readme,
    /不自行推断表决结果、对方态度、合作判断、后续事项、负责人或期限/,
  );
  assert.match(validator, /reject_fields\(record, \("format", "source_type"\)/);
  assert.match(validator, /reject_fields\(meeting, \("format", "source_type"\)/);
});
