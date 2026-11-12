"""Reversible visibility changes. Business source files and shared files stay intact."""
import copy
import hashlib
import json
import re
from datetime import datetime, timezone

import yaml

INDEX = "recycle-bin.yaml"


def fail(message, code="invalid"):
    from workspace_service import ServiceError
    raise ServiceError(message, code)


def operations(files):
    value = yaml.safe_load(files.get(INDEX, "operations: []"))
    if not isinstance(value, dict) or set(value) != {"operations"} or not isinstance(value["operations"], list):
        fail("回收站索引格式无效。")
    return value["operations"]


def states(files):
    return {(x["kind"], x["project_id"], x["id"]): x for x in operations(files)}


def hidden(files, project, event=""):
    state = states(files)
    return state.get(("project", project, project), {}).get("operation") == "archive" or bool(event and state.get(("progress", project, event), {}).get("operation") == "archive")


def require_active(files, project, event=""):
    if project and hidden(files, project, event):
        fail("这条记录已移入回收站，请由管理员恢复后再操作。", "archived")


def guard(files, request):
    kind = request.get("kind")
    if kind in {"project", "progress"}:
        require_active(files, request.get("project_id") if kind == "progress" else request.get("id"), request.get("id", "") if kind == "progress" else "")


def project_record(files, project, record):
    if not record:
        return record
    result = copy.deepcopy(record)
    result["events"] = [e for e in result["events"] if not hidden(files, project, e["id"])]
    paths = {e.get("related_record") for e in result["events"]}
    result["documents"] = {p: text for p, text in result["documents"].items() if p in paths}
    from workspace_service import parse_md
    result["supplements"] = {p: text for p, text in result.get("supplements", {}).items() if not hidden(files, project, parse_md(text)[0].get("event_id"))}
    return result


def file_visible(files, item):
    # A shared file remains available through its other matters. ACL still checks ALL original links.
    return any(not hidden(files, p) for p in item.get("project_ids", []))


def visible_files(files, items):
    result = []
    for item in items:
        if not file_visible(files, item):
            continue
        value = copy.deepcopy(item)
        value["records"] = [r for r in value.get("records", []) if not hidden(files, r["project_id"], r.get("event_id", ""))]
        result.append(value)
    return result


def dashboard(data, files):
    if not operations(files):
        return data
    result = copy.deepcopy(data)
    result["projects"] = [p for p in result["projects"] if not hidden(files, p["id"])]
    for p in result["projects"]:
        p["events"] = [e for e in p["events"] if not hidden(files, p["id"], e["id"])]
        # An empty matter has no business-activity date, rather than the deletion date.
        p["last_activity"] = max((e["date"] for e in p["events"]), default="")
        for c in p["contacts"]:
            c["last_activity"] = max((e["date"] for e in p["events"] if c["person_id"] in e["participants"]), default="")
    projects = {p["id"]: p for p in result["projects"]}
    for person in result["people"]:
        person["projects"] = [p for p in person["projects"] if p["project_id"] in projects]
        for p in person["projects"]:
            c = next((c for c in projects[p["project_id"]]["contacts"] if c["person_id"] == person["id"]), None)
            p["last_activity"] = c["last_activity"] if c else None
        person["last_activity"] = max((p["last_activity"] for p in person["projects"] if p["last_activity"]), default=None)
    for party in result["counterparties"]:
        related = [p for p in projects.values() if party["id"] in p["counterparty_ids"]]
        party["matter_ids"] = [p["id"] for p in related]
        party["related_people"] = sorted(set(party["people"]) | {c["person_id"] for p in related for c in p["contacts"]})
    result["files"] = visible_files(files, result.get("files", []))
    result["updated_at"] = max([p["last_activity"] for p in projects.values() if p["last_activity"]] + [e["date"] for e in result["company_events"]], default=None)
    return result


def validate(files, projects):
    seen, current = set(), {}
    for row in operations(files):
        fields = {"kind", "project_id", "id", "operation", "at", "actor", "request_id", "fingerprint"}
        if not isinstance(row, dict) or set(row) != fields or row["kind"] not in {"project", "progress"} or row["operation"] not in {"archive", "restore"}:
            fail("回收站操作记录无效。")
        if any(not isinstance(row[k], str) or not row[k] for k in fields - {"actor"}):
            fail("回收站操作字段无效。")
        actor = row["actor"]
        if not isinstance(actor, dict) or set(actor) != {"id", "name"} or any(not isinstance(v, str) or not v for v in actor.values()):
            fail("回收站操作账号无效。")
        datetime.fromisoformat(row["at"])
        key = (row["kind"], row["project_id"], row["id"])
        if row["kind"] == "project" and row["project_id"] != row["id"]:
            fail("回收站事项关联无效。")
        matter = projects.get(row["project_id"])
        if not matter or (row["kind"] == "progress" and not any(e["id"] == row["id"] for e in yaml.safe_load(files[matter[0] + "/events.yaml"])["events"])):
            fail("回收站原始记录缺失，不能保存。")
        receipt = (actor["id"], row["request_id"])
        if receipt in seen or current.get(key, "restore") == row["operation"]:
            fail("回收站操作重复或顺序无效。")
        seen.add(receipt)
        current[key] = row["operation"]


