"""Preview and normalize one file's archive paths without changing its bytes."""
from copy import deepcopy
import hashlib
from file_library import FileLibrary, LibraryError, check_index, path_key


def normalize_paths(workspace, request):
    from workspace_service import digest, dump
    from file_backup import create_backup

    before = workspace.read_files()
    index = deepcopy(check_index(before))
    item = next((item for item in index["files"] if item["id"] == request.get("id")), None)
    if not item:
        raise LibraryError("没有找到要整理的资料。", "not_found")
    library = FileLibrary(workspace)
    directory = library.document_directory(before, index, item, normalize=True)
    reserved = library.reserved_paths(index)
    changes = []
    versions = {version["id"]: version for version in item["versions"]}
    for entry in [*item["versions"], *item["records"]]:
        if "archive_path" not in entry:
            continue
        version = versions[entry.get("version_id", entry["id"])]
        library.verified(version)
        old = entry["archive_path"]
        is_record = "version_id" in entry
        new = version["archive_path"] if is_record else library.available_path(directory, version["filename"], version["sha256"], item["versions"].index(version) + 1, reserved)
        if old == new and not is_record:
            continue
        source = library.path(old)
        if source.exists() and (not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != version["sha256"]):
            raise LibraryError("归档副本已被外部修改，未整理；请先将修改内容导入为新版本。", "conflict")
        changes.append({"from": old, "to": new, "version_id": version["id"], "sha256": version["sha256"], "kind": "reuse_version" if is_record else "move_version"})
        if is_record:
            del entry["archive_path"]
        else:
            entry["archive_path"] = new
    plan = {"id": item["id"], "revision": digest(before), "changes": changes, "file_count": len(changes)}
    plan["plan_revision"] = digest(plan)
    if not request.get("apply"):
        return plan
    if request.get("plan_revision") != plan["plan_revision"]:
        raise LibraryError("预览后资料或归档位置已变化，请重新预览。", "conflict")
    if not changes:
        return {**plan, "saved": False, "message": "文件名符合归档规则，无需调整。"}
    after = {**before, "files.yaml": dump(index)}
    check_index(after)
    errors, _ = workspace.stage(after)
    if errors:
        raise LibraryError("整理后的资料未通过校验。", details=errors)
    backup = create_backup(workspace)
    # Publish all new copies first; any interrupted write leaves old paths usable.
    for change in changes:
        library.put(change["to"], library.verified(versions[change["version_id"]]).read_bytes())
    result = workspace.commit(before, after, "整理资料归档：" + item["title"], "attachment")
    retained = []
    active = library.reserved_paths(index)
    for change in changes:
        old = change["from"]
        if path_key(old) in active:
            continue
        try:
            source = library.path(old)
            if source.is_file() and hashlib.sha256(source.read_bytes()).hexdigest() == change["sha256"]:
                source.unlink()
                # Remove empty document/version folders, leaving category directories.
                parent = source.parent
                while len(parent.relative_to(library.root).parts) > 4:
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent
            elif source.exists():
                retained.append(old)
        except (OSError, LibraryError):
            retained.append(old)
    return {**plan, **result, "backup_id": backup["id"], "retained_paths": retained}
