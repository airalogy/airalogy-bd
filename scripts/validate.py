#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "PyYAML>=6.0,<7",
# ]
# ///

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any

import yaml


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验 BD 工作台内容")
    parser.add_argument(
        "--content-dir",
        type=Path,
        default=Path.cwd() / "content",
        help="公司 BD 内容目录，默认为当前目录下的 content",
    )
    return parser.parse_args()


ARGS = parse_args()
CONTENT_ROOT = ARGS.content_dir.resolve()
ROOT = CONTENT_ROOT.parent
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ASCII_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CONTACT_ID_PATTERN = re.compile(r"^[^\s/\\]+$")
ROLE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

PROJECT_STAGES = {
    "initial_contact",
    "opportunity_assessment",
    "solution_discussion",
    "agreement_negotiation",
    "signed",
    "execution",
    "paused",
    "terminated",
}
RELATIONSHIP_STATES = {"active", "dormant", "maintained"}
PRIORITIES = {"high", "medium", "low"}
FOLLOW_UP_STATUSES = {
    "active_progress",
    "proactive_contact",
    "awaiting_response",
    "on_hold",
    "closed",
}
RECORD_TYPES = {"cooperation", "investment", "resource"}
SOURCE_CERTAINTIES = {"confirmed", "provisional", "unknown"}
CONTACT_SIDES = {"counterparty", "internal", "advisor"}
EVENT_TYPES = {
    "contact",
    "meeting",
    "proposal",
    "agreement",
    "administrative",
    "decision",
    "payment",
    "milestone",
    "status_change",
    "other",
}
EVENT_IMPORTANCE = {"key", "normal"}
COMPANY_INITIATIVE_STATUSES = {"active", "paused", "completed"}
errors: list[str] = []
project_ids: dict[str, Path] = {}
meeting_ids: dict[str, Path] = {}
people_profiles: dict[str, dict[str, Any]] = {}
project_count = 0
people_count = 0
contact_count = 0
event_count = 0
meeting_count = 0
company_event_count = 0
company_record_count = 0


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT))


def present_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def flatten_participant_ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if present_string(item)]
    if isinstance(value, dict):
        return [
            item
            for items in value.values()
            if isinstance(items, list)
            for item in items
            if present_string(item)
        ]
    return []