class RecycleBin:
    def __init__(self, workspace):
        self.workspace = workspace

    def authorize(self):
        from team_auth import AuthError
        if self.workspace.policy and not self.workspace.policy.admin:
            raise AuthError("仅管理员可以查看回收站、移入和恢复记录。")

    def describe(self, files, request):
        from file_library import index_from
        from progress_supplements import records
        from workspace_service import digest
        kind, identity = request.get("kind"), request.get("id")
        if kind not in {"project", "progress"} or not isinstance(identity, str) or not identity:
            fail("请选择要处理的事项或沟通进展。")
        project = identity if kind == "project" else request.get("project_id")
        record = self.workspace.record(files, kind, identity, project)
        matter = self.workspace.projects(files).get(project)
        if not record or not matter:
            fail("未找到这条记录。", "not_found")
        linked = [f for f in index_from(files)["files"] if project in f["project_ids"] and (kind == "project" or any(r.get("event_id") == identity and r.get("project_id") == project for r in f["records"]))]
        children = records(files, matter[0], identity if kind == "progress" else None)
        history = [x for x in operations(files) if x["kind"] == kind and x["project_id"] == project and x["id"] == identity]
        archived = bool(history and history[-1]["operation"] == "archive")
        return {"kind": kind, "id": identity, "project_id": project, "title": record["metadata"]["name"] if kind == "project" else record["event"]["title"], "matter_name": matter[1]["name"], "archived": archived,
                "parent_archived": kind == "progress" and hidden(files, project), "history": history,
                "counts": {"progress": len(record["events"]) if kind == "project" else 1, "attachments": len(linked), "supplements": len(children)},
                "revision": digest({"record": record, "linked": linked, "supplements": children, "operations": [x for x in operations(files) if x["project_id"] == project]})}

    def execute(self, request):
        self.authorize()
        from workspace_service import dump
        files = self.workspace.read_files()
        op = request.get("operation", "list")
        if op == "list":
            items = [self.describe(files, x) for x in states(files).values()]
            return {"items": sorted(items, key=lambda x: x["history"][-1]["at"], reverse=True)}
        if op not in {"preview", "read", "archive", "restore"}:
            fail("未知的回收站操作。")
        if op in {"preview", "read"}:
            item = self.describe(files, request)
            if op == "read":
                item["record"] = self.workspace.record(files, item["kind"], item["id"], item["project_id"])
                if item["kind"] == "progress":
                    from workspace_service import parse_yaml
                    record = item["record"]
                    participants = list(record["event"].get("participants", []))
                    groups = record["document"].get("participants", {})
                    participants += [p for group in groups.values() for p in group] if isinstance(groups, dict) else groups
                    people = {p["id"]: p["name"] for p in parse_yaml(files["people.yaml"])["people"]}
                    item["participant_names"] = [people.get(p, p) for p in dict.fromkeys(participants)]
                    from progress_supplements import records
                    item["supplements"] = records(files, self.workspace.projects(files)[item["project_id"]][0], item["id"])
            return item
        if request.get("confirmed") is not True:
            fail("请先核对影响范围并确认。")
        actor = self.workspace.actor or {"id": "local", "name": "本地操作"}
        request_id = request.get("request_id", "")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
            fail("请提供唯一操作编号。")
        signature = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        existing = next((x for x in operations(files) if x["actor"]["id"] == actor["id"] and x["request_id"] == request_id), None)
        if existing:
            if existing["fingerprint"] != signature:
                fail("操作编号已用于其他内容。", "conflict")
            return {"saved": True, "replayed": True, "message": "本次操作已完成，无需重复提交。"}
        item = self.describe(files, request)
        if item["revision"] != request.get("revision"):
            fail("记录或关联资料已有变化，请重新核对后操作。", "conflict")
        if item["parent_archived"]:
            fail("请先恢复所属事项，再处理这条进展。", "archived")
        if item["archived"] == (op == "archive"):
            fail("回收站状态已变化，请刷新后操作。", "conflict")
        row = {k: item[k] for k in ("kind", "id", "project_id")}
        row.update(operation=op, at=datetime.now(timezone.utc).isoformat(), actor={k: actor[k] for k in ("id", "name")}, request_id=request_id, fingerprint=signature)
        after = {**files, INDEX: dump({"operations": operations(files) + [row]})}
        label = ("移入回收站：" if op == "archive" else "从回收站恢复：") + item["title"]
        result = self.workspace.commit(files, after, label, "form")
        return {**result, "message": "已移入回收站，可由管理员恢复。" if op == "archive" else "已恢复记录。", "id": item["id"]}
