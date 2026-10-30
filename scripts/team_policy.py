"""Deny-by-default server authorization and redaction before data leaves Python."""
import copy

from team_auth import AuthError


class Policy:
    def __init__(self, workspace, actor):
        self.workspace, self.actor = workspace, actor
        self.admin = actor["role"] == "admin"
        self.allowed = set(workspace.projects(workspace.read_files())) if actor["all_projects"] else set(actor["project_ids"])

    def project(self, identity):
        if identity not in self.allowed:
            raise AuthError("你没有访问这条事项的权限。")

    def file_allowed(self, item):
        return bool(item.get("project_ids")) and set(item["project_ids"]).issubset(self.allowed)

    def file(self, identity, files=None):
        from file_library import index_from
        item = next((x for x in index_from(files or self.workspace.read_files())["files"] if x["id"] == identity), None)
        if not item or not self.file_allowed(item):
            raise AuthError("你没有访问这份资料的权限。")
        return item

    def references(self, payload, new_people=()):
        if self.actor["all_projects"]:
            return
        from file_library import index_from
        files = self.workspace.read_files()
        people, parties = set(), set()
        for identity in self.allowed:
            record = self.workspace.record(files, "project", identity)
            if not record:
                continue
            parties.update(record["metadata"].get("counterparty_ids", []))
            people.update(record["metadata"].get("sourced_by", []))
            people.update(c["person_id"] for c in record["contacts"])
            people.update(p for e in record["events"] for p in e.get("participants", []))
        people.update(p for f in index_from(files)["files"] if self.file_allowed(f) for r in f["records"] for p in r["people"])
        people.update(p["id"] for p in new_people)
        supplied = list(payload.get("participants", [])) + list(payload.get("sourced_by", [])) + list(payload.get("people", []))
        supplied += [c.get("person_id") for c in payload.get("contacts", []) + payload.get("new_contacts", [])]
        linked = list(payload.get("counterparty_ids", []))
        linked += [payload[k] for k in ("home_counterparty_id", "primary_counterparty_id") if payload.get(k)]
        if any(x not in people for x in supplied) or any(x not in parties for x in linked):
            raise AuthError("只能关联有权查看的人员和对接方，或随本次进展新增人员；其他关联请联系管理员。")

    def authorize(self, request):
        action = "save" if request.get("action") == "preview" else request.get("action")
        # Opening a server-side Finder or arbitrary backup directories is never a web operation.
        if action in {"file_location", "file_normalize_paths", "restore_backup", "migrate_layout", "backup_tick"}:
            raise AuthError("此操作仅可由服务器维护人员执行。")
        if action in {"upload_stage", "upload_discard"}:
            if self.actor["role"] == "viewer":
                raise AuthError("只读成员不能上传文件。")
            if action == "upload_stage":
                self.project(request.get("project_id"))
            return
        if self.admin:
            return
        if action in {"workspace", "files"}:
            return
        if action == "file_download":
            self.file(request.get("id"))
            if request.get("snapshot"):
                raise AuthError("历史版本资料由管理员查看。")
            return
        if action == "record":
            kind = request.get("kind")
            if kind in {"project", "progress"}:
                self.project(request.get("project_id") if kind == "progress" else request.get("id"))
                return
            raise AuthError("人员总库和共享档案由管理员维护。")
        if action in {"save", "file_save"} and self.actor["role"] == "editor":
            payload = request.get("payload") or {}
            if not isinstance(payload, dict):
                raise AuthError("资料格式无效。", "invalid")
            if action == "save":
                kind = request.get("kind")
                if kind not in {"project", "progress"}:
                    raise AuthError("共享档案和公司动态由管理员维护。")
                self.project(request.get("project_id") if kind == "progress" else request.get("id"))
                if kind != "progress" and payload.get("new_people"):
                    raise AuthError("只能随获授权事项的进展新增人员。")
                new_people = self.workspace.new_progress_people(self.workspace.read_files(), payload) if kind == "progress" else []
                self.references(payload, new_people)
                # An editor cannot create global counterparties via a project save.
                if payload.get("additional_counterparties") or payload.get("new_counterparty"):
                    raise AuthError("新对接方由管理员创建。")
                return
            if payload.get("new_people"):
                raise AuthError("只能随获授权事项的进展新增人员。")
            self.references(payload)
            item = self.file(request["id"]) if request.get("id") else None
            links = payload.get("project_ids", item["project_ids"] if item else [])
            if not isinstance(links, list) or not links or any(not isinstance(x, str) or x not in self.allowed for x in links):
                raise AuthError("资料只能关联你获授权的事项。")
            if request.get("operation") == "usage":
                self.project(payload.get("project_id"))
            return
        raise AuthError("你没有执行此操作的权限。")

    def dashboard(self, data):
        if not data:
            return data
        result = copy.deepcopy(data)
        result["access"] = {"server": True, "role": self.actor["role"], "name": self.actor["name"], "all_projects": self.actor["all_projects"]}
        if self.admin:
            return result
        result["projects"] = [x for x in result["projects"] if x["id"] in self.allowed]
        result["files"] = [x for x in result.get("files", []) if self.file_allowed(x)]
        if not self.actor["all_projects"]:
            result["company_events"] = []
            parties = {x for p in result["projects"] for x in p["counterparty_ids"]}
            people = {c["person_id"] for p in result["projects"] for c in p["contacts"]}
            people.update(x for p in result["projects"] for x in p.get("sourced_by", []))
            people.update(x for p in result["projects"] for e in p["events"] for x in e["participants"])
            people.update(x for f in result["files"] for r in f["records"] for x in r["people"])
            result["people"] = [x for x in result["people"] if x["id"] in people]
            for person in result["people"]:
                person["projects"] = [x for x in person["projects"] if x["project_id"] in self.allowed]
                person["last_activity"] = max((x["last_activity"] for x in person["projects"] if x.get("last_activity")), default=None)
            result["counterparties"] = [x for x in result["counterparties"] if x["id"] in parties]
            for party in result["counterparties"]:
                party["matter_ids"] = [x for x in party["matter_ids"] if x in self.allowed]
                party["people"] = [x for x in party["people"] if x in people]
                party["related_people"] = [x for x in party["related_people"] if x in people]
                party["body"] = ""  # Shared notes may refer to another, restricted matter.
            result["updated_at"] = max((p["last_activity"] for p in result["projects"] if p.get("last_activity")), default=None)
        return result

    def result(self, request, result):
        action = request.get("action")
        if not self.admin and result.get("status", {}).get("errors"):
            result["status"]["errors"] = ["部分资料需要管理员检查。"]
        if action == "workspace":
            result["data"] = self.dashboard(result.get("data"))
            result["csrf"] = self.actor["csrf"]
            result["user"] = self.actor
        elif action == "files" and not self.admin:
            result["files"] = [x for x in result["files"] if self.file_allowed(x)]
            result["workspace_directory"] = ""
        elif action == "historical":
            result["data"] = self.dashboard(result["data"])
        return result
