"""Organize workspace files into counterparties/<name>/matters/<matter>."""
from __future__ import annotations
import hashlib
import json
import os
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path
from content_paths import migrate_files, counterparties, is_attachment_path
from file_library import FileLibrary, LibraryError


def old_archives(workspace):
    root = workspace.root / "projects"
    if not root.exists():
        return
    if root.is_symlink():
        raise LibraryError("源事项目录含符号链接，整理已停止。", "unsafe_path")
    for directory in sorted(root.iterdir()):
        if directory.is_symlink():
            raise LibraryError("源事项目录含符号链接，整理已停止。", "unsafe_path")
        archive = directory / "attachments"
        if archive.is_symlink():
            raise LibraryError("源附件目录含符号链接，整理已停止。", "unsafe_path")
        if archive.is_dir():
            for base, folders, names in os.walk(archive, followlinks=False):
                if any((Path(base) / name).is_symlink() for name in folders + names):
                    raise LibraryError("源附件含符号链接，整理已停止。", "unsafe_path")
            yield archive


def preserve_backup(workspace, files, archives):
    """Version 2 backup keeps the exact pre-migration bytes and existing private history."""
    from workspace_service import digest
    workspace.snapshot(files, "checkpoint", "整理前留存全部资料")
    exports = workspace.store / "exports"
    exports.mkdir(exist_ok=True)
    target = exports / ("before-layout-" + uuid.uuid4().hex + ".zip")
    checksums = {}
    with tempfile.TemporaryDirectory(dir=exports) as directory:
        bundle = Path(directory) / "history.bundle"
        workspace.git("bundle", "create", str(bundle), "--all")
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as output:
            for name, text in files.items():
                data = text.encode("utf-8")
                output.writestr("content/" + name, data)
                checksums["content/" + name] = hashlib.sha256(data).hexdigest()
            for archive in archives:
                for file in sorted(archive.rglob("*")):
                    if not file.is_file():
                        continue
                    key = "files/" + file.relative_to(workspace.root).as_posix()
                    data = file.read_bytes()
                    output.writestr(key, data)
                    checksums[key] = hashlib.sha256(data).hexdigest()
            data = bundle.read_bytes()
            output.writestr("history.bundle", data)
            checksums["history.bundle"] = hashlib.sha256(data).hexdigest()
            output.writestr("backup.json", json.dumps({"format": "airalogy-bd-backup", "version": 2, "revision": digest(files), "checksums": checksums}))
            output.writestr("恢复说明.txt", "整理前的完整备份；使用 bd restore-backup 恢复到新目录。")
    return target


def migrate_layout(workspace, apply=False, make_backup=True):
    before = workspace.read_files()
    after, matters, archive_paths = migrate_files(before)
    archives = list(old_archives(workspace))
    legacy_root = workspace.root / "projects"
    if legacy_root.exists():
        for source in legacy_root.rglob("*"):
            if source.is_symlink():
                raise LibraryError("源目录含符号链接，整理已停止。", "unsafe_path")
            if source.is_file() and not is_attachment_path(source.relative_to(workspace.root)) and source.suffix not in {".md", ".yaml", ".yml"} and source.name not in {".gitkeep", ".DS_Store"}:
                raise LibraryError("源事项目录包含未归档文件，整理未开始：" + source.relative_to(workspace.root).as_posix())
    preview = {"matters": len(matters), "counterparties": len(counterparties(after)), "paths": matters, "attachments": sum(1 for archive in archives for file in archive.rglob("*") if file.is_file())}
    if not apply:
        return {**preview, "message": "资料整理预览；尚未修改资料。"}
    backup = preserve_backup(workspace, before, archives) if make_backup and matters else None
    library = FileLibrary(workspace)
    # Publish immutable copies before committing references. Originals survive any failure.
    for archive in archives:
        old = archive.relative_to(workspace.root).as_posix()
        new = archive_paths.get(old, "counterparties/" + archive.parent.name + "/attachments")
        for source in sorted(archive.rglob("*")):
            if source.is_file():
                library.put(new + "/" + source.relative_to(archive).as_posix(), source.read_bytes())
    if matters:
        result = workspace.commit(before, after, "整理资料目录：按对接方与事项归档", "migration")
    else:
        result = {"saved": False, "message": "当前资料已使用对接方与事项结构。"}
    # Keep the original archive outside content; it is not an active second directory.
    if archives:
        retained = workspace.store / "pre-layout-archives"
        retained.mkdir(exist_ok=True)
        for archive in archives:
            destination = retained / (archive.parent.name + "-" + uuid.uuid4().hex[:8])
            shutil.move(str(archive), destination)
    legacy_root = workspace.root / "projects"
    if legacy_root.exists():
        for marker in legacy_root.rglob(".gitkeep"):
            relative = marker.relative_to(workspace.root).as_posix()
            old = "/".join(relative.split("/")[:2])
            destination = matters.get(old)
            if not destination:
                candidates = list((workspace.root / "counterparties" / marker.relative_to(legacy_root).parts[0] / "matters").glob("*"))
                if len(candidates) == 1:
                    destination = candidates[0].relative_to(workspace.root).as_posix()
            if destination:
                target = workspace.root / (destination + relative[len(old):])
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    shutil.copy2(marker, target)
                if target.read_bytes() == marker.read_bytes():
                    marker.unlink()
        for cache in legacy_root.rglob(".DS_Store"):
            cache.unlink()
    workspace.repair_directories(after)
    ignore = workspace.root.parent / ".gitignore"
    existing = ignore.read_text() if ignore.exists() else ""
    rule = "/content/counterparties/*/attachments/"
    if rule not in existing.splitlines():
        workspace.atomic(ignore, existing.rstrip() + "\n" + rule + "\n")
    if (workspace.root / "projects").exists():
        raise LibraryError("文字资料已整理，源目录仍有未识别文件，已保留，请检查整理前备份和源目录。")
    return {**preview, **result, "backup": str(backup) if backup else None}
