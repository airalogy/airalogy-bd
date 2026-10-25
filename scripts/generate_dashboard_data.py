# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyyaml==6.0.3",
# ]
# ///

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

import yaml


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成 BD 工作台数据")
    parser.add_argument(
        "--content-dir",
        type=Path,
        default=Path.cwd() / "content",
        help="公司 BD 内容目录，默认为当前目录下的 content",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="生成的 dashboard.json 路径",
    )
    return parser.parse_args()


ARGS = parse_args()
CONTENT_ROOT = ARGS.content_dir.resolve()
REPOSITORY_ROOT = CONTENT_ROOT.parent
PROJECTS_DIRECTORY = CONTENT_ROOT / "counterparties"
COMPANY_DIRECTORY = CONTENT_ROOT / "company"
COMPANY_EVENTS_FILE = COMPANY_DIRECTORY / "events.yaml"
PEOPLE_FILE = CONTENT_ROOT / "people.yaml"
WORKSPACE_FILE = CONTENT_ROOT / "workspace.yaml"
OUTPUT_FILE = (
    ARGS.output.resolve()
    if ARGS.output is not None
    else CONTENT_ROOT / "generated" / "dashboard.json"
)


def normalize(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    content = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---\n?(.*)\Z", content, re.DOTALL)
    if not match:
        raise ValueError(f"{path.relative_to(REPOSITORY_ROOT)} 缺少 YAML frontmatter")
    metadata = yaml.safe_load(match.group(1)) or {}
    return normalize(metadata), match.group(2)


def extract_section(markdown: str, heading: str) -> str:
    pattern = re.compile(
        rf"^## {re.escape(heading)}\s*$\n(.*?)(?=^## |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(markdown)
    return match.group(1).strip() if match else ""


def plain_text(markdown: str) -> str:
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", markdown)
    text = re.sub(r"[*_`#>]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def list_items(markdown: str) -> list[str]:
    items: list[str] = []
    for line in markdown.splitlines():
        match = re.match(r"^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.*)$", line)
        if match:
            item = plain_text(match.group(1))
            if item:
                items.append(item)
    return items


def load_yaml(path: Path) -> dict[str, Any]:
    return normalize(yaml.safe_load(path.read_text(encoding="utf-8")) or {})


def markdown_title_and_body(markdown: str, fallback_title: str) -> tuple[str, str]:
    match = re.match(r"^#\s+(.+?)\s*$\n?(.*)\Z", markdown.strip(), re.MULTILINE | re.DOTALL)
    if not match:
        return fallback_title, markdown.strip()
    return plain_text(match.group(1)), match.group(2).strip()


def flatten_participant_ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    if isinstance(value, dict):
        return [
            item
            for items in value.values()
            if isinstance(items, list)
            for item in items
            if isinstance(item, str)
        ]
    return []


def build_events(
    project_directory: Path,
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rendered_events: list[dict[str, Any]] = []
    for event in events:
        rendered_event = dict(event)
        participant_ids = flatten_participant_ids(event.get("participants"))
        related_record = event.get("related_record")
        if isinstance(related_record, str) and related_record.endswith(".md"):
            record_path = (project_directory / related_record).resolve()
            if not record_path.is_relative_to(project_directory.resolve()):
                raise ValueError(f"{related_record} 必须位于当前项目目录内")
            metadata, markdown = parse_frontmatter(record_path)
            participant_ids.extend(
                flatten_participant_ids(metadata.get("participants"))
            )
            title, body = markdown_title_and_body(markdown, event.get("title", "完整记录"))
            rendered_event["related_document"] = {
                "path": related_record,
                "title": title,
                "markdown": body,
            }
        rendered_event["participants"] = list(dict.fromkeys(participant_ids))
        rendered_events.append(rendered_event)
    return rendered_events


def build_project(
    project_directory: Path,
    people_by_id: dict[str, dict[str, Any]],
    parties_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    metadata, markdown = parse_frontmatter(project_directory / "README.md")
    contacts_document = load_yaml(project_directory / "contacts.yaml")
    events_document = load_yaml(project_directory / "events.yaml")
    events = build_events(
        project_directory,
        events_document.get("events", []),
    )
    if not events:
        raise ValueError(f"{project_directory.name}: 至少需要一条事件来计算项目最近活动日期")
    last_activity = max(event["date"] for event in events)
    contacts: list[dict[str, Any]] = []
    for relation in contacts_document.get("contacts", []):
        person_id = relation["person_id"]
        profile = people_by_id[person_id]
        activity_dates = [
            event["date"]
            for event in events
            if person_id in event["participants"]
        ]
        if not activity_dates:
            raise ValueError(
                f"{project_directory.name}: {person_id} 没有可用于计算最近参与日期的事件"
            )
        contacts.append(
            {
                **profile,
                **relation,
                "last_activity": max(activity_dates),
            }
        )

    return {
        **metadata,
        "last_activity": last_activity,
        "directory": project_directory.relative_to(CONTENT_ROOT).as_posix(),
        "counterparties": [parties_by_id[identity]["name"] for identity in metadata["counterparty_ids"]],
        "source_people": [
            people_by_id[person_id] for person_id in metadata.get("sourced_by", [])
        ],
        "summary": plain_text(extract_section(markdown, "管理摘要")),
        "management_decisions": list_items(
            extract_section(markdown, "需要管理层决策")
        ),
        "contacts": contacts,
        "events": events,
    }


def build_people(
    profiles: list[dict[str, Any]],
    projects: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    participations: dict[str, list[dict[str, Any]]] = {
        profile["id"]: [] for profile in profiles
    }
    for project in projects:
        for contact in project["contacts"]:
            participations[contact["person_id"]].append(
                {
                    "project_id": project["id"],
                    "project_name": project["name"],
                    "side": contact["side"],
                    "project_roles": contact["project_roles"],
                    "last_activity": contact["last_activity"],
                    "notes": contact.get("notes", ""),
                }
            )

    people: list[dict[str, Any]] = []
    for profile in profiles:
        projects_for_person = participations[profile["id"]]
        people.append(
            {
                **profile,
                "last_activity": max(
                    (
                        participation["last_activity"]
                        for participation in projects_for_person
                    ),
                    default=None,
                ),
                "projects": sorted(
                    projects_for_person,
                    key=lambda participation: participation["last_activity"],
                    reverse=True,
                ),
            }
        )
    return people


def main() -> None:
    workspace = load_yaml(WORKSPACE_FILE)
    people_document = load_yaml(PEOPLE_FILE)
    profiles = people_document.get("people", [])
    people_by_id = {profile["id"]: profile for profile in profiles}
    parties = []
    for directory in sorted(PROJECTS_DIRECTORY.glob("*")):
        if directory.is_dir() and (directory / "README.md").is_file():
            metadata, body = parse_frontmatter(directory / "README.md")
            shared = load_yaml(directory / "contacts.yaml")
            parties.append({**metadata, "directory": directory.relative_to(CONTENT_ROOT).as_posix(), "body": body, "people": shared["people"]})
    parties_by_id = {item["id"]: item for item in parties}
    projects = [
        build_project(path, people_by_id, parties_by_id)
        for path in sorted(PROJECTS_DIRECTORY.glob("*/matters/*"), key=lambda item: item.as_posix())
        if path.is_dir() and (path / "README.md").exists()
    ]
    for party in parties:
        related = [project for project in projects if party["id"] in project["counterparty_ids"]]
        party["matter_ids"] = [project["id"] for project in related]
        party["related_people"] = sorted(set(party["people"]) | {contact["person_id"] for project in related for contact in project["contacts"]})
    company_events_document = (
        load_yaml(COMPANY_EVENTS_FILE) if COMPANY_EVENTS_FILE.is_file() else {}
    )
    company_events = build_events(
        COMPANY_DIRECTORY,
        company_events_document.get("events", []),
    )
    updated_at = max(
        [project["last_activity"] for project in projects]
        + [event["date"] for event in company_events],
        default=None,
    )
    payload = {
        "workspace": workspace,
        "counterparties": parties,
        "updated_at": updated_at,
        "people": build_people(profiles, projects),
        "projects": projects,
        "company_events": company_events,
        "files": load_yaml(CONTENT_ROOT / "files.yaml").get("files", []) if (CONTENT_ROOT / "files.yaml").exists() else [],
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    contact_count = sum(len(project["contacts"]) for project in projects)
    event_count = sum(len(project["events"]) for project in projects)
    print(
        f"看板数据已更新：{len(projects)} 个项目，"
        f"{len(profiles)} 位人员，{contact_count} 条项目人员关系，"
        f"{event_count} 条项目事件，{len(company_events)} 条公司事件。"
    )


if __name__ == "__main__":
    main()
