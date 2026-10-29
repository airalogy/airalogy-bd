"""Explicitly authorized multi-record business intake, planned before one atomic save.

Plans are private, account/credential-bound and short lived. Candidate files come
only from the normal data service, never from caller-supplied paths or file text.
"""
import json
import re
import secrets
import time

from content_paths import counterparties, name_key
from file_library import FileLibrary
from staged_uploads import UploadStore
from team_auth import AuthError


def require_intake(actor, token):
    if actor["role"] != "admin" or not token["can_intake"] or not token["can_draft"]:
        raise AuthError("此连接尚未获准新建事项及维护人员、对接方档案，请在“我的账号”中明确授权。")


class Intake:
    def __init__(self, remote, actor, token):
        self.remote, self.workspace, self.db = remote, remote.workspace, remote.db
        self.actor, self.token = actor, token

    def read(self, identity):
        require_intake(self.actor, self.token)
        row = self.db.execute("SELECT * FROM remote_intakes WHERE id=?", (identity,)).fetchone()
        if not row or row["owner"] != self.actor["id"] or row["token_id"] != self.token["id"] or row["binding"] != self.actor["revision"] or row["expires"] <= int(time.time()):
            raise AuthError("录入方案已失效或不属于此连接，请重新查询后准备。", "conflict")
        return row, json.loads(row["value"])

    def authorize_upload(self, identity, matter):
        _, plan = self.read(identity)
        if plan["matter_id"] != matter or not plan.get("progress_id"):
            raise AuthError("上传必须关联此录入方案中的进展。")

    def prepare(self, args):
        from remote_access import exact, text, PROGRESS_FIELDS
        from workspace_service import digest, parse_yaml, PROJECT_FIELDS, PERSON_FIELDS, LABELS
        require_intake(self.actor, self.token)
        exact(args, {"operations"}, {"operations"})
        operations = args["operations"]
        if not isinstance(operations, list) or not 1 <= len(operations) <= 12:
            raise AuthError("一次录入须包含 1–12 项修改。", "invalid")
        if self.db.execute("SELECT COUNT(*) FROM remote_intakes WHERE owner=?", (self.actor["id"],)).fetchone()[0] >= 20:
            raise AuthError("录入方案过多，请移除不用的方案或等待到期。", "rate_limited")
        before = self.workspace.read_files()
        files, refs, changes, records, seen = dict(before), {}, [], [], set()
        target_matter, target_progress = "", ""
        def resolve(value):
            if isinstance(value, str) and value.startswith("@"):
                if value[1:] not in refs:
                    raise AuthError("引用的记录尚未创建，请按人员、对接方、事项、进展的顺序排列。", "invalid")
                return refs[value[1:]]
            if isinstance(value, list): return [resolve(v) for v in value]
            if isinstance(value, dict): return {k: resolve(v) for k, v in value.items()}
            return value
        for index, operation in enumerate(operations):
            exact(operation, {"ref", "kind", "id", "matter_id", "revision", "changes"}, {"ref", "kind", "changes"})
            ref = text(operation["ref"], 40)
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", ref) or ref in refs:
                raise AuthError("每项修改需要唯一的英文引用名。", "invalid")
            kind = {"matter": "project"}.get(operation["kind"], operation["kind"])
            if kind not in {"person", "counterparty", "project", "progress"}:
                raise AuthError("仅支持人员、对接方、事项和沟通进展。", "invalid")
            identity = resolve(text(operation.get("id", ""), 160, True))
            matter = resolve(text(operation.get("matter_id", ""), 160, True))
            if kind != "progress" and matter:
                raise AuthError("只有沟通进展需要 matter_id。", "invalid")
            if identity and identity not in {v for v in refs.values()} and not self.workspace.record(before, kind, identity, matter):
                raise AuthError("指定记录不存在，请先查询。", "not_found")
            current = self.workspace.record(files, kind, identity, matter) if identity else None
            if identity and not current: raise AuthError("指定记录不存在。", "not_found")
            if identity and (kind, identity) in seen:
                raise AuthError("同一方案不能重复修改同一记录。", "invalid")
            if identity:
                expected = self.workspace.record_revision(before, kind, identity, matter)
                if operation.get("revision") != expected:
                    raise AuthError("资料已变化，请重新读取记录及版本。", "conflict")
            elif operation.get("revision") is not None:
                raise AuthError("新记录不接受已有版本号。", "invalid")
            allowed = PERSON_FIELDS if kind == "person" else {"name", "short_name", "kind", "body", "people"} if kind == "counterparty" else PROJECT_FIELDS | {"body", "contacts", "initial_event"} if kind == "project" else PROGRESS_FIELDS | {"new_contacts"}
            exact(operation["changes"], allowed)
            if not operation["changes"]: raise AuthError("请填写实际修改内容。", "invalid")
            patch = dict(operation["changes"])
            # Resolve references only in relational fields, never in business prose.
            for key in {"primary_counterparty_id", "counterparty_ids", "owner", "sourced_by", "people", "participants"} & patch.keys():
                patch[key] = resolve(patch[key])
            for key in {"contacts", "new_contacts"} & patch.keys():
                if not isinstance(patch[key], list): raise AuthError("联系人关系须为列表。", "invalid")
                for relation in patch[key]:
                    exact(relation, {"person_id", "side", "project_roles", "notes"}, {"person_id", "side", "project_roles", "notes"})
                patch[key] = [{**r, "person_id": resolve(r["person_id"])} for r in patch[key]]
            if "initial_event" in patch:
                exact(patch["initial_event"], PROGRESS_FIELDS)
                patch["initial_event"] = {**patch["initial_event"], "participants": resolve(patch["initial_event"].get("participants", []))}
            if kind == "person":
                previous = current or {"name": "", "affiliation": "", "phone": "", "wechat": "", "email": ""}
                # Reject case/spacing variants of known identities rather than guessing a merge.
                if not current and any(name_key(p["name"]) == name_key(patch.get("name", "")) for p in parse_yaml(files["people.yaml"])["people"]):
                    raise AuthError("同名人员已存在，请查询并明确选择已有档案。", "duplicate")
            elif kind == "counterparty":
                previous = {**current["metadata"], "body": current["body"], "people": current["people"]} if current else {"kind": "organization", "short_name": "", "people": [], "body": ""}
                if not current:
                    names = {name_key(v[1].get(k) or "") for v in counterparties(files).values() for k in ("name", "short_name")}
                    if any(name_key(patch.get(k) or "") in names for k in ("name", "short_name") if patch.get(k)):
                        raise AuthError("同名或同简称对接方已存在，请先查询并明确选择。", "duplicate")
                    identity = self.workspace.ensure_counterparty(files, patch.get("name"), patch.get("kind", "organization"))
            elif kind == "project":
                previous = {**current["metadata"], "body": current["body"], "contacts": current["contacts"]} if current else {
                    "counterparty_ids": [], "record_type": "cooperation", "category": ["待分类"], "stage": "initial_contact", "relationship": "active", "priority": "medium", "owner": "待确认", "first_contact": None,
                    "first_contact_certainty": "unknown", "sourced_by": [], "source_certainty": "unknown", "source_note": "未记录", "follow_up_status": "active_progress", "next_action": "待明确", "next_action_due": None, "body": "", "contacts": []}
                if current and "initial_event" in patch: raise AuthError("已有事项请使用 progress 操作记录进展。", "invalid")
                if not (patch.get("primary_counterparty_id") or previous.get("primary_counterparty_id")):
                    raise AuthError("请明确选择归档对接方，或引用本方案新建的对接方。", "invalid")
            else:
                if not matter: raise AuthError("沟通进展需要指定事项。", "invalid")
                previous = self.remote.progress_fields(current) if current else {"date": "", "type": "other", "title": "", "summary": "", "importance": "normal", "participants": [], "body": "", "location": ""}
            payload = {**previous, **patch}
            if kind == "project" and not current:
                initial = payload.get("initial_event")
                if not isinstance(initial, dict): raise AuthError("新事项必须一起提供首条实际进展。", "invalid")
                payload["initial_event"] = {"type": "other", "importance": "normal", "participants": [], "body": "", "location": "", **initial}
            result = self.workspace.save({"kind": kind, "id": identity, "project_id": matter,
                "revision": self.workspace.record_revision(files, kind, identity, matter), "payload": payload}, candidate=files)
            files, identity = result["files"], result["id"]
            seen.add((kind, identity)); refs[ref] = identity
            if kind == "project":
                if target_matter and target_matter != identity: raise AuthError("一次方案只能处理一个事项。", "invalid")
                target_matter = identity
                if not current: target_progress = self.workspace.record(files, kind, identity)["events"][0]["id"]
            elif kind == "progress":
                if (target_matter and target_matter != matter) or target_progress:
                    raise AuthError("一次方案只能处理一个事项和一条进展。", "invalid")
                target_matter, target_progress = matter, identity
            label = {"person": "人员", "counterparty": "对接方", "project": "事项", "progress": "进展"}[kind] + "：" + result["title"]
            records.append({"kind": kind, "id": identity, "matter_id": matter, "name": result["title"], "created": current is None})
            changes.extend({"field": f"{index}.{k}", "label": label + " · " + LABELS.get(k, k), "before": previous.get(k) if current else None, "after": v} for k, v in payload.items() if k != "id" and (not current or previous.get(k) != v))
        if files == before: raise AuthError("内容没有变化，无需保存。", "invalid")
        errors, _ = self.workspace.stage(files)
        if errors: raise AuthError("资料校验未通过，请检查必填信息、日期、联系人关系和正文。", "invalid")
        matter_record = self.workspace.record(files, "project", target_matter) if target_matter else None
        progress_record = self.workspace.record(files, "progress", target_progress, target_matter) if target_progress else None
        review = {"operation": "intake", "matterId": target_matter, "matterName": matter_record["metadata"]["name"] if matter_record else "业务档案维护", "counterparty": "", "progressTitle": progress_record["event"]["title"] if progress_record else "", "progressDate": progress_record["event"]["date"] if progress_record else "", "changes": changes}
        if matter_record:
            review["counterparty"] = counterparties(files)[matter_record["metadata"]["primary_counterparty_id"]][1]["name"]
        identity, expires = secrets.token_hex(16), min(int(time.time()) + 86400, self.token["expires"])
        plan = {"base": digest(before), "delta": {k: v for k, v in files.items() if before.get(k) != v}, "removed": sorted(set(before) - set(files)), "matter_id": target_matter, "progress_id": target_progress, "records": records, "references": refs, "review": review}
        with self.db:
            self.db.execute("INSERT INTO remote_intakes VALUES(?,?,?,?,?,?)", (identity, self.actor["id"], self.token["id"], self.actor["revision"], json.dumps(plan, ensure_ascii=False), expires))
        return {"intake_id": identity, "expires": expires, "references": refs, "matter_id": target_matter, "progress_id": target_progress, "review": review, "status": "prepared", "message": "方案尚未保存。核对后可附加上传文件，再提交草稿；明确获准直接保存的连接可正式保存。"}

    def save(self, request, preview=False):
        from workspace_service import digest
        from progress_files import attach_progress
        row, plan = self.read(request["intake_id"])
        before = self.workspace.read_files()
        if digest(before) != plan["base"]:
            raise AuthError("准备方案后工作区已有更新，请重新查询并准备，避免覆盖他人的修改。", "conflict")
        files = {k: v for k, v in {**before, **plan["delta"]}.items() if k not in plan["removed"]}
        attachments = request.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > 10 or (attachments and not plan["progress_id"]):
            raise AuthError("最多 10 个附件，且必须关联本次方案的进展。", "invalid")
        writes, attached = [], []
        if attachments:
            # Candidate matter is authorized only within this admin's explicit intake scope.
            self.workspace.policy.allowed.add(plan["matter_id"])
            event = self.workspace.record(files, "progress", plan["progress_id"], plan["matter_id"])["event"]
            files, writes, attached = attach_progress(self.workspace, files, plan["matter_id"], plan["progress_id"], event["date"], attachments)
        errors, _ = self.workspace.stage(files, verify_attachments=not bool(attachments))
        if errors: raise AuthError("资料校验未通过，请重新准备录入方案。", "invalid")
        if preview: return {"valid": True, "attachments": attached, "review": plan["review"]}
        for relative, data in writes: FileLibrary(self.workspace).put(relative, data)
        result = self.workspace.commit(before, files, "外部工具录入：" + plan["review"]["matterName"], "form")
        for attachment in attachments:
            if attachment.get("upload_id"): UploadStore(self.workspace).remove(attachment["upload_id"])
        with self.db: self.db.execute("DELETE FROM remote_intakes WHERE id=?", (row["id"],))
        return {"status": "saved", "matter_id": plan["matter_id"], "progress_id": plan["progress_id"], "records": plan["records"],
                "references": plan["references"], "history_version": result["status"]["version"], "attachments": attached,
                "message": "业务资料及附件已一并正式保存，并留存修改历史。"}
