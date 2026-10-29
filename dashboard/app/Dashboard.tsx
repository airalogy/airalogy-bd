"use client";
import EventAttachments from "./EventAttachments";
import { BrandLogo } from "./Branding";
import Link from "next/link";
import AiAssistant from "./AiAssistant";
import HistoricalFiles from "./HistoricalFiles";
import type {HistoricalSnapshot, Version, BackupStatus} from "./lib/workspace-types";

import * as Dialog from "@radix-ui/react-dialog";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useMemo, useState, type ReactNode } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ExportDialog from "./ExportDialog";
import WeeklyReportDialog from "./WeeklyReportDialog";
import ToolbarActions from "./ToolbarActions";
import FileLibraryDialog, { type FileTarget } from "./FileLibrary";
import type { LibraryFile } from "./lib/file-library";
import OverviewActivity from "./OverviewActivity";
import { collectActivityEvents, type ScopedActivityEvent } from "./lib/activity-calendar";
import CompanyActivity from "./CompanyActivity";
import InvestmentOverview from "./InvestmentOverview";
import BpStatus from "./BpStatus";
import ContactChannels from "./ContactChannels";
import CounterpartyContext from "./CounterpartyContext";
import WorkspaceAdmin from "./WorkspaceAdmin";
import VersionHistory from "./VersionHistory";
import RecordEditor from "./RecordEditor";
import type { RecordTarget, SavedResponse, WorkspaceStatus } from "./lib/workspace-types";
import { companyCategoryLabel } from "./lib/company-events";
import {
  followUpStatusLabels,
  priorityLabels,
  projectRelationshipLabel,
  recordTypeLabels,
  relationshipLabels,
  roleLabels,
  stageLabels,
} from "./lib/labels";
import type {
  DashboardData,
  Project,
  ProjectEvent,
  Workspace,
} from "./lib/types";

const STAGES = [
  "initial_contact",
  "opportunity_assessment",
  "solution_discussion",
  "agreement_negotiation",
  "signed",
  "execution",
  "paused",
  "terminated",
] as const;

const PRIORITIES = ["high", "medium", "low"] as const;

const FOLLOW_UP_STATUSES = [
  "active_progress",
  "proactive_contact",
  "awaiting_response",
  "on_hold",
  "closed",
] as const;

const RELATIONSHIPS = ["active", "maintained", "dormant"] as const;

type ViewMode = "all" | Project["record_type"];
type ProjectSort = "recent" | "follow_up" | "priority" | "stale";
type PeopleSort = "recent" | "name" | "projects";
type EventPeriod = "all" | "7d" | "30d" | "90d" | "custom";
type ScopedEvent = ScopedActivityEvent;
type RecordSelection = {
  projectId?: string;
  event: ProjectEvent;
  sourceLabel: string;
};

const EVENT_PERIODS: Array<{ value: Exclude<EventPeriod, "custom">; label: string }> = [
  { value: "all", label: "全部历史" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "90d", label: "近 90 天" },
];

const projectSortLabels: Record<ProjectSort, string> = {
  recent: "最近更新",
  follow_up: "可主动跟进优先",
  priority: "高优先级优先",
  stale: "最久未更新",
};

const peopleSortLabels: Record<PeopleSort, string> = {
  recent: "最近参与",
  name: "姓名拼音",
  projects: "关联事项数",
};

const chineseNameCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  sensitivity: "base",
  numeric: true,
});

const followUpStatusRanks: Record<Project["follow_up_status"], number> = {
  proactive_contact: 0,
  active_progress: 1,
  awaiting_response: 2,
  on_hold: 3,
  closed: 4,
};

const priorityRanks: Record<Project["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const viewModeLabels: Record<ViewMode, string> = {
  all: "全局总览",
  cooperation: "合作项目",
  investment: "投资人对接",
  resource: "资源对接",
};

const viewModeDescriptions: Record<ViewMode, string> = {
  all: "合作、融资与资源关系合并查看",
  cooperation: "业务、研发与产业合作",
  investment: "投资人及融资进展",
  resource: "可引荐合作或投资的外部关系",
};

const eventTypeLabels: Record<string, string> = {
  contact: "接触",
  meeting: "会议",
  proposal: "方案",
  agreement: "协议",
  administrative: "手续",
  decision: "决策",
  payment: "付款",
  milestone: "里程碑",
  status_change: "阶段变化",
  other: "其他",
};

const sideLabels: Record<string, string> = {
  counterparty: "对接方",
  internal: "我方",
  advisor: "顾问",
};

const keyContactRoles = new Set([
  "decision_maker",
  "project_lead",
  "project_owner",
  "business_contact",
  "government_contact",
  "investor_contact",
  "technical_lead",
  "management_representative",
  "senior_contact",
  "legal_representative",
  "general_manager",
  "board_chair",
  "director",
  "supervisor",
]);

