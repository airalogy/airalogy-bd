"""Immutable attachment bytes; editable, versioned YAML index shared with the workbench."""
from __future__ import annotations

import base64
import hashlib
import os
import re
import tempfile
import uuid
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path, PurePosixPath

import yaml

from content_paths import is_attachment_path, MATTER_README, counterparties

MAX_BYTES = 50 * 1024 * 1024
CATEGORIES = {"agreement", "presentation", "bp", "introduction", "other"}
AGREEMENT_TYPES = {"unspecified", "nda", "investment_cooperation"}
STATUSES = {"unspecified", "draft", "final", "signed"}
AGREEMENT_DATES = {"agreement_date": "协议载明日期", "signing_completed_date": "实际签署完成日期"}
USES = {"reference", "meeting", "sent", "received"}
EXTENSIONS = {".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".txt", ".md", ".csv", ".zip"}


class LibraryError(Exception):
    def __init__(self, message, code="invalid", details=None):
        super().__init__(message)
        self.code, self.details = code, details


def index_from(files):
    try:
        value = yaml.safe_load(files.get("files.yaml", "schema_version: 1\nfiles: []\n"))
        if not isinstance(value, dict) or value.get("schema_version") != 1 or not isinstance(value.get("files"), list):
            raise ValueError()
        return value
    except (ValueError, yaml.YAMLError):
        raise LibraryError("资料索引格式有误，请在修改历史中恢复 files.yaml。")


def text(value, label, required=True, limit=500):
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit or "\x00" in value:
        raise LibraryError(f"{label}请填写有效文字（最多 {limit} 字）。")
    return value.strip()


def safe_relative(value):
    return isinstance(value, str) and bool(value) and not PurePosixPath(value).is_absolute() and all(part not in {"..", ".", ""} for part in value.split("/")) and "\\" not in value and not any(ord(char) < 32 for char in value)


def check_index(files):
    """Check all relationships, including AI edits, without depending on a machine path."""
    index = index_from(files)
    people = {item["id"] for item in (yaml.safe_load(files.get("people.yaml", "people: []")) or {}).get("people", [])}
    projects, events = {}, {}
    parties = counterparties(files)
    directories = {identity: directory + "/attachments/" for identity, (directory, _, _) in parties.items()}
    for name, source in files.items():
        if MATTER_README.fullmatch(name):
            match = re.match(r"\A---\s*\n(.*?)\n---", source, re.S)
            if match:
                metadata = yaml.safe_load(match[1])
                projects[metadata["id"]] = metadata
                event_data = yaml.safe_load(files.get(str(Path(name).parent / "events.yaml"), "events: []")) or {}
                events[metadata["id"]] = {item["id"] for item in event_data.get("events", [])}
    ids = set()
    for item in index["files"]:
        if not isinstance(item, dict) or not re.fullmatch(r"file-[a-f0-9]{32}", item.get("id", "")) or item["id"] in ids:
            raise LibraryError("资料编号缺失或重复。")
        ids.add(item["id"])
        text(item.get("title"), "资料名称", limit=100)
        text(item.get("organization"), "对接机构或个人", limit=100)
        text(item.get("notes", ""), "备注", required=False, limit=2000)
        if item.get("category") not in CATEGORIES or type(item.get("archived")) is not bool:
            raise LibraryError("资料分类或回收站状态无效。")
        agreement_type = item.get("agreement_type", "unspecified")
        if agreement_type not in AGREEMENT_TYPES or (agreement_type != "unspecified" and item["category"] != "agreement"):
            raise LibraryError("协议类型无效；具体协议类型须归入协议分类。")
        related = item.get("project_ids")
        if not isinstance(related, list) or not related or len(set(related)) != len(related) or any(key not in projects for key in related):
            raise LibraryError("资料必须关联现有事项；请先调整附件关联，再移除事项。")
        home = item.get("home_counterparty_id")
        if not isinstance(home, str) or home not in parties or not any(home in projects[identity].get("counterparty_ids", []) for identity in related):
            raise LibraryError("归档对接方必须至少关联这份资料的一个事项。")
        archive_prefix = directories[home]
        versions = item.get("versions")
        if not isinstance(versions, list) or not versions:
            raise LibraryError("资料至少需要一个文件版本。")
        version_ids = set()
        for version in versions:
            if not isinstance(version, dict) or not re.fullmatch(r"version-[a-f0-9]{32}", version.get("id", "")) or version["id"] in version_ids:
                raise LibraryError("文件版本编号无效或重复。")
            version_ids.add(version["id"])
            filename = text(version.get("filename"), "文件名", limit=180)
            if "/" in filename or "\\" in filename or Path(filename).suffix.lower() not in EXTENSIONS:
                raise LibraryError("不支持此文件名或文件类型。")
            if not re.fullmatch(r"[a-f0-9]{64}", version.get("sha256", "")) or type(version.get("size")) is not int or not 0 < version["size"] <= MAX_BYTES:
                raise LibraryError("文件指纹或大小无效。")
            if version.get("status") not in STATUSES or not safe_relative(version.get("archive_path")) or not version["archive_path"].startswith(archive_prefix) or version["archive_path"][len(archive_prefix):].split("/")[0] not in {"agreements", "materials"}:
                raise LibraryError("文件状态或归档位置无效。")
            text(version.get("created_at"), "版本时间", limit=40)
            text(version.get("note", ""), "版本说明", required=False, limit=500)
            for field, label in AGREEMENT_DATES.items():
                value = version.get(field, "")
                if value == "":
                    continue
                if item["category"] != "agreement":
                    raise LibraryError("协议日期仅适用于协议；请先清空各版本的协议日期，再修改资料分类。")
                try:
                    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                        raise ValueError()
                    date.fromisoformat(value)
                except (ValueError, TypeError):
                    raise LibraryError(f"{label}须留空或填写有效的 YYYY-MM-DD。")
        if item.get("current_version") not in version_ids:
            raise LibraryError("当前文件版本不存在。")
        records = item.get("records")
        if not isinstance(records, list):
            raise LibraryError("资料使用记录必须是列表。")
        record_ids = set()
        for record in records:
            if not isinstance(record, dict) or not re.fullmatch(r"use-[a-f0-9]{32}", record.get("id", "")) or record["id"] in record_ids:
                raise LibraryError("使用记录编号无效或重复。")
            record_ids.add(record["id"])
            if record.get("version_id") not in version_ids or record.get("kind") not in USES or record.get("project_id") not in related:
                raise LibraryError("使用记录必须关联这份资料的具体版本和事项。")
            if record.get("event_id") and record["event_id"] not in events[record["project_id"]]:
                raise LibraryError("附件关联的交流已不存在；请先调整附件关联。")
            try:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", record.get("date", "")):
                    raise ValueError()
                date.fromisoformat(record["date"])
            except (ValueError, TypeError):
                raise LibraryError("实际日期必须是有效的 YYYY-MM-DD。")
            recipients = record.get("people")
            if not isinstance(recipients, list) or len(set(recipients)) != len(recipients) or any(person not in people for person in recipients):
                raise LibraryError("请选择现有人员档案。")
            if record["kind"] in {"sent", "received"} and (not recipients or not record.get("channel", "").strip()):
                raise LibraryError("发送或收到材料时，请填写具体人员及渠道。")
            text(record.get("channel", ""), "渠道", required=False, limit=100)
            text(record.get("note", ""), "使用说明", required=False, limit=1000)
            # Legacy indexes may still reference a separate interaction copy.
            # New records only reference the immutable version, without another file.
            if "archive_path" in record and (not safe_relative(record["archive_path"]) or not record["archive_path"].startswith(archive_prefix + "interactions/")):
                raise LibraryError("使用记录归档位置无效。")
    return index


def slug(value):
    return re.sub(r'[\x00-\x1f/\\:*?"<>|]', "_", value).strip(". ")[:70] or "未命名"


def archive_filename(value):
    # Preserve readable source names (including extension case) within filesystem limits.
    name = Path(re.sub(r'[\x00-\x1f/\\:*?"<>|]', "_", value).strip(". ") or "未命名")
    stem = name.stem
    while len((stem + name.suffix).encode("utf-8")) > 240:
        stem = stem[:-1]
    return stem + name.suffix


def path_key(value):
    # Avoid collisions on case-insensitive and Unicode-normalizing filesystems too.
    return unicodedata.normalize("NFC", value).casefold()


class FileLibrary:
    def __init__(self, workspace):
        self.workspace = workspace
        self.workspace_root = workspace.root.parent
        self.root = workspace.root

    def archive_directory(self, files, identity):
        value = counterparties(files).get(identity)
        if not value:
            raise LibraryError("请选择现有对接方作为归档位置。")
        return value[0] + "/attachments"

    def document_directory(self, files, index, item, normalize=False):
        owned = {str(Path(version["archive_path"]).parent) for version in item["versions"]}
        if owned and not normalize:
            return str(Path(item["versions"][0]["archive_path"]).parent)
        base = f'{self.archive_directory(files, item["home_counterparty_id"])}/{"agreements" if item["category"] == "agreement" else "materials"}/{slug(item["title"])}'
        occupied = {path_key(str(Path(version["archive_path"]).parent)) for other in index["files"] if other["id"] != item["id"] for version in other["versions"]}
        number = 1
        while True:
            candidate = base if number == 1 else f"{base} ({number})"
            target = self.path(candidate)
            if path_key(candidate) not in occupied and (not target.exists() or candidate in owned):
                return candidate
            number += 1

    @staticmethod
    def reserved_paths(index):
        reserved = {}
        for item in index["files"]:
            versions = {version["id"]: version for version in item["versions"]}
            for version in item["versions"]:
                reserved[path_key(version["archive_path"])] = version["sha256"]
            for record in item["records"]:
                if "archive_path" in record:
                    reserved[path_key(record["archive_path"])] = versions[record["version_id"]]["sha256"]
        return reserved

    def available_path(self, directory, filename, checksum, number, reserved):
        name = Path(archive_filename(filename))
        attempt = 0
        while True:
            suffix = "" if attempt == 0 else f"-v{max(number, 2) + attempt - 1:03d}"
            stem = name.stem
            while len((stem + suffix + name.suffix).encode("utf-8")) > 240:
                stem = stem[:-1]
            candidate = f"{directory}/{stem}{suffix}{name.suffix}"
            target = self.path(candidate)
            key = path_key(candidate)
            # Check siblings as well as the index, including user-created files.
            siblings = [child for child in target.parent.iterdir() if path_key(child.name) == path_key(target.name)] if target.parent.is_dir() else []
            available = key not in reserved or reserved[key] == checksum
            for child in siblings:
                if child.is_symlink():
                    raise LibraryError("归档位置含符号链接，已停止访问。", "unsafe_path")
                if child.name != target.name or not child.is_file() or hashlib.sha256(child.read_bytes()).hexdigest() != checksum:
                    available = False
            if available:
                reserved[key] = checksum
                return candidate
            attempt += 1

    def restore_copies(self, files):
        """Recreate missing visible copies when restoring an older index after migration."""
        for item in check_index(files)["files"]:
            versions = {version["id"]: version for version in item["versions"]}
            for entry in [*item["versions"], *item["records"]]:
                if "archive_path" in entry and not self.path(entry["archive_path"]).exists():
                    version = versions[entry.get("version_id", entry["id"])]
                    self.put(entry["archive_path"], self.verified(version).read_bytes())

    def archive_roots(self):
        # Include retained archives whose matter was removed by a historical restore.
        projects = self.root / "counterparties"
        if projects.is_symlink():
            raise LibraryError("事项目录不能是符号链接。", "unsafe_path")
        for project in sorted(projects.iterdir()):
            if project.is_symlink():
                raise LibraryError("事项目录不能是符号链接。", "unsafe_path")
            if project.is_dir():
                archive = self.path(project.relative_to(self.root).as_posix() + "/attachments")
                if archive.is_dir():
                    yield archive

    def path(self, relative):
        if not safe_relative(relative) or not is_attachment_path(relative) or not relative.startswith("counterparties/"):
            raise LibraryError("资料路径无效。", "unsafe_path")
        target = self.root
        if self.root.is_symlink():
            raise LibraryError("资料库路径发生变化，已停止访问。", "unsafe_path")
        for part in relative.split("/"):
            target = target / part
            if target.is_symlink():
                raise LibraryError("资料库含符号链接，已停止访问。", "unsafe_path")
        return target

    def object_path(self, version):
        checksum = version["sha256"]
        if not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise LibraryError("文件指纹无效。")
        return self.path("/".join(version["archive_path"].split("/")[:3]) + "/.objects/" + checksum)

    def verified(self, version):
        target = self.object_path(version)
        if not target.is_file() or target.stat().st_size != version["size"] or hashlib.sha256(target.read_bytes()).hexdigest() != version["sha256"]:
            raise LibraryError("归档原件缺失或内容已改变，请从完整备份恢复资料库。", "missing_file")
        return target

    def verify_index(self, files):
        index = check_index(files)
        seen = set()
        for item in index["files"]:
            for version in item["versions"]:
                if str(self.object_path(version)) not in seen:
                    self.verified(version)
                    seen.add(str(self.object_path(version)))

    def put(self, relative, data):
        target = self.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.exists():
            if target.read_bytes() != data:
                raise LibraryError("归档位置已被不同内容占用，未覆盖原文件。", "conflict")
            return
        descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix=".import-")
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            # Exclusive publication: crashes can only leave unreferenced bytes, never a half file.
            os.link(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def list(self):
        from workspace_service import digest
        files = self.workspace.read_files()
        index = check_index(files)
        return {"files": [{**item, "revision": digest(item)} for item in index["files"]], "directory_pattern": "content/counterparties/<对接方>/attachments/", "workspace_directory": str(self.workspace_root), "max_bytes": MAX_BYTES}

    def prepare(self, request, before):
        from workspace_service import digest, dump
        writes = []
        index = check_index(before)
        identity = request.get("id", "")
        item = next((entry for entry in index["files"] if entry["id"] == identity), None)
        operation = request.get("operation")
        payload = request.get("payload", {})
        if not isinstance(payload, dict):
            raise LibraryError("无法读取资料表单。")
        if identity and not item:
            raise LibraryError("这份资料已不存在，请刷新列表。")
        if item and request.get("revision") != digest(item):
            raise LibraryError("资料已发生变化，请刷新后重新操作；当前输入已保留。", "conflict")
        if operation == "upload":
            if item and item["archived"]:
                raise LibraryError("请先从回收站恢复这份资料。")
            if not item:
                item = {"id": "file-" + uuid.uuid4().hex, "title": payload.get("title"), "organization": payload.get("organization"), "category": payload.get("category"), "agreement_type": payload.get("agreement_type", "unspecified"), "project_ids": payload.get("project_ids"), "home_counterparty_id": payload.get("home_counterparty_id"), "notes": payload.get("notes", ""), "archived": False, "versions": [], "records": []}
                index["files"].append(item)
            filename = text(payload.get("filename"), "文件名", limit=180)
            if "/" in filename or "\\" in filename or Path(filename).suffix.lower() not in EXTENSIONS:
                raise LibraryError("请选择 PDF、Office 文档、图片、文本或 ZIP 文件。")
            encoded = payload.get("data", "")
            if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES + 2) // 3 * 4:
                raise LibraryError("单个文件不能超过 50 MB。", "too_large")
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                raise LibraryError("文件内容读取失败。")
            if not data or len(data) > MAX_BYTES:
                raise LibraryError("请选择非空文件，单个文件不能超过 50 MB。", "too_large")
            version_id = "version-" + uuid.uuid4().hex
            directory = self.document_directory(before, index, item)
            archive_path = self.available_path(directory, filename, hashlib.sha256(data).hexdigest(), len(item["versions"]) + 1, self.reserved_paths(index))
            version = {"id": version_id, "filename": filename, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "status": payload.get("status", "unspecified"), "note": payload.get("note", ""), "created_at": datetime.now(timezone.utc).isoformat(), "archive_path": archive_path}
            for field in AGREEMENT_DATES:
                if field in payload:
                    version[field] = payload[field]
            item["versions"].append(version)
            item["current_version"] = version_id
            after = {**before, "files.yaml": dump(index)}
            check_index(after)
            writes = [(self.object_path(version).relative_to(self.root).as_posix(), data), (archive_path, data)]
            label = "导入资料版本：" + item["title"]
        else:
            if not item:
                raise LibraryError("请选择现有资料。")
            if operation == "metadata":
                if "home_counterparty_id" in payload and payload["home_counterparty_id"] != item["home_counterparty_id"]:
                    raise LibraryError("归档位置在导入后保持不变；可增加其他关联事项。")
                for key in ("title", "organization", "category", "agreement_type", "project_ids", "notes"):
                    if key in payload:
                        item[key] = payload[key]
                if item["category"] != "agreement" and "agreement_type" not in payload:
                    item["agreement_type"] = "unspecified"
                label = "修改资料信息：" + str(item["title"])
            elif operation == "agreement_dates":
                if item["archived"]:
                    raise LibraryError("请先从回收站恢复这份资料。")
                if item["category"] != "agreement":
                    raise LibraryError("仅协议资料可填写协议日期。")
                version = next((entry for entry in item["versions"] if entry["id"] == payload.get("version_id")), None)
                if not version:
                    raise LibraryError("请选择具体协议版本。")
                for field in AGREEMENT_DATES:
                    if field in payload:
                        if payload[field] == "":
                            version.pop(field, None)
                        else:
                            version[field] = payload[field]
                label = "修改协议日期：" + item["title"] + " · v" + str(item["versions"].index(version) + 1)
            elif operation in {"archive", "unarchive"}:
                item["archived"] = operation == "archive"
                label = ("移入资料回收站：" if item["archived"] else "从资料回收站恢复：") + item["title"]
            elif operation == "select_version":
                item["current_version"] = payload.get("version_id")
                label = "恢复为所选文件版本：" + item["title"]
            elif operation == "usage_remove":
                record_id = payload.get("record_id")
                if not any(record["id"] == record_id for record in item["records"]):
                    raise LibraryError("使用记录已不存在。")
                item["records"] = [record for record in item["records"] if record["id"] != record_id]
                label = "移除错误的资料使用记录：" + item["title"]
            elif operation == "usage":
                if item["archived"]:
                    raise LibraryError("请先从回收站恢复这份资料。")
                record = {key: payload.get(key, "") for key in ("version_id", "kind", "date", "project_id", "event_id", "channel", "note")}
                record_id = payload.get("record_id")
                if record_id and not any(record["id"] == record_id for record in item["records"]):
                    raise LibraryError("使用记录已不存在。")
                record.update({"id": record_id or "use-" + uuid.uuid4().hex, "people": payload.get("people", [])})
                version = next((version for version in item["versions"] if version["id"] == record["version_id"]), None)
                if not version:
                    raise LibraryError("请选择具体文件版本。")
                existing = next((entry for entry in item["records"] if entry["id"] == record_id), None)
                if existing and existing["version_id"] == record["version_id"] and "archive_path" in existing:
                    # Keep legacy copies discoverable until an explicit backed-up migration.
                    record["archive_path"] = existing["archive_path"]
                item["records"] = [existing for existing in item["records"] if existing["id"] != record["id"]] + [record]
                after = {**before, "files.yaml": dump(index)}
                check_index(after)
                self.verified(version)
                label = "记录资料使用：" + item["title"]
            else:
                raise LibraryError("不支持的资料操作。")
        after = {**before, "files.yaml": dump(index)}
        check_index(after)
        return after, item["id"], label, writes

    def save(self, request):
        before = self.workspace.read_files()
        after, identity, label, writes = self.prepare(request, before)
        for relative, data in writes:
            self.put(relative, data)
        result = self.workspace.commit(before, after, label, "attachment")
        return {**result, "id": identity}

    def download(self, identity, version_id, files=None):
        index = check_index(self.workspace.read_files() if files is None else files)
        item = next((item for item in index["files"] if item["id"] == identity), None)
        version = next((version for version in (item or {}).get("versions", []) if version["id"] == version_id), None)
        if not version:
            raise LibraryError("没有找到该文件版本。", "not_found")
        return {"path": str(self.verified(version)), "filename": version["filename"], "size": version["size"]}

    def location(self, identity, version_id="", record_id=""):
        """Resolve only indexed, visible archive copies for the local file manager."""
        if bool(version_id) == bool(record_id):
            raise LibraryError("请选择一个文件版本或使用记录。")
        index = check_index(self.workspace.read_files())
        item = next((item for item in index["files"] if item["id"] == identity), None)
        entries = (item or {}).get("records" if record_id else "versions", [])
        entry = next((entry for entry in entries if entry["id"] == (record_id or version_id)), None)
        if not entry:
            raise LibraryError("没有找到该文件版本或使用记录，请刷新资料。", "not_found")
        if record_id:
            entry = next(version for version in item["versions"] if version["id"] == entry["version_id"])
        target = self.path(entry["archive_path"])
        if not target.is_file():
            raise LibraryError("归档副本已移动或缺失，无法定位；可下载该版本查看文件。", "missing_file")
        return {"path": str(target)}
