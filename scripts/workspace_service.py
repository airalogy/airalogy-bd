#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["PyYAML>=6.0,<7"]
# ///
"""Local, recoverable edits to the canonical Markdown/YAML content.

The private snapshot repository never stages or commits the user's repository.
All writers (HTTP, watcher and CLI) share one filesystem lock and transaction log.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from datetime import date, datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any

import yaml
from file_library import FileLibrary, LibraryError, check_index, index_from
from team_auth import Accounts, AuthError

SCRIPTS = Path(__file__).resolve().parent
FRONTMATTER = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)
KINDS = {"counterparty", "person", "project", "progress", "company"}
PROJECT_FIELDS = {"name", "counterparty_ids", "primary_counterparty_id", "record_type", "category", "stage", "relationship", "priority", "owner", "first_contact", "first_contact_certainty", "sourced_by", "source_certainty", "source_note", "follow_up_status", "next_action", "next_action_due", "target_investment_amount_cny"}
PERSON_FIELDS = {"name", "affiliation", "phone", "wechat", "email"}
EVENT_FIELDS = {"date", "type", "title", "summary", "importance", "participants"}
LABELS = {"name": "名称", "affiliation": "单位及职位", "phone": "电话", "wechat": "微信", "email": "邮箱", "counterparties": "对方单位", "record_type": "事项类型", "category": "分类", "stage": "阶段", "relationship": "关系", "priority": "优先级", "owner": "负责人", "first_contact": "首次接触日期", "first_contact_certainty": "首次接触日期依据", "sourced_by": "对接来源人员", "source_certainty": "来源依据", "source_note": "来源说明", "follow_up_status": "跟进状态", "next_action": "下一步", "next_action_due": "下一步期限", "target_investment_amount_cny": "目标投资金额（元）", "date": "日期", "type": "事件类型", "title": "标题", "summary": "进展摘要", "importance": "重要程度", "participants": "参与人", "organizers": "主办方", "location": "地点", "side": "关系", "project_roles": "项目角色", "notes": "备注", "body": "正文", "contacts": "事项联系人", "events": "沟通进展", "metadata": "事项信息", "documents": "沟通记录", "document": "记录信息", "event": "进展信息"}


LABELS.update({"attachments":"进展附件", "agreement_date":"协议载明日期", "signing_completed_date":"实际签署完成日期", "agreement_type":"协议类型", "organization":"对接机构或个人", "home_counterparty_id":"归档对接方", "primary_counterparty_id":"归档对接方", "counterparty_ids":"参与对接方", "short_name":"简称", "kind":"对接方类型", "project_ids":"关联事项", "archived":"回收站状态", "current_version":"当前文件版本", "versions":"文件版本", "records":"使用与发送记录", "filename":"文件名", "sha256":"文件指纹", "size":"文件大小", "status":"文件状态", "created_at":"归档时间", "note":"说明", "archive_path":"归档位置", "version_id":"具体版本", "kind":"类型", "people":"相关人员", "channel":"渠道", "event_id":"关联交流", "project_id":"关联事项"})


class ServiceError(Exception):
    def __init__(self, message: str, code: str = "invalid", details: Any = None):
        super().__init__(message)
        self.code, self.details = code, details


def normalized(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    return value


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def parse_yaml(text: str) -> dict:
    try:
        value = normalized(yaml.safe_load(text))
        if not isinstance(value, dict):
            raise ValueError("顶层须为对象")
        return value
    except (yaml.YAMLError, ValueError) as exc:
        raise ServiceError("资料格式有误，请查看修改历史或修正原文件。", details=str(exc).splitlines()[0]) from exc


def parse_md(text: str) -> tuple[dict, str]:
    match = FRONTMATTER.match(text)
    if not match:
        raise ServiceError("文档缺少资料信息。")
    return parse_yaml(match[1]), text[match.end():].strip()


class Dumper(yaml.SafeDumper):
    def increase_indent(self, flow=False, indentless=False):
        return super().increase_indent(flow, False)


def dump(value: Any) -> str:
    return yaml.dump(value, Dumper=Dumper, allow_unicode=True, sort_keys=False, width=1000)


def markdown(metadata: dict, body: str) -> str:
    return "---\n" + dump(metadata) + "---\n\n" + body.strip() + "\n"


def replace_item(text: str, key: str, id_key: str, item_id: str, replacement: dict | None, *, sort_dates=False) -> str:
    """Keep unrelated list entries and comments byte-for-byte where possible."""
    document = parse_yaml(text)
    entries = document.get(key, [])
    if not isinstance(entries, list):
        raise ServiceError("资料列表格式有误。")
    index = next((i for i, item in enumerate(entries) if item.get(id_key) == item_id), None)
    updated = [item for item in entries if item.get(id_key) != item_id]
    if replacement is not None:
        updated.append(replacement)
    if sort_dates:
        updated.sort(key=lambda item: item.get("date", ""))
    elif index is not None and replacement is not None:
        updated.insert(index, updated.pop())
    root = yaml.compose(text)
    sequence = next((node for name, node in root.value if name.value == key), None)
    # Inserting or reordering events can affect their order; preserve their data.
    if index is None or sort_dates or not sequence or sequence.flow_style:
        document[key] = updated
        return dump(document)
    node = sequence.value[index]
    lines = text.splitlines(keepends=True)
    start_line = node.start_mark.line
    end_line = sequence.value[index + 1].start_mark.line if index + 1 < len(sequence.value) else sequence.end_mark.line
    # A following top-level key must not be swallowed with the list.
    end_line = min(end_line, len(lines))
    indent = len(lines[start_line]) - len(lines[start_line].lstrip())
    new_lines = dump([replacement]).splitlines() if replacement is not None else []
    inserted = "".join(" " * indent + line + "\n" for line in new_lines)
    return "".join(lines[:start_line]) + inserted + "".join(lines[end_line:])


from content_paths import is_attachment_path, MATTER_README, PARTY_README, counterparties, migrate_files, valid_folder, name_key, party_id


class Workspace:
    def __init__(self, root: Path):
        self.root = root.resolve(strict=True)
        if not (self.root / "workspace.yaml").is_file():
            raise ServiceError("未找到工作区资料。")
        self.store = self.root.parent / ".bd-history" / digest(str(self.root))[:16]
        self.store.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.repo = self.store / "versions"
        self.journal = self.store / "transaction.json"
        self.state_file = self.store / "state.json"
        self.actor = None
        self.policy = None
        self.upload_scope = {"owner": "local", "channel": "web"}
        self.original_repo: Path | None = None
        self.original_prefix = "content"
        discovered = subprocess.run(["git", "-C", str(self.root), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if discovered.returncode == 0:
            self.original_repo = Path(discovered.stdout.strip())
            self.original_prefix = self.root.relative_to(self.original_repo).as_posix()
        imported = self.store / "original-history.json"
        if imported.is_file():
            self.original_repo = self.store / "original-versions"
            self.original_prefix = json.loads(imported.read_text())["prefix"]

    def git(self, *args: str, repo: Path | None = None, check=True) -> str:
        result = subprocess.run(["git", "--no-pager", "-C", str(repo or self.repo), *args], capture_output=True, text=True)
        if check and result.returncode:
            raise ServiceError("版本留存失败，资料未保存。请检查本地历史库。", "storage")
        return result.stdout

    def read_files(self) -> dict[str, str]:
        files: dict[str, str] = {}
        for base, directories, names in os.walk(self.root, followlinks=False):
            directories[:] = sorted(directory for directory in directories if directory not in {"generated", ".git"} and not is_attachment_path((Path(base) / directory).relative_to(self.root)))
            for directory in directories:
                if (Path(base) / directory).is_symlink():
                    raise ServiceError("资料目录含符号链接，暂停编辑以避免写入其他目录。", "unsafe_path")
            for name in sorted(names):
                source = Path(base) / name
                if source.suffix not in {".md", ".yaml", ".yml"}:
                    continue
                if source.is_symlink():
                    raise ServiceError("资料文件含符号链接，暂停编辑以避免写入其他目录。", "unsafe_path")
                files[source.relative_to(self.root).as_posix()] = source.read_text(encoding="utf-8")
        return files

    def ensure_repo(self):
        if not (self.repo / ".git").is_dir():
            self.repo.mkdir(mode=0o700, exist_ok=True)
            self.git("init", "--initial-branch=history")
            self.git("config", "user.name", "Airalogy BD")
            self.git("config", "user.email", "local@airalogy-bd.invalid")
            self.git("config", "core.autocrlf", "false")
            self.git("config", "core.quotePath", "false")
            self.git("config", "commit.gpgsign", "false")
            self.git("config", "core.hooksPath", str(self.store / "no-hooks"))

    def version_files(self, version: str, *, raw=False) -> dict[str, str]:
        match = re.fullmatch(r"(local|repo):([0-9a-f]{40,64})", version)
        if not match:
            raise ServiceError("无效的版本。")
        source, sha = match.groups()
        if source == "repo":
            if self.original_repo is None:
                raise ServiceError("未找到原有版本库。")
            repo, prefix = self.original_repo, self.original_prefix + "/"
        else:
            repo, prefix = self.repo, "content/"
        # Verify a commit, rather than accepting arbitrary Git revision syntax.
        if not self.git("cat-file", "-t", sha, repo=repo, check=False).strip() == "commit":
            raise ServiceError("该版本不存在。")
        paths = self.git("ls-tree", "-r", "--name-only", "-z", sha, "--", prefix, repo=repo).split("\0")
        files = {}
        for name in paths:
            relative = name[len(prefix):]
            if not name.startswith(prefix) or not relative or "generated" in Path(relative).parts or is_attachment_path(relative) or Path(relative).suffix not in {".md", ".yaml", ".yml"}:
                continue
            if Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise ServiceError("历史版本包含不安全的文件地址。")
            files[relative] = self.git("show", f"{sha}:{name}", repo=repo)
        if raw:
            return files
        try:
            return migrate_files(files, self.read_files())[0]
        except (ValueError, KeyError, TypeError, yaml.YAMLError):
            # Invalid historical text remains inspectable; validation blocks unsafe restores.
            return files

    def snapshot(self, files: dict[str, str], origin="external", label="记录文件修改", errors: list[str] | None = None) -> str:
        self.ensure_repo()
        head = self.git("rev-parse", "--verify", "HEAD", check=False).strip()
        previous = self.version_files("local:" + head, raw=True) if head else {}
        if previous == files:
            return "local:" + head
        mirror = self.repo / "content"
        mirror.mkdir(exist_ok=True)
        for existing in mirror.rglob("*"):
            if existing.is_file() and existing.relative_to(mirror).as_posix() not in files:
                existing.unlink()
        for name, text in files.items():
            target = mirror / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.read_text(encoding="utf-8") != text:
                self.atomic(target, text)
        affected = sorted(set(self.changed_records(previous, files)))
        metadata = {"origin": origin if head else "baseline", "label": label if head else "开始留存：当前全部资料", "affected": affected, "valid": not errors}
        if self.actor and origin in {"form", "restore", "recovery", "attachment"}:
            metadata["actor"] = {key: self.actor[key] for key in ("id", "name", "email")}
        self.git("add", "--all", "--", "content")
        self.git("commit", "--no-verify", "-m", json.dumps(metadata, ensure_ascii=False))
        return "local:" + self.git("rev-parse", "HEAD").strip()

    @staticmethod
    def atomic(target: Path, text: str):
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".bd-write-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(text)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, target)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def target(self, relative: str) -> Path:
        if Path(relative).is_absolute() or ".." in Path(relative).parts or "generated" in Path(relative).parts or is_attachment_path(relative):
            raise ServiceError("不允许写入该文件。", "unsafe_path")
        target = self.root / relative
        current = target
        while current != self.root:
            if current.is_symlink():
                raise ServiceError("不允许通过符号链接保存资料。", "unsafe_path")
            current = current.parent
        if not target.resolve().is_relative_to(self.root):
            raise ServiceError("不允许写入工作区以外的文件。", "unsafe_path")
        return target

    def repair_directories(self, files: dict[str, str]):
        # Removed records must not leave ghost project directories behind.
        directories = []
        for base, children, _ in os.walk(self.root):
            children[:] = [child for child in children if child != "generated" and not is_attachment_path((Path(base) / child).relative_to(self.root))]
            directories.append(Path(base))
        for directory in reversed(directories):
            if directory == self.root or "generated" in directory.relative_to(self.root).parts:
                continue
            try:
                directory.rmdir()
            except OSError:
                pass
        (self.root / "counterparties").mkdir(exist_ok=True)
        for name in files:
            if MATTER_README.fullmatch(name):
                (self.root / Path(name).parent / "meetings").mkdir(exist_ok=True)
        if "company/events.yaml" in files:
            (self.root / "company" / "records").mkdir(exist_ok=True)

    def stage(self, files: dict[str, str], *, verify_attachments=True) -> tuple[list[str], str | None]:
        try:
            if verify_attachments:
                FileLibrary(self).verify_index(files)
        except (LibraryError, ValueError, TypeError, KeyError, yaml.YAMLError) as exc:
            return [str(exc) or "资料索引格式无效。"], None
        with tempfile.TemporaryDirectory(prefix="validation-", dir=self.store) as directory:
            root = Path(directory) / "content"
            root.mkdir()
            for name, text in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
            # Empty meetings directories are structural, but are not represented in Git.
            for project in (root / "counterparties").glob("*/matters/*"):
                if project.is_dir():
                    (project / "meetings").mkdir(exist_ok=True)
            if (root / "company").exists():
                (root / "company" / "records").mkdir(exist_ok=True)
            result = subprocess.run([sys.executable, str(SCRIPTS / "validate.py"), "--content-dir", str(root)], capture_output=True, text=True)
            if result.returncode:
                return [line.removeprefix("- ") for line in result.stderr.splitlines() if line.startswith("- ")] or ["资料校验未完成，未覆盖当前资料。"], None
            output = Path(directory) / "dashboard.json"
            result = subprocess.run([sys.executable, str(SCRIPTS / "generate_dashboard_data.py"), "--content-dir", str(root), "--output", str(output)], capture_output=True, text=True)
            if result.returncode:
                return ["资料汇总失败，未覆盖当前显示数据。"], None
            return [], output.read_text(encoding="utf-8")

    def observe(self, label="记录文件修改", origin="external", force=False) -> dict:
        if (self.store / "uploads").exists():
            from staged_uploads import UploadStore
            UploadStore(self).cleanup()
        files = self.read_files()
        revision = digest(files)
        state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        if force or state.get("revision") != revision or (not (self.root / "generated" / "dashboard.json").exists() and not state.get("errors")):
            errors, data = self.stage(files)
            version = self.snapshot(files, origin, label, errors)
            # Never publish a mixed state if an external editor changed files during validation.
            if self.read_files() != files:
                return self.observe(label, origin)
            if data:
                self.atomic(self.root / "generated" / "dashboard.json", data)
            state = {"revision": revision, "version": version, "errors": errors, "observed_at": datetime.now(timezone.utc).isoformat()}
            self.atomic(self.state_file, json.dumps(state, ensure_ascii=False))
        return state

    def recover(self):
        if not self.journal.exists():
            return
        journal = json.loads(self.journal.read_text())
        current = self.read_files()
        for name, values in journal["changes"].items():
            if current.get(name) not in (values["before"], values["after"]):
                errors, _ = self.stage(current)
                self.snapshot(current, "external", "保存中断后的外部修改", errors)
                raise ServiceError("上次保存被中断，随后资料又发生修改。为避免覆盖，已暂停保存；当前和保存前版本均保留在修改历史中。", "recovery_conflict")
        completed = all(current.get(name) == values["after"] for name, values in journal["changes"].items())
        if not completed:
            for name, values in journal["changes"].items():
                target = self.target(name)
                if values["before"] is None:
                    target.unlink(missing_ok=True)
                else:
                    self.atomic(target, values["before"])
        self.repair_directories(self.read_files())
        self.journal.unlink()
        self.actor = journal.get("actor") if completed else None
        self.observe("恢复中断前的完整资料" if not completed else journal["label"], "recovery")

    def commit(self, before: dict[str, str], after: dict[str, str], label: str, origin: str) -> dict:
        if before == after:
            return {"saved": False, "message": "内容没有变化。", "status": self.observe()}
        errors, generated = self.stage(after)
        if errors:
            raise ServiceError("资料校验未通过，未保存任何修改。", "validation", errors)
        if self.read_files() != before:
            self.observe()
            raise ServiceError("资料已被其他编辑修改，请先比较最新内容。", "conflict")
        self.snapshot(before, "before_save", "保存前留存当前资料")
        changes = {name: {"before": before.get(name), "after": after.get(name)} for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)}
        if self.journal.exists():
            if origin != "restore":
                raise ServiceError("上次保存中断的资料尚未恢复，请先在修改历史中比较并恢复。", "recovery_conflict")
            archive = self.store / "interrupted-transactions"
            archive.mkdir(exist_ok=True)
            os.replace(self.journal, archive / (uuid.uuid4().hex + ".json"))
        self.atomic(self.journal, json.dumps({"changes": changes, "label": label, "actor": self.actor}, ensure_ascii=False))
        try:
            for name, values in changes.items():
                # Recheck each file immediately before replacing it.
                target = self.target(name)
                live = target.read_text(encoding="utf-8") if target.exists() else None
                if live != values["before"]:
                    raise ServiceError("保存期间原文件发生变化，保存已停止；请查看修改历史。", "conflict")
                if values["after"] is None:
                    target.unlink(missing_ok=True)
                else:
                    self.atomic(target, values["after"])
            self.repair_directories(after)
            version = self.snapshot(after, origin, label)
            # Failures after file writes retain the journal for recovery on the next call.
            self.atomic(self.root / "generated" / "dashboard.json", generated)
            state = {"revision": digest(after), "version": version, "errors": [], "observed_at": datetime.now(timezone.utc).isoformat()}
            self.atomic(self.state_file, json.dumps(state, ensure_ascii=False))
            self.journal.unlink()
            return {"saved": True, "message": "已保存，并留存可恢复版本。", "status": state}
        except Exception:
            self.recover()
            raise

    @staticmethod
    def projects(files: dict[str, str]) -> dict[str, tuple[str, dict, str]]:
        projects = {}
        for name, text in files.items():
            if MATTER_README.fullmatch(name):
                try:
                    metadata, body = parse_md(text)
                    projects[metadata["id"]] = (str(Path(name).parent), metadata, body)
                except (ServiceError, KeyError):
                    continue
        return projects

    def record(self, files: dict[str, str], kind: str, identity: str, project_id="") -> dict | None:
        if kind == "counterparty":
            value = counterparties(files).get(identity)
            if not value:
                return None
            directory, metadata, body = value
            return {"metadata": metadata, "body": body, "people": parse_yaml(files[directory + "/contacts.yaml"])["people"]}
        if kind == "file":
            return next((item for item in index_from(files)["files"] if item["id"] == identity), None)
        if kind == "person":
            return next((item for item in parse_yaml(files.get("people.yaml", "people: []"))["people"] if item["id"] == identity), None)
        if kind == "project":
            value = self.projects(files).get(identity)
            if not value:
                return None
            directory, metadata, body = value
            return {"metadata": metadata, "body": body, "contacts": parse_yaml(files[directory + "/contacts.yaml"]).get("contacts", []), "events": parse_yaml(files[directory + "/events.yaml"]).get("events", []), "documents": {name[len(directory)+1:]: text for name, text in files.items() if name.startswith(directory + "/meetings/")}}
        if kind in {"progress", "company"}:
            if kind == "company":
                directory = "company"
            else:
                value = self.projects(files).get(project_id)
                if not value:
                    return None
                directory = value[0]
            events = parse_yaml(files.get(directory + "/events.yaml", "events: []")).get("events", [])
            event = next((item for item in events if item["id"] == identity), None)
            if not event:
                return None
            text = files.get(directory + "/" + event.get("related_record", ""))
            document, body = parse_md(text) if text else ({}, "")
            result = {"event": event, "document": document, "body": body}
            if kind == "progress":
                result["attachments"] = []
                for item in index_from(files)["files"]:
                    if self.policy and not self.policy.file_allowed(item):
                        continue
                    for use in item["records"]:
                        if use["kind"] == "reference" and use["project_id"] == project_id and use.get("event_id") == identity:
                            version = next(v for v in item["versions"] if v["id"] == use["version_id"])
                            result["attachments"].append({"file_id": item["id"], "title": item["title"], "version_id": version["id"], "filename": version["filename"], "status": version["status"]})
            return result
        raise ServiceError("未知的资料类型。")

    def record_revision(self, files: dict[str, str], kind: str, identity: str, project_id="") -> str:
        if kind == "progress":
            # Includes contacts and all project events that a progress save may change.
            return digest(self.record(files, "project", project_id))
        return digest(self.record(files, kind, identity, project_id))

    def changed_records(self, before: dict[str, str], after: dict[str, str]) -> list[str]:
        keys = set()
        for files in (before, after):
            try:
                keys.update("file:" + item["id"] for item in index_from(files)["files"])
                keys.update("person:" + item["id"] for item in parse_yaml(files.get("people.yaml", "people: []")).get("people", []))
                keys.update("project:" + item for item in self.projects(files))
                keys.update("counterparty:" + item for item in counterparties(files))
                keys.update("company:" + item["id"] for item in parse_yaml(files.get("company/events.yaml", "events: []")).get("events", []))
            except (ServiceError, LibraryError, KeyError, TypeError):
                pass
        changed = []
        for key in keys:
            kind, identity = key.split(":", 1)
            try:
                if self.record(before, kind, identity) != self.record(after, kind, identity):
                    changed.append(key)
            except (ServiceError, LibraryError, KeyError, TypeError):
                changed.append(key)
        for project in set(self.projects(before)) | set(self.projects(after)):
            event_ids = set()
            for files in (before, after):
                record = self.record(files, "project", project)
                event_ids.update(e["id"] for e in (record or {}).get("events", []))
            for identity in event_ids:
                if self.record(before, "progress", identity, project) != self.record(after, "progress", identity, project):
                    changed.append("progress:" + identity)
        return changed

    def get_record(self, request: dict) -> dict:
        files = self.read_files()
        kind, identity, project = request["kind"], request.get("id", ""), request.get("project_id", "")
        return {"record": self.record(files, kind, identity, project), "revision": self.record_revision(files, kind, identity, project)}

    @staticmethod
    def check_date(value: Any):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ServiceError("请填写有效的实际日期。")
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ServiceError("请填写有效的实际日期。") from exc

    def new_progress_people(self, files: dict[str, str], payload: dict) -> list[dict]:
        """Validate fresh participants without writing or disclosing existing profiles."""
        supplied = payload.get("new_people", [])
        if not isinstance(supplied, list) or len(supplied) > 30:
            raise ServiceError("每条进展最多新增 30 位人员。")
        participants, relations = payload.get("participants", []), payload.get("new_contacts", [])
        if not isinstance(participants, list) or any(not isinstance(p, str) for p in participants) or not isinstance(relations, list) or any(not isinstance(r, dict) for r in relations):
            raise ServiceError("请核对参与人及事项关系。")
        existing = parse_yaml(files["people.yaml"])["people"]
        names = {name_key(p[key]) for p in existing for key in ("id", "name")}
        result = []
        for value in supplied:
            if not isinstance(value, dict) or set(value) - PERSON_FIELDS:
                raise ServiceError("新增人员只能填写姓名、单位及职位和联系方式。")
            profile = {key: value.get(key) for key in PERSON_FIELDS}
            for key, limit in (("name", 100), ("affiliation", 1000), ("phone", 100), ("wechat", 200), ("email", 254)):
                item = profile[key]
                if item is not None and (not isinstance(item, str) or len(item) > limit):
                    raise ServiceError("新增人员信息格式或长度不正确。")
            name = (profile["name"] or "").strip()
            if not name or re.search(r"[\s/\\]", name) or not (profile["affiliation"] or "").strip():
                raise ServiceError("请填写人员姓名、单位及职位；姓名不能包含空格或斜杠。")
            if name_key(name) in names:
                # Never return the colliding profile: it may belong to a restricted matter.
                raise ServiceError("无法新增该人员，请选择有权查看的已有人员，或联系管理员核对。", "duplicate")
            if name not in participants or sum(r.get("person_id") == name for r in relations) != 1:
                raise ServiceError("新增人员须参与本次进展，并填写一条事项关系。")
            names.add(name_key(name))
            result.append({**profile, "id": name, "name": name, "affiliation": profile["affiliation"].strip()})
        return result

    def write_progress(self, files: dict[str, str], kind: str, identity: str, project_id: str, payload: dict) -> tuple[str, str]:
        value = self.projects(files).get(project_id) if kind == "progress" else None
        if kind == "progress" and value is None:
            raise ServiceError("该事项已不存在，请刷新资料。", "conflict")
        if kind != "progress" and payload.get("new_people"):
            raise ServiceError("随进展新增人员仅适用于已有事项。")
        for profile in self.new_progress_people(files, payload):
            files["people.yaml"] = replace_item(files["people.yaml"], "people", "id", profile["id"], profile)
        directory = value[0] if value else "company"
        current = self.record(files, kind, identity, project_id) if identity else None
        event = {**(current or {}).get("event", {}), **{key: payload.get(key) for key in EVENT_FIELDS}}
        self.check_date(event["date"])
        identity = identity or event["date"] + "-" + uuid.uuid4().hex[:12]
        event["id"] = identity
        if kind == "company":
            event.update(category=payload.get("category"), organizers=payload.get("organizers", []))
        profiles = parse_yaml(files["people.yaml"])["people"]
        known_ids = {profile["id"] for profile in profiles}
        if not isinstance(event["participants"], list) or not set(event["participants"]).issubset(known_ids):
            raise ServiceError("请从人员库选择参与人。")
        if kind == "progress":
            contacts_path = directory + "/contacts.yaml"
            contacts = parse_yaml(files[contacts_path])
            contact_ids = {item["person_id"] for item in contacts["contacts"]}
            additions = payload.get("new_contacts", [])
            for relation in additions:
                person_id = relation.get("person_id")
                if person_id not in event["participants"] or person_id in contact_ids:
                    raise ServiceError("新增事项联系人须参与本次进展，且不能重复。")
                contacts["contacts"].append({key: relation.get(key) for key in ("person_id", "side", "project_roles", "notes")})
                contact_ids.add(person_id)
            if not set(event["participants"]).issubset(contact_ids):
                raise ServiceError("请补全新参与人的事项关系和角色。")
            if additions:
                files[contacts_path] = dump(contacts)
            side_by_person = {item["person_id"]: item["side"] for item in contacts["contacts"]}
            groups = {side: [person_id for person_id in event["participants"] if side_by_person[person_id] == side] for side in ("counterparty", "internal", "advisor")}
        else:
            groups = {"participants": event["participants"]}
        body = payload.get("body", "").strip()
        needs_document = bool(body) or event["type"] == "meeting" or bool((current or {}).get("document"))
        if needs_document and not body:
            raise ServiceError("会议进展需要填写整理后的沟通记录。")
        old_record = (current or {}).get("event", {}).get("related_record")
        if needs_document:
            # The filename follows the actual date and never overwrites another meeting.
            record_name = old_record if old_record and Path(old_record).name.startswith(event["date"].replace("-", "")) else ("meetings/" if kind == "progress" else "records/") + event["date"].replace("-", "") + ".md"
            if record_name != old_record and directory + "/" + record_name in files:
                record_name = str(Path(record_name).with_name(event["date"].replace("-", "") + "-" + identity[-12:] + ".md"))
            metadata = {**(current or {}).get("document", {}), "id": (current or {}).get("document", {}).get("id", "record-" + uuid.uuid4().hex), "date": event["date"], "type": (current or {}).get("document", {}).get("type", "project_meeting" if kind == "progress" else "company_event"), "participants": {key: items for key, items in groups.items() if items} or {"participants": []}}
            if kind == "progress":
                metadata["project"] = project_id
            else:
                metadata.update(scope="company", category=event["category"])
            if "location" in payload or "location" in metadata:
                metadata["location"] = payload.get("location") or None
            metadata.pop("source_type", None)
            metadata.pop("format", None)
            files[directory + "/" + record_name] = markdown(metadata, body)
            event["related_record"] = record_name
        events_path = directory + "/events.yaml"
        if events_path not in files:
            workspace_id = parse_yaml(files["workspace.yaml"])["id"]
            files[events_path] = dump({"company": workspace_id, "events": []})
        if old_record and old_record != event.get("related_record"):
            other_events = parse_yaml(files[events_path])["events"]
            if not any(item["id"] != identity and item.get("related_record") == old_record for item in other_events):
                files.pop(directory + "/" + old_record, None)
        files[events_path] = replace_item(files[events_path], "events", "id", identity, event, sort_dates=True)
        return identity, event["title"]

    def ensure_counterparty(self, files, name, kind):
        name = name.strip() if isinstance(name, str) else ""
        if not valid_folder(name) or kind not in {"organization", "person"}:
            raise ServiceError("请填写有效的对接方名称和类型。")
        existing = next((identity for identity, (_, metadata, _) in counterparties(files).items() if name_key(metadata["name"]) == name_key(name)), None)
        if existing:
            return existing
        identity = party_id(name)
        if identity in counterparties(files):
            identity = "counterparty-" + uuid.uuid4().hex[:16]
        directory = "counterparties/" + name
        if any(path.startswith(directory + "/") for path in files) or (self.root / directory).exists():
            raise ServiceError("此对接方目录已存在，请选择已有档案或使用可区分的名称。", "duplicate")
        files[directory + "/README.md"] = markdown({"id": identity, "name": name, "kind": kind}, "# " + name)
        files[directory + "/contacts.yaml"] = dump({"counterparty": identity, "people": []})
        return identity

    def save(self, request: dict, *, preview=False, candidate=None) -> dict:
        # Internal candidate mode composes validated transactions without writing to disk.
        before = self.read_files() if candidate is None else candidate
        files = dict(before)
        kind, identity, project = request["kind"], request.get("id", ""), request.get("project_id", "")
        if request.get("revision") != self.record_revision(before, kind, identity, project):
            raise ServiceError("这条资料已被其他编辑修改。你的草稿仍保留，请先比较最新内容再保存。", "conflict", self.get_record(request))
        payload = request.get("payload")
        if not isinstance(payload, dict):
            raise ServiceError("没有可保存的资料。")
        if kind != "progress" and payload.get("new_people"):
            raise ServiceError("随进展新增人员仅适用于已有事项。")
        if kind == "counterparty":
            current = counterparties(before).get(identity)
            if not current:
                raise ServiceError("请在新增事项时一起创建对接方。")
            directory, metadata, _ = current
            name = payload.get("name", "").strip()
            if not name or any(key != identity and name_key(value[1]["name"]) == name_key(name) for key, value in counterparties(before).items()):
                raise ServiceError("对接方名称不能为空或与已有档案重复。", "duplicate")
            metadata = {**metadata, "name": name, "kind": payload.get("kind"), "short_name": payload.get("short_name") or None}
            files[directory + "/README.md"] = markdown(metadata, payload.get("body", ""))
            files[directory + "/contacts.yaml"] = dump({"counterparty": identity, "people": payload.get("people", [])})
            title = name
        elif kind == "person":
            current = self.record(before, kind, identity) or {}
            profile = {**current, **{key: payload.get(key) for key in PERSON_FIELDS}}
            if not identity:
                identity = profile.get("name", "").strip()
                if not identity or re.search(r"[\s/\\]", identity):
                    raise ServiceError("姓名不能为空，也不能包含空格或斜杠。")
                if self.record(before, kind, identity):
                    raise ServiceError("同名人员已存在，请编辑已有档案。", "duplicate")
            if current and profile["name"] != current["name"]:
                raise ServiceError("姓名是统一档案标识，请保留姓名，在单位或备注中区分身份。")
            profile["id"] = identity
            files["people.yaml"] = replace_item(files["people.yaml"], "people", "id", identity, profile)
            title = profile["name"]
        elif kind == "project":
            current = self.projects(before).get(identity)
            metadata = {**(current[1] if current else {}), **{key: payload.get(key) for key in PROJECT_FIELDS if key in payload}}
            primary = payload.get("primary_counterparty_id", metadata.get("primary_counterparty_id"))
            if not primary:
                new_party = payload.get("new_counterparty", {})
                primary = self.ensure_counterparty(files, new_party.get("name", ""), new_party.get("kind", "organization"))
            if primary not in counterparties(files):
                raise ServiceError("归档对接方已不存在，请重新选择。", "conflict")
            linked = payload.get("counterparty_ids", metadata.get("counterparty_ids", []))
            if not isinstance(linked, list):
                raise ServiceError("请选择参与对接方。")
            linked = list(dict.fromkeys([primary] + linked))
            for name in payload.get("additional_counterparties", []):
                linked.append(self.ensure_counterparty(files, name, "person" if self.record(files, "person", name) else "organization"))
            metadata.update(primary_counterparty_id=primary, counterparty_ids=list(dict.fromkeys(linked)))
            if current:
                if primary != current[1]["primary_counterparty_id"]:
                    raise ServiceError("归档对接方在创建后保持不变；可以调整其他参与对接方。")
                directory = current[0]
            else:
                name = metadata.get("name", "").strip()
                if not valid_folder(name):
                    raise ServiceError("请填写有效的事项名称。")
                directory = counterparties(files)[primary][0] + "/matters/" + name
                if any(item.startswith(directory + "/") for item in before):
                    raise ServiceError("同名事项目录已存在。", "duplicate")
                identity = "project-" + uuid.uuid4().hex[:16]
            metadata["id"] = identity
            for field in ("updated", "last_activity", "source_type", "format"):
                metadata.pop(field, None)
            files[directory + "/README.md"] = markdown(metadata, payload.get("body", ""))
            contacts = payload.get("contacts", [])
            files[directory + "/contacts.yaml"] = dump({"project": identity, "contacts": [{key: contact.get(key) for key in ("person_id", "side", "project_roles", "notes")} for contact in contacts]})
            if not current:
                files[directory + "/events.yaml"] = dump({"project": identity, "events": []})
                initial = payload.get("initial_event")
                if not isinstance(initial, dict):
                    raise ServiceError("新增事项需要一条实际进展记录。")
                self.write_progress(files, "progress", "", identity, initial)
            title = metadata["name"]
        elif kind in {"progress", "company"}:
            identity, title = self.write_progress(files, kind, identity, project, payload)
        else:
            raise ServiceError("未知的资料类型。")
        if candidate is not None:
            return {"files": files, "id": identity, "title": title}
        attachments = request.get("attachments", [])
        if not isinstance(attachments, list):
            raise ServiceError("附件列表格式无效。")
        writes, attached = [], []
        if attachments:
            if kind != "progress":
                raise ServiceError("附件合并保存仅适用于已有事项的进展。")
            from progress_files import attach_progress
            files, writes, attached = attach_progress(self, files, project, identity, payload["date"], attachments)
        if preview or attachments:
            errors, _ = self.stage(files, verify_attachments=not bool(attachments))
            if errors:
                raise ServiceError("草稿尚未通过资料校验，请补充或修正后重试。", "validation", errors)
            if preview:
                return {"valid": True, "attachments": attached}
        for relative, data in writes:
            FileLibrary(self).put(relative, data)
        result = self.commit(before, files, ("修改" if request.get("id") else "新增") + "：" + title, "form")
        result["id"] = identity
        if attachments:
            from staged_uploads import UploadStore
            uploads = UploadStore(self)
            for item in attachments:
                if item.get("upload_id"):
                    uploads.remove(item["upload_id"])
            result["attachments"] = attached
        return result

    def restore_candidate(self, current: dict[str, str], historical: dict[str, str], kind: str, identity: str, project_id="") -> dict[str, str]:
        if kind == "workspace":
            return dict(historical)
        after = dict(current)
        record = self.record(historical, kind, identity, project_id)
        if kind == "counterparty":
            old = counterparties(historical).get(identity)
            live = counterparties(current).get(identity)
            if live:
                after.pop(live[0] + "/README.md", None)
                after.pop(live[0] + "/contacts.yaml", None)
            if old:
                directory = live[0] if live else old[0]
                for filename in ("README.md", "contacts.yaml"):
                    after[directory + "/" + filename] = historical[old[0] + "/" + filename]
        elif kind == "file":
            index = index_from(current)
            index["files"] = [item for item in index["files"] if item["id"] != identity]
            if record:
                index["files"].append(record)
            after["files.yaml"] = dump(index)
        elif kind == "person":
            after["people.yaml"] = replace_item(current["people.yaml"], "people", "id", identity, record)
        elif kind == "project":
            old_project = self.projects(historical).get(identity)
            current_project = self.projects(current).get(identity)
            if current_project and not old_project and current_project[0] + "/README.md" in historical:
                raise ServiceError("这条事项在所选版本中格式有误，请选择校验通过的版本。")
            if current_project:
                after = {name: text for name, text in after.items() if not name.startswith(current_project[0] + "/")}
            if old_project:
                for party in old_project[1]["counterparty_ids"]:
                    if party not in counterparties(after):
                        old_party = counterparties(historical).get(party)
                        if old_party:
                            for filename in ("README.md", "contacts.yaml"):
                                after[old_party[0] + "/" + filename] = historical[old_party[0] + "/" + filename]
                destination = current_project[0] if current_project else old_project[0]
                if not current_project and any(name.startswith(destination + "/") for name in current):
                    raise ServiceError("该事项原目录已被其他事项使用，无法直接恢复。")
                after.update({destination + name[len(old_project[0]):]: text for name, text in historical.items() if name.startswith(old_project[0] + "/")})
        elif kind in {"progress", "company"}:
            directory = "company" if kind == "company" else self.projects(current)[project_id][0]
            event_path = directory + "/events.yaml"
            if event_path not in after:
                after[event_path] = dump({"company": parse_yaml(current["workspace.yaml"])["id"], "events": []})
            current_record = self.record(current, kind, identity, project_id)
            old_related = (current_record or {}).get("event", {}).get("related_record")
            new_related = (record or {}).get("event", {}).get("related_record")
            other_events = [item for item in parse_yaml(after[event_path])["events"] if item["id"] != identity]
            if old_related and old_related != new_related and not any(item.get("related_record") == old_related for item in other_events):
                after.pop(directory + "/" + old_related, None)
            if new_related:
                old_directory = "company" if kind == "company" else self.projects(historical)[project_id][0]
                if new_related != old_related and directory + "/" + new_related in current:
                    raise ServiceError("历史记录的文件名已被其他记录占用，无法直接恢复。")
                after[directory + "/" + new_related] = historical[old_directory + "/" + new_related]
            after[event_path] = replace_item(after[event_path], "events", "id", identity, record["event"] if record else None, sort_dates=True)
            if kind == "progress":
                current_index, old_index = index_from(after), index_from(historical)
                relevant = lambda r: r["kind"] == "reference" and r["project_id"] == project_id and r.get("event_id") == identity
                known = {f["id"]: f for f in current_index["files"]}
                for file in current_index["files"]:
                    file["records"] = [r for r in file["records"] if not relevant(r)]
                for old_file in old_index["files"]:
                    records = [r for r in old_file["records"] if relevant(r)]
                    if not records: continue
                    file = known.get(old_file["id"])
                    if not file or any(r["version_id"] not in {v["id"] for v in file["versions"]} for r in records):
                        raise ServiceError("历史关联的文件版本已不在当前资料库，请先恢复对应资料版本。")
                    file["records"].extend(records)
                if current_index != index_from(after):
                    after["files.yaml"] = dump(current_index)
            if kind == "company" and not record and not other_events and event_path not in historical:
                after.pop(event_path, None)
        else:
            raise ServiceError("请先选择要恢复的事项、人员或动态。")
        return after

    def comparison(self, request: dict) -> dict:
        live = self.read_files()
        historical = self.version_files(request["version"])
        current = live
        mode = request.get("mode", "current")
        if mode == "change":
            source, sha = request["version"].split(":", 1)
            repo = self.repo if source == "local" else self.original_repo
            parent = self.git("rev-parse", sha + "^", repo=repo, check=False).strip()
            current = historical
            historical = self.version_files(source + ":" + parent) if re.fullmatch(r"[0-9a-f]{40,64}", parent) else {}
        kind, identity, project = request["kind"], request.get("id", ""), request.get("project_id", "")
        catalog = {}
        for files in (historical, current):
            for party_id_value, (_, metadata, _) in counterparties(files).items():
                catalog["counterparty:" + party_id_value] = {"kind": "counterparty", "id": party_id_value, "name": metadata["name"]}
            for item_id, (_, metadata, _) in self.projects(files).items():
                catalog["project:" + item_id] = {"kind": "project", "id": item_id, "name": metadata.get("name", item_id)}
            try:
                for item in index_from(files)["files"]:
                    catalog["file:" + item["id"]] = {"kind": "file", "id": item["id"], "name": item["title"]}
                for item in parse_yaml(files.get("people.yaml", "people: []")).get("people", []):
                    catalog["person:" + item["id"]] = {"kind": "person", "id": item["id"], "name": item.get("name", item["id"])}
                for item in parse_yaml(files.get("company/events.yaml", "events: []")).get("events", []):
                    catalog["company:" + item["id"]] = {"kind": "company", "id": item["id"], "name": item.get("title", item["id"])}
            except (ServiceError, LibraryError, KeyError, TypeError):
                pass
        if not kind or not identity or kind == "workspace":
            changes = [{"label": name, "before": historical.get(name, "（该版本中不存在）"), "after": current.get(name, "（当前不存在）")} for name in sorted(current.keys() | historical.keys()) if current.get(name) != historical.get(name)]
            errors, _ = self.stage(historical)
            return {"changes": changes, "files": [item["label"] for item in changes], "revision": digest(live), "errors": errors if mode != "change" else [], "can_restore": mode != "change" and bool(changes) and not errors, "historical_exists": True, "current_exists": True, "records": list(catalog.values())}
        old, new = self.record(historical, kind, identity, project), self.record(current, kind, identity, project)
        changes = []
        def walk(before, after, label=""):
            if before == after:
                return
            if isinstance(before, list) and isinstance(after, list) and all(isinstance(item, dict) and ("person_id" in item or "id" in item) for item in before + after):
                indexed_before = {item.get("person_id", item.get("id")): item for item in before}
                indexed_after = {item.get("person_id", item.get("id")): item for item in after}
                for item_id in sorted(indexed_before.keys() | indexed_after.keys()):
                    item = indexed_after.get(item_id) or indexed_before[item_id]
                    walk(indexed_before.get(item_id, {}), indexed_after.get(item_id, {}), label + " · " + item.get("person_id", item.get("title", item_id)))
                return
            if isinstance(before, str) and isinstance(after, str) and before.startswith("---\n") and after.startswith("---\n"):
                try:
                    old_metadata, old_body = parse_md(before)
                    new_metadata, new_body = parse_md(after)
                    walk({"metadata": old_metadata, "body": old_body}, {"metadata": new_metadata, "body": new_body}, label)
                    return
                except ServiceError:
                    pass
            if isinstance(before, dict) and isinstance(after, dict):
                for key in sorted(before.keys() | after.keys()):
                    if key == "id":
                        continue
                    walk(before.get(key), after.get(key), (label + " · " if label else "") + LABELS.get(key, key))
            else:
                def display(value):
                    if value is None:
                        return "（未填写 / 不存在）"
                    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
                changes.append({"label": label or "整条资料", "before": display(before), "after": display(after)})
        if kind == "file":
            def readable_file(item, files):
                if item is None:
                    return None
                project_index = self.projects(files)
                version_names = {version["id"]: f'v{index + 1} · {version["filename"]}' for index, version in enumerate(item["versions"])}
                def project_name(identity):
                    return project_index.get(identity, (None, {}, None))[1].get("name", identity)
                def event_name(record):
                    project = self.record(files, "project", record["project_id"])
                    return next((event["title"] for event in (project or {}).get("events", []) if event["id"] == record.get("event_id")), record.get("event_id", ""))
                statuses = {"unspecified": "未标注", "draft": "草案", "final": "定稿", "signed": "签署件"}
                categories = {"agreement": "协议", "presentation": "演示材料", "bp": "商业计划书", "introduction": "公司介绍", "other": "其他资料"}
                uses = {"reference": "进展附件", "meeting": "会议使用", "sent": "实际发送", "received": "对方提供"}
                display = {**item, "category": categories.get(item["category"], item["category"]), "archived": "已移入回收站" if item["archived"] else "在用资料", "project_ids": [project_name(identity) for identity in item["project_ids"]], "home_counterparty_id": counterparties(files).get(item["home_counterparty_id"], (None, {}, None))[1].get("name", item["home_counterparty_id"]), "current_version": version_names.get(item["current_version"], item["current_version"])}
                display["versions"] = [{**version, "title": version_names[version["id"]], "status": statuses[version["status"]], "size": f'{version["size"]:,} 字节'} for version in item["versions"]]
                display["records"] = [{**record, "title": record["date"] + " · " + uses[record["kind"]], "kind": uses[record["kind"]], "version_id": version_names[record["version_id"]], "project_id": project_name(record["project_id"]), "event_id": event_name(record)} for record in item["records"]]
                return display
            walk(readable_file(old, historical), readable_file(new, current))
        elif kind in {"project", "counterparty"}:
            def readable_record(item, files):
                if item is None:
                    return None
                metadata = dict(item["metadata"])
                parties = counterparties(files)
                def party_name(identity):
                    return parties.get(identity, (None, {}, None))[1].get("name", identity)
                if kind == "project":
                    metadata["primary_counterparty_id"] = party_name(metadata["primary_counterparty_id"])
                    metadata["counterparty_ids"] = [party_name(identity) for identity in metadata["counterparty_ids"]]
                else:
                    metadata["kind"] = {"person": "个人", "organization": "机构 / 单位"}.get(metadata["kind"], metadata["kind"])
                return {**item, "metadata": metadata}
            walk(readable_record(old, historical), readable_record(new, current))
        else:
            walk(old, new)
        try:
            candidate = self.restore_candidate(current, historical, kind, identity, project)
            errors, _ = self.stage(candidate)
        except (ServiceError, KeyError) as exc:
            errors = [str(exc)]
        paths = sorted(name for name in current.keys() | historical.keys() if current.get(name) != historical.get(name))
        if kind == "project":
            directories = [item[0] for item in (self.projects(current).get(identity), self.projects(historical).get(identity)) if item]
            paths = [name for name in paths if any(name.startswith(directory + "/") for directory in directories)]
        elif kind == "person":
            paths = ["people.yaml"] if changes else []
        else:
            paths = []
        return {"changes": changes, "files": paths, "revision": digest(live), "errors": errors if mode != "change" else [], "can_restore": mode != "change" and bool(changes) and not errors, "historical_exists": old is not None, "current_exists": new is not None, "records": list(catalog.values())}

    def restore(self, request: dict) -> dict:
        before = self.read_files()
        if digest(before) != request.get("revision"):
            raise ServiceError("预览后资料又发生变化，请重新预览恢复范围。", "conflict")
        historical = self.version_files(request["version"])
        after = self.restore_candidate(before, historical, request["kind"], request["id"], request.get("project_id", ""))
        # Visible archive names may have been reorganized since this historical index.
        if request["kind"] in {"file", "workspace"}:
            errors, _ = self.stage(after)
            if not errors:
                FileLibrary(self).restore_copies(after)
        return self.commit(before, after, "恢复资料版本：" + (request["id"] or "全部资料"), "restore")

    def history_entries(self, request: dict) -> list[dict]:
        self.ensure_repo()
        kind, identity = request.get("kind", ""), request.get("id", "")
        key = kind + ":" + identity
        entries = []
        for line in self.git("log", "--format=%H%x09%cI%x09%s", check=False).splitlines():
            sha, at, subject = line.split("\t", 2)
            metadata = json.loads(subject)
            if identity and key not in metadata.get("affected", []) and metadata.get("origin") != "baseline":
                continue
            if kind and not identity and metadata.get("origin") != "baseline" and not any(item.startswith(kind + ":") for item in metadata.get("affected", [])):
                continue
            entries.append({"version": "local:" + sha, "at": at, "label": metadata.get("label", "保存资料"), "origin": metadata.get("origin", "external"), "valid": metadata.get("valid", True), "actor": metadata.get("actor")})
        if self.original_repo:
            prefix = self.original_prefix
            paths = [prefix]
            current = self.read_files()
            if kind == "file":
                paths = [prefix + "/files.yaml"]
            elif kind == "person":
                paths = [prefix + "/people.yaml"]
            elif kind == "project" and identity in self.projects(current):
                paths = [prefix + "/" + self.projects(current)[identity][0], prefix + "/projects"]
            elif kind == "counterparty" and identity in counterparties(current):
                paths = [prefix + "/" + counterparties(current)[identity][0], prefix + "/projects"]
            elif kind == "company":
                paths = [prefix + "/company"]
            for line in self.git("log", "--format=%H%x09%cI%x09%s", "--", *paths, repo=self.original_repo, check=False).splitlines():
                sha, at, label = line.split("\t", 2)
                if identity:
                    parent = self.git("rev-parse", sha + "^", repo=self.original_repo, check=False).strip()
                    old = self.version_files("repo:" + parent) if re.fullmatch(r"[0-9a-f]{40,64}", parent) else {}
                    new = self.version_files("repo:" + sha)
                    try:
                        if self.record(old, kind, identity) == self.record(new, kind, identity):
                            continue
                    except (ServiceError, LibraryError, KeyError, TypeError):
                        pass
                entries.append({"version": "repo:" + sha, "at": at, "label": label, "origin": "git", "valid": True})
        # Stable sorting keeps the latest Git descendant first when saves share a second.
        entries.sort(key=lambda entry: datetime.fromisoformat(entry["at"]), reverse=True)
        return entries

    def history(self, request: dict) -> dict:
        entries = self.history_entries(request)
        offset = max(0, int(request.get("offset", 0)))
        return {"versions": entries[offset:offset + 40], "has_more": len(entries) > offset + 40, "total": len(entries)}

    def historical(self, request: dict) -> dict:
        entries = self.history_entries({})
        selected = None
        try:
            zone = parse_yaml((self.root / "workspace.yaml").read_text()).get("timezone", "Asia/Shanghai")
            ZoneInfo(zone)
        except Exception:
            cached = self.root / "generated" / "dashboard.json"
            if cached.is_file():
                zone = json.loads(cached.read_text())["workspace"]["timezone"]
            elif entries:
                valid_workspace = next((self.version_files(item["version"]).get("workspace.yaml") for item in entries if item["valid"]), None)
                zone = parse_yaml(valid_workspace or "timezone: Asia/Shanghai").get("timezone", "Asia/Shanghai")
            else:
                zone = "Asia/Shanghai"
        if request.get("version"):
            selected = next((item for item in entries if item["version"] == request["version"]), None)
        else:
            try:
                value = request.get("date", "")
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    raise ValueError()
                end = datetime.combine(date.fromisoformat(value) + timedelta(days=1), datetime.min.time(), ZoneInfo(zone))
            except (ValueError, TypeError):
                raise ServiceError("请选择有效的回看日期。")
            selected = next((item for item in entries if datetime.fromisoformat(item["at"]) < end), None)
        if selected is None:
            raise ServiceError("所选日期或版本没有已留存的资料。可以选择更晚的日期或历史列表中的版本。", "not_found")
        files = self.version_files(selected["version"])
        # Viewing text does not depend on attachment bytes being online. Downloads still verify hashes.
        errors, data = self.stage(files, verify_attachments=False)
        if errors or data is None:
            raise ServiceError("所选版本的资料格式有问题，无法完整浏览。仍可在修改历史中比较内容；没有改用其他版本。", "validation", errors)
        return {"data": json.loads(data), "version": selected, "date": request.get("date"), "timezone": zone}



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-dir", type=Path, required=True)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    web = os.environ.get("BD_REQUEST_WEB") == "1"
    server = os.environ.get("BD_MODE") == "server"
    if os.environ.get("BD_MODE") not in {None, "", "local", "server"}:
        raise AuthError("工作台运行模式配置无效。")
    if web and request.get("action") == "restore_backup":
        raise AuthError("完整恢复仅能通过服务器维护命令执行。")
    if request.get("action") == "restore_backup":
        from file_backup import restore_backup
        result = restore_backup(request["archive"], request["destination"])
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return
    workspace = Workspace(args.content_dir)
    with (workspace.store / "lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        workspace.lock = lock
        action = request.get("action", "status")
        policy, accounts, actor = None, None, None
        if action.startswith("remote_"):
            if not (web and server):
                raise AuthError("远程接入仅在已配置账号的团队模式中提供。")
            from remote_access import RemoteAccess
            accounts = Accounts(workspace.root)
            try:
                remote = RemoteAccess(workspace, accounts)
                if action == "remote_rpc":
                    result = remote.rpc(request, os.environ.get("BD_REMOTE_TOKEN", ""))
                elif action == "remote_browser":
                    result = remote.browser(request, accounts.session(os.environ.get("BD_SESSION", "")))
                else:
                    raise AuthError("未知远程操作。", "invalid")
                print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
            finally:
                accounts.close()
            return
        if action in {"account_init", "account_recover", "account_status"}:
            if web:
                raise AuthError("此命令只能由服务器维护人员执行。")
            accounts = Accounts(workspace.root)
            if action == "account_status":
                result = {"initialized": bool(accounts.db.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone())}
            elif action == "account_init":
                result = accounts.invite({**request, "role": "admin", "all_projects": True}, None, set(), bootstrap=True)
            else:
                result = accounts.reset(request.get("email"), None, recovery=True)
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
            accounts.close()
            return
        if web and server:
            from team_policy import Policy
            accounts = Accounts(workspace.root)
            if action not in {"auth_invite_info"}:
                actor = accounts.session(os.environ.get("BD_SESSION", ""))
            if action.startswith(("auth_", "team_")):
                result = accounts.dispatch(action, request, actor, {identity: metadata["name"] for identity, (_, metadata, _) in workspace.projects(workspace.read_files()).items()})
                print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
                accounts.close()
                return
            policy = Policy(workspace, actor)
            workspace.policy = policy
            workspace.upload_scope = {"owner": actor["id"], "binding": actor["revision"], "channel": "web"}
            policy.authorize(request)
            workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
            if action in {"save", "file_save", "restore", "backup_config", "backup_now", "file_backup"}:
                accounts.audit(actor, action, request.get("id") or request.get("project_id", ""), "started")
        if action == "migrate_layout":
            from workspace_layout import migrate_layout
            workspace.recover()
            result = migrate_layout(workspace, apply=request.get("apply") is True)
        elif action == "history":
            result = workspace.history(request)
        elif action == "historical":
            result = workspace.historical(request)
        elif action == "file_download" and request.get("snapshot"):
            result = FileLibrary(workspace).download(request.get("id", ""), request.get("version_id", ""), workspace.version_files(request["snapshot"]))
        elif action in {"backup_status", "backup_config", "backup_now", "backup_tick"}:
            from automatic_backup import BackupManager
            manager = BackupManager(workspace)
            if action == "backup_config":
                result = manager.configure(request)
            elif action in {"backup_now", "backup_tick"}:
                result = manager.run(force=action == "backup_now")
            else:
                result = manager.status_with_revision()
        else:
            if action != "compare":
                try:
                    workspace.recover()
                except ServiceError as exc:
                    # Explicit restore is allowed only after a current, validated preview.
                    if action != "restore" or exc.code != "recovery_conflict":
                        raise
            status = workspace.observe(request.get("label", "记录文件修改"), request.get("origin", "external"), request.get("force", False))
            if action in {"status", "checkpoint"}:
                result = status
            elif action == "workspace":
                data_file = workspace.root / "generated" / "dashboard.json"
                result = {"status": status, "data": json.loads(data_file.read_text()) if data_file.exists() else None}
            elif action == "files":
                result = FileLibrary(workspace).list()
            elif action in {"upload_stage", "upload_discard"}:
                from staged_uploads import UploadStore
                result = UploadStore(workspace).dispatch(request)
            elif action == "file_save":
                result = FileLibrary(workspace).save(request)
            elif action == "file_download":
                result = FileLibrary(workspace).download(request.get("id", ""), request.get("version_id", ""))
            elif action == "file_location":
                result = FileLibrary(workspace).location(request.get("id", ""), request.get("version_id", ""), request.get("record_id", ""))
            elif action == "file_normalize_paths":
                from file_archive_paths import normalize_paths
                result = normalize_paths(workspace, request)
            elif action == "file_backup":
                from file_backup import create_backup
                result = create_backup(workspace)
            elif action == "backup_download":
                from file_backup import backup_download
                result = backup_download(workspace, request.get("id", ""))
            elif action == "record":
                result = workspace.get_record(request)
            elif action == "save":
                result = workspace.save(request)
            elif action == "preview":
                result = workspace.save(request, preview=True)
            elif action == "compare":
                result = workspace.comparison(request)
            elif action == "restore":
                result = workspace.restore(request)
            else:
                raise ServiceError("未知操作。")
        if policy:
            result = policy.result(request, result)
            if action in {"save", "file_save", "restore", "backup_config", "backup_now", "file_backup"}:
                accounts.audit(actor, action, result.get("id") or request.get("id") or request.get("project_id", ""), "failed" if result.get("error") else "success")
            accounts.close()
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ServiceError, LibraryError, AuthError) as exc:
        details = exc.details
        if os.environ.get("BD_REQUEST_WEB") == "1" and os.environ.get("BD_MODE") == "server" and exc.code == "validation":
            # Candidate validation covers the whole workspace, including restricted matters.
            details = ["请检查本次输入；共享资料的格式问题可由管理员查看工作区状态。"]
        print(json.dumps({"ok": False, "error": str(exc), "code": exc.code, "details": details}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "操作未完成，已保留当前资料和历史版本。请检查资料格式或本地存储。", "code": "internal", "details": type(exc).__name__}, ensure_ascii=False))
