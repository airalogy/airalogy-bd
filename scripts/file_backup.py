"""Portable complete backups. Restore only into a new workspace, never over live data."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path

from file_library import FileLibrary, LibraryError, safe_relative
from content_paths import is_attachment_path


def checksum(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def create_backup(workspace):
    from workspace_service import digest
    before = workspace.read_files()
    library = FileLibrary(workspace)
    errors, _ = workspace.stage(before)
    if errors:
        raise LibraryError("当前资料未通过校验，请先在修改历史中修复后再创建完整备份。", details=errors)
    workspace.snapshot(before, "checkpoint", "完整备份前留存资料")
    exports = workspace.store / "exports"
    exports.mkdir(exist_ok=True, mode=0o700)
    identity = uuid.uuid4().hex
    destination = exports / (identity + ".zip")
    with tempfile.TemporaryDirectory(dir=exports) as directory:
        staging = Path(directory)
        bundle = staging / "history.bundle"
        workspace.git("bundle", "create", str(bundle), "--all")
        entries = {}
        from team_auth import backup_accounts
        account_copy = staging / "accounts.sqlite3"
        has_accounts = backup_accounts(workspace.root, account_copy)
        original = None
        # Do not accidentally include an unrelated ancestor repository in a workspace backup.
        if workspace.original_repo and (workspace.original_repo == workspace.root.parent or workspace.original_repo == workspace.store / "original-versions"):
            original_bundle = staging / "original-history.bundle"
            head = workspace.git("rev-parse", "--verify", "HEAD", repo=workspace.original_repo, check=False).strip()
            if head:
                workspace.git("bundle", "create", str(original_bundle), "--all", repo=workspace.original_repo)
                original = {"prefix": workspace.original_prefix}
        with zipfile.ZipFile(staging / "backup.zip", "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for name, source in before.items():
                data = source.encode("utf-8")
                archive.writestr("content/" + name, data)
                entries["content/" + name] = hashlib.sha256(data).hexdigest()
            for archive_root in library.archive_roots():
                for base, folders, names in os.walk(archive_root, followlinks=False):
                    if any((Path(base) / folder).is_symlink() for folder in folders):
                        raise LibraryError("资料库含符号链接，无法创建完整备份。")
                    for name in names:
                        source = Path(base) / name
                        relative = source.relative_to(library.root).as_posix()
                        source = library.path(relative)
                        if not source.is_file():
                            continue
                        key = "files/" + relative
                        first = checksum(source)
                        archive.write(source, key)
                        if checksum(source) != first:
                            raise LibraryError("备份时附件被外部修改，请重新备份。", "conflict")
                        entries[key] = first
            if has_accounts:
                archive.write(account_copy, "accounts.sqlite3")
                entries["accounts.sqlite3"] = checksum(account_copy)
            archive.write(bundle, "history.bundle")
            entries["history.bundle"] = checksum(bundle)
            if original:
                archive.write(original_bundle, "original-history.bundle")
                entries["original-history.bundle"] = checksum(original_bundle)
            archive.writestr("backup.json", json.dumps({"format": "airalogy-bd-backup", "version": 5, "revision": digest(before), "checksums": entries, "original_history": original}, ensure_ascii=False))
            archive.writestr("恢复说明.txt", "本备份包含业务文字、全部附件版本、归档副本和工作台自动修改历史；若已启用团队账号，还包含账号、权限及操作记录。登录会话和未使用邀请不随备份恢复。备份含敏感账号信息，请妥善保管。\n恢复到新目录：bd restore-backup --archive <备份.zip> --destination <新目录>\n新目录不会覆盖原工作区。独立内容仓库的已有 Git 历史也包含在备份中；如果内容位于更大的父级仓库内，请另行备份父级仓库。\n")
        with zipfile.ZipFile(staging / "backup.zip") as completed:
            if len(completed.infolist()) > 100000 or sum(item.file_size for item in completed.infolist()) > 2 * 1024**3:
                raise LibraryError("完整备份超过 2 GB 或 10 万个文件，请先缩小资料库。")
        if workspace.read_files() != before:
            raise LibraryError("备份时业务资料发生变化，请重新备份。", "conflict")
        os.replace(staging / "backup.zip", destination)
    return {"id": identity, "filename": "BD工作台完整备份.zip", "size": destination.stat().st_size}


def backup_download(workspace, identity):
    if not re.fullmatch(r"[a-f0-9]{32}", identity):
        raise LibraryError("备份编号无效。")
    path = workspace.store / "exports" / (identity + ".zip")
    if not path.is_file() or path.is_symlink():
        raise LibraryError("备份不存在，请重新生成。", "not_found")
    return {"path": str(path), "filename": "BD工作台完整备份.zip", "size": path.stat().st_size}


def restore_backup(archive_path, destination):
    from workspace_service import Workspace
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise LibraryError("恢复目标必须是尚不存在的新目录，避免覆盖现有资料。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".bd-restore-", dir=destination.parent) as directory:
        staging = Path(directory) / "workspace"
        staging.mkdir()
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            names = [item.filename for item in entries]
            if len(names) != len(set(names)) or len(names) > 100000 or sum(item.file_size for item in entries) > 2 * 1024**3:
                raise LibraryError("备份条目重复或备份过大，无法自动恢复。")
            if "backup.json" not in names or archive.getinfo("backup.json").file_size > 20 * 1024**2:
                raise LibraryError("未找到有效备份清单。")
            metadata = json.loads(archive.read("backup.json"))
            if metadata.get("format") != "airalogy-bd-backup" or metadata.get("version") not in {2, 3, 4, 5} or not isinstance(metadata.get("checksums"), dict):
                raise LibraryError("不支持的备份格式。")
            if set(names) != set(metadata["checksums"]) | {"backup.json", "恢复说明.txt"}:
                raise LibraryError("备份文件与清单不一致。")
            original = metadata.get("original_history")
            if original is not None and (not isinstance(original, dict) or not safe_relative(original.get("prefix", "")) or "original-history.bundle" not in names):
                raise LibraryError("原有历史的备份信息无效。")
            if "original-history.bundle" in names and not original:
                raise LibraryError("原有历史缺少备份信息。")
            for item in entries:
                name = item.filename
                if not safe_relative(name) or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise LibraryError("备份包含不安全路径或符号链接。", "unsafe_path")
                if name in {"backup.json", "恢复说明.txt"}:
                    continue
                if name.startswith("content/"):
                    relative = name[len("content/"):]
                    if is_attachment_path(relative) or Path(relative).suffix not in {".md", ".yaml", ".yml"} or any(part.startswith(".") for part in Path(relative).parts):
                        raise LibraryError("备份包含不支持的业务文件。")
                    target = staging / name
                elif name.startswith("files/"):
                    relative = name[len("files/"):]
                    if not is_attachment_path(relative) or len(Path(relative).parts) < 4:
                        raise LibraryError("备份中的附件未位于事项目录内。")
                    target = staging / "content" / relative
                elif name in {"history.bundle", "original-history.bundle"} or (name == "accounts.sqlite3" and metadata["version"] == 5):
                    target = staging / name
                else:
                    raise LibraryError("备份包含未知内容。")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                if checksum(target) != metadata["checksums"][name]:
                    raise LibraryError("备份校验失败，未恢复任何资料。")
        if (staging / "accounts.sqlite3").exists():
            from team_auth import validate_account_backup
            validate_account_backup(staging / "accounts.sqlite3")
        candidate = Workspace(staging / "content")
        if metadata["version"] == 2:
            from workspace_layout import migrate_layout
            migrate_layout(candidate, apply=True, make_backup=False)
        FileLibrary(candidate).verify_index(candidate.read_files())
        errors, _ = candidate.stage(candidate.read_files())
        if errors:
            raise LibraryError("备份中的业务资料未通过校验。", details=errors)
        # Move only after checking every byte and all business relationships.
        destination.mkdir()  # exclusive; a concurrently created destination is never replaced
        try:
            for name in ("content",):
                if (staging / name).exists():
                    shutil.move(str(staging / name), destination / name)
            restored = Workspace(destination / "content")
            # Backups contain files, so reconstruct required empty directories too.
            restored.repair_directories(restored.read_files())
            result = subprocess.run(["git", "clone", "--no-checkout", "--quiet", str(staging / "history.bundle"), str(restored.repo)], capture_output=True, text=True)
            if result.returncode:
                raise LibraryError("历史版本导入失败。")
            for key, value in {"user.name": "Airalogy BD", "user.email": "local@airalogy-bd.invalid", "core.hooksPath": str(restored.store / "no-hooks"), "core.quotePath": "false", "commit.gpgsign": "false"}.items():
                restored.git("config", key, value)
            restored.git("read-tree", "HEAD")
            for name, source in restored.read_files().items():
                restored.atomic(restored.repo / "content" / name, source)
            if original:
                imported = restored.store / "original-versions"
                result = subprocess.run(["git", "clone", "--bare", "--quiet", str(staging / "original-history.bundle"), str(imported)], capture_output=True, text=True)
                if result.returncode:
                    raise LibraryError("原有历史版本导入失败。")
                restored.atomic(restored.store / "original-history.json", json.dumps(original))
                restored = Workspace(destination / "content")
            if (staging / "accounts.sqlite3").exists():
                account_dir = destination / ".bd-auth"
                account_dir.mkdir(mode=0o700)
                shutil.move(str(staging / "accounts.sqlite3"), account_dir / "accounts.sqlite3")
                os.chmod(account_dir / "accounts.sqlite3", 0o600)
            restored.observe("恢复完整备份", "recovery", force=True)
            (destination / ".gitignore").write_text(".bd-auth/\n.bd-ai/\n.env\n.bd-history/\ncontent/counterparties/*/attachments/\n.bd-local.json\n.airalogy-bd/\n.uv-cache/\ncontent/generated/\n", encoding="utf-8")
        except Exception:
            shutil.rmtree(destination)
            raise
    return {"directory": str(destination), "message": "已恢复到新工作区，原资料未被覆盖。"}
