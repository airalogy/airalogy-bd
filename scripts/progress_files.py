"""Plan attachments and progress in one workspace transaction; never infer a sending/signing event."""
import base64
import uuid

from file_library import FileLibrary, LibraryError, check_index, index_from
from staged_uploads import UploadStore


def attach_progress(workspace, files, matter, progress, date, attachments):
    from workspace_service import digest, dump
    if not isinstance(attachments, list) or not 1 <= len(attachments) <= 10:
        raise LibraryError("每次进展最多添加 10 个附件。")
    library, uploads = FileLibrary(workspace), UploadStore(workspace)
    writes, result, seen = [], [], set()
    original = index_from(files)
    project = workspace.projects(files)[matter][1]
    from content_paths import counterparties
    party = counterparties(files)[project["primary_counterparty_id"]][1]
    for attachment in attachments:
        common = {"mode", "file_id", "revision"}
        version = {"upload_id", "status", "agreement_date", "signing_completed_date", "note"}
        mode = attachment.get("mode") if isinstance(attachment, dict) else None
        allowed = common | ({"version_id"} if mode == "existing" else version | ({"title", "category", "agreement_type"} if mode == "upload" else set()))
        if mode not in {"existing", "upload", "version"} or set(attachment) - allowed:
            raise LibraryError("附件操作无效。")
        item = next((v for v in original["files"] if v["id"] == attachment.get("file_id")), None)
        if mode != "upload":
            if not item or item["archived"] or matter not in item["project_ids"]:
                raise LibraryError("请选择本事项中在用的资料。", "forbidden")
            if workspace.policy:
                workspace.policy.file(item["id"])
            if attachment.get("revision") != digest(item):
                raise LibraryError("附件资料已变化，请刷新附件列表并重新核对。", "attachment_conflict")
        elif attachment.get("file_id") or attachment.get("revision"):
            raise LibraryError("新文件不能指定已有资料编号。")
        if mode == "existing":
            chosen = next((v for v in item["versions"] if v["id"] == attachment.get("version_id")), None)
            if not chosen:
                raise LibraryError("请选择具体文件版本。")
            library.verified(chosen)
            key = (item["id"], chosen["id"])
        else:
            value, data = uploads.bytes(attachment.get("upload_id"), matter)
            key = ("upload", value["upload_id"])
            payload = {k: attachment[k] for k in version - {"upload_id"} if k in attachment}
            if mode == "upload":
                payload.update(title=attachment.get("title"), category=attachment.get("category", "other"),
                               agreement_type=attachment.get("agreement_type", "unspecified"), organization=party["name"],
                               home_counterparty_id=project["primary_counterparty_id"], project_ids=[matter])
            payload.update(filename=value["filename"], data=base64.b64encode(data).decode())
            # Sequential candidate revisions allow two versions of one file without hiding external changes.
            candidate = next((v for v in index_from(files)["files"] if item and v["id"] == item["id"]), None)
            files, identity, _, pending = library.prepare({"operation": "upload", "id": item["id"] if item else "",
                                                          "revision": digest(candidate) if candidate else None, "payload": payload}, files)
            writes.extend(pending)
            item = next(v for v in index_from(files)["files"] if v["id"] == identity)
            chosen = item["versions"][-1]
        if key in seen:
            raise LibraryError("同一次保存不能重复添加相同附件。")
        seen.add(key)
        index = index_from(files)
        live = next(v for v in index["files"] if v["id"] == item["id"])
        if not any(r["project_id"] == matter and r.get("event_id") == progress and r["version_id"] == chosen["id"] for r in live["records"]):
            live["records"].append({"id": "use-" + uuid.uuid4().hex, "kind": "reference", "date": date,
                                    "project_id": matter, "event_id": progress, "version_id": chosen["id"],
                                    "people": [], "channel": "", "note": ""})
        files = {**files, "files.yaml": dump(index)}
        result.append({"mode": mode, "file_id": live["id"], "title": live["title"], "version_id": chosen["id"],
                       "version_number": len(live["versions"]) if mode != "existing" else live["versions"].index(chosen) + 1,
                       **{k: chosen.get(k, "") for k in ("filename", "size", "sha256", "status", "note", "agreement_date", "signing_completed_date")},
                       **({"upload_id": attachment["upload_id"]} if mode != "existing" else {})})
    check_index(files)
    return files, writes, result