function formatDate(
  value: string | null | undefined,
  workspace: Workspace,
  withYear = true,
) {
  if (!value) return "待定";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(workspace.locale, {
    year: withYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
    timeZone: workspace.timezone,
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function daysBetween(from: string, to: string | null) {
  if (!to) return 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function formatCnyAmount(value: number, workspace: Workspace) {
  if (value >= 10_000 && value % 10_000 === 0) {
    return `${new Intl.NumberFormat(workspace.locale).format(value / 10_000)} 万元`;
  }
  return `${new Intl.NumberFormat(workspace.locale).format(value)} 元`;
}

function formatMonth(value: string, workspace: Workspace) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(workspace.locale, {
    year: "numeric",
    month: "long",
    timeZone: workspace.timezone,
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function shiftIsoDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventSort(a: ProjectEvent, b: ProjectEvent) {
  return b.date.localeCompare(a.date);
}

function isActiveProject(project: Project) {
  return !["paused", "terminated"].includes(project.stage);
}

function compareProjects(a: Project, b: Project, sort: ProjectSort) {
  const recent = b.last_activity.localeCompare(a.last_activity);
  const priority = priorityRanks[a.priority] - priorityRanks[b.priority];
  const followUp =
    followUpStatusRanks[a.follow_up_status] -
    followUpStatusRanks[b.follow_up_status];
  const name = a.name.localeCompare(b.name, "zh-CN");

  if (sort === "follow_up") return followUp || priority || recent || name;
  if (sort === "priority") return priority || followUp || recent || name;
  if (sort === "stale") {
    return a.last_activity.localeCompare(b.last_activity) || followUp || priority || name;
  }
  return recent || followUp || priority || name;
}

function comparePeople<
  T extends {
    name: string;
    last_activity: string | null;
    projects: Array<unknown>;
  },
>(a: T, b: T, sort: PeopleSort) {
  const name = chineseNameCollator.compare(a.name, b.name);
  const recent = (b.last_activity ?? "").localeCompare(a.last_activity ?? "");
  const projects = b.projects.length - a.projects.length;

  if (sort === "name") return name || recent || projects;
  if (sort === "projects") return projects || recent || name;
  return recent || name || projects;
}

function projectMatchesQuery(project: Project, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    project.name,
    project.owner,
    project.counterparties.join(" "),
    project.next_action,
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalizedQuery);
}

function SelectField({
  label,
  value,
  onChange,
  ariaLabel,
  children,
  className = "",
  layout = "stacked",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  children: React.ReactNode;
  className?: string;
  layout?: "stacked" | "inline";
}) {
  return (
    <label
      className={`control-field control-field-${layout}${className ? ` ${className}` : ""}`}
    >
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
      >
        {children}
      </select>
    </label>
  );
}

function SearchField({
  label,
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <label
      className={`control-field control-field-stacked${className ? ` ${className}` : ""}`}
    >
      <span>{label}</span>
      <span className="search-box">
        <svg
          className="search-icon"
          viewBox="0 0 20 20"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.6"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M8.5 3.25a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5Zm3.9 9.15 4.1 4.1" />
        </svg>
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />
      </span>
    </label>
  );
}

function FilterBadge({
  className,
  children,
  active = false,
  onClick,
  ariaLabel,
}: {
  className: string;
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  if (!onClick) {
    return <span className={`status-tag ${className}`}>{children}</span>;
  }

  return (
    <button
      type="button"
      className={`status-tag ${className} filter-badge${active ? " active" : ""}`}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function ProjectBadge({
  project,
  active,
  onClick,
}: {
  project: Project;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <FilterBadge
      className={`stage-badge stage-${project.stage}`}
      active={active}
      onClick={onClick}
      ariaLabel={
        active
          ? `取消${stageLabels[project.stage] ?? project.stage}筛选`
          : `筛选${stageLabels[project.stage] ?? project.stage}事项`
      }
    >
      {stageLabels[project.stage] ?? project.stage}
    </FilterBadge>
  );
}

function RecordTypeBadge({
  project,
  active,
  onClick,
}: {
  project: Project;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <FilterBadge
      className={`record-type-badge record-type-${project.record_type}`}
      active={active}
      onClick={onClick}
      ariaLabel={
        active
          ? `取消${recordTypeLabels[project.record_type]}筛选`
          : `只看${recordTypeLabels[project.record_type]}`
      }
    >
      {recordTypeLabels[project.record_type]}
    </FilterBadge>
  );
}

function PriorityBadge({
  project,
  active,
  onClick,
}: {
  project: Project;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <FilterBadge
      className={`priority priority-${project.priority}`}
      active={active}
      onClick={onClick}
      ariaLabel={
        active
          ? `取消${priorityLabels[project.priority] ?? project.priority}优先级筛选`
          : `只看${priorityLabels[project.priority] ?? project.priority}优先级事项`
      }
    >
      {priorityLabels[project.priority] ?? project.priority}优先级
    </FilterBadge>
  );
}

function FollowUpBadge({
  project,
  active,
  onClick,
}: {
  project: Project;
  active?: boolean;
  onClick?: () => void;
}) {
  const label = followUpStatusLabels[project.follow_up_status];
  return (
    <FilterBadge
      className={`follow-up-tag follow-up-${project.follow_up_status}`}
      active={active}
      onClick={onClick}
      ariaLabel={active ? `取消${label}筛选` : `只看${label}事项`}
    >
      {label}
    </FilterBadge>
  );
}

function RelationshipBadge({
  project,
  active,
  onClick,
}: {
  project: Project;
  active?: boolean;
  onClick?: () => void;
}) {
  const label = projectRelationshipLabel(project);
  if (!label) return null;

  return (
    <FilterBadge
      className={`relationship-tag relationship-${project.relationship}`}
      active={active}
      onClick={onClick}
      ariaLabel={active ? `取消${label}筛选` : `只看${label}事项`}
    >
      {label}
    </FilterBadge>
  );
}

function EventItem({
  event,
  workspace,
  sourceLabel,
  compact = false,
  onOpenRecord,
  actions,
  attachments,
}: {
  event: ProjectEvent;
  workspace: Workspace;
  sourceLabel?: string;
  compact?: boolean;
  onOpenRecord?: (event: ProjectEvent) => void;
  actions?: ReactNode;
  attachments?: ReactNode;
}) {
  return (
    <article className={`event-item${compact ? " compact" : ""}`}>
      <div className="event-marker" aria-hidden="true" />
      <div className="event-content">
        <div className="event-meta">
          <time dateTime={event.date}>{formatDate(event.date, workspace)}</time>
          {sourceLabel && <span>{sourceLabel}</span>}
          {event.importance === "key" && <span className="event-importance">重要</span>}
          <span className={`event-type event-${event.type}`}>
            {eventTypeLabels[event.type] ?? event.type}
          </span>
        </div>
        <h4>{event.title}</h4>
        <p>{event.summary}</p>
        {attachments}
        {(event.related_document && onOpenRecord) || actions ? (
          <div className={actions ? "event-actions" : undefined}>
            {event.related_document && onOpenRecord && (
              <button
                type="button"
                className="event-record-trigger"
                onClick={() => onOpenRecord(event)}
                aria-label={`阅读${event.related_document.title}完整记录`}
              >
                阅读完整记录
                <span aria-hidden="true">›</span>
              </button>
            )}
            {actions && <div className={`event-secondary-actions${event.related_document && onOpenRecord ? " after-record" : ""}`} role="group" aria-label={`${event.title}管理操作`}>{actions}</div>}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function EventRecordDialog({
  selection,
  workspace,
  onClose,
  onFiles,
  files,
  snapshot,
}: {
  selection: RecordSelection | null;
  files: LibraryFile[];
  snapshot?: string;
  workspace: Workspace;
  onFiles?: () => void;
  onClose: () => void;
}) {
  const document = selection?.event.related_document;
  if (!selection) return null;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="record-dialog-overlay" />
        <Dialog.Content className="record-dialog">
          <header className="record-dialog-head">
            <div>
              <div className="eyebrow">{document ? "完整记录" : "进展记录"}</div>
              <Dialog.Title>{document?.title || selection.event.title}</Dialog.Title>
              <Dialog.Description>
                {selection.sourceLabel} · {formatDate(selection.event.date, workspace)}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="close-button" aria-label="关闭完整记录">
                ×
              </button>
            </Dialog.Close>
          </header>
          <div className="record-dialog-scroll">
            <article className="markdown-record">
              {document ? <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw, rehypeSanitize]}
              >
                {document.markdown}
              </ReactMarkdown> : <p>{selection.event.summary}</p>}
            </article>
            {selection.projectId && <EventAttachments key={`${selection.projectId}:${selection.event.id}`} files={files} matter={selection.projectId} event={selection.event.id} snapshot={snapshot} onDetails={onFiles} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EventHistoryDialog({
  events,
  workspace,
  scopeLabel,
  referenceDate,
  onOpenRecord,
}: {
  events: ScopedEvent[];
  workspace: Workspace;
  scopeLabel: string;
  referenceDate: string;
  onOpenRecord: (event: ScopedEvent) => void;
}) {
  const [period, setPeriod] = useState<EventPeriod>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState(referenceDate);

  const presetDays: Partial<Record<EventPeriod, number>> = {
    "7d": 7,
    "30d": 30,
    "90d": 90,
  };
  const presetStart = presetDays[period]
    ? shiftIsoDate(referenceDate, -(presetDays[period]! - 1))
    : "";
  const rangeStart = period === "custom" ? dateFrom : presetStart;
  const rangeEnd = period === "custom" ? dateTo : period === "all" ? "" : referenceDate;
  const invalidRange = Boolean(rangeStart && rangeEnd && rangeStart > rangeEnd);
  const visibleEvents = invalidRange
    ? []
    : events.filter(
        (event) =>
          (!rangeStart || event.date >= rangeStart) &&
          (!rangeEnd || event.date <= rangeEnd),
      );
  const groupedEvents = visibleEvents.reduce<Array<[string, ScopedEvent[]]>>(
    (groups, event) => {
      const month = event.date.slice(0, 7);
      const currentGroup = groups.at(-1);
      if (currentGroup?.[0] === month) {
        currentGroup[1].push(event);
      } else {
        groups.push([month, [event]]);
      }
      return groups;
    },
    [],
  );

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="history-trigger"
          aria-label={`查看当前范围全部${events.length}条历史事件`}
        >
          查看全部
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="event-history-overlay" />
        <Dialog.Content className="event-history-dialog">
          <header className="event-history-head">
            <div>
              <div className="eyebrow">完整时间线</div>
              <Dialog.Title>历史事件</Dialog.Title>
              <Dialog.Description>
                {scopeLabel} · 当前事项筛选范围
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="close-button" aria-label="关闭历史事件">
                ×
              </button>
            </Dialog.Close>
          </header>

          <div className="event-history-controls">
            <div className="event-period-control">
              <span>快捷时间范围</span>
              <ToggleGroup.Root
                className="event-period-switcher"
                type="single"
                value={period === "custom" ? "" : period}
                onValueChange={(value) => {
                  if (value) setPeriod(value as EventPeriod);
                }}
                aria-label="筛选历史事件时间范围"
              >
                {EVENT_PERIODS.map((item) => (
                  <ToggleGroup.Item
                    className="event-period-button"
                    key={item.value}
                    value={item.value}
                  >
                    {item.label}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>
            </div>

            <div className="event-custom-range">
              <span>自定义周期</span>
              <div>
                <label>
                  <span>开始</span>
                  <input
                    type="date"
                    value={dateFrom}
                    max={referenceDate}
                    onChange={(event) => {
                      setDateFrom(event.target.value);
                      setPeriod("custom");
                    }}
                  />
                </label>
                <i aria-hidden="true">—</i>
                <label>
                  <span>结束</span>
                  <input
                    type="date"
                    value={dateTo}
                    max={referenceDate}
                    onChange={(event) => {
                      setDateTo(event.target.value);
                      setPeriod("custom");
                    }}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="event-history-status" aria-live="polite">
            <span>
              显示 <strong>{visibleEvents.length}</strong> / {events.length} 条事件
            </span>
            {period === "custom" && !invalidRange && (
              <span>
                {dateFrom || "最早记录"} 至 {dateTo || referenceDate}
              </span>
            )}
            {invalidRange && <span className="range-error">开始日期不能晚于结束日期</span>}
          </div>

          <div className="event-history-scroll">
            {groupedEvents.length > 0 ? (
              groupedEvents.map(([month, monthEvents]) => (
                <section className="event-month-group" key={month}>
                  <div className="event-month-heading">
                    <h3>{formatMonth(month, workspace)}</h3>
                    <span>{monthEvents.length} 条</span>
                  </div>
                  <div className="event-list">
                    {monthEvents.map((event) => (
                      <EventItem
                        key={event.activityId}
                        event={event}
                        workspace={workspace}
                        sourceLabel={event.sourceLabel}
                        onOpenRecord={() => onOpenRecord(event)}
                      />
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className="event-history-empty">
                {invalidRange ? "请调整日期范围。" : "当前时间范围内没有事件。"}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProjectDrawer({
  fileSnapshot,
  data, onSelectProject, onCounterpartyFiles, readOnly, onAi,
  onFiles,
  fileCount,
  onBpFiles,
  onEdit,
  onHistory,
  project,
  workspace,
  onClose,
  onRecordTypeFilter,
  onStageFilter,
  onPriorityFilter,
  onFollowUpFilter,
  onRelationshipFilter,
  onOpenRecord,
  recordTypeActive,
  stageActive,
  priorityActive,
  followUpActive,
  relationshipActive,
}: {
  project: Project;
  workspace: Workspace;
  data: DashboardData;
  onSelectProject: (project:Project) => void;
  onAi?: () => void;
  onCounterpartyFiles: (identity:string) => void;
  fileSnapshot?: string;
  onFiles: (eventId?:string) => void;
  fileCount: number;
  onBpFiles: (fileId?: string) => void;
  readOnly: boolean;
  onEdit: (target: RecordTarget) => void;
  onHistory: (target: RecordTarget) => void;
  onClose: () => void;
  onRecordTypeFilter: (recordType: Project["record_type"]) => void;
  onStageFilter: (stage: string) => void;
  onPriorityFilter: (priority: string) => void;
  onFollowUpFilter: (status: Project["follow_up_status"]) => void;
  onRelationshipFilter: (relationship: string) => void;
  onOpenRecord: (event: ProjectEvent) => void;
  recordTypeActive: boolean;
  stageActive: boolean;
  priorityActive: boolean;
  followUpActive: boolean;
  relationshipActive: boolean;
}) {
  const sortedEvents = [...project.events].sort(eventSort);
  const keyContacts = project.contacts.filter((contact) =>
    contact.project_roles.some((role) => keyContactRoles.has(role)),
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-layer" />
        <Dialog.Content asChild aria-describedby={undefined}>
          <aside className="project-drawer">
            <div className="drawer-head">
              <div>
                <div className="eyebrow">事项详情</div>
                <Dialog.Title asChild>
                  <h2>{project.name}</h2>
                </Dialog.Title>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="close-button" aria-label="关闭事项详情">
                  ×
                </button>
              </Dialog.Close>
            </div>

            <div className="admin-actions drawer-edit-actions">
              {!readOnly && <button type="button" className="admin-button admin-primary" onClick={() => onEdit({kind:"progress",id:"",project_id:project.id})}>新增进展</button>}
              {onAi && <button type="button" className="admin-button" onClick={onAi}>用 AI 整理此事项</button>}
              <button type="button" className="admin-button" onClick={() => onFiles()}>事项资料{fileCount ? ` · ${fileCount}` : ""}</button>
              {!readOnly && <button type="button" className="admin-button" onClick={() => onEdit({kind:"project",id:project.id})}>编辑信息</button>}
              {!readOnly && (!data.access || data.access.role==="admin") && <button type="button" className="admin-button" onClick={() => onHistory({kind:"project",id:project.id})}>修改历史</button>}
            </div>
            <CounterpartyContext readOnly={readOnly || (!!data.access && data.access.role!=="admin")} project={project} data={data} onSelectProject={onSelectProject} onEdit={onEdit} onFiles={onCounterpartyFiles} />
            {project.record_type === "investment" && <section className="drawer-bp"><h3>BP 发送与版本</h3><BpStatus projectId={project.id} files={data.files || []} people={data.people} onOpen={onBpFiles} /><p className="admin-help">以实际发送记录为准，版本更新不会改变此前发给对方的版本。</p></section>}
            <div className="drawer-badges">
              <RecordTypeBadge
                project={project}
                active={recordTypeActive}
                onClick={() => onRecordTypeFilter(project.record_type)}
              />
              <ProjectBadge
                project={project}
                active={stageActive}
                onClick={() => onStageFilter(project.stage)}
              />
              <PriorityBadge
                project={project}
                active={priorityActive}
                onClick={() => onPriorityFilter(project.priority)}
              />
              <FollowUpBadge
                project={project}
                active={followUpActive}
                onClick={() => onFollowUpFilter(project.follow_up_status)}
              />
              <RelationshipBadge
                project={project}
                active={relationshipActive}
                onClick={() => onRelationshipFilter(project.relationship)}
              />
            </div>

            <section className="drawer-section">
              <h3>管理摘要</h3>
              <p className="long-copy">{project.summary}</p>
            </section>

            <section className="drawer-section detail-grid">
              <div>
                <span>负责人</span>
                <strong>{project.owner}</strong>
              </div>
              <div>
                <span>首次接触</span>
                <strong>{project.first_contact ? formatDate(project.first_contact, workspace) : "未知"}</strong>
              </div>
              <div>
                <span>最初对接来源</span>
                <strong>
                  {project.source_people.map((person) => person.name).join("、")}
                </strong>
              </div>
              <div>
                <span>最近进展</span>
                <strong>{formatDate(project.last_activity, workspace)}</strong>
              </div>
              <div>
                <span>对接方</span>
                <strong>{project.counterparties.join("、")}</strong>
              </div>
              {project.target_investment_amount_cny && (
                <div>
                  <span>目标投资金额</span>
                  <strong>
                    {formatCnyAmount(
                      project.target_investment_amount_cny,
                      workspace,
                    )}
                  </strong>
                </div>
              )}
            </section>

            <section className="drawer-section source-note-panel">
              <div className="source-note-label">线索来源</div>
              <p>{project.source_note}</p>
            </section>

            <section className="drawer-section next-action-panel">
              <div className="eyebrow">下一步</div>
              <p>{project.next_action}</p>
              <span>期限：{formatDate(project.next_action_due, workspace)}</span>
            </section>

            {project.management_decisions.length > 0 && (
              <section className="drawer-section">
                <h3>需要管理层决策</h3>
                <ul className="decision-list">
                  {project.management_decisions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            )}

            <section className="drawer-section">
              <div className="section-title-row">
                <h3>关键联系人</h3>
                <span>{keyContacts.length} 人</span>
              </div>
              <div className="drawer-contacts">
                {keyContacts.map((contact) => (
                  <div className="drawer-contact" key={`${project.id}-${contact.id}`}>
                    <div className="avatar">{contact.name.slice(-2)}</div>
                    <div>
                      <strong>{contact.name}</strong>
                      <p>{contact.affiliation}</p>
                      <ContactChannels person={contact} />
                      <span>
                        {contact.project_roles.map((role) => roleLabels[role] ?? role).join(" · ")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="drawer-section">
              <div className="section-title-row">
                <h3>项目时间线</h3>
                <span>{sortedEvents.length} 条</span>
              </div>
              <div className="event-list drawer-timeline">
                {sortedEvents.map((event) => (
                  <EventItem
                    key={event.id}
                    event={event}
                    workspace={workspace}
                    compact
                    onOpenRecord={onOpenRecord}
                    attachments={<EventAttachments files={data.files || []} matter={project.id} event={event.id} snapshot={fileSnapshot} onDetails={() => onFiles(event.id)} compact/>}
                  />
                ))}
              </div>
            </section>
          </aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function Dashboard({ data, workspaceStatus, workspaceError, onWorkspaceRefresh, readOnly = false, historicalVersion, onBrowseHistory, initialHistoryVersion, backupStatus }: { data: DashboardData; workspaceStatus: WorkspaceStatus | null; workspaceError: string; onWorkspaceRefresh: () => Promise<void>; readOnly?:boolean; historicalVersion?:string; onBrowseHistory?:(snapshot:HistoricalSnapshot)=>void; initialHistoryVersion?:Version|null; backupStatus?:BackupStatus|null; }) {
  const canAdmin=!data.access || data.access.role==="admin";
  const canEdit=!data.access || data.access.role!=="viewer";
  const [page, setPage] = useState<"projects" | "company" | "investments" | "admin" | "history" | "ai">(initialHistoryVersion ? "history" : "projects");
  const [aiScope, setAiScope] = useState("");
  const [editTarget, setEditTarget] = useState<RecordTarget | null>(null);
  const [filesTarget, setFilesTarget] = useState<FileTarget | null>(null);
  const openFiles = (projectId?:string,eventId?:string,counterpartyId?:string) => {setSelectedProject(null);setSelectedRecord(null);setFilesTarget({projectId,eventId,counterpartyId});};
  const [exportPanel, setExportPanel] = useState<"projects" | "weekly" | null>(null);
  const [historyTarget, setHistoryTarget] = useState<RecordTarget | null>(null);
  const [saveNotice, setSaveNotice] = useState("");
  const openHistory = (target: RecordTarget) => {setSelectedProject(null);setHistoryTarget(target);setPage("history");};
  const saved = (result: SavedResponse) => {setSaveNotice(result.message);setEditTarget(null);void onWorkspaceRefresh();};
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [projectScope, setProjectScope] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [followUpFilter, setFollowUpFilter] = useState<
    "all" | Project["follow_up_status"]
  >("all");
  const [relationshipFilter, setRelationshipFilter] = useState("all");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectSort, setProjectSort] = useState<ProjectSort>("recent");
  const [selectedProjectValue, setSelectedProject] = useState<Project | null>(null);
  const selectedProject = data.projects.find(project => project.id === selectedProjectValue?.id) || null;
  const [selectedRecord, setSelectedRecord] = useState<RecordSelection | null>(null);
  const [keyPeopleOnly, setKeyPeopleOnly] = useState(true);
  const [peopleSort, setPeopleSort] = useState<PeopleSort>("recent");

  const clearFacetFilters = () => {
    setStageFilter("all");
    setPriorityFilter("all");
    setFollowUpFilter("all");
    setRelationshipFilter("all");
    setProjectQuery("");
  };

  const resetAllFilters = () => {
    setViewMode("all");
    setProjectScope("all");
    clearFacetFilters();
    setProjectSort("recent");
    setPeopleSort("recent");
    setSelectedProject(null);
  };

  const scrollToFilters = () => {
    window.setTimeout(() => {
      document
        .getElementById("filters")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const selectView = (mode: ViewMode) => {
    setViewMode((current) =>
      mode !== "all" && current === mode ? "all" : mode,
    );
    setProjectScope("all");
    clearFacetFilters();
    setSelectedProject(null);
  };

  const selectProjectScope = (projectId: string) => {
    setProjectScope((current) =>
      current === projectId ? "all" : projectId,
    );
    clearFacetFilters();
    setSelectedProject(null);
    window.setTimeout(() => {
      document
        .getElementById("filters")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const selectStage = (stage: string) => {
    setProjectScope("all");
    setProjectQuery("");
    setStageFilter((current) => (current === stage ? "all" : stage));
    setSelectedProject(null);
    scrollToFilters();
  };

  const selectPriority = (priority: string) => {
    setProjectScope("all");
    setProjectQuery("");
    setPriorityFilter((current) =>
      current === priority ? "all" : priority,
    );
    setSelectedProject(null);
    scrollToFilters();
  };

  const selectFollowUp = (status: Project["follow_up_status"]) => {
    setProjectScope("all");
    setProjectQuery("");
    setFollowUpFilter((current) => (current === status ? "all" : status));
    setSelectedProject(null);
    scrollToFilters();
  };

  const selectRelationship = (relationship: string) => {
    setProjectScope("all");
    setProjectQuery("");
    setRelationshipFilter((current) =>
      current === relationship ? "all" : relationship,
    );
    setSelectedProject(null);
    scrollToFilters();
  };

  const projectsForView = useMemo(
    () =>
      viewMode === "all"
        ? data.projects
        : data.projects.filter((project) => project.record_type === viewMode),
    [data.projects, viewMode],
  );
  const scopedProjects = useMemo(
    () =>
      projectScope === "all"
        ? projectsForView
        : projectsForView.filter((project) => project.id === projectScope),
    [projectScope, projectsForView],
  );
  const selectedScopeProject = data.projects.find(
    (project) => project.id === projectScope,
  );
  const viewAllLabel =
    viewMode === "all" ? "全部事项" : `全部${recordTypeLabels[viewMode]}`;
  const scopeLabel = selectedScopeProject?.name ?? viewAllLabel;

  const viewCounts: Record<ViewMode, number> = {
    all: data.projects.length,
    cooperation: data.projects.filter(
      (project) => project.record_type === "cooperation",
    ).length,
    investment: data.projects.filter(
      (project) => project.record_type === "investment",
    ).length,
    resource: data.projects.filter(
      (project) => project.record_type === "resource",
    ).length,
  };

  const matchesStage = (project: Project) =>
    stageFilter === "all" || project.stage === stageFilter;
  const matchesPriority = (project: Project) =>
    priorityFilter === "all" || project.priority === priorityFilter;
  const matchesFollowUp = (project: Project) =>
    followUpFilter === "all" || project.follow_up_status === followUpFilter;
  const matchesRelationship = (project: Project) =>
    relationshipFilter === "all" || project.relationship === relationshipFilter;
  const matchesQuery = (project: Project) =>
    projectMatchesQuery(project, projectQuery);

  const filteredProjects = scopedProjects.filter(
    (project) =>
      matchesStage(project) &&
      matchesPriority(project) &&
      matchesFollowUp(project) &&
      matchesRelationship(project) &&
      matchesQuery(project),
  );
  const sortedProjects = [...filteredProjects].sort((a, b) =>
    compareProjects(a, b, projectSort),
  );

  const projectCount = filteredProjects.length;
  const scopeProjectCount = scopedProjects.length;
  const highPriorityCount = scopedProjects.filter(
    (project) =>
      project.priority === "high" &&
      matchesStage(project) &&
      matchesFollowUp(project) &&
      matchesRelationship(project) &&
      matchesQuery(project),
  ).length;
  const proactiveContactCount = scopedProjects.filter(
    (project) =>
      project.follow_up_status === "proactive_contact" &&
      matchesStage(project) &&
      matchesPriority(project) &&
      matchesRelationship(project) &&
      matchesQuery(project),
  ).length;
  const activeCount = filteredProjects.filter(isActiveProject).length;

  const stageCounts = Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      scopedProjects.filter(
        (project) =>
          project.stage === stage &&
          matchesPriority(project) &&
          matchesFollowUp(project) &&
          matchesRelationship(project) &&
          matchesQuery(project),
      ).length,
    ]),
  ) as Record<(typeof STAGES)[number], number>;

  const includeCompanyEvents =
    viewMode === "all" &&
    projectScope === "all" &&
    stageFilter === "all" &&
    priorityFilter === "all" &&
    followUpFilter === "all" &&
    relationshipFilter === "all" &&
    projectQuery.trim().length === 0;
  const allEvents = collectActivityEvents(filteredProjects, includeCompanyEvents ? data.company_events : []).sort(eventSort);

  const scopedProjectIds = new Set(filteredProjects.map((project) => project.id));
  const scopedPeople = data.people
    .map((person) => {
      const projects = person.projects.filter((participation) =>
        scopedProjectIds.has(participation.project_id),
      );
      return {
        ...person,
        projects,
        project_roles: Array.from(
          new Set(projects.flatMap((participation) => participation.project_roles)),
        ),
        sides: Array.from(new Set(projects.map((participation) => participation.side))),
        last_activity:
          projects
            .map((participation) => participation.last_activity)
            .sort()
            .at(-1) ?? null,
      };
    })
    .filter((person) => person.projects.length > 0);

  const people = scopedPeople
    .filter(
      (person) =>
        !keyPeopleOnly ||
        person.project_roles.some((role) => keyContactRoles.has(role)),
    )
    .sort((a, b) => comparePeople(a, b, peopleSort));

  const activeFilters = [
    viewMode !== "all"
      ? {
          key: "view",
          label: viewModeLabels[viewMode],
          clear: () => {
            setViewMode("all");
            setProjectScope("all");
          },
        }
      : null,
    projectScope !== "all" && selectedScopeProject
      ? {
          key: "scope",
          label: selectedScopeProject.name,
          clear: () => setProjectScope("all"),
        }
      : null,
    stageFilter !== "all"
      ? {
          key: "stage",
          label: stageLabels[stageFilter] ?? stageFilter,
          clear: () => setStageFilter("all"),
        }
      : null,
    priorityFilter !== "all"
      ? {
          key: "priority",
          label: `${priorityLabels[priorityFilter] ?? priorityFilter}优先级`,
          clear: () => setPriorityFilter("all"),
        }
      : null,
    followUpFilter !== "all"
      ? {
          key: "follow-up",
          label: followUpStatusLabels[followUpFilter],
          clear: () => setFollowUpFilter("all"),
        }
      : null,
    relationshipFilter !== "all"
      ? {
          key: "relationship",
          label: relationshipLabels[relationshipFilter] ?? relationshipFilter,
          clear: () => setRelationshipFilter("all"),
        }
      : null,
    projectQuery.trim()
      ? {
          key: "query",
          label: `搜索：${projectQuery.trim()}`,
          clear: () => setProjectQuery(""),
        }
      : null,
  ].filter((filter): filter is NonNullable<typeof filter> => filter !== null);

  const hasFacetFilters =
    stageFilter !== "all" ||
    priorityFilter !== "all" ||
    followUpFilter !== "all" ||
    relationshipFilter !== "all" ||
    projectQuery.trim().length > 0;
  const projectListTitle =
    viewMode === "all"
      ? "合作项目、投资人对接与资源对接"
      : viewMode === "cooperation"
        ? "合作项目清单"
        : viewMode === "investment"
          ? "投资人对接清单"
          : "资源对接清单";
  const exportFacetLabels = activeFilters
    .filter((filter) => !["view", "scope"].includes(filter.key))
    .map((filter) => filter.label);
  const currentExportScopeLabel =
    exportFacetLabels.length > 0
      ? `${scopeLabel}（${exportFacetLabels.join("、")}）`
      : scopeLabel;

  return (
    <main className="page-shell workspace-page">
      <header className="workspace-toolbar">
        {readOnly?<a className="brand" href="#top" aria-label="返回历史看板顶部"><BrandLogo/><span><strong>{data.workspace.short_name}</strong><small>历史资料</small></span></a>:<div className="workspace-context"><span>业务工作台</span><p>{data.workspace.description}</p></div>}
        <div className="topbar-actions">
          <div className="data-freshness">
            <span className="live-dot" aria-hidden="true" />
            {data.updated_at ? `数据更新至 ${formatDate(data.updated_at, data.workspace)}` : "暂无业务记录"}
          </div>
          {!readOnly && <ToolbarActions
            onNewProject={canAdmin ? () => setEditTarget({kind:"project",id:""}) : undefined}
            onNewProgress={canEdit ? () => setEditTarget({kind:"progress",id:""}) : undefined}
            onExportProjects={page === "projects" ? () => setExportPanel("projects") : undefined}
            onExportWeekly={() => setExportPanel("weekly")}
          />}
        </div>
      </header>
      {page === "projects" && <ExportDialog
        data={data}
        currentProjects={filteredProjects}
        currentScopeLabel={currentExportScopeLabel}
        includeCurrentCompanyEvents={includeCompanyEvents}
        open={exportPanel === "projects"}
        onOpenChange={(open) => setExportPanel(open ? "projects" : null)}
      />}
      <WeeklyReportDialog data={data} open={exportPanel === "weekly"}
        onOpenChange={(open) => setExportPanel(open ? "weekly" : null)} />

      {(workspaceError || workspaceStatus?.errors.length) ? <div className="admin-alert" role="alert"><strong>{workspaceError || "最近文件修改有格式问题，已保留历史版本。当前展示上次校验通过的资料。"}</strong>{workspaceStatus?.errors.length ? <details><summary>查看问题</summary><ul>{workspaceStatus.errors.map((error,index) => <li key={index}>{error}</li>)}</ul></details> : null}{canAdmin&&<button type="button" className="admin-button" onClick={() => {setHistoryTarget(null);setPage("history");}}>查看修改历史</button>}</div> : null}
      {saveNotice && <div className="admin-notice" role="status">{saveNotice}<button type="button" aria-label="关闭保存提示" onClick={() => setSaveNotice("")}>×</button></div>}
      <nav className="workspace-nav" aria-label="工作台视图">
        <button type="button" aria-pressed={page === "projects"} onClick={() => setPage("projects")}>业务总览</button>
        <button type="button" aria-pressed={page === "investments"} onClick={() => setPage("investments")}>
          投资总览 <span>{data.projects.filter((project) => project.record_type === "investment").length}</span>
        </button>
        <button type="button" aria-pressed={page === "company"} onClick={() => setPage("company")}>
          公司动态 <span>{data.company_events.length}</span>
        </button>
        {!readOnly && canAdmin && <button type="button" aria-pressed={page === "admin"} onClick={() => setPage("admin")}>资料管理</button>}
        {!readOnly && canAdmin && <button type="button" aria-pressed={page === "history"} onClick={() => {setHistoryTarget(null);setPage("history");}}>修改历史</button>}
        {!readOnly && <button type="button" onClick={()=>openFiles()}>事项资料</button>}{readOnly && <button type="button" onClick={()=>openFiles()}>历史资料</button>}
        {!readOnly && <button type="button" aria-pressed={page === "ai"} onClick={() => {setAiScope("");setPage("ai");}}>AI 助手</button>}
      </nav>
      {!readOnly && page === "ai" && <AiAssistant key={aiScope} initialScope={aiScope} data={data} onSaved={saved} onSource={source => {const project = data.projects.find(p => p.id === source.projectId);const event = project?.events.find(e => e.id === source.eventId);if(project && event) setSelectedRecord({event,sourceLabel:project.name,projectId:project.id});}} />}
      {!readOnly && canAdmin && backupStatus?.error && <div className="admin-alert" role="alert">最近自动备份未完成，当前资料和已有版本仍然保留。<Link className="admin-button" href="/admin?section=backup">查看备份情况</Link></div>}
      {!readOnly && canAdmin && page === "admin" && <WorkspaceAdmin data={data} onEdit={setEditTarget} onHistory={openHistory} onFiles={openFiles} onNdaFiles={() => setFilesTarget({agreementType:"nda"})} onOpenRecord={(event,sourceLabel,projectId) => setSelectedRecord({event,sourceLabel,projectId})} />}
      {!readOnly && canAdmin && page === "history" && <VersionHistory onBrowse={onBrowseHistory} initialVersion={historyTarget ? null : initialHistoryVersion} key={historyTarget ? `${historyTarget.kind}:${historyTarget.id}` : "all"} data={data} initialTarget={historyTarget} onRestored={saved} />}
      <div hidden={page !== "investments"}>
        <InvestmentOverview projects={data.projects} files={data.files || []} people={data.people} onOpenProject={setSelectedProject} onOpenBp={(projectId,fileId) => setFilesTarget({projectId,fileId,category:"bp",usageKind:"sent"})} />
      </div>
      <div hidden={page !== "company"}>
        <CompanyActivity events={data.company_events} timezone={data.workspace.timezone} renderEvent={(event) => (
          <EventItem event={event} workspace={data.workspace}
            sourceLabel={companyCategoryLabel(event.category)}
            onOpenRecord={() => setSelectedRecord({ event, sourceLabel: "公司动态" })}
            actions={!readOnly && canAdmin && <>
              <button type="button" className="event-secondary-trigger" aria-label={`编辑动态：${event.title}`} onClick={() => setEditTarget({kind:"company",id:event.id})}>编辑动态</button>
              <button type="button" className="event-secondary-trigger" aria-label={`查看修改历史：${event.title}`} onClick={() => openHistory({kind:"company",id:event.id})}>修改历史</button>
            </>} />
        )} />
      </div>
      <div hidden={page !== "projects"}>
      <section className="company-preview" aria-label="最新公司动态">
        <strong>公司动态</strong>
        <span>{[...data.company_events].sort(eventSort)[0]?.title ?? "暂无公司动态"}</span>
        <button type="button" className="history-trigger" onClick={() => setPage("company")}>查看全部公司动态</button>
      </section>

      <section className="management-summary" id="top">
        <div className="summary-title">
          <div className="eyebrow">管理概览</div>
          <h1>业务与融资进展</h1>
          <span>{scopeLabel}</span>
        </div>
        <div className="summary-metrics" aria-label="可筛选核心指标">
          <button
            type="button"
            className={`summary-metric${!hasFacetFilters ? " active" : ""}`}
            onClick={clearFacetFilters}
            aria-pressed={!hasFacetFilters}
            aria-label={`显示当前范围全部${scopeProjectCount}个事项`}
          >
            <span>当前结果</span>
            <strong>{projectCount}</strong>
            <small>/ {scopeProjectCount}</small>
          </button>
          <button
            type="button"
            className={`summary-metric${priorityFilter === "high" ? " active" : ""}`}
            onClick={() => selectPriority("high")}
            aria-pressed={priorityFilter === "high"}
            aria-label={`筛选高优先级事项，共${highPriorityCount}个`}
          >
            <span>高优先级</span>
            <strong>{highPriorityCount}</strong>
            <small>个事项</small>
          </button>
          <button
            type="button"
            className={`summary-metric${followUpFilter === "proactive_contact" ? " active" : ""}`}
            onClick={() => selectFollowUp("proactive_contact")}
            aria-pressed={followUpFilter === "proactive_contact"}
            aria-label={`筛选可主动跟进事项，共${proactiveContactCount}个`}
          >
            <span>可主动跟进</span>
            <strong>{proactiveContactCount}</strong>
            <small>个事项</small>
          </button>
          <button
            type="button"
            className="summary-metric"
            onClick={() =>
              document
                .getElementById("people")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            aria-label={`查看当前结果相关人员，共${scopedPeople.length}人`}
          >
            <span>相关人员</span>
            <strong>{scopedPeople.length}</strong>
            <small>已去重</small>
          </button>
        </div>
      </section>

      <div className="dashboard-grid">
        <section className="panel pipeline-panel" aria-labelledby="pipeline-title">
          <div className="section-heading">
            <div>
              <div className="eyebrow">事项管线</div>
              <h2 id="pipeline-title">整体推进阶段</h2>
            </div>
            <span>{activeCount} 个活跃事项</span>
          </div>
          <div className="pipeline">
            {STAGES.slice(0, 6).map((stage) => {
              const count = stageCounts[stage];
              return (
                <button
                  type="button"
                  className={`pipeline-stage${count ? " has-project" : ""}${stageFilter === stage ? " active" : ""}`}
                  key={stage}
                  onClick={() => selectStage(stage)}
                  disabled={count === 0 && stageFilter !== stage}
                  aria-pressed={stageFilter === stage}
                  aria-label={`筛选${stageLabels[stage]}事项，共${count}个`}
                >
                  <span>{stageLabels[stage]}</span>
                  <strong>{count}</strong>
                  <i style={{ "--stage-width": `${Math.max(8, count * 100)}%` } as React.CSSProperties} />
                </button>
              );
            })}
          </div>
        </section>

      </div>

      <OverviewActivity key={JSON.stringify([viewMode,projectScope,stageFilter,priorityFilter,followUpFilter,relationshipFilter,projectQuery])}
        events={allEvents} timezone={data.workspace.timezone} includeCompanyEvents={includeCompanyEvents} scopeLabel={scopeLabel}
        historyAction={<EventHistoryDialog events={allEvents} workspace={data.workspace} scopeLabel={scopeLabel}
          referenceDate={data.updated_at ?? ""} onOpenRecord={event => setSelectedRecord({event, sourceLabel:event.sourceLabel,projectId:event.projectId})} />}
        renderEvent={event => <EventItem event={event} workspace={data.workspace} sourceLabel={event.sourceLabel}
          onOpenRecord={() => setSelectedRecord({event,sourceLabel:event.sourceLabel,projectId:event.projectId})}
          actions={!event.related_document ? <button type="button" className="event-secondary-trigger" onClick={() => setSelectedRecord({event,sourceLabel:event.sourceLabel,projectId:event.projectId})}>查看进展</button> : undefined} />} />

      <section
        className="filter-hub"
        id="filters"
        aria-labelledby="filters-title"
      >
        <div className="filter-hub-head">
          <div className="filter-hub-title">
            <div className="eyebrow">统一筛选</div>
            <h2 id="filters-title">筛选与查看范围</h2>
          </div>
          <ToggleGroup.Root
            className="view-switcher"
            type="single"
            value={viewMode}
            onValueChange={(value) => {
              selectView((value || "all") as ViewMode);
            }}
            aria-label="选择全局、合作项目、投资人对接或资源对接看板"
          >
            {(["all", "cooperation", "investment", "resource"] as const).map((mode) => (
              <ToggleGroup.Item
                className="view-switch-button"
                key={mode}
                value={mode}
                aria-label={
                  mode !== "all" && viewMode === mode
                    ? `取消${viewModeLabels[mode]}筛选，返回全局总览`
                    : `切换到${viewModeLabels[mode]}，${viewCounts[mode]}个事项`
                }
              >
                <strong>{viewModeLabels[mode]}</strong>
                <span className="view-switch-count">{viewCounts[mode]}</span>
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
          <span className="view-nav-hint">
            {viewMode === "all"
              ? viewModeDescriptions[viewMode]
              : `${viewModeDescriptions[viewMode]} · 再次点击可取消`}
          </span>
        </div>

        <div className="filter-controls">
          <SelectField
            label="单项范围"
            value={projectScope}
            onChange={(value) => {
              if (value === "all") {
                setProjectScope("all");
                clearFacetFilters();
                setSelectedProject(null);
              } else {
                selectProjectScope(value);
              }
            }}
            ariaLabel="按单项筛选当前看板"
            className="scope-control"
          >
            <option value="all">{viewAllLabel}</option>
            {projectsForView.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SelectField>
          <SearchField
            label="关键词"
            value={projectQuery}
            onChange={setProjectQuery}
            placeholder="事项、对接方或负责人"
            ariaLabel="搜索事项"
            className="search-control"
          />
          <SelectField
            label="推进阶段"
            value={stageFilter}
            onChange={setStageFilter}
            ariaLabel="按事项阶段筛选"
          >
            <option value="all">全部阶段</option>
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stageLabels[stage]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="优先级"
            value={priorityFilter}
            onChange={setPriorityFilter}
            ariaLabel="按事项优先级筛选"
          >
            <option value="all">全部优先级</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priorityLabels[priority]}优先级
              </option>
            ))}
          </SelectField>
          <SelectField
            label="排序方式"
            value={projectSort}
            onChange={(value) => setProjectSort(value as ProjectSort)}
            ariaLabel="调整事项清单排序"
          >
            {(Object.entries(projectSortLabels) as Array<
              [ProjectSort, string]
            >).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="跟进状态"
            value={followUpFilter}
            onChange={(value) =>
              setFollowUpFilter(
                value as "all" | Project["follow_up_status"],
              )
            }
            ariaLabel="按跟进状态筛选"
          >
            <option value="all">全部跟进状态</option>
            {FOLLOW_UP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {followUpStatusLabels[status]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="关系策略"
            value={relationshipFilter}
            onChange={setRelationshipFilter}
            ariaLabel="按关系策略筛选"
            className="relationship-control"
          >
            <option value="all">全部关系策略</option>
            {RELATIONSHIPS.map((relationship) => (
              <option key={relationship} value={relationship}>
                {relationshipLabels[relationship]}
              </option>
            ))}
          </SelectField>
        </div>

        <div className="filter-status" aria-label="当前筛选条件" aria-live="polite">
          <div className="filter-result-count">
            <span>当前显示</span>
            <strong>{projectCount}</strong>
            <span>/ {scopeProjectCount} 个事项</span>
          </div>
          <div className="active-filter-list">
            {activeFilters.length === 0 ? (
              <span className="no-filter-copy">当前未添加筛选条件</span>
            ) : (
              activeFilters.map((filter) => (
                <button
                  type="button"
                  className="active-filter-chip"
                  key={filter.key}
                  onClick={filter.clear}
                  aria-label={`移除筛选：${filter.label}`}
                >
                  {filter.label}
                  <span aria-hidden="true">×</span>
                </button>
              ))
            )}
          </div>
          {activeFilters.length > 0 && (
            <button type="button" className="reset-filters" onClick={resetAllFilters}>
              重置全部
            </button>
          )}
        </div>
      </section>

      <section className="section-block" id="projects" aria-labelledby="projects-title">
        <div className="section-heading large">
          <div>
            <div className="eyebrow">事项清单</div>
            <h2 id="projects-title">{projectListTitle}</h2>
          </div>
          <span>
            {projectCount} 个结果 · {projectSortLabels[projectSort]}
          </span>
        </div>

        <div className="project-table" role="table" aria-label="事项清单">
          <div className="project-row project-table-head" role="row">
            <span role="columnheader">事项 / 对接方</span>
            <span role="columnheader">类型 / 阶段</span>
            <span role="columnheader">最新进展</span>
            <span role="columnheader">下一步行动</span>
            <span role="columnheader">负责人</span>
          </div>
          {sortedProjects.map((project) => {
            const latestEvent = [...project.events].sort(eventSort)[0];
            const inactiveDays = daysBetween(project.last_activity, data.updated_at);
            return (
              <div
                className="project-row"
                role="row"
                key={project.id}
              >
                <span className="project-cell-title" role="cell">
                  <button
                    type="button"
                    className="project-title-button"
                    onClick={() => setSelectedProject(project)}
                    aria-label={`查看${project.name}详情`}
                  >
                    <strong>{project.name}</strong>
                    <small>{project.counterparties.join("、")}</small>
                  </button>
                  <span className="mobile-badges">
                    <RecordTypeBadge
                      project={project}
                      active={viewMode === project.record_type}
                      onClick={() => selectView(project.record_type)}
                    />
                    <ProjectBadge
                      project={project}
                      active={stageFilter === project.stage}
                      onClick={() => selectStage(project.stage)}
                    />
                    <PriorityBadge
                      project={project}
                      active={priorityFilter === project.priority}
                      onClick={() => selectPriority(project.priority)}
                    />
                    <FollowUpBadge
                      project={project}
                      active={followUpFilter === project.follow_up_status}
                      onClick={() => selectFollowUp(project.follow_up_status)}
                    />
                    <RelationshipBadge
                      project={project}
                      active={relationshipFilter === project.relationship}
                      onClick={() => selectRelationship(project.relationship)}
                    />
                  </span>
                </span>
                <span role="cell" className="desktop-stage">
                  <RecordTypeBadge
                    project={project}
                    active={viewMode === project.record_type}
                    onClick={() => selectView(project.record_type)}
                  />
                  <ProjectBadge
                    project={project}
                    active={stageFilter === project.stage}
                    onClick={() => selectStage(project.stage)}
                  />
                  <PriorityBadge
                    project={project}
                    active={priorityFilter === project.priority}
                    onClick={() => selectPriority(project.priority)}
                  />
                  <FollowUpBadge
                    project={project}
                    active={followUpFilter === project.follow_up_status}
                    onClick={() => selectFollowUp(project.follow_up_status)}
                  />
                  <RelationshipBadge
                    project={project}
                    active={relationshipFilter === project.relationship}
                    onClick={() => selectRelationship(project.relationship)}
                  />
                </span>
                <span className="latest-cell" role="cell">
                  <time dateTime={latestEvent?.date}>
                    {formatDate(latestEvent?.date, data.workspace)}
                  </time>
                  <strong>{latestEvent?.title ?? "暂无事件"}</strong>
                  <small>{inactiveDays === 0 ? "本日更新" : `${inactiveDays} 天未更新`}</small>
                </span>
                <span className="action-cell" role="cell">
                  {project.next_action}
                </span>
                <span className="owner-cell" role="cell">
                  <span className="owner-avatar">{project.owner.slice(-1)}</span>
                  {project.owner}
                  <button
                    type="button"
                    className="project-details-button"
                    onClick={() => setSelectedProject(project)}
                    aria-label={`查看${project.name}详情`}
                  >
                    查看
                    <i aria-hidden="true">›</i>
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {filteredProjects.length === 0 && (
          <div className="empty-state">没有符合当前筛选条件的事项。</div>
        )}
      </section>

      <section className="section-block" id="people" aria-labelledby="people-title">
        <div className="section-heading large">
          <div>
            <div className="eyebrow">人员视图</div>
            <h2 id="people-title">事项相关人员</h2>
          </div>
          <div className="people-tools">
            <span className="people-scope">{scopeLabel} · 显示 {people.length} / {scopedPeople.length} 人</span>
            <SelectField
              label="排序方式"
              value={peopleSort}
              onChange={(value) => setPeopleSort(value as PeopleSort)}
              ariaLabel="人员排序方式"
              className="people-sort"
              layout="inline"
            >
              {(Object.entries(peopleSortLabels) as Array<
                [PeopleSort, string]
              >).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectField>
            <button
              type="button"
              className={`toggle-button${keyPeopleOnly ? " active" : ""}`}
              onClick={() => setKeyPeopleOnly((value) => !value)}
              aria-pressed={keyPeopleOnly}
            >
              只看关键联系人
            </button>
          </div>
        </div>

        {people.length > 0 ? (
          <div className="people-table-scroll" role="region" aria-label="人员列表，可滚动查看" tabIndex={0}>
            <table className="people-table">
              <caption className="sr-only">事项相关人员列表</caption>
              <colgroup><col className="people-name-column" /><col className="people-affiliation-column" /><col className="people-roles-column" /><col className="people-contact-column" /><col className="people-projects-column" /><col className="people-date-column" /></colgroup>
              <thead><tr>
                <th scope="col" aria-sort={peopleSort === "name" ? "ascending" : undefined}>
                  <button type="button" className="people-sort-header" onClick={() => setPeopleSort("name")} aria-label="按姓名拼音排序">姓名{peopleSort === "name" && <span aria-hidden="true">↑</span>}</button>
                </th>
                <th scope="col">单位及职位</th><th scope="col">项目角色</th><th scope="col">联系方式</th>
                <th scope="col" aria-sort={peopleSort === "projects" ? "descending" : undefined}>
                  <button type="button" className="people-sort-header" onClick={() => setPeopleSort("projects")} aria-label="按关联事项数排序">关联事项{peopleSort === "projects" && <span aria-hidden="true">↓</span>}</button>
                </th>
                <th scope="col" aria-sort={peopleSort === "recent" ? "descending" : undefined}>
                  <button type="button" className="people-sort-header" onClick={() => setPeopleSort("recent")} aria-label="按最近参与时间排序">最近参与{peopleSort === "recent" && <span aria-hidden="true">↓</span>}</button>
                </th>
              </tr></thead>
              <tbody>{people.map((person) => {
                const projectButton = (participation: (typeof person.projects)[number]) => (
                    <button
                      type="button"
                      key={participation.project_id}
                      className={
                        projectScope === participation.project_id ? "active" : ""
                      }
                      onClick={() => selectProjectScope(participation.project_id)}
                      aria-pressed={projectScope === participation.project_id}
                      aria-label={
                        projectScope === participation.project_id
                          ? `取消${participation.project_name}筛选`
                          : `只看${participation.project_name}`
                      }
                    >
                      {participation.project_name}
                    </button>
                );
                return <tr key={person.id} data-person-id={person.id}>
                  <th scope="row">{readOnly || !canAdmin ? <strong>{person.name}</strong> : <button type="button" className="people-person-link" aria-label={`编辑人员${person.name}`} onClick={() => setEditTarget({kind:"person",id:person.id})}>{person.name}</button>}<span className="people-side">{person.sides.map((side) => sideLabels[side]).join(" / ")}</span>{!readOnly && canAdmin && <button type="button" className="people-history-link" aria-label={`查看${person.name}修改历史`} onClick={() => openHistory({kind:"person",id:person.id})}>历史</button>}</th>
                  <td>{person.affiliation}</td>
                  <td><div className="role-tags">{person.project_roles.map((role) => <span key={role}>{roleLabels[role] ?? role}</span>)}</div></td>
                  <td>{[person.phone, person.wechat, person.email].some((value) => value?.trim()) ? <ContactChannels person={person} /> : <span className="people-muted">未填写</span>}</td>
                  <td><span className="people-project-count">{person.projects.length} 个事项</span>
                    <div className="person-projects">{person.projects.slice(0, 2).map(projectButton)}</div>
                    {person.projects.length > 2 && <details className="people-more-projects"><summary>另 {person.projects.length - 2} 个事项</summary><div className="person-projects">{person.projects.slice(2).map(projectButton)}</div></details>}
                  </td>
                  <td className="people-last-activity"><time dateTime={person.last_activity ?? undefined}>{person.last_activity ?? "—"}</time></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : (
          <div className="people-empty-state">当前筛选下暂无相关人员。</div>
        )}
      </section>

      </div>
      <footer className="page-footer">
        <span>{data.workspace.short_name} · {data.workspace.workspace_title}</span>
        <div className="page-footer-meta"><span>数据来自事项档案、人员记录与结构化事件</span></div>
      </footer>

      {selectedProject && (
        <ProjectDrawer fileSnapshot={historicalVersion} readOnly={readOnly || !canEdit}
          onBpFiles={fileId => setFilesTarget({projectId:selectedProject.id,fileId,category:"bp",usageKind:"sent"})}
          onAi={readOnly ? undefined : () => {setAiScope(selectedProject.id);setSelectedProject(null);setPage("ai");}}
          data={data} onSelectProject={setSelectedProject} onCounterpartyFiles={identity => openFiles(undefined,undefined,identity)}
          onEdit={setEditTarget}
          onHistory={openHistory}
          onFiles={eventId => openFiles(selectedProject.id,eventId)}
          fileCount={(data.files || []).filter(item => !item.archived && item.project_ids.includes(selectedProject.id)).length}
          project={selectedProject}
          workspace={data.workspace}
          onClose={() => setSelectedProject(null)}
          onRecordTypeFilter={(recordType) => {
            setPage("projects");
            selectView(recordType);
            scrollToFilters();
          }}
          onStageFilter={(value) => { setPage("projects"); selectStage(value); }}
          onPriorityFilter={(value) => { setPage("projects"); selectPriority(value); }}
          onFollowUpFilter={(value) => { setPage("projects"); selectFollowUp(value); }}
          onRelationshipFilter={(value) => { setPage("projects"); selectRelationship(value); }}
          onOpenRecord={(event) =>
            setSelectedRecord({ event, sourceLabel: selectedProject.name, projectId: selectedProject.id })
          }
          recordTypeActive={viewMode === selectedProject.record_type}
          stageActive={stageFilter === selectedProject.stage}
          priorityActive={priorityFilter === selectedProject.priority}
          followUpActive={followUpFilter === selectedProject.follow_up_status}
          relationshipActive={relationshipFilter === selectedProject.relationship}
        />
      )}
      {!readOnly && canEdit && editTarget && <RecordEditor key={`${editTarget.kind}:${editTarget.id}:${editTarget.project_id || ""}`} target={editTarget} data={data} onTargetChange={setEditTarget} onClose={() => setEditTarget(null)} onSaved={saved} onSavedWithFiles={async result => {const target=editTarget;await onWorkspaceRefresh();setSaveNotice(result.message);setEditTarget(null);openFiles(target.kind === "project" ? result.id : target.project_id,target.kind === "progress" ? result.id : undefined);}} />}
      {readOnly && historicalVersion && filesTarget && <HistoricalFiles data={data} target={filesTarget} version={historicalVersion} onClose={()=>setFilesTarget(null)}/> }
      {!readOnly && filesTarget && <FileLibraryDialog data={data} target={filesTarget} onClose={() => setFilesTarget(null)} onChanged={onWorkspaceRefresh} onHistory={openHistory} />}
      <EventRecordDialog
        selection={selectedRecord}
        files={data.files || []}
        snapshot={readOnly ? historicalVersion : undefined}
        onFiles={selectedRecord?.projectId ? () => openFiles(selectedRecord.projectId,selectedRecord.event.id) : undefined}
        workspace={data.workspace}
        onClose={() => setSelectedRecord(null)}
      />
    </main>
  );
}
