"""Independent progress-linked Markdown supplements, under the existing workspace lock."""
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from team_auth import AuthError

FIELDS = {"title", "date", "body"}
READS = {"list", "read", "history", "version"}
ID = re.compile(r"supp-[0-9a-f]{32}")


def records(files, directory, event_id=None):
    from workspace_service import parse_md
    result = []
    prefix = directory + "/supplements/"
    for path, text in files.items():
        if path.startswith(prefix) and path.endswith(".md"):
            metadata, body = parse_md(text)
            if event_id is None or metadata.get("event_id") == event_id:
                result.append({**metadata, "body": body})
    return sorted(result, key=lambda item: (item["date"], item["created_at"], item["id"]))


def validate(files, projects):
    from workspace_service import ServiceError, Workspace, parse_yaml
    for project, (directory, _, _) in projects.items():
        events = {e["id"]: e for e in parse_yaml(files[directory + "/events.yaml"])["events"]}
        for item in records(files, directory):
            identity = item.get("id", "")
            if not ID.fullmatch(identity) or directory + "/supplements/" + identity + ".md" not in files:
                raise ServiceError("补充记录标识或保存位置无效。")
            if item.get("event_id") not in events:
                raise ServiceError("补充记录必须关联所属事项中的沟通进展。")
            Workspace.check_date(item.get("date"))
            if not isinstance(item.get("title"), str) or len(item["title"]) > 120 or not isinstance(item.get("body"), str) or not item["body"].strip() or len(item["body"]) > 50000:
                raise ServiceError("补充记录标题或正文格式无效。")
            for field in ("author", "updated_by"):
                actor = item.get(field)
                if not isinstance(actor, dict) or set(actor) != {"id", "name"} or not all(isinstance(v, str) and v for v in actor.values()):
                    raise ServiceError("补充记录缺少实际操作账号。")
            for field in ("created_at", "updated_at"):
                try:
                    if not datetime.fromisoformat(item[field]).tzinfo: raise ValueError()
                except (KeyError, TypeError, ValueError):
                    raise ServiceError("补充记录保存时间无效。")


