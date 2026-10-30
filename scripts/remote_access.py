"""Optional, user-bound remote tools. All entry points run under the workspace lock.

External credentials can query or propose; administrators may explicitly issue
progress-write credentials. Browser confirmation remains separate from direct saves.
Keep transient access in the private account database, excluded from account backups.
"""
import hashlib
import json
import re
import secrets
import time

from team_auth import AuthError, fingerprint, public_user
from team_policy import Policy
from content_paths import counterparties
from file_library import LibraryError, index_from
from staged_uploads import UploadStore
from remote_intake import Intake, require_intake
from remote_qa import TOOLS as QA_TOOLS, require_qa, tool as qa_tool
from investment_qa import InvestmentQA

MATTER_FIELDS = {"body", "stage", "follow_up_status", "next_action", "next_action_due"}
PROGRESS_FIELDS = {"date", "type", "title", "summary", "importance", "participants", "body", "location"}
PROGRESS_INPUT_FIELDS = PROGRESS_FIELDS | {"new_people", "new_contacts"}
LABELS = {"body": "正文", "stage": "阶段", "follow_up_status": "跟进状态", "next_action": "下一步",
          "next_action_due": "下一步日期", "date": "实际日期", "type": "进展类型", "title": "标题",
          "summary": "摘要", "importance": "重要程度", "participants": "参与人", "location": "地点",
          "new_people": "新增人员档案", "new_contacts": "新增事项关系"}