def load_yaml_text(text: str, path: Path, label: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        first_line = str(exc).splitlines()[0]
        errors.append(f"{relative(path)}: {label}语法错误（{first_line}）")
        return {}

    if not isinstance(data, dict):
        errors.append(f"{relative(path)}: {label}顶层必须是对象")
        return {}
    return data


def load_yaml_file(path: Path) -> dict[str, Any]:
    return load_yaml_text(path.read_text(encoding="utf-8"), path, "YAML ")


def load_frontmatter(path: Path) -> dict[str, Any]:
    content = path.read_text(encoding="utf-8")
    match = re.match(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", content, re.DOTALL)
    if not match:
        errors.append(f"{relative(path)}: 缺少 YAML frontmatter")
        return {}
    return load_yaml_text(match.group(1), path, "frontmatter ")


def markdown_body(path: Path) -> str:
    content = path.read_text(encoding="utf-8")
    match = re.match(r"\A---[ \t]*\n.*?\n---[ \t]*(?:\n|\Z)", content, re.DOTALL)
    return content[match.end() :] if match else content


def validate_management_prose(path: Path) -> None:
    body = markdown_body(path)
    if re.search(r"`[^`\n]+`", body):
        errors.append(
            f"{relative(path)}: 管理层正文不应使用 Markdown 行内代码；"
            "字段名和英文状态值应只放在 frontmatter"
        )

    implementation_phrases = (
        "阶段登记为",
        "阶段记为",
        "状态登记为",
        "关系策略登记为",
        "项目阶段更新为",
        "标记为 provisional",
    )
    found_phrases = [phrase for phrase in implementation_phrases if phrase in body]
    if found_phrases:
        errors.append(
            f"{relative(path)}: 管理层正文包含实现式表述 "
            f"{', '.join(f'`{phrase}`' for phrase in found_phrases)}"
        )


def missing(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def require_fields(
    data: dict[str, Any],
    fields: tuple[str, ...],
    path: Path,
    prefix: str = "",
    allow_empty: tuple[str, ...] = (),
) -> None:
    for field in fields:
        if missing(data.get(field)) and not (field in allow_empty and data.get(field) == []):
            errors.append(f"{relative(path)}: 缺少必填字段 `{prefix}{field}`")


def reject_fields(
    data: dict[str, Any],
    fields: tuple[str, ...],
    path: Path,
) -> None:
    for field in fields:
        if field in data:
            errors.append(f"{relative(path)}: 不再支持字段 `{field}`，请删除")


def normalize_date(value: Any) -> str:
    return value.isoformat() if isinstance(value, date) else str(value)


def validate_date(
    value: Any,
    field: str,
    path: Path,
    *,
    allow_none: bool = False,
) -> None:
    if allow_none and value is None:
        return

    date_text = normalize_date(value)
    if not DATE_PATTERN.fullmatch(date_text):
        errors.append(f"{relative(path)}: `{field}` 必须使用 YYYY-MM-DD")
        return

    try:
        date.fromisoformat(date_text)
    except ValueError:
        errors.append(f"{relative(path)}: `{field}` 不是有效日期")


workspace_data: dict[str, Any] = {}
workspace_file = CONTENT_ROOT / "workspace.yaml"
if not workspace_file.is_file():
    errors.append("content/workspace.yaml: 缺少工作区配置")
else:
    workspace_data = load_yaml_file(workspace_file)
    require_fields(
        workspace_data,
        (
            "id",
            "name",
            "short_name",
            "workspace_title",
            "description",
            "locale",
            "timezone",
            "brand_mark",
            "privacy_notice",
        ),
        workspace_file,
    )
    workspace_id = workspace_data.get("id")
    if present_string(workspace_id) and not ASCII_ID_PATTERN.fullmatch(workspace_id):
        errors.append(
            f"{relative(workspace_file)}: `id` 只能包含小写字母、数字和连字符"
        )
    for field in (
        "name",
        "short_name",
        "workspace_title",
        "description",
        "locale",
        "timezone",
        "brand_mark",
        "privacy_notice",
    ):
        if not present_string(workspace_data.get(field)):
            errors.append(f"{relative(workspace_file)}: `{field}` 必须是非空字符串")

people_file = CONTENT_ROOT / "people.yaml"
people_label = relative(people_file)
if not people_file.is_file():
    errors.append(f"{people_label}: 缺少全局人员库")
else:
    people_data = load_yaml_file(people_file)

    people = people_data.get("people")
    if not isinstance(people, list):
        errors.append(f"{people_label}: `people` 必须是数组")
        people = []

    for index, person in enumerate(people):
        label = f"people[{index}]"
        if not isinstance(person, dict):
            errors.append(f"{people_label}: {label} 必须是对象")
            continue

        require_fields(
            person,
            ("id", "name", "affiliation"),
            people_file,
            f"{label}.",
        )
        person_id = person.get("id")
        if present_string(person_id):
            if not CONTACT_ID_PATTERN.fullmatch(person_id):
                errors.append(
                    f"{people_label}: {label}.id 不能包含空格、斜杠或反斜杠"
                )
            if person_id in people_profiles:
                errors.append(f"{people_label}: {label}.id `{person_id}` 重复")
            else:
                people_profiles[person_id] = person

        if not present_string(person.get("name")):
            errors.append(f"{people_label}: {label}.name 必须是非空字符串")
        if not present_string(person.get("affiliation")):
            errors.append(
                f"{people_label}: {label}.affiliation 必须是非空的“单位及职位”字符串"
            )
        for field in ("phone", "wechat", "email"):
            value = person.get(field)
            if value is None:
                continue
            if not isinstance(value, str) or any(ord(char) < 32 or ord(char) == 127 for char in value):
                errors.append(f"{people_label}: {label}.{field} 必须是单行字符串或 null；电话号码请加引号")
            elif field == "email" and value.strip() and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value.strip()):
                errors.append(f"{people_label}: {label}.email 必须是有效的邮箱格式")
        people_count += 1

company_dir = CONTENT_ROOT / "company"
company_fundraising_file = company_dir / "fundraising.md"
company_events_file = company_dir / "events.yaml"
company_records_dir = company_dir / "records"

if company_dir.is_dir():
    if company_fundraising_file.is_file():
        fundraising = load_frontmatter(company_fundraising_file)
        validate_management_prose(company_fundraising_file)
        require_fields(
            fundraising,
            (
                "id",
                "company",
                "name",
                "status",
                "priority",
                "owner",
                "participants",
                "started",
                "last_activity",
                "next_action",
            ),
            company_fundraising_file,
        )
        if fundraising.get("company") != workspace_data.get("id"):
            errors.append(
                f"{relative(company_fundraising_file)}: `company` 必须与工作区 ID 一致"
            )
        if fundraising.get("status") not in COMPANY_INITIATIVE_STATUSES:
            errors.append(
                f"{relative(company_fundraising_file)}: `status` 必须是 active、paused 或 completed"
            )
        if fundraising.get("priority") not in PRIORITIES:
            errors.append(
                f"{relative(company_fundraising_file)}: `priority` 必须是 high、medium 或 low"
            )
        owner = fundraising.get("owner")
        if present_string(owner) and owner not in people_profiles:
            errors.append(
                f"{relative(company_fundraising_file)}: `owner` 引用了不存在的人员 `{owner}`"
            )
        participants = fundraising.get("participants")
        if not (
            isinstance(participants, list)
            and participants
            and all(present_string(person_id) for person_id in participants)
        ):
            errors.append(
                f"{relative(company_fundraising_file)}: `participants` 必须是非空人员 ID 数组"
            )
        else:
            for person_id in participants:
                if person_id not in people_profiles:
                    errors.append(
                        f"{relative(company_fundraising_file)}: `participants` 引用了不存在的人员 `{person_id}`"
                    )
        validate_date(fundraising.get("started"), "started", company_fundraising_file)
        validate_date(
            fundraising.get("last_activity"),
            "last_activity",
            company_fundraising_file,
        )
        validate_date(
            fundraising.get("next_action_due"),
            "next_action_due",
            company_fundraising_file,
            allow_none=True,
        )

    company_related_records: set[Path] = set()
    if not company_events_file.is_file():
        errors.append(f"{relative(company_dir)}: 缺少 events.yaml")
    else:
        company_events_data = load_yaml_file(company_events_file)
        require_fields(
            company_events_data,
            ("company",),
            company_events_file,
        )
        if company_events_data.get("company") != workspace_data.get("id"):
            errors.append(
                f"{relative(company_events_file)}: `company` 必须与工作区 ID 一致"
            )
        company_events = company_events_data.get("events")
        if not isinstance(company_events, list):
            errors.append(f"{relative(company_events_file)}: `events` 必须是数组")
            company_events = []

        company_event_ids: dict[str, int] = {}
        previous_company_event_date: str | None = None
        for index, event in enumerate(company_events):
            company_event_count += 1
            label = f"events[{index}]"
            if not isinstance(event, dict):
                errors.append(f"{relative(company_events_file)}: {label} 必须是对象")
                continue
            require_fields(
                event,
                (
                    "id",
                    "date",
                    "category",
                    "type",
                    "title",
                    "summary",
                    "importance",
                    "participants",
                ),
                company_events_file,
                f"{label}.",
            )
            event_id = event.get("id")
            if present_string(event_id):
                if not ASCII_ID_PATTERN.fullmatch(event_id):
                    errors.append(
                        f"{relative(company_events_file)}: {label}.id 只能包含小写字母、数字和连字符"
                    )
                if event_id in company_event_ids:
                    errors.append(
                        f"{relative(company_events_file)}: {label}.id 与 events[{company_event_ids[event_id]}] 重复"
                    )
                else:
                    company_event_ids[event_id] = index
            validate_date(event.get("date"), f"{label}.date", company_events_file)
            event_date = normalize_date(event.get("date"))
            try:
                valid_event_date = bool(DATE_PATTERN.fullmatch(event_date))
                if valid_event_date:
                    date.fromisoformat(event_date)
            except ValueError:
                valid_event_date = False
            if valid_event_date:
                if (
                    previous_company_event_date is not None
                    and event_date < previous_company_event_date
                ):
                    errors.append(
                        f"{relative(company_events_file)}: 事件必须按日期从早到晚排列"
                    )
                previous_company_event_date = event_date
            if not present_string(event.get("category")):
                errors.append(
                    f"{relative(company_events_file)}: {label}.category 必须是非空字符串"
                )
            if event.get("type") not in EVENT_TYPES:
                errors.append(
                    f"{relative(company_events_file)}: {label}.type 不在允许范围内"
                )
            if event.get("importance") not in EVENT_IMPORTANCE:
                errors.append(
                    f"{relative(company_events_file)}: {label}.importance 必须是 key 或 normal"
                )
            title = event.get("title")
            summary = event.get("summary")
            if present_string(title) and len(title) > 40:
                errors.append(
                    f"{relative(company_events_file)}: {label}.title 不应超过 40 个字符"
                )
            if present_string(summary) and len(summary) > 200:
                errors.append(
                    f"{relative(company_events_file)}: {label}.summary 不应超过 200 个字符"
                )
            participants = event.get("participants")
            if not (
                isinstance(participants, list)
                and participants
                and all(present_string(person_id) for person_id in participants)
            ):
                errors.append(
                    f"{relative(company_events_file)}: {label}.participants 必须是非空人员 ID 数组"
                )
            else:
                for person_id in participants:
                    if person_id not in people_profiles:
                        errors.append(
                            f"{relative(company_events_file)}: {label}.participants 引用了不存在的人员 `{person_id}`"
                        )
            organizers = event.get("organizers")
            if organizers is not None and not (
                isinstance(organizers, list)
                and all(present_string(organizer) for organizer in organizers)
            ):
                errors.append(
                    f"{relative(company_events_file)}: {label}.organizers 必须是字符串数组"
                )
            related_record = event.get("related_record")
            if related_record is not None:
                if not present_string(related_record):
                    errors.append(
                        f"{relative(company_events_file)}: {label}.related_record 必须是相对路径字符串"
                    )
                else:
                    target = (company_dir / related_record).resolve()
                    if not target.is_relative_to(company_dir.resolve()):
                        errors.append(
                            f"{relative(company_events_file)}: {label}.related_record 必须位于 company 目录内"
                        )
                    elif not target.is_file():
                        errors.append(
                            f"{relative(company_events_file)}: {label}.related_record 指向的文件不存在"
                        )
                    else:
                        company_related_records.add(target)

    if not company_records_dir.is_dir():
        errors.append(f"{relative(company_dir)}: 缺少 records/ 目录")
    else:
        company_record_ids: dict[str, Path] = {}
        for record_file in sorted(company_records_dir.glob("*.md")):
            company_record_count += 1
            record = load_frontmatter(record_file)
            reject_fields(record, ("format", "source_type"), record_file)
            require_fields(
                record,
                (
                    "id",
                    "scope",
                    "category",
                    "date",
                    "type",
                    "participants",
                ),
                record_file,
            )
            record_id = record.get("id")
            if present_string(record_id):
                if not ASCII_ID_PATTERN.fullmatch(record_id):
                    errors.append(
                        f"{relative(record_file)}: `id` 只能包含小写字母、数字和连字符"
                    )
                if record_id in company_record_ids:
                    errors.append(
                        f"{relative(record_file)}: 公司记录 ID 与 {relative(company_record_ids[record_id])} 重复"
                    )
                else:
                    company_record_ids[record_id] = record_file
            if record.get("scope") != "company":
                errors.append(f"{relative(record_file)}: `scope` 必须是 company")
            if not present_string(record.get("category")):
                errors.append(f"{relative(record_file)}: `category` 必须是非空字符串")
            validate_date(record.get("date"), "date", record_file)
            record_date = normalize_date(record.get("date"))
            compact_record_date = record_date.replace("-", "")
            record_filename_pattern = re.compile(
                rf"^{re.escape(compact_record_date)}(?:-.+)?\.md$"
            )
            if not record_filename_pattern.fullmatch(record_file.name):
                errors.append(
                    f"{relative(record_file)}: 文件名必须使用 {compact_record_date}.md"
                    f" 或 {compact_record_date}-主题.md"
                )
            record_participants = record.get("participants")
            if not (
                isinstance(record_participants, dict)
                and record_participants
                and all(
                    isinstance(names, list)
                    and all(present_string(name) for name in names)
                    for names in record_participants.values()
                )
            ):
                errors.append(
                    f"{relative(record_file)}: `participants` 必须按参与方分组并使用姓名数组"
                )
            if record_file.resolve() not in company_related_records:
                errors.append(
                    f"{relative(record_file)}: 必须在 company/events.yaml 中由一条公司事件引用"
                )

from content_paths import is_attachment_path, archive_only_project, name_key

party_catalog = {}
party_names = set()
party_directories = {}
if (CONTENT_ROOT / "projects").exists():
    errors.append("content/projects/: 不支持此目录结构，请按 content/counterparties/<对接方>/matters/<事项>/ 组织资料。")
for directory in sorted((CONTENT_ROOT / "counterparties").glob("*")):
    if not directory.is_dir() or archive_only_project(directory):
        continue
    source = directory / "README.md"
    contacts_path = directory / "contacts.yaml"
    if not source.is_file() or not contacts_path.is_file():
        errors.append(f"{relative(directory)}: 对接方缺少 README.md 或 contacts.yaml")
        continue
    metadata = load_frontmatter(source)
    require_fields(metadata, ("id", "name", "kind"), source)
    identity, name = metadata.get("id"), metadata.get("name")
    if not present_string(identity) or not ASCII_ID_PATTERN.fullmatch(identity):
        errors.append(f"{relative(source)}: 对接方 id 无效")
        continue
    if identity in party_catalog:
        errors.append(f"{relative(source)}: 对接方 id 重复")
    if not present_string(name) or (present_string(name) and name_key(name) in party_names):
        errors.append(f"{relative(source)}: 对接方名称为空或重复")
    elif present_string(name):
        party_names.add(name_key(name))
    if metadata.get("kind") not in {"organization", "person"}:
        errors.append(f"{relative(source)}: kind 必须是 organization 或 person")
    if "short_name" in metadata and metadata["short_name"] is not None and not present_string(metadata["short_name"]):
        errors.append(f"{relative(source)}: short_name 须为非空文字")
    shared = load_yaml_file(contacts_path)
    ids = shared.get("people")
    if shared.get("counterparty") != identity or not isinstance(ids, list) or any(not isinstance(person, str) or person not in people_profiles for person in ids) or (isinstance(ids, list) and len(set(ids)) != len(ids)):
        errors.append(f"{relative(contacts_path)}: 共用联系人须引用现有人员且不能重复")
    party_catalog[identity] = metadata
    party_directories[identity] = directory

project_dirs = sorted(path for path in (CONTENT_ROOT / "counterparties").glob("*/matters/*") if path.is_dir())

for project_dir in project_dirs:
    project_count += 1
    project_file = project_dir / "README.md"
    contacts_file = project_dir / "contacts.yaml"
    events_file = project_dir / "events.yaml"
    meetings_dir = project_dir / "meetings"

    if not project_file.is_file():
        errors.append(f"{relative(project_dir)}: 缺少 README.md")
    if not contacts_file.is_file():
        errors.append(f"{relative(project_dir)}: 缺少 contacts.yaml")
    if not events_file.is_file():
        errors.append(f"{relative(project_dir)}: 缺少 events.yaml")
    if not meetings_dir.is_dir():
        errors.append(f"{relative(project_dir)}: 缺少 meetings/ 目录")
    if not project_file.is_file():
        continue

    project = load_frontmatter(project_file)
    validate_management_prose(project_file)
    require_fields(
        project,
        (
            "id",
            "name",
            "counterparty_ids",
            "primary_counterparty_id",
            "record_type",
            "category",
            "stage",
            "relationship",
            "priority",
            "owner",
            "first_contact_certainty",
            "sourced_by",
            "source_certainty",
            "source_note",
            "follow_up_status",
            "next_action",
        ),
        project_file,
        allow_empty=("sourced_by",) if project.get("source_certainty") == "unknown" else (),
    )

    project_id = project.get("id")
    if present_string(project_id):
        if not ASCII_ID_PATTERN.fullmatch(project_id):
            errors.append(
                f"{relative(project_file)}: `id` 只能包含小写字母、数字和连字符"
            )
        if project_id in project_ids:
            errors.append(
                f"{relative(project_file)}: 项目 ID 与 {relative(project_ids[project_id])} 重复"
            )
        else:
            project_ids[project_id] = project_file

    linked = project.get("counterparty_ids")
    primary = project.get("primary_counterparty_id")
    if not isinstance(linked, list) or not linked or any(not isinstance(item, str) or item not in party_catalog for item in linked) or len(set(linked)) != len(linked):
        errors.append(f"{relative(project_file)}: counterparty_ids 必须引用现有对接方且不能重复")
    if not isinstance(primary, str) or primary not in party_catalog or not isinstance(linked, list) or primary not in linked or party_directories.get(primary) != project_dir.parent.parent:
        errors.append(f"{relative(project_file)}: 归档对接方必须与当前目录和关联对接方一致")
    reject_fields(project, ("counterparties",), project_file)

    categories = project.get("category")
    if not (
        isinstance(categories, list)
        and categories
        and all(present_string(item) for item in categories)
    ):
        errors.append(f"{relative(project_file)}: `category` 必须是非空字符串数组")

    if project.get("record_type") not in RECORD_TYPES:
        errors.append(
            f"{relative(project_file)}: `record_type` 必须是 cooperation、investment 或 resource"
        )

    target_investment_amount = project.get("target_investment_amount_cny")
    if target_investment_amount is not None:
        if project.get("record_type") != "investment":
            errors.append(
                f"{relative(project_file)}: 只有 investment 记录可以设置 `target_investment_amount_cny`"
            )
        if (
            isinstance(target_investment_amount, bool)
            or not isinstance(target_investment_amount, int)
            or target_investment_amount <= 0
        ):
            errors.append(
                f"{relative(project_file)}: `target_investment_amount_cny` 必须是正整数人民币元"
            )

    if project.get("stage") not in PROJECT_STAGES:
        errors.append(f"{relative(project_file)}: `stage` 不在允许范围内")
    if project.get("relationship") not in RELATIONSHIP_STATES:
        errors.append(
            f"{relative(project_file)}: `relationship` 必须是 active、dormant 或 maintained"
        )
    if project.get("priority") not in PRIORITIES:
        errors.append(
            f"{relative(project_file)}: `priority` 必须是 high、medium 或 low"
        )
    if project.get("first_contact_certainty") not in {"confirmed", "provisional", "unknown"}:
        errors.append(
            f"{relative(project_file)}: `first_contact_certainty` 必须是 confirmed、provisional 或 unknown"
        )
    sourced_by = project.get("sourced_by")
    if not (
        isinstance(sourced_by, list)
        and (sourced_by or project.get("source_certainty") == "unknown")
        and all(present_string(person_id) for person_id in sourced_by)
    ):
        errors.append(
            f"{relative(project_file)}: `sourced_by` 必须是人员 ID 数组；只有来源未知时才可为空"
        )
    else:
        if len(set(sourced_by)) != len(sourced_by):
            errors.append(f"{relative(project_file)}: `sourced_by` 不能包含重复人员")
        for person_id in sourced_by:
            if person_id not in people_profiles:
                errors.append(
                    f"{relative(project_file)}: `sourced_by` 引用了不存在的人员 `{person_id}`"
                )
    if project.get("source_certainty") not in SOURCE_CERTAINTIES:
        errors.append(
            f"{relative(project_file)}: `source_certainty` 必须是 confirmed、provisional 或 unknown"
        )
    if not present_string(project.get("source_note")):
        errors.append(f"{relative(project_file)}: `source_note` 必须是非空字符串")
    if project.get("follow_up_status") not in FOLLOW_UP_STATUSES:
        errors.append(
            f"{relative(project_file)}: `follow_up_status` 不在允许范围内"
        )
    if project.get("stage") == "terminated" and project.get("follow_up_status") != "closed":
        errors.append(
            f"{relative(project_file)}: `stage` 为 terminated 时，`follow_up_status` 必须是 closed"
        )

    if project.get("first_contact_certainty") == "unknown":
        if "first_contact" not in project or project["first_contact"] is not None:
            errors.append(f"{relative(project_file)}: 首次接触日期未知时，`first_contact` 必须为 null")
    else:
        validate_date(project.get("first_contact"), "first_contact", project_file)
    validate_date(
        project.get("next_action_due"),
        "next_action_due",
        project_file,
        allow_none=True,
    )

    contact_ids: dict[str, int] = {}
    if contacts_file.is_file():
        contacts_data = load_yaml_file(contacts_file)
        require_fields(contacts_data, ("project", "contacts"), contacts_file, allow_empty=("contacts",))

        if contacts_data.get("project") != project_id:
            errors.append(
                f"{relative(contacts_file)}: `project` 必须与项目 README.md 的 `id` 一致"
            )

        contacts = contacts_data.get("contacts")
        if not isinstance(contacts, list):
            errors.append(f"{relative(contacts_file)}: `contacts` 必须是数组")
            contacts = []

        for index, contact in enumerate(contacts):
            label = f"contacts[{index}]"
            if not isinstance(contact, dict):
                errors.append(f"{relative(contacts_file)}: {label} 必须是对象")
                continue

            require_fields(
                contact,
                (
                    "person_id",
                    "side",
                    "project_roles",
                ),
                contacts_file,
                f"{label}.",
            )

            contact_id = contact.get("person_id")
            if present_string(contact_id):
                if not CONTACT_ID_PATTERN.fullmatch(contact_id):
                    errors.append(
                        f"{relative(contacts_file)}: {label}.person_id 不能包含空格、斜杠或反斜杠"
                    )
                if contact_id in contact_ids:
                    errors.append(
                        f"{relative(contacts_file)}: {label}.person_id 与 contacts[{contact_ids[contact_id]}] 重复"
                    )
                else:
                    contact_ids[contact_id] = index
                if contact_id not in people_profiles:
                    errors.append(
                        f"{relative(contacts_file)}: {label}.person_id `{contact_id}` 不存在于 content/people.yaml"
                    )

            if contact.get("side") not in CONTACT_SIDES:
                errors.append(
                    f"{relative(contacts_file)}: {label}.side 必须是 counterparty、internal 或 advisor"
                )
            deprecated_fields = {
                "id",
                "name",
                "affiliation",
                "affiliations",
                "phone",
                "wechat",
                "email",
                "last_activity",
            }.intersection(contact)
            if deprecated_fields:
                errors.append(
                    f"{relative(contacts_file)}: {label} 不应包含人员基本信息或自动派生字段 "
                    f"{', '.join(f'`{field}`' for field in sorted(deprecated_fields))}"
                )

            roles = contact.get("project_roles")
            if not (
                isinstance(roles, list)
                and roles
                and all(
                    present_string(role) and ROLE_PATTERN.fullmatch(role)
                    for role in roles
                )
            ):
                errors.append(
                    f"{relative(contacts_file)}: {label}.project_roles 必须是 snake_case 字符串数组"
                )

            notes = contact.get("notes")
            if notes is not None and not isinstance(notes, str):
                errors.append(
                    f"{relative(contacts_file)}: {label}.notes 必须是字符串或 null"
                )
            contact_count += 1

    related_records: set[Path] = set()
    activity_dates_by_person: dict[str, list[str]] = {
        person_id: [] for person_id in contact_ids
    }
    if events_file.is_file():
        events_data = load_yaml_file(events_file)
        require_fields(events_data, ("project", "events"), events_file)

        if events_data.get("project") != project_id:
            errors.append(
                f"{relative(events_file)}: `project` 必须与项目 README.md 的 `id` 一致"
            )

        events = events_data.get("events")
        if not isinstance(events, list):
            errors.append(f"{relative(events_file)}: `events` 必须是数组")
            events = []
        elif not events:
            errors.append(
                f"{relative(events_file)}: `events` 至少需要一条事件，以计算项目最近活动日期"
            )

        event_ids: dict[str, int] = {}
        previous_event_date: str | None = None
        latest_event_date: str | None = None

        for index, event in enumerate(events):
            event_count += 1
            label = f"events[{index}]"
            if not isinstance(event, dict):
                errors.append(f"{relative(events_file)}: {label} 必须是对象")
                continue

            require_fields(
                event,
                ("id", "date", "type", "title", "summary", "importance"),
                events_file,
                f"{label}.",
            )

            event_id = event.get("id")
            if present_string(event_id):
                if not ASCII_ID_PATTERN.fullmatch(event_id):
                    errors.append(
                        f"{relative(events_file)}: {label}.id 只能包含小写字母、数字和连字符"
                    )
                if event_id in event_ids:
                    errors.append(
                        f"{relative(events_file)}: {label}.id 与 events[{event_ids[event_id]}] 重复"
                    )
                else:
                    event_ids[event_id] = index

            validate_date(event.get("date"), f"{label}.date", events_file)
            event_date = normalize_date(event.get("date"))
            try:
                valid_event_date = bool(DATE_PATTERN.fullmatch(event_date))
                if valid_event_date:
                    date.fromisoformat(event_date)
            except ValueError:
                valid_event_date = False

            if valid_event_date:
                if previous_event_date is not None and event_date < previous_event_date:
                    errors.append(
                        f"{relative(events_file)}: 事件必须按日期从早到晚排列"
                    )
                previous_event_date = event_date
                latest_event_date = event_date

            if event.get("type") not in EVENT_TYPES:
                errors.append(f"{relative(events_file)}: {label}.type 不在允许范围内")
            if event.get("importance") not in EVENT_IMPORTANCE:
                errors.append(
                    f"{relative(events_file)}: {label}.importance 必须是 key 或 normal"
                )

            title = event.get("title")
            summary = event.get("summary")
            if present_string(title) and len(title) > 40:
                errors.append(
                    f"{relative(events_file)}: {label}.title 不应超过 40 个字符"
                )
            if present_string(summary) and len(summary) > 200:
                errors.append(
                    f"{relative(events_file)}: {label}.summary 不应超过 200 个字符"
                )

            related_record = event.get("related_record")
            related_participant_ids: list[str] = []
            if related_record is not None:
                if not present_string(related_record):
                    errors.append(
                        f"{relative(events_file)}: {label}.related_record 必须是相对路径字符串"
                    )
                else:
                    target = (project_dir / related_record).resolve()
                    if not target.is_relative_to(project_dir.resolve()):
                        errors.append(
                            f"{relative(events_file)}: {label}.related_record 必须位于当前项目目录内"
                        )
                    elif not target.is_file():
                        errors.append(
                            f"{relative(events_file)}: {label}.related_record 指向的文件不存在"
                        )
                    else:
                        related_records.add(target)
                        if target.suffix == ".md":
                            record = load_frontmatter(target)
                            related_participant_ids = flatten_participant_ids(
                                record.get("participants")
                            )

            explicit_participants = event.get("participants")
            if explicit_participants is None:
                explicit_participant_ids: list[str] = []
            elif not (
                isinstance(explicit_participants, list)
                and all(present_string(person_id) for person_id in explicit_participants)
            ):
                errors.append(
                    f"{relative(events_file)}: {label}.participants 必须是人员 ID 数组"
                )
                explicit_participant_ids = []
            else:
                explicit_participant_ids = explicit_participants
                if len(set(explicit_participant_ids)) != len(explicit_participant_ids):
                    errors.append(
                        f"{relative(events_file)}: {label}.participants 不能包含重复人员"
                    )

            event_participant_ids = list(
                dict.fromkeys(explicit_participant_ids + related_participant_ids)
            )
            for person_id in event_participant_ids:
                if person_id not in people_profiles:
                    errors.append(
                        f"{relative(events_file)}: {label} 引用了不存在的人员 `{person_id}`"
                    )
                elif person_id not in contact_ids:
                    errors.append(
                        f"{relative(events_file)}: {label} 的人员 `{person_id}` 必须先加入 contacts.yaml"
                    )
                elif valid_event_date:
                    activity_dates_by_person[person_id].append(event_date)

            if event.get("type") == "meeting" and related_record is None:
                errors.append(
                    f"{relative(events_file)}: {label} 为会议事件，必须提供 related_record"
                )

        for person_id, contact_index in contact_ids.items():
            if not activity_dates_by_person[person_id]:
                errors.append(
                    f"{relative(contacts_file)}: contacts[{contact_index}] `{person_id}` "
                    "没有可用于计算最近参与日期的事件"
                )

    if not meetings_dir.is_dir():
        continue

    for meeting_file in sorted(meetings_dir.glob("*.md")):
        meeting_count += 1
        meeting = load_frontmatter(meeting_file)
        reject_fields(meeting, ("format", "source_type"), meeting_file)
        require_fields(
            meeting,
            (
                "id",
                "project",
                "date",
                "type",
                "participants",
            ),
            meeting_file,
        )

        meeting_id = meeting.get("id")
        if present_string(meeting_id):
            if not ASCII_ID_PATTERN.fullmatch(meeting_id):
                errors.append(
                    f"{relative(meeting_file)}: `id` 只能包含小写字母、数字和连字符"
                )
            if meeting_id in meeting_ids:
                errors.append(
                    f"{relative(meeting_file)}: 会议 ID 与 {relative(meeting_ids[meeting_id])} 重复"
                )
            else:
                meeting_ids[meeting_id] = meeting_file

        if meeting.get("project") != project_id:
            errors.append(
                f"{relative(meeting_file)}: `project` 必须与项目 README.md 的 `id` 一致"
            )

        validate_date(meeting.get("date"), "date", meeting_file)
        meeting_date = normalize_date(meeting.get("date"))
        compact_meeting_date = meeting_date.replace("-", "")
        meeting_filename_pattern = re.compile(
            rf"^{re.escape(compact_meeting_date)}(?:-.+)?\.md$"
        )
        if not meeting_filename_pattern.fullmatch(meeting_file.name):
            errors.append(
                f"{relative(meeting_file)}: 文件名必须使用 {compact_meeting_date}.md"
                f" 或 {compact_meeting_date}-主题.md"
            )

        participants = meeting.get("participants")
        if not (
            isinstance(participants, dict)
            and participants
            and all(
                isinstance(names, list)
                and all(present_string(name) for name in names)
                for names in participants.values()
            )
        ):
            errors.append(
                f"{relative(meeting_file)}: `participants` 必须按参与方分组并使用姓名数组"
            )
        if meeting_file.resolve() not in related_records:
            errors.append(
                f"{relative(meeting_file)}: 必须在 events.yaml 中由一条会议事件引用"
            )

for markdown_file in sorted(CONTENT_ROOT.glob("**/*.md")):
    if is_attachment_path(markdown_file.relative_to(CONTENT_ROOT)):
        continue
    content = markdown_file.read_text(encoding="utf-8")
    for bracketed, plain in re.findall(
        r"\]\((?:<([^>]+)>|([^)]+))\)",
        content,
    ):
        link = (bracketed or plain).strip()
        if link.startswith(("http:", "https:", "mailto:", "#")):
            continue

        relative_target = link.split("#", 1)[0]
        target = (markdown_file.parent / relative_target).resolve()
        if not target.exists():
            errors.append(
                f"{relative(markdown_file)}: 链接目标不存在 `{link}`"
            )

try:
    from file_library import check_index
    file_sources = {}
    for candidate in CONTENT_ROOT.rglob("*"):
        if candidate.is_file() and candidate.suffix in {".yaml", ".yml", ".md"} and "generated" not in candidate.relative_to(CONTENT_ROOT).parts and not is_attachment_path(candidate.relative_to(CONTENT_ROOT)):
            file_sources[candidate.relative_to(CONTENT_ROOT).as_posix()] = candidate.read_text(encoding="utf-8")
    check_index(file_sources)
except Exception as exc:
    errors.append(f"content/files.yaml: {exc}")

if errors:
    print("BD 结构校验失败：", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

print(
    f"BD 结构校验通过：{len(party_catalog)} 个对接方，{project_count} 个事项，"
    f"{people_count} 位人员，{contact_count} 条项目人员关系，"
    f"{event_count} 条项目事件，{company_event_count} 条公司事件，"
    f"{meeting_count} 份会议记录，{company_record_count} 份公司记录。"
)