class Supplements:
    def __init__(self, workspace):
        self.workspace = workspace

    def authorize(self, request):
        op = request.get("operation", "list")
        if op not in READS | {"save", "migrate"}:
            raise AuthError("未知的补充记录操作。", "invalid")
        policy = self.workspace.policy
        if policy:
            if not (policy.admin and op in READS and request.get("snapshot")):
                policy.project(request.get("project_id"))
            if op not in READS and policy.actor["role"] == "viewer":
                raise AuthError("只读成员不能编辑补充记录。")
            if op == "migrate" and not policy.admin:
                raise AuthError("迁移已有进展由管理员操作。")
        if op not in READS and (request.get("snapshot") or request.get("version")):
            raise AuthError("历史补充只供查看，请返回当前记录编辑。", "invalid")

    def context(self, files, request):
        from workspace_service import ServiceError
        from recycle_bin import require_active
        require_active(files, request.get("project_id"), request.get("event_id", ""))
        matter = self.workspace.projects(files).get(request.get("project_id"))
        event = self.workspace.record(files, "progress", request.get("event_id"), request.get("project_id")) if matter else None
        if not event:
            raise ServiceError("未找到所属事项中的沟通进展。", "not_found")
        return matter, event

    def read(self, request, files=None):
        from workspace_service import digest, ServiceError
        files = files if files is not None else self.workspace.read_files()
        matter, event = self.context(files, request)
        items = records(files, matter[0], request["event_id"])
        identity = request.get("id", "")
        if identity:
            found = next((item for item in items if item["id"] == identity), None)
            if not found: raise ServiceError("未找到这条补充记录。", "not_found")
            return {"record": found, "revision": digest(found)}
        return {"items": items, "revision": digest(items), "progress_title": event["event"]["title"]}

    def execute(self, request, *, preview=False):
        from workspace_service import ServiceError, digest, markdown, replace_item
        self.authorize(request)
        workspace = self.workspace
        op = request.get("operation", "list")
        if op in {"list", "read"}:
            return self.read(request, workspace.version_files(request["snapshot"]) if request.get("snapshot") else None)
        if op in {"history", "version"}:
            current = self.read(request, workspace.version_files(request["snapshot"]) if request.get("snapshot") else None)
            if "record" not in current: raise ServiceError("请选择一条补充。")
            entries = workspace.history_entries({"kind": "supplement", "id": request["id"]})
            # Return only versions containing this exact record in this authorized matter.
            versions = []
            ceiling = request.get("snapshot")
            allowed = None
            if ceiling:
                self.read(request, workspace.version_files(ceiling))
                if not re.fullmatch(r"local:[0-9a-f]{40,64}", ceiling): return {"versions": []}
                allowed = set(workspace.git("rev-list", ceiling.split(":", 1)[1]).splitlines())
            for version in entries:
                if not version["version"].startswith("local:") or (allowed is not None and version["version"].split(":", 1)[1] not in allowed): continue
                if op == "version" and version["version"] != request.get("version"): continue
                try:
                    record = self.read(request, workspace.version_files(version["version"]))["record"]
                except ServiceError: continue
                safe = {key: version[key] for key in ("version", "at", "label")}
                safe["actor"] = {key: version["actor"][key] for key in ("id", "name")} if version.get("actor") else None
                if op == "version": return {"record": record, "version": safe}
                versions.append(safe)
            if op == "version": raise ServiceError("未找到这条补充的历史版本。", "not_found")
            try: offset = int(request.get("offset", 0))
            except (TypeError, ValueError): raise ServiceError("页码无效。")
            if offset < 0: raise ServiceError("页码无效。")
            return {"versions": versions[offset:offset + 40], "has_more": len(versions) > offset + 40}
        actor = workspace.actor or {"id": "local", "name": "本地操作"}
        actor = {key: actor[key] for key in ("id", "name")}
        request_id = request.get("request_id", "")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            raise ServiceError("请提供至少 16 位唯一请求编号。")
        receipt_path = workspace.store / "supplement-requests" / (digest([actor["id"], request_id]) + ".json")
        signature = digest(request)
        if receipt_path.exists() and not preview:
            old = json.loads(receipt_path.read_text())
            if old["signature"] != signature: raise ServiceError("同一请求编号不能用于不同内容。", "conflict")
            if old.get("result"): return old["result"]
            raise ServiceError("保存结果需要核对，请回读补充和历史，不要更换请求编号重试。", "uncertain")
        before = workspace.read_files()
        matter, progress = self.context(before, request)
        current = self.read(request, before)
        if request.get("revision") != current["revision"]:
            raise ServiceError("补充内容已变化，请读取最新版本后再保存。", "conflict")
        files = dict(before)
        payload = request.get("payload", {})
        source_id = None
        if op == "migrate":
            if request.get("id") or request.get("confirmed") is not True:
                raise ServiceError("请确认将已有补充进展迁入这条沟通进展。")
            source_id = request.get("source_id")
            source = workspace.record(before, "progress", source_id, request["project_id"])
            if not source or source_id == request["event_id"] or not source["event"]["title"].startswith("会后补充："):
                raise ServiceError("仅可迁入同一事项中标题以“会后补充：”开头的临时进展。")
            if request.get("source_revision") != workspace.record_revision(before, "progress", source_id, request["project_id"]):
                raise ServiceError("待迁入进展已变化，请重新读取。", "conflict")
            from file_library import index_from
            from investment_qa import identities, raw_record
            if any(r.get("event_id") == source_id and r.get("project_id") == request["project_id"] for f in index_from(before)["files"] for r in f["records"]) or records(before, matter[0], source_id):
                raise ServiceError("这条进展还关联资料或补充，请先保留并整理其关联。")
            # Q&A stores links in nested working and recommended revisions.
            if any(source_id in json.dumps(raw_record(before, identity), ensure_ascii=False) for identity in identities(before)):
                raise ServiceError("这条进展已被投资问答引用，请先调整来源关联。")
            payload = {"title": source["event"]["title"].removeprefix("会后补充：").strip(), "date": source["event"]["date"], "body": source["body"] or source["event"]["summary"]}
            event_path = matter[0] + "/events.yaml"
            files[event_path] = replace_item(files[event_path], "events", "id", source_id, None)
            related = source["event"].get("related_record")
            from workspace_service import parse_yaml
            if related and not any(e.get("related_record") == related for e in parse_yaml(files[event_path])["events"]):
                files.pop(matter[0] + "/" + related, None)
        if not isinstance(payload, dict) or set(payload) != FIELDS:
            raise ServiceError("补充仅接受标题、补充日期和 Markdown 正文。")
        workspace.check_date(payload["date"])
        if not isinstance(payload["title"], str) or len(payload["title"]) > 120 or not isinstance(payload["body"], str) or not payload["body"].strip() or len(payload["body"]) > 50000:
            raise ServiceError("请填写正文（最多 50000 字），标题最多 120 字。")
        identity = request.get("id") or "supp-" + uuid.uuid4().hex
        previous = current.get("record")
        if any(item["id"] != identity and item["date"] == payload["date"] and item["body"] == payload["body"].strip() for item in records(before, matter[0], request["event_id"])):
            raise ServiceError("该进展已有同日期、同正文的补充，请查看已有记录。", "duplicate")
        now = datetime.now(timezone.utc).isoformat()
        metadata = {"id": identity, "event_id": request["event_id"], "title": payload["title"].strip(), "date": payload["date"],
                    "author": previous["author"] if previous else actor, "created_at": previous["created_at"] if previous else now,
                    "updated_by": actor, "updated_at": now}
        if source_id: metadata["source_progress_id"] = source_id
        elif previous and previous.get("source_progress_id"): metadata["source_progress_id"] = previous["source_progress_id"]
        files[matter[0] + "/supplements/" + identity + ".md"] = markdown(metadata, payload["body"])
        errors, _ = workspace.stage(files)
        if errors: raise ServiceError("补充未通过资料校验。", "validation", errors)
        if preview: return {"valid": True}
        receipt_path.parent.mkdir(mode=0o700, exist_ok=True)
        workspace.atomic(receipt_path, json.dumps({"signature": signature}))
        if workspace.actor is None:
            workspace.actor = {**actor, "email": ""}
        result = workspace.commit(before, files, ("迁入补充记录：" if source_id else "修改补充记录：" if previous else "新增补充记录：") + (metadata["title"] or progress["event"]["title"]), "form")
        result.update(id=identity, revision=self.read({**request, "id": identity})["revision"])
        workspace.atomic(receipt_path, json.dumps({"signature": signature, "result": result}, ensure_ascii=False))
        return result
