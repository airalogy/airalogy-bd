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

MATTER_FIELDS = {"body", "stage", "follow_up_status", "next_action", "next_action_due"}
PROGRESS_FIELDS = {"date", "type", "title", "summary", "importance", "participants", "body", "location"}
LABELS = {"body": "正文", "stage": "阶段", "follow_up_status": "跟进状态", "next_action": "下一步",
          "next_action_due": "下一步日期", "date": "实际日期", "type": "进展类型", "title": "标题",
          "summary": "摘要", "importance": "重要程度", "participants": "参与人", "location": "地点"}


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
        with self.db:
            self.db.execute("DELETE FROM remote_attempts WHERE at<?", (int(time.time()) - 60,))
            # Keep consumed request IDs until expiry for replay protection, but clear their contents.
            self.db.execute("DELETE FROM remote_drafts WHERE expires<=?", (int(time.time()),))
            # Direct-save receipts outlive drafts and remain until their credential expires.
            self.db.execute("DELETE FROM remote_writes WHERE expires<=?", (int(time.time()),))
            self.db.execute("DELETE FROM remote_tokens WHERE expires<=?", (int(time.time()),))

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
        actor = public_user(row)
        self.grant(actor)
        return actor

    def ready(self):
        self.workspace.recover()
        status = self.workspace.observe()
        if status["errors"]:
            raise AuthError("工作区资料需要管理员检查。", "unavailable")

    def status(self, actor, manage=False):
        result = self.settings() | {"granted": self.accounts.remote_allowed(actor["id"])}
        result["tokens"] = [dict(row) for row in self.db.execute(
            "SELECT id,owner,label,can_draft,can_save,expires,created FROM remote_tokens WHERE " + ("1=1" if manage else "owner=?") + " ORDER BY created DESC",
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
            days, writable = request.get("days", 7), mode != "read"
            if type(days) is not int or not 1 <= days <= 30 or (writable and actor["role"] == "viewer"):
                raise AuthError("有效期须为 1–30 天；只读成员不能提交草稿。", "invalid")
            now = int(time.time())
            if self.db.execute("SELECT COUNT(*) FROM remote_tokens WHERE owner=? AND expires>?", (actor["id"], now)).fetchone()[0] >= 5:
                raise AuthError("最多保留 5 个有效凭据，请先撤销不再使用的凭据。", "rate_limited")
            label = text(request.get("label"), 80)
            token, identity = "bdr_" + secrets.token_urlsafe(32), secrets.token_hex(16)
            with self.db:
                self.db.execute("INSERT INTO remote_tokens(id,digest,owner,binding,label,can_draft,expires,created,can_save) VALUES(?,?,?,?,?,?,?,?,?)", (identity, fingerprint(token), actor["id"], actor["revision"], label, int(writable), now + days * 86400, now, int(mode == "direct")))
            self.accounts.audit(actor, "remote.issue_direct" if mode == "direct" else "remote.issue", identity)
            return {"id": identity, "token": token, "expires": now + days * 86400, "accessMode": mode}
        if op == "revoke":
            identity = text(request.get("tokenId"))
            row = self.db.execute("SELECT * FROM remote_tokens WHERE id=?", (identity,)).fetchone()
            if not row or (actor["role"] != "admin" and row["owner"] != actor["id"]): raise AuthError("不能撤销此凭据。")
            with self.db:
                self.db.execute("DELETE FROM remote_tokens WHERE id=?", (identity,))
                self.db.execute("DELETE FROM remote_drafts WHERE token_id=?", (identity,))
                self.db.execute("DELETE FROM remote_writes WHERE token_id=?", (identity,))
            self.accounts.audit(actor, "remote.revoke", identity)
            return {"revoked": True}
        if op == "drafts":
            self.grant(actor)
            return {"drafts": [{"id": row["id"], "created": row["created"], "expires": row["expires"],
                                **json.loads(row["value"])["review"]} for row in self.pending_drafts(actor)]}
        if op in {"confirm", "reject"}:
            self.grant(actor)
            row = self.db.execute("SELECT * FROM remote_drafts WHERE id=?", (text(request.get("draftId")),)).fetchone()
            self.check_draft(row, actor, Policy(self.workspace, actor))
            if op == "reject":
                with self.db: self.db.execute("UPDATE remote_drafts SET state='rejected',value='' WHERE id=?", (row["id"],))
                self.accounts.audit(actor, "remote.reject", row["id"])
                return {"rejected": True}
            if request.get("confirmed") is not True: raise AuthError("请核对草稿后明确确认。", "invalid")
            self.ready()
            saved = json.loads(row["value"])["request"]
            Policy(self.workspace, actor).authorize(saved)
            self.workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
            # Claim before touching business files. A crash leaves a non-retryable receipt;
            # it cannot cause a duplicated event on retry. History resolves uncertain outcomes.
            with self.db: self.db.execute("UPDATE remote_drafts SET state='processing',value='' WHERE id=?", (row["id"],))
            self.accounts.audit(actor, "remote.confirm", row["id"], "started")
            try:
                result = self.workspace.save(saved)
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
        policy.project(row["matter"])

    def rpc(self, request, credential):
        actor, token = self.authenticate(credential)
        op, args = request.get("tool"), request.get("arguments", {})
        if not isinstance(args, dict): raise AuthError("参数须为对象。", "invalid")
        now = int(time.time())
        if self.db.execute("SELECT COUNT(*) FROM remote_attempts WHERE owner=? AND at>=?", (actor["id"], now - 60)).fetchone()[0] >= 60:
            raise AuthError("远程请求过于频繁，请稍后再试。", "rate_limited")
        with self.db: self.db.execute("INSERT INTO remote_attempts VALUES(?,?)", (actor["id"], now))
        if op == "access": return {"canDraft": bool(token["can_draft"]) and actor["role"] != "viewer", "canSave": bool(token["can_save"]) and actor["role"] == "admin"}
        if op not in {"search_matters", "read_matter", "read_progress", "submit_draft", "save_progress"}: raise AuthError("远程接口不提供此操作。")
        policy = Policy(self.workspace, actor)
        self.ready()
        try:
            result = self.tool(op, args, actor, token, policy)
        except Exception:
            self.accounts.audit(actor, "remote." + op, token["id"], "failed")
            raise
        self.accounts.audit(actor, "remote." + op, token["id"])
        return result

    def tool(self, op, args, actor, token, policy):
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
                if identity in policy.allowed and query in metadata["name"].casefold():
                    matches.append({**{key: metadata.get(key) for key in ("id", "name", "stage", "follow_up_status")}, "counterparty": party_name(metadata)})
            return {"matters": matches[offset:offset + 20], "nextOffset": offset + 20 if len(matches) > offset + 20 else None}
        matter = text(args.get("matter_id"))
        policy.project(matter)  # Also enforce a real target for administrators.
        target = {"kind": "project", "id": matter}
        opened = self.workspace.get_record(target)
        record = opened["record"]
        if not record: raise AuthError("事项已不存在。", "not_found")
        if op == "read_matter":
            exact(args, {"matter_id", "offset"}, {"matter_id"})
            offset = args.get("offset", 0)
            if type(offset) is not int or not 0 <= offset <= 100000: raise AuthError("页码无效。", "invalid")
            events = sorted(record["events"], key=lambda e: (e["date"], e["id"]), reverse=True)
            return {"matter_id": matter, "name": record["metadata"]["name"], "revision": opened["revision"],
                    "counterparty": party_name(record["metadata"]),
                    "fields": {key: record["body"] if key == "body" else record["metadata"].get(key) for key in sorted(MATTER_FIELDS)},
                    "participant_ids": [c["person_id"] for c in record["contacts"]],
                    "events": [{k: e.get(k) for k in ("id", "date", "type", "title", "summary")} for e in events[offset:offset + 20]],
                    "nextOffset": offset + 20 if len(events) > offset + 20 else None}
        progress_id = text(args.get("progress_id", ""), 160, True)
        if op == "read_progress":
            exact(args, {"matter_id", "progress_id"}, {"matter_id", "progress_id"})
            item = self.workspace.get_record({"kind": "progress", "id": progress_id, "project_id": matter})
            if not item["record"]: raise AuthError("未找到这条进展。", "not_found")
            return {"matter_id": matter, "progress_id": progress_id, "revision": item["revision"], "fields": self.progress_fields(item["record"])}
        direct = op == "save_progress"
        if direct and (not token["can_save"] or actor["role"] != "admin"):
            raise AuthError("直接保存仅限管理员明确开启此权限的连接。")
        if not token["can_draft"] or actor["role"] == "viewer": raise AuthError("此凭据只允许查询。")
        exact(args, {"matter_id", "progress_id", "revision", "operation", "changes", "request_id"}, {"matter_id", "revision", "operation", "changes", "request_id"})
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
        exact(changes, MATTER_FIELDS if operation == "update_matter" else PROGRESS_FIELDS)
        if not changes: raise AuthError("请提供要修改的内容。", "invalid")
        for key, value in changes.items():
            if key == "participants":
                if not isinstance(value, list) or len(value) > 30 or any(not isinstance(v, str) or v not in {c["person_id"] for c in record["contacts"]} for v in value): raise AuthError("只能引用当前事项已有参与人。", "invalid")
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
        save = {"action": "save", **target, "revision": text(args["revision"]), "payload": {**before, **changes}}
        if operation != "add_progress" and all(before.get(key) == value for key, value in changes.items()):
            raise AuthError("内容没有变化，无需提交修改。", "invalid")
        policy.authorize(save)
        self.workspace.save(save, preview=True)
        if direct:
            return self.save_progress(save, args, actor, token, signature)
        if self.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'", (actor["id"],)).fetchone()[0] >= 20 or self.db.execute("SELECT COUNT(*) FROM remote_drafts").fetchone()[0] >= 2000:
            raise AuthError("待处理草稿过多，请先在 BD 中确认或驳回。", "rate_limited")
        identity, created = secrets.token_hex(16), int(time.time())
        expires = min(created + 86400, token["expires"])
        # New progress displays default fields too; edits show only fields that can change.
        displayed = save["payload"] if operation == "add_progress" else changes
        review = {"matterId": matter, "matterName": record["metadata"]["name"], "operation": operation, "progressId": progress_id,
                  "counterparty": party_name(record["metadata"]),
                  "progressTitle": (before if progress_id else save["payload"]).get("title", ""),
                  "progressDate": (before if progress_id else save["payload"]).get("date", ""),
                  "changes": [{"field": key, "label": LABELS[key], "before": None if operation == "add_progress" else before.get(key), "after": save["payload"][key]} for key in sorted(displayed)]}
        with self.db:
            self.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)", (identity, actor["id"], token["id"], actor["revision"], request_id, signature, matter, json.dumps({"request": save, "review": review}, ensure_ascii=False), created, expires))
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
                       "history_version": result["status"]["version"],
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