def text(value, maximum=160, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise AuthError("输入格式或长度不正确。", "invalid")
    return value


def exact(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise AuthError("包含不支持的字段或缺少必要字段。", "invalid")


class RemoteAccess:
    def __init__(self, workspace, accounts):
        self.workspace, self.accounts, self.db = workspace, accounts, accounts.db
        self.db.executescript("""
            PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS remote_intakes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, token_id TEXT NOT NULL,
                binding TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS remote_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, revision TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS remote_grants (owner TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS remote_tokens (id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
                binding TEXT NOT NULL, label TEXT NOT NULL, can_draft INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS remote_drafts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, token_id TEXT NOT NULL,
                binding TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, matter TEXT NOT NULL,
                value TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
                UNIQUE(token_id,request_id));
            CREATE TABLE IF NOT EXISTS remote_attempts (owner TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS remote_writes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, token_id TEXT NOT NULL,
                binding TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, matter TEXT NOT NULL,
                state TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
                UNIQUE(token_id,request_id));
        """)
        if "can_save" not in {row["name"] for row in self.db.execute("PRAGMA table_info(remote_tokens)")}:
            self.db.execute("ALTER TABLE remote_tokens ADD COLUMN can_save INTEGER NOT NULL DEFAULT 0")
        if "can_intake" not in {row["name"] for row in self.db.execute("PRAGMA table_info(remote_tokens)")}:
            self.db.execute("ALTER TABLE remote_tokens ADD COLUMN can_intake INTEGER NOT NULL DEFAULT 0")
        if "can_qa" not in {row["name"] for row in self.db.execute("PRAGMA table_info(remote_tokens)")}:
            self.db.execute("ALTER TABLE remote_tokens ADD COLUMN can_qa INTEGER NOT NULL DEFAULT 0")
        with self.db:
            self.db.execute("DELETE FROM remote_intakes WHERE expires<=?", (int(time.time()),))
            self.db.execute("DELETE FROM remote_attempts WHERE at<?", (int(time.time()) - 60,))
            # Keep consumed request IDs until expiry for replay protection, but clear their contents.
            self.db.execute("DELETE FROM remote_drafts WHERE expires<=?", (int(time.time()),))
            # Direct-save receipts outlive drafts and remain until their credential expires.
            self.db.execute("DELETE FROM remote_writes WHERE expires<=?", (int(time.time()),))
            self.db.execute("DELETE FROM remote_tokens WHERE expires<=?", (int(time.time()),))

    def upload_context(self, actor, token):
        self.workspace.policy = Policy(self.workspace, actor)
        self.workspace.authorize_intake_upload = Intake(self, actor, token).authorize_upload
        self.workspace.upload_scope = {"owner": actor["id"], "binding": actor["revision"], "channel": "remote", "token": token["id"], "expires": token["expires"]}

    def settings(self):
        row = self.db.execute("SELECT enabled,revision FROM remote_settings WHERE id=1").fetchone()
        return {"enabled": bool(row["enabled"]), "revision": row["revision"]} if row else {"enabled": False, "revision": "initial"}

    def enabled(self):
        if not self.settings()["enabled"]:
            raise AuthError("远程接入尚未开启。", "unavailable")

    def grant(self, actor):
        self.enabled()
        if not self.accounts.remote_allowed(actor["id"]):
            raise AuthError("管理员尚未授权此账号使用远程接入。")

    def invalidate(self, clause="1=1", values=()):
        # Delete token hashes and proposed business text when access is revoked.
        self.db.execute(f"DELETE FROM remote_tokens WHERE {clause}", values)
        self.db.execute(f"DELETE FROM remote_drafts WHERE {clause}", values)
        self.db.execute(f"DELETE FROM remote_writes WHERE {clause}", values)
        self.db.execute(f"DELETE FROM remote_intakes WHERE {clause}", values)

    def authenticate(self, token):
        self.enabled()
        if not isinstance(token, str) or not re.fullmatch(r"bdr_[A-Za-z0-9_-]{43}", token):
            raise AuthError("远程凭据无效或已失效。", "unauthenticated")
        row = self.db.execute("SELECT * FROM remote_tokens WHERE digest=?", (fingerprint(token),)).fetchone()
        return self.token_actor(row), row

    def token_actor(self, token):
        self.enabled()
        if not token or token["expires"] <= int(time.time()):
            raise AuthError("远程凭据无效或已失效。", "unauthenticated")
        row = self.db.execute("SELECT * FROM users WHERE id=? AND active=1 AND revision=?", (token["owner"], token["binding"])).fetchone()
        if not row or not self.accounts.enrolled(row["id"]) or not self.accounts.email_allowed(row["id"]):
            raise AuthError("账号或权限已变化，请重新登录并生成凭据。", "unauthenticated")
        actor = public_user(row) | {"qa_allowed": self.accounts.qa_allowed(row["id"]), "qa_can_publish": self.accounts.qa_can_publish(row["id"])}
        self.grant(actor)
        return actor

    def ready(self):
        self.workspace.recover()
        status = self.workspace.observe()
        if status["errors"]:
            raise AuthError("工作区资料需要管理员检查。", "unavailable")

    def status(self, actor, manage=False):
        result = self.settings() | {"granted": self.accounts.remote_allowed(actor["id"]), "qa_allowed": self.accounts.qa_allowed(actor["id"])}
        result["tokens"] = [dict(row) for row in self.db.execute(
            "SELECT id,owner,label,can_draft,can_save,can_intake,can_qa,expires,created FROM remote_tokens WHERE " + ("1=1" if manage else "owner=?") + " ORDER BY created DESC",
            () if manage else (actor["id"],))]
        if manage:
            result["members"] = [{"id": row["id"], "name": row["name"], "role": row["role"], "active": bool(row["active"]),
                                  "granted": self.accounts.remote_allowed(row["id"])} for row in self.db.execute(
                "SELECT * FROM users ORDER BY name")]
        return result

    def browser(self, request, actor):
        op = request.get("operation")
        if op == "status": return self.status(actor)
        if op == "pending":
            if not self.settings()["enabled"] or not self.accounts.remote_allowed(actor["id"]) or actor["role"] == "viewer":
                return {"count": 0}
            return {"count": sum(1 for _ in self.pending_drafts(actor))}
        if op in {"settings", "configure"}:
            self.accounts.require_admin(actor)
            if op == "configure":
                if type(request.get("enabled")) is not bool or request.get("revision") != self.settings()["revision"]:
                    raise AuthError("设置已变化，请刷新后重试。", "conflict")
                with self.db:
                    self.db.execute("INSERT OR REPLACE INTO remote_settings VALUES(1,?,?)", (int(request["enabled"]), secrets.token_hex(16)))
                    if not request["enabled"]: self.invalidate()
                self.accounts.audit(actor, "remote.configure", "enabled" if request["enabled"] else "disabled")
            return self.status(actor, True)
        if op == "grant":
            self.accounts.require_admin(actor)
            identity = text(request.get("memberId"))
            member = self.db.execute("SELECT * FROM users WHERE id=?", (identity,)).fetchone()
            if type(request.get("allowed")) is not bool or not member:
                raise AuthError("成员或授权设置无效。", "invalid")
            if member["role"] == "admin":
                raise AuthError("管理员默认具备外部 AI 工具权限，无需单独授权；可在全局设置关闭接入或撤销个人凭据。", "invalid")
            before = {"remote_allowed": "允许" if self.accounts.remote_allowed(identity) else "不允许"}
            with self.db:
                self.accounts.set_remote_allowed(identity, request["allowed"])
                self.accounts.member_audit(actor, "remote.grant" if request["allowed"] else "remote.ungrant", member,
                                           before, {"remote_allowed": "允许" if request["allowed"] else "不允许"})
            return self.status(actor, True)
        if op == "issue":
            self.grant(actor)
            if "accessMode" in request and "canDraft" in request:
                raise AuthError("请只指定一种连接权限。", "invalid")
            if "canDraft" in request and type(request["canDraft"]) is not bool:
                raise AuthError("连接权限无效。", "invalid")
            mode = request.get("accessMode", "draft" if request.get("canDraft", actor["role"] != "viewer") else "read")
            if mode not in ("read", "draft", "direct"):
                raise AuthError("连接权限无效。", "invalid")
            if mode == "direct": self.accounts.require_admin(actor)
            intake = request.get("canIntake", False)
            if type(intake) is not bool or (intake and (actor["role"] != "admin" or mode == "read")):
                raise AuthError("业务档案维护仅限管理员明确授权的可写连接。", "invalid")
            can_qa = request.get("canQa", False)
            if type(can_qa) is not bool or (can_qa and not self.accounts.qa_allowed(actor["id"])):
                raise AuthError("此账号尚未获准访问投资问答库。")
            days, writable = request.get("days", 7), mode != "read"
            if type(days) is not int or not 1 <= days <= 30 or (writable and actor["role"] == "viewer"):
                raise AuthError("有效期须为 1–30 天；只读成员不能提交草稿。", "invalid")
            now = int(time.time())
            if self.db.execute("SELECT COUNT(*) FROM remote_tokens WHERE owner=? AND expires>?", (actor["id"], now)).fetchone()[0] >= 5:
                raise AuthError("最多保留 5 个有效凭据，请先撤销不再使用的凭据。", "rate_limited")
            label = text(request.get("label"), 80)
            token, identity = "bdr_" + secrets.token_urlsafe(32), secrets.token_hex(16)
            with self.db:
                self.db.execute("INSERT INTO remote_tokens(id,digest,owner,binding,label,can_draft,expires,created,can_save,can_intake,can_qa) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (identity, fingerprint(token), actor["id"], actor["revision"], label, int(writable), now + days * 86400, now, int(mode == "direct"), int(intake), int(can_qa)))
            self.accounts.audit(actor, "remote.issue_direct" if mode == "direct" else "remote.issue", identity)
            return {"id": identity, "token": token, "expires": now + days * 86400, "accessMode": mode}
        if op == "allow_qa":
            self.grant(actor)
            row=self.db.execute("SELECT * FROM remote_tokens WHERE id=? AND owner=?", (text(request.get('tokenId')),actor['id'])).fetchone()
            if not row or request.get('confirmed') is not True or not self.accounts.qa_allowed(actor['id']): raise AuthError('请本人确认允许此连接访问投资问答库。')
            self.token_actor(row)
            with self.db: self.db.execute("UPDATE remote_tokens SET can_qa=1 WHERE id=?", (row['id'],))
            self.accounts.audit(actor,'remote.allow_qa',row['id'])
            return {'allowed':True}
        if op == "allow_intake":
            self.accounts.require_admin(actor)
            self.grant(actor)
            row = self.db.execute("SELECT * FROM remote_tokens WHERE id=? AND owner=?", (text(request.get("tokenId")), actor["id"])).fetchone()
            if not row or not row["can_draft"] or request.get("confirmed") is not True:
                raise AuthError("请本人明确确认允许此连接维护业务档案。", "invalid")
            self.token_actor(row)
            with self.db: self.db.execute("UPDATE remote_tokens SET can_intake=1 WHERE id=?", (row["id"],))
            self.accounts.audit(actor, "remote.allow_intake", row["id"])
            return {"allowed": True}
        if op == "revoke":
            identity = text(request.get("tokenId"))
            row = self.db.execute("SELECT * FROM remote_tokens WHERE id=?", (identity,)).fetchone()
            if not row or (actor["role"] != "admin" and row["owner"] != actor["id"]): raise AuthError("不能撤销此凭据。")
            with self.db:
                self.db.execute("DELETE FROM remote_tokens WHERE id=?", (identity,))
                self.db.execute("DELETE FROM remote_drafts WHERE token_id=?", (identity,))
                self.db.execute("DELETE FROM remote_writes WHERE token_id=?", (identity,))
                self.db.execute("DELETE FROM remote_intakes WHERE token_id=?", (identity,))
            self.accounts.audit(actor, "remote.revoke", identity)
            return {"revoked": True}
        if op == "drafts":
            self.grant(actor)
            return {"drafts": [{"id": row["id"], "created": row["created"], "expires": row["expires"],
                                **json.loads(row["value"])["review"]} for row in self.pending_drafts(actor)]}
        if op in {"confirm", "reject", "attachment"}:
            self.grant(actor)
            row = self.db.execute("SELECT * FROM remote_drafts WHERE id=?", (text(request.get("draftId")),)).fetchone()
            self.check_draft(row, actor, Policy(self.workspace, actor))
            token = self.db.execute("SELECT * FROM remote_tokens WHERE id=?", (row["token_id"],)).fetchone()
            self.upload_context(actor, token)
            self.workspace.upload_claim = row["id"]
            saved = json.loads(row["value"])["request"]
            if op == "attachment":
                upload_id = request.get("uploadId")
                if not any(a.get("upload_id") == upload_id for a in saved.get("attachments", [])):
                    raise AuthError("文件不属于这份草稿。")
                store = UploadStore(self.workspace)
                value, _ = store.bytes(upload_id, row["matter"])
                return {"path": str(store.path(upload_id, ".bin")), "filename": value["filename"], "size": value["size"]}
            if op == "reject":
                for a in saved.get("attachments", []):
                    if a.get("upload_id"):
                        UploadStore(self.workspace).remove(a["upload_id"])
                with self.db: self.db.execute("UPDATE remote_drafts SET state='rejected',value='' WHERE id=?", (row["id"],))
                self.accounts.audit(actor, "remote.reject", row["id"])
                return {"rejected": True}
            if request.get("confirmed") is not True: raise AuthError("请核对草稿后明确确认。", "invalid")
            self.ready()
            Policy(self.workspace, actor).authorize(saved)
            try:
                self.save_request(saved, actor, token, preview=True)
            except Exception as exc:
                if getattr(exc, "code", None) in {"conflict", "attachment_conflict", "upload_expired"}:
                    with self.db: self.db.execute("UPDATE remote_drafts SET state='failed',value='' WHERE id=?", (row["id"],))
                    for a in saved.get("attachments", []):
                        if a.get("upload_id"): UploadStore(self.workspace).remove(a["upload_id"])
                    raise AuthError("资料或文件已变化，本草稿已失效。请重新读取后提交。", "conflict") from exc
                raise
            self.workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
            # Claim before touching business files. A crash leaves a non-retryable receipt;
            # it cannot cause a duplicated event on retry. History resolves uncertain outcomes.
            with self.db: self.db.execute("UPDATE remote_drafts SET state='processing',value='' WHERE id=?", (row["id"],))
            self.accounts.audit(actor, "remote.confirm", row["id"], "started")
            try:
                result = self.save_request(saved, actor, token)
            except Exception as exc:
                with self.db: self.db.execute("UPDATE remote_drafts SET state='failed' WHERE id=?", (row["id"],))
                self.accounts.audit(actor, "remote.confirm", row["id"], "failed")
                if getattr(exc, "code", None) == "conflict":
                    raise AuthError("原记录已变化，本草稿已失效。请读取最新资料并重新提交。", "conflict") from exc
                raise
            with self.db: self.db.execute("UPDATE remote_drafts SET state='saved' WHERE id=?", (row["id"],))
            self.accounts.audit(actor, "remote.confirm", row["id"], "success")
            return result
        raise AuthError("未知的远程管理操作。", "invalid")

    def pending_drafts(self, actor):
        # The badge and review page use the same ownership, expiry and permission checks.
        policy = Policy(self.workspace, actor)
        for row in self.db.execute("SELECT * FROM remote_drafts WHERE owner=? AND state='pending' ORDER BY created DESC", (actor["id"],)):
            try:
                self.check_draft(row, actor, policy)
            except AuthError:
                continue
            yield row

    def check_draft(self, row, actor, policy):
        if not row or row["owner"] != actor["id"] or row["binding"] != actor["revision"] or row["expires"] <= int(time.time()) or row["state"] != "pending":
            raise AuthError("草稿已处理或失效；请检查最新记录，必要时重新提交。", "conflict")
        token = self.db.execute("SELECT * FROM remote_tokens WHERE id=?", (row["token_id"],)).fetchone()
        self.token_actor(token)
        if actor["role"] == "viewer" or not token["can_draft"]: raise AuthError("此账号不能确认草稿。")
        saved = json.loads(row["value"])["request"]
        if saved.get("kind") == "qa":
            require_qa(actor, token)
        elif saved.get("kind") == "intake":
            Intake(self, actor, token).read(saved["intake_id"])
        else:
            policy.project(row["matter"])
        for attachment in json.loads(row["value"])["request"].get("attachments", []):
            if attachment.get("file_id"):
                item = policy.file(attachment["file_id"])
                if row["matter"] not in item["project_ids"]:
                    raise AuthError("附件不再属于此事项。")

    def rpc(self, request, credential):
        actor, token = self.authenticate(credential)
        op, args = request.get("tool"), request.get("arguments", {})
        if not isinstance(args, dict): raise AuthError("参数须为对象。", "invalid")
        now = int(time.time())
        if self.db.execute("SELECT COUNT(*) FROM remote_attempts WHERE owner=? AND at>=?", (actor["id"], now - 60)).fetchone()[0] >= 60:
            raise AuthError("远程请求过于频繁，请稍后再试。", "rate_limited")
        with self.db: self.db.execute("INSERT INTO remote_attempts VALUES(?,?)", (actor["id"], now))
        if op == "access": return {"canQa": bool(token["can_qa"]) and self.accounts.qa_allowed(actor["id"]),"canDraft": bool(token["can_draft"]) and actor["role"] != "viewer", "canSave": bool(token["can_save"]) and actor["role"] == "admin", "canIntake": bool(token["can_intake"]) and actor["role"] == "admin"}
        if op not in QA_TOOLS | {"search_entities", "read_entity", "prepare_intake", "discard_intake", "submit_intake", "save_intake", "search_matters", "read_matter", "read_progress", "list_files", "read_file", "prepare_upload", "upload_status", "discard_upload", "upload_bytes", "submit_draft", "save_progress"}: raise AuthError("远程接口不提供此操作。")
        policy = Policy(self.workspace, actor)
        self.upload_context(actor, token)
        self.ready()
        try:
            result = self.tool(op, args, actor, token, policy)
        except Exception:
            self.accounts.audit(actor, "remote." + op, token["id"], "failed")
            raise
        self.accounts.audit(actor, "remote." + op, token["id"])
        return result

    def save_request(self, saved, actor, token, preview=False):
        if saved.get("kind") == "qa":
            require_qa(actor, token)
            return InvestmentQA(self.workspace).execute(saved, preview=preview)
        if saved.get("kind") == "intake":
            return Intake(self, actor, token).save(saved, preview=preview)
        return self.workspace.save(saved, preview=preview)

    def tool(self, op, args, actor, token, policy):
        if op in QA_TOOLS:
            return qa_tool(self, op, args, actor, token)
        if op in {"prepare_intake", "discard_intake", "submit_intake", "save_intake"}:
            require_intake(actor, token)
            intake = Intake(self, actor, token)
            if op == "prepare_intake": return intake.prepare(args)
            if op == "discard_intake":
                exact(args, {"intake_id"}, {"intake_id"})
                intake.read(text(args["intake_id"]))
                if self.db.execute("SELECT 1 FROM remote_drafts WHERE state='pending' AND token_id=? AND json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.request.intake_id')=?", (token["id"], args["intake_id"])).fetchone():
                    raise AuthError("方案已用于待确认草稿，请在网页驳回。", "conflict")
                with self.db: self.db.execute("DELETE FROM remote_intakes WHERE id=?", (args["intake_id"],))
                return {"discarded": True}
            return self.submit_intake(op, args, actor, token)
        if op in {"search_entities", "read_entity"}:
            return self.entities(op, args, actor, token, policy)
        if op in {"prepare_upload", "upload_status", "discard_upload", "upload_bytes"}:
            if not token["can_draft"] or actor["role"] == "viewer":
                raise AuthError("此凭据只允许查询。")
            store = UploadStore(self.workspace)
            if op == "prepare_upload":
                exact(args, {"matter_id", "filename", "size", "sha256", "intake_id"}, {"matter_id", "filename", "size", "sha256"})
                value = store.prepare(text(args["matter_id"]), args["filename"], args["size"], args["sha256"], args.get("intake_id"))
                return {**value, "upload_path": "/api/mcp/uploads", "method": "POST", "multipart_fields": ["upload_id", "file"],
                        "instructions": "Upload actual local file bytes with multipart/form-data using the same Bearer credential, outside model context. Resolve this path against this MCP server origin only. Never send the credential or file bytes into the conversation. A local path alone is not an upload. Then use upload_id in attachments on submit_draft/save_progress, or submit_intake/save_intake for an intake plan."}
            exact(args, {"upload_id", "filename", "data"} if op == "upload_bytes" else {"upload_id"}, {"upload_id", "filename", "data"} if op == "upload_bytes" else {"upload_id"})
            value = store.read(args["upload_id"])
            if op == "upload_bytes":
                return store.write(args["upload_id"], args["filename"], args["data"])
            if op == "discard_upload":
                if value.get("claim"):
                    raise AuthError("此上传已用于待确认草稿，请在网页驳回草稿。", "conflict")
                store.remove(args["upload_id"])
                return {"discarded": True}
            return store.public(value)
        files = self.workspace.read_files()
        parties = counterparties(files)
        def party_name(metadata):
            party = parties.get(metadata.get("primary_counterparty_id"))
            return party[1]["name"] if party else ""
        if op == "search_matters":
            exact(args, {"query", "offset"})
            query, offset = text(args.get("query", ""), 100, True).casefold(), args.get("offset", 0)
            if type(offset) is not int or not 0 <= offset <= 100000: raise AuthError("页码无效。", "invalid")
            matches = []
            for identity, (_, metadata, _) in sorted(self.workspace.projects(files).items()):
                if identity in policy.allowed and any(query in name.casefold() for name in [metadata["name"], party_name(metadata)] + [parties[p][1].get("short_name") or "" for p in metadata.get("counterparty_ids", []) if p in parties]):
                    matches.append({**{key: metadata.get(key) for key in ("id", "name", "stage", "follow_up_status")}, "counterparty": party_name(metadata)})
            return {"matters": matches[offset:offset + 20], "nextOffset": offset + 20 if len(matches) > offset + 20 else None}
        matter = text(args.get("matter_id"))
        policy.project(matter)  # Also enforce a real target for administrators.
        target = {"kind": "project", "id": matter}
        opened = self.workspace.get_record(target)
        record = opened["record"]
        if not record: raise AuthError("事项已不存在。", "not_found")
        if op in {"list_files", "read_file"}:
            exact(args, {"matter_id", "file_id", "offset"} if op == "read_file" else {"matter_id", "query", "offset"}, {"matter_id", "file_id"} if op == "read_file" else {"matter_id"})
            offset = args.get("offset", 0)
            if type(offset) is not int or not 0 <= offset <= 100000: raise AuthError("页码无效。", "invalid")
            from workspace_service import digest
            available = [v for v in index_from(files)["files"] if matter in v["project_ids"] and not v["archived"] and policy.file_allowed(v)]
            def describe(v):
                return {"file_id": v["id"], "title": v["title"], "category": v["category"], "agreement_type": v.get("agreement_type", "unspecified"), "revision": digest(v), "current_version": v["current_version"], "version_count": len(v["versions"])}
            if op == "list_files":
                query = text(args.get("query", ""), 100, True).casefold()
                available = [v for v in available if query in v["title"].casefold()]
                return {"files": [describe(v) for v in available[offset:offset+20]], "nextOffset": offset+20 if len(available)>offset+20 else None}
            item = next((v for v in available if v["id"] == args["file_id"]), None)
            if not item: raise AuthError("未找到可访问的资料。", "forbidden")
            versions = list(reversed(item["versions"]))
            return {**describe(item), "versions": [{"version_id": v["id"], "version_number": len(versions)-offset-i,
                    **{k: v.get(k, "") for k in ("filename", "size", "sha256", "status", "agreement_date", "signing_completed_date", "note")}} for i,v in enumerate(versions[offset:offset+20])],
                    "nextOffset": offset+20 if len(versions)>offset+20 else None}
        if op == "read_matter":
            exact(args, {"matter_id", "offset"}, {"matter_id"})
            offset = args.get("offset", 0)
            if type(offset) is not int or not 0 <= offset <= 100000: raise AuthError("页码无效。", "invalid")
            events = sorted(record["events"], key=lambda e: (e["date"], e["id"]), reverse=True)
            return {"matter_id": matter, "name": record["metadata"]["name"], "revision": opened["revision"],
                    "counterparty": party_name(record["metadata"]),
                    "fields": {key: record["body"] if key == "body" else record["metadata"].get(key) for key in sorted(MATTER_FIELDS)},
                    "participant_ids": [c["person_id"] for c in record["contacts"]],
                    **({"record": {"metadata": record["metadata"], "body": record["body"], "contacts": record["contacts"]}} if token["can_intake"] and actor["role"] == "admin" else {}),
                    "events": [{k: e.get(k) for k in ("id", "date", "type", "title", "summary")} for e in events[offset:offset + 20]],
                    "nextOffset": offset + 20 if len(events) > offset + 20 else None}
        progress_id = text(args.get("progress_id", ""), 160, True)
        if op == "read_progress":
            exact(args, {"matter_id", "progress_id"}, {"matter_id", "progress_id"})
            item = self.workspace.get_record({"kind": "progress", "id": progress_id, "project_id": matter})
            if not item["record"]: raise AuthError("未找到这条进展。", "not_found")
            return {"matter_id": matter, "progress_id": progress_id, "revision": item["revision"], "fields": self.progress_fields(item["record"]), "attachments": item["record"].get("attachments", [])}
        direct = op == "save_progress"
        if direct and (not token["can_save"] or actor["role"] != "admin"):
            raise AuthError("直接保存仅限管理员明确开启此权限的连接。")
        if not token["can_draft"] or actor["role"] == "viewer": raise AuthError("此凭据只允许查询。")
        exact(args, {"matter_id", "progress_id", "revision", "operation", "changes", "request_id", "attachments"}, {"matter_id", "revision", "operation", "changes", "request_id"})
        request_id = text(args["request_id"], 80)
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id): raise AuthError("请提供至少 16 位唯一请求编号。", "invalid")
        signature = hashlib.sha256(json.dumps(args, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        table, other = ("remote_writes", "remote_drafts") if direct else ("remote_drafts", "remote_writes")
        if self.db.execute(f"SELECT 1 FROM {other} WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone():
            raise AuthError("此请求编号已用于其他操作，请先检查原操作结果。", "conflict")
        existing = self.db.execute(f"SELECT * FROM {table} WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone()
        if existing:
            if existing["fingerprint"] != signature: raise AuthError("同一请求编号不能提交不同内容。", "conflict")
            return self.write_receipt(existing) if direct else self.receipt(existing)
        operation, changes = args["operation"], args["changes"]
        if operation not in {"add_progress", "update_progress", "update_matter"}: raise AuthError("不支持此类修改。", "invalid")
        if direct and operation not in {"add_progress", "update_progress"}:
            raise AuthError("直接保存仅支持新增或修改已有事项的进展；事项信息请提交草稿。", "invalid")
        exact(changes, MATTER_FIELDS if operation == "update_matter" else PROGRESS_INPUT_FIELDS)
        attachments = args.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > 10 or (attachments and operation == "update_matter"):
            raise AuthError("附件仅可随进展保存，每次最多 10 个。", "invalid")
        if not changes and not attachments: raise AuthError("请提供要修改的内容。", "invalid")
        for key, value in changes.items():
            if key == "participants":
                if not isinstance(value, list) or len(value) > 30 or any(not isinstance(v, str) for v in value): raise AuthError("参与人列表格式无效。", "invalid")
            elif key in {"new_people", "new_contacts"}:
                if not isinstance(value, list) or len(value) > 30 or any(not isinstance(v, dict) for v in value): raise AuthError("新增人员及事项关系列表格式无效。", "invalid")
            elif key == "next_action_due" and value is None: pass
            else: text(value, 8000 if key == "body" else 1000, True)
        if operation == "update_matter":
            if progress_id: raise AuthError("事项修改不接受进展编号。", "invalid")
            before = {**record["metadata"], "body": record["body"], "contacts": record["contacts"]}
        else:
            if (operation == "update_progress") != bool(progress_id): raise AuthError("进展编号与操作不匹配。", "invalid")
            target = {"kind": "progress", "id": progress_id, "project_id": matter}
            item = self.workspace.get_record(target)["record"]
            if progress_id and not item: raise AuthError("未找到这条进展。", "not_found")
            before = self.progress_fields(item) if item else {"date": "", "type": "other", "title": "", "summary": "", "importance": "normal", "participants": [], "body": "", "location": ""}
        save = {"action": "save", **target, "revision": text(args["revision"]), "payload": {**before, **changes}, "attachments": attachments}
        if operation != "update_matter":
            self.workspace.new_progress_people(files, save["payload"])
        if not attachments and operation != "add_progress" and all(before.get(key) == value for key, value in changes.items()):
            raise AuthError("内容没有变化，无需提交修改。", "invalid")
        policy.authorize(save)
        preview = self.workspace.save(save, preview=True)
        if direct:
            return self.save_progress(save, args, actor, token, signature)
        if self.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'", (actor["id"],)).fetchone()[0] >= 20 or self.db.execute("SELECT COUNT(*) FROM remote_drafts").fetchone()[0] >= 2000:
            raise AuthError("待处理草稿过多，请先在 BD 中确认或驳回。", "rate_limited")
        identity, created = secrets.token_hex(16), int(time.time())
        expires = min([created + 86400, token["expires"]] + [UploadStore(self.workspace).read(a["upload_id"])["expires"] for a in attachments if a.get("upload_id")])
        # New progress displays default fields too; edits show only fields that can change.
        displayed = save["payload"] if operation == "add_progress" else changes
        review = {"matterId": matter, "matterName": record["metadata"]["name"], "operation": operation, "progressId": progress_id,
                  "counterparty": party_name(record["metadata"]),
                  "progressTitle": (before if progress_id else save["payload"]).get("title", ""),
                  "progressDate": (before if progress_id else save["payload"]).get("date", ""),
                  "changes": [{"field": key, "label": LABELS[key], "before": None if operation == "add_progress" else before.get(key), "after": save["payload"][key]} for key in sorted(displayed)]}
        review["attachments"] = preview.get("attachments", [])
        upload_ids = [a["upload_id"] for a in attachments if a.get("upload_id")]
        UploadStore(self.workspace).claim(upload_ids, identity)
        try:
            with self.db:
                self.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)", (identity, actor["id"], token["id"], actor["revision"], request_id, signature, matter, json.dumps({"request": save, "review": review}, ensure_ascii=False), created, expires))
        except Exception:
            UploadStore(self.workspace).claim(upload_ids, None)
            raise
        return self.receipt(self.db.execute("SELECT * FROM remote_drafts WHERE id=?", (identity,)).fetchone())

    def save_progress(self, save, args, actor, token, signature):
        if self.db.execute("SELECT COUNT(*) FROM remote_writes").fetchone()[0] >= 2000:
            raise AuthError("保存请求记录已达上限，请撤销不再使用的凭据或等待到期。", "rate_limited")
        identity, created = secrets.token_hex(16), int(time.time())
        # Commit the claim before any business write. After an interruption, the same
        # request must return its receipt, never execute a second time.
        with self.db:
            self.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)",
                            (identity, actor["id"], token["id"], actor["revision"], args["request_id"], signature, args["matter_id"], created, token["expires"]))
        self.accounts.audit(actor, "remote.save_progress", identity, "started")
        self.workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
        try:
            result = self.workspace.save(save)
            opened = self.workspace.get_record({"kind": "progress", "id": result["id"], "project_id": args["matter_id"]})
            receipt = {"write_id": identity, "request_id": args["request_id"], "status": "saved",
                       "matter_id": args["matter_id"], "progress_id": result["id"], "revision": opened["revision"],
                       "history_version": result["status"]["version"], "attachments": result.get("attachments", []),
                       "message": "进展已正式保存，并留存修改历史；无需网页确认。"}
            with self.db:
                self.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False), identity))
        except Exception as exc:
            with self.db: self.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?", (identity,))
            self.accounts.audit(actor, "remote.save_progress", identity, "failed")
            raise AuthError("保存结果需要核对。请保留原请求编号，查询最新进展和修改历史；不要更换编号重复保存。", "uncertain") from exc
        self.accounts.audit(actor, "remote.save_progress", identity, "success")
        return receipt

    @staticmethod
    def write_receipt(row):
        if row["state"] == "saved": return json.loads(row["result"])
        return {"write_id": row["id"], "request_id": row["request_id"], "matter_id": row["matter"], "status": "uncertain",
                "message": "此请求已开始执行，结果需要核对；不会再次执行。请查询最新进展和修改历史，不要更换编号重复保存。"}

    @staticmethod
    def progress_fields(record):
        return {**{k: record["event"].get(k) for k in PROGRESS_FIELDS - {"body", "location"}}, "body": record["body"], "location": record["document"].get("location") or ""}

    @staticmethod
    def receipt(row):
        return {"draftId": row["id"], "status": row["state"], "expires": row["expires"], "reviewPath": "/remote#draft-" + row["id"],
                "message": "草稿尚未写入业务资料，请本人登录 BD 核对并确认。" if row["state"] == "pending" else "此草稿已处理，不会再次保存。请在 BD 查看结果。"}

    def entities(self, op, args, actor, token, policy):
        from workspace_service import parse_yaml
        files = self.workspace.read_files()
        exact(args, {"kind", "id"} if op == "read_entity" else {"kind", "query", "offset"}, {"kind", "id"} if op == "read_entity" else {"kind"})
        kind = args["kind"]
        if kind not in {"person", "counterparty"}: raise AuthError("请选择人员或对接方。", "invalid")
        if op == "read_entity":
            require_intake(actor, token)
            result = self.workspace.get_record({"kind": kind, "id": text(args["id"])})
            if not result["record"]: raise AuthError("未找到这条档案。", "not_found")
            return result
        query, offset = text(args.get("query", ""), 100, True).casefold(), args.get("offset", 0)
        if type(offset) is not int or not 0 <= offset <= 100000: raise AuthError("页码无效。", "invalid")
        projects = {k: v for k, v in self.workspace.projects(files).items() if k in policy.allowed}
        linked = {}
        for identity, (_, metadata, _) in projects.items():
            record = self.workspace.record(files, "project", identity)
            ids = metadata.get("counterparty_ids", []) if kind == "counterparty" else set(metadata.get("sourced_by", []) + [c["person_id"] for c in record["contacts"]] + [p for e in record["events"] for p in e.get("participants", [])])
            for entity in ids: linked.setdefault(entity, []).append(identity)
        if kind == "person":
            values = [{k: p.get(k, "") for k in ("id", "name", "affiliation")} for p in parse_yaml(files["people.yaml"])["people"]]
        else:
            values = [{k: v[1].get(k, "") for k in ("id", "name", "short_name", "kind")} for v in counterparties(files).values()]
        values = [{**v, "matter_ids": linked.get(v["id"], [])} for v in values if (actor["role"] == "admin" or v["id"] in linked) and any(query in str(x).casefold() for k, x in v.items() if k != "id")]
        values.sort(key=lambda v: (v["name"], v["id"]))
        return {"entities": values[offset:offset+20], "nextOffset": offset+20 if len(values)>offset+20 else None,
                "instructions": "Matches are candidates, not proof of identity. Read related matters before creating a new one. Ask the user when multiple candidates remain plausible."}

    def submit_intake(self, op, args, actor, token):
        direct = op == "save_intake"
        if direct and not token["can_save"]: raise AuthError("此连接只允许提交草稿，请在网页确认。")
        exact(args, {"intake_id", "request_id", "attachments"}, {"intake_id", "request_id"})
        request_id = text(args["request_id"], 80)
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id): raise AuthError("请提供至少 16 位唯一请求编号。", "invalid")
        signature = hashlib.sha256(json.dumps(args, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        table, other = ("remote_writes", "remote_drafts") if direct else ("remote_drafts", "remote_writes")
        if self.db.execute(f"SELECT 1 FROM {other} WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone():
            raise AuthError("此请求编号已用于其他操作，请先核对原操作结果。", "conflict")
        old = self.db.execute(f"SELECT * FROM {table} WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone()
        if old:
            if old["fingerprint"] != signature: raise AuthError("同一请求编号不能提交不同内容。", "conflict")
            return self.write_receipt(old) if direct else self.receipt(old)
        intake = Intake(self, actor, token)
        row, plan = intake.read(text(args["intake_id"]))
        save = {"action": "save", "kind": "intake", "intake_id": args["intake_id"], "attachments": args.get("attachments", [])}
        preview = intake.save(save, preview=True)
        if self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] >= 2000 or (not direct and self.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'", (actor["id"],)).fetchone()[0] >= 20):
            raise AuthError("请求记录已达上限，请先处理待确认修改或等待到期。", "rate_limited")
        identity, created = secrets.token_hex(16), int(time.time())
        upload_ids = [a["upload_id"] for a in save["attachments"] if a.get("upload_id")]
        if direct:
            with self.db:
                self.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)", (identity, actor["id"], token["id"], actor["revision"], request_id, signature, plan["matter_id"], created, token["expires"]))
            self.workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
            self.accounts.audit(actor, "remote.save_intake", identity, "started")
            try:
                receipt = {**intake.save(save), "write_id": identity, "request_id": request_id}
                with self.db: self.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False), identity))
            except Exception as exc:
                with self.db: self.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?", (identity,))
                self.accounts.audit(actor, "remote.save_intake", identity, "failed")
                raise AuthError("保存结果需要核对，请保留原请求编号并查询最新资料和修改历史，不要重新编号重复保存。", "uncertain") from exc
            self.accounts.audit(actor, "remote.save_intake", identity, "success")
            return receipt
        expires = min([row["expires"]] + [UploadStore(self.workspace).read(i)["expires"] for i in upload_ids])
        review = {**plan["review"], "attachments": preview["attachments"]}
        UploadStore(self.workspace).claim(upload_ids, identity)
        try:
            with self.db:
                self.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)", (identity, actor["id"], token["id"], actor["revision"], request_id, signature, plan["matter_id"], json.dumps({"request": save, "review": review}, ensure_ascii=False), created, expires))
        except Exception:
            UploadStore(self.workspace).claim(upload_ids, None)
            raise
        return self.receipt(self.db.execute("SELECT * FROM remote_drafts WHERE id=?", (identity,)).fetchone())
