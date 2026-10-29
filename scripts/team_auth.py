"""Invitation-only membership, authorization and audit. Credentials belong to Better Auth.

The web transport supplies the session through the child environment, not JSON.
SQLite transactions protect account changes; business writes use the workspace lock.
"""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path


class AuthError(Exception):
    def __init__(self, message, code="forbidden"):
        super().__init__(message)
        self.code, self.details = code, None


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()


def email_verification_required():
    value = os.environ.get("BD_REQUIRE_EMAIL_VERIFICATION", "0") or "0"
    if value not in {"0", "1"}:
        raise AuthError("BD_REQUIRE_EMAIL_VERIFICATION 只支持 0 或 1。", "unavailable")
    return os.environ.get("BD_MODE") == "server" and value == "1"


def public_user(row):
    return {key: row[key] for key in ("id", "email", "name", "username", "role", "active", "revision")} | {
        "all_projects": bool(row["all_projects"]), "project_ids": json.loads(row["project_ids"]),
    }


MEMBER_AUDIT_ACTIONS = ("account.invite", "account.permissions", "account.reset", "remote.grant", "remote.ungrant")
ROLE_LABELS = {"admin": "管理员", "editor": "编辑成员", "viewer": "只读成员"}


class Accounts:
    def __init__(self, content):
        self.directory = Path(content).resolve().parent / ".bd-auth"
        if self.directory.is_symlink():
            raise AuthError("账号目录不能使用符号链接。")
        self.directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.path = self.directory / "accounts.sqlite3"
        if self.path.is_symlink():
            raise AuthError("账号数据库不能使用符号链接。")
        self.db = sqlite3.connect(self.path, timeout=30)
        self.db.row_factory = sqlite3.Row
        os.chmod(self.path, 0o600)
        self.db.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL,
                role TEXT NOT NULL, all_projects INTEGER NOT NULL, project_ids TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 0, credential_revision TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS remote_grants (owner TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS invitations (
                digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
                actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
                target TEXT NOT NULL, outcome TEXT NOT NULL);
        """)

        self.allow_pending_email()
        # Additive migration keeps existing IDs, grants and email logins unchanged.
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if 'username' not in {row[1] for row in self.db.execute('PRAGMA table_info(users)')}:
                self.db.execute('ALTER TABLE users ADD COLUMN username TEXT')
            self.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username COLLATE NOCASE)')
            if 'details' not in {row[1] for row in self.db.execute('PRAGMA table_info(audit)')}:
                self.db.execute("ALTER TABLE audit ADD COLUMN details TEXT NOT NULL DEFAULT '{}'")
            # Complete an interrupted provider update before reading or backing up membership.
            if 'username' in {row[1] for row in self.db.execute('PRAGMA table_info(ba_user)')}:
                for row in self.db.execute('SELECT u.id,b.username FROM users u JOIN ba_user b ON b.memberId=u.id AND b.credentialRevision=u.credential_revision WHERE u.username IS NULL AND b.username IS NOT NULL').fetchall():
                    if not re.fullmatch(r'[a-z0-9][a-z0-9._]{2,29}', row['username']):
                        raise AuthError('账号用户名格式无效。', 'invalid')
                    self.db.execute('UPDATE users SET username=? WHERE id=?', (row['username'],row['id']))

    def allow_pending_email(self):
        if not any(row['name'] == 'email' and row['notnull'] for row in self.db.execute('PRAGMA table_info(users)')):
            return
        # SQLite requires a table rebuild to remove NOT NULL. Keep parent IDs and
        # all referencing rows, then verify foreign keys before committing the swap.
        self.db.execute('PRAGMA foreign_keys=OFF')
        try:
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                columns = {row['name'] for row in self.db.execute('PRAGMA table_info(users)')}
                if any(row['name'] == 'email' and row['notnull'] for row in self.db.execute('PRAGMA table_info(users)')):
                    self.db.execute('''CREATE TABLE users_pending_email (
                        id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL,
                        role TEXT NOT NULL, all_projects INTEGER NOT NULL, project_ids TEXT NOT NULL,
                        active INTEGER NOT NULL DEFAULT 0, credential_revision TEXT NOT NULL DEFAULT '',
                        revision TEXT NOT NULL, username TEXT)''')
                    names = 'id,email,name,role,all_projects,project_ids,active,credential_revision,revision'
                    if 'username' in columns:
                        names += ',username'
                    self.db.execute(f'INSERT INTO users_pending_email({names}) SELECT {names} FROM users')
                    self.db.execute('DROP TABLE users')
                    self.db.execute('ALTER TABLE users_pending_email RENAME TO users')
                    self.db.execute('CREATE UNIQUE INDEX users_username_unique ON users(username COLLATE NOCASE)')
                    if self.db.execute('PRAGMA foreign_key_check').fetchone():
                        raise AuthError('账号结构更新未通过关联校验。', 'invalid')
        finally:
            self.db.execute('PRAGMA foreign_keys=ON')

    def close(self):
        self.db.close()

    def audit(self, actor, action, target="", outcome="success", *, details=None, commit=True):
        self.db.execute("INSERT INTO audit(at,actor_id,actor_name,action,target,outcome,details) VALUES(?,?,?,?,?,?,?)",
                        (int(time.time()), (actor or {}).get("id", "system"), (actor or {}).get("name", "系统"), action, str(target)[:250], outcome,
                         json.dumps(details or {}, ensure_ascii=False)))
        if commit: self.db.commit()

    @staticmethod
    def audit_subject(row):
        # Keep identity at operation time; never copy email, credentials or request payloads.
        return {"id": row["id"], "name": row["name"], "username": row["username"]}

    def permission_snapshot(self, row, known):
        projects = json.loads(row["project_ids"])
        full_access = bool(row["all_projects"]) or row["role"] == "admin"
        scope = {"all": full_access, "projects": [] if full_access else [
            {"id": identity, "name": known.get(identity, identity) if isinstance(known, dict) else identity} for identity in projects]}
        state = {"active":"已启用", "email":"待验证邮箱", "setup":"待绑定验证器", "invited":"待接受邀请", "expired":"邀请已过期", "disabled":"已停用"}[self.member_info(row)["status"]]
        return {"role": ROLE_LABELS[row["role"]],
                "scope": scope,
                "remote_allowed": "允许（管理员默认）" if row["role"] == "admin" else "允许" if self.remote_allowed(row["id"]) else "不允许",
                "status": state}

    def member_audit(self, actor, action, row, before, after, note=""):
        labels = {"role": "成员角色", "scope": "事项范围", "remote_allowed": "外部 AI 工具", "status": "账号状态"}
        changes = [{"field": key, "label": labels[key], "before": before.get(key), "after": value}
                   for key, value in after.items() if before.get(key) != value]
        self.audit(actor, action, row["id"], details={"subject": self.audit_subject(row), "changes": changes, "note": note}, commit=False)

    def audit_entries(self, request):
        scope, before = request.get("scope", "all"), request.get("before", 9223372036854775807)
        if scope not in ("all", "members") or type(before) is not int or not 0 < before <= 9223372036854775807:
            raise AuthError("操作记录查询条件无效。", "invalid")
        predicate = " AND action IN (" + ",".join("?" for _ in MEMBER_AUDIT_ACTIONS) + ")" if scope == "members" else ""
        values = (before, *MEMBER_AUDIT_ACTIONS) if scope == "members" else (before,)
        rows = self.db.execute("SELECT * FROM audit WHERE id<?" + predicate + " ORDER BY id DESC LIMIT 101", values).fetchall()
        entries = []
        for row in rows[:100]:
            item = dict(row)
            details = json.loads(item.pop("details"))
            subject = details.get("subject")
            if subject:
                item["subject"] = {**subject, "source": "recorded"}
            elif row["action"].startswith("account.") or row["action"] in ("remote.grant", "remote.ungrant"):
                current = self.db.execute("SELECT * FROM users WHERE id=?", (row["target"],)).fetchone()
                item["subject"] = {**self.audit_subject(current), "source": "current"} if current else None
            else:
                item["subject"] = None
            item["changes"], item["note"] = details.get("changes"), details.get("note", "")
            entries.append(item)
        return {"entries": entries, "next_before": entries[-1]["id"] if len(rows) > 100 else None}

    def session(self, token):
        # Better Auth has already verified the signed cookie in Node. Check its persisted
        # session again under the business lock so revocation wins over queued writes.
        if not token or not self.has_provider():
            raise AuthError("请登录后继续。", "unauthenticated")
        row = self.db.execute("""SELECT u.*,b.emailVerified AS email_verified,s.csrf,CAST(strftime('%s',s.expiresAt) AS INTEGER) AS expires FROM ba_session s
            JOIN ba_user b ON b.id=s.userId JOIN users u ON u.id=b.memberId
            WHERE s.token=? AND CAST(strftime('%s',s.expiresAt) AS INTEGER)>? AND u.active=1 AND b.twoFactorEnabled=1
            AND s.mfaVerified=1 AND s.permissionRevision=u.revision
            AND b.credentialRevision=u.credential_revision""", (token, int(time.time()))).fetchone()
        if not row or (email_verification_required() and not row["email_verified"]):
            raise AuthError("登录已失效，请重新登录。", "unauthenticated")
        return public_user(row) | {"csrf": row["csrf"], "expires": row["expires"], "email_verified": bool(row["email_verified"])}

    def has_provider(self):
        return bool(self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ba_session'").fetchone())

    def revoke(self, identity):
        for table in ("remote_tokens", "remote_drafts", "remote_writes", "remote_intakes"):
            if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                self.db.execute("DELETE FROM " + table + " WHERE owner=?", (identity,))
        if self.has_provider():
            row = self.db.execute("SELECT email FROM users WHERE id=?", (identity,)).fetchone()
            if row and row["email"]:
                self.db.execute("DELETE FROM ba_verification WHERE identifier IN (?,?)", ("email-verification-otp-" + row["email"], "bd-email-send-" + row["email"]))
            self.db.execute("DELETE FROM ba_session WHERE userId IN (SELECT id FROM ba_user WHERE memberId=?)", (identity,))
            self.db.execute("DELETE FROM ba_verification WHERE value IN (SELECT id FROM ba_user WHERE memberId=?)", (identity,))

    def enrolled(self, identity):
        return self.has_provider() and bool(self.db.execute("SELECT 1 FROM ba_user b JOIN users u ON u.id=b.memberId WHERE u.id=? AND b.credentialRevision=u.credential_revision AND b.twoFactorEnabled=1", (identity,)).fetchone())

    def email_allowed(self, identity):
        if not email_verification_required():
            return True
        return self.has_provider() and bool(self.db.execute("SELECT 1 FROM ba_user b JOIN users u ON u.id=b.memberId WHERE u.id=? AND b.credentialRevision=u.credential_revision AND b.emailVerified=1", (identity,)).fetchone())

    @staticmethod
    def require_admin(actor):
        if not actor or actor["role"] != "admin":
            raise AuthError("此操作需要管理员权限。")

    @staticmethod
    def email(value):
        value = str(value or "").strip().lower()
        if len(value) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise AuthError("请填写有效的邮箱地址。", "invalid")
        return value

    @staticmethod
    def permissions(payload, known):
        role = payload.get("role", "viewer")
        all_projects = payload.get("all_projects", False)
        projects = payload.get("project_ids", [])
        if role not in {"admin", "editor", "viewer"} or type(all_projects) is not bool or not isinstance(projects, list) or any(not isinstance(x, str) or x not in known for x in projects):
            raise AuthError("角色或事项授权无效。", "invalid")
        if role == "admin":
            all_projects, projects = True, []
        return role, all_projects, sorted(set(projects)) if not all_projects else []

    def remote_allowed(self, identity):
        # Role-derived eligibility is separate from activation, the global switch and credentials.
        return bool(self.db.execute("""SELECT 1 FROM users u WHERE u.id=? AND
            (u.role='admin' OR EXISTS (SELECT 1 FROM remote_grants g WHERE g.owner=u.id))""", (identity,)).fetchone())

    def remote_enabled(self):
        if not self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_settings'").fetchone():
            return False
        row = self.db.execute("SELECT enabled FROM remote_settings WHERE id=1").fetchone()
        return bool(row and row["enabled"])

    @staticmethod
    def remote_permission(payload, default=False):
        allowed = payload.get("remote_allowed", default)
        if type(allowed) is not bool:
            raise AuthError("外部 AI 工具权限无效。", "invalid")
        return allowed

    def set_remote_allowed(self, identity, allowed):
        # Called inside the account transaction; never creates a personal credential.
        administrator = bool(self.db.execute("SELECT 1 FROM users WHERE id=? AND role='admin'", (identity,)).fetchone())
        if allowed and not administrator:
            self.db.execute("INSERT OR IGNORE INTO remote_grants VALUES(?)", (identity,))
        else:
            # Never persist an administrator's implicit access as an ordinary member grant.
            self.db.execute("DELETE FROM remote_grants WHERE owner=?", (identity,))
        if not allowed and not administrator:
            for table in ("remote_tokens", "remote_drafts", "remote_writes", "remote_intakes"):
                if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    self.db.execute("DELETE FROM " + table + " WHERE owner=?", (identity,))

    def invite(self, payload, actor, known, bootstrap=False):
        if not bootstrap:
            self.require_admin(actor)
        supplied = payload.get("email")
        empty_email = supplied is None or (isinstance(supplied, str) and not supplied.strip())
        email = self.email(supplied) if bootstrap or not empty_email else None
        name = str(payload.get("name", "")).strip()
        if not 1 <= len(name) <= 100:
            raise AuthError("请填写成员姓名（不超过 100 个字符）。", "invalid")
        role, all_projects, projects = self.permissions(payload, known)
        remote_allowed = self.remote_permission(payload)
        remote_allowed = role == "admin" or remote_allowed
        with self.db:
            if bootstrap and self.db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                raise AuthError("管理员已初始化，请通过成员管理邀请其他账号。", "conflict")
            if email and self.db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone():
                raise AuthError("该邮箱已有账号，请在成员列表中重新签发邀请或重置登录。", "conflict")
            identity = secrets.token_hex(16)
            self.db.execute("INSERT INTO users(id,email,name,role,all_projects,project_ids,revision,credential_revision) VALUES(?,?,?,?,?,?,?,?)",
                            (identity, email, name, role, int(all_projects), json.dumps(projects), secrets.token_hex(16), secrets.token_hex(16)))
            self.set_remote_allowed(identity, remote_allowed)
            invitation = self.new_invitation(identity)
            row = self.db.execute("SELECT * FROM users WHERE id=?", (identity,)).fetchone()
            self.member_audit(actor, "account.invite", row, {}, self.permission_snapshot(row, known), "邀请有效期 48 小时，需由成员本人激活。")
        return invitation

    def new_invitation(self, identity):
        self.db.execute("DELETE FROM invitations WHERE user_id=?", (identity,))
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + 48 * 3600
        self.db.execute("INSERT INTO invitations VALUES(?,?,?)", (fingerprint(token), identity, expires))
        return {"token": token, "expires": expires}

    def invitation(self, token):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,100}", token):
            raise AuthError("邀请链接无效或已过期。", "unauthenticated")
        row = self.db.execute("SELECT i.*,u.email,u.name,u.username FROM invitations i JOIN users u ON i.user_id=u.id WHERE i.digest=? AND i.expires>?", (fingerprint(token), int(time.time()))).fetchone()
        if not row:
            raise AuthError("邀请链接无效或已过期。", "unauthenticated")
        return row

    def invite_info(self, token):
        row = self.invitation(token)
        return {"email": row["email"], "name": row["name"], "username": row["username"], "expires": row["expires"]}

    def member_info(self, row):
        invitation = self.db.execute('SELECT expires FROM invitations WHERE user_id=?', (row['id'],)).fetchone()
        status = ('active' if self.enrolled(row['id']) else 'setup') if row['active'] else (
            ('invited' if invitation['expires'] > time.time() else 'expired') if invitation else 'disabled')
        if row['active'] and not self.email_allowed(row['id']):
            status = 'email'
        return public_user(row) | {'status': status, 'invitation_expires': invitation['expires'] if invitation else None, 'remote_allowed': self.remote_allowed(row['id'])}

    def update(self, payload, actor, known):
        self.require_admin(actor)
        role, all_projects, projects = self.permissions(payload, known)
        if type(payload.get("active")) is not bool:
            raise AuthError("账号状态无效。", "invalid")
        with self.db:
            row = self.db.execute("SELECT * FROM users WHERE id=?", (payload.get("id"),)).fetchone()
            if not row or payload.get("revision") != row["revision"]:
                raise AuthError("成员信息已变化，请刷新后重试。", "conflict")
            before = self.permission_snapshot(row, known)
            was_allowed = self.remote_allowed(row["id"])
            # Demotion requires a deliberate grant; even an older explicit admin grant must not carry over.
            remote_allowed = self.remote_permission(payload, was_allowed if row["role"] != "admin" else False)
            remote_allowed = role == "admin" or remote_allowed
            if "remote_allowed" in payload and (type(payload.get("remote_allowed_before")) is not bool or payload["remote_allowed_before"] != was_allowed):
                raise AuthError("外部 AI 工具权限已变化，请刷新后重试。", "conflict")
            if payload["active"] and not row["active"] and not self.enrolled(row["id"]):
                raise AuthError("成员须先通过邀请设置登录信息。", "invalid")
            others = sum(self.enrolled(r[0]) for r in self.db.execute("SELECT id FROM users WHERE role='admin' AND active=1 AND id!=?", (row["id"],)).fetchall())
            if row["role"] == "admin" and row["active"] and not others and (role != "admin" or not payload["active"]):
                raise AuthError("至少保留一名已启用的管理员。", "conflict")
            self.db.execute("UPDATE users SET role=?,all_projects=?,project_ids=?,active=?,revision=? WHERE id=?",
                            (role, int(all_projects), json.dumps(projects), int(payload["active"]), secrets.token_hex(16), row["id"]))
            self.revoke(row["id"])
            self.set_remote_allowed(row["id"], remote_allowed)
            # Editing an unaccepted invitation must not silently cancel its link.
            if row["active"] or payload["active"]:
                self.db.execute("DELETE FROM invitations WHERE user_id=?", (row["id"],))
            updated = self.db.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
            preserved_invitation = self.db.execute("SELECT 1 FROM invitations WHERE user_id=?", (row["id"],)).fetchone()
            note = "原有登录和工具凭据已失效。" + ("原邀请链接及到期时间保留。" if preserved_invitation else "账号已停用。" if not payload["active"] else "需重新登录。")
            self.member_audit(actor, "account.permissions", row, before, self.permission_snapshot(updated, known), note)
        return {"saved": True}

    def reset(self, identity, actor, recovery=False):
        if not recovery:
            self.require_admin(actor)
        row = self.db.execute("SELECT * FROM users WHERE id=? OR email=?", (identity, identity)).fetchone()
        if not row:
            raise AuthError("未找到成员。", "not_found")
        if not recovery and row["id"] == actor["id"]:
            raise AuthError("请由另一名管理员重置，或在服务器上使用账号恢复命令。", "invalid")
        before_status = self.permission_snapshot(row, {})["status"]
        with self.db:
            result = self.new_invitation(row["id"])
            self.revoke(row["id"])
            # Reject old provider credentials and pending MFA challenges immediately.
            self.db.execute("UPDATE users SET active=0,credential_revision=?,revision=? WHERE id=?", (secrets.token_hex(16), secrets.token_hex(16), row["id"]))
            self.member_audit(actor, "account.reset", row, {"status": before_status}, {"status": "待接受邀请"},
                              "已签发新的 48 小时邀请；旧邀请、登录和工具凭据失效。原角色和事项权限保留，需重新设置密码及身份验证器。")
        return result

    def dispatch(self, action, request, actor, known):
        if action == "auth_invite_info": return self.invite_info(request.get("token"))
        if action == "auth_session": return actor
        self.require_admin(actor)
        if action == "team_list":
            return {"users": [self.member_info(row) for row in self.db.execute("SELECT * FROM users ORDER BY name")], "remote_enabled": self.remote_enabled()}
        if action == "team_invite": return self.invite(request, actor, known)
        if action == "team_update": return self.update(request, actor, known)
        if action == "team_reset": return self.reset(request.get("id"), actor)
        if action == "team_audit":
            return self.audit_entries(request)
        raise AuthError("未知账号操作。", "invalid")


def backup_accounts(content, destination):
    """Consistent SQLite snapshot without transferable sessions or invitations."""
    path = Path(content).resolve().parent / '.bd-auth' / 'accounts.sqlite3'
    if not path.exists(): return False
    accounts = Accounts(content)
    try:
        with closing(sqlite3.connect(destination)) as backup:
            accounts.db.backup(backup)
            with backup:
                clear_transient_access(backup)
            # Rebuild pages so deleted session/challenge tokens are not recoverable from the ZIP.
            backup.execute("VACUUM")
    finally:
        accounts.close()
    os.chmod(destination, 0o600)
    return True


def validate_account_backup(path):
    with closing(sqlite3.connect(path)) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
            raise AuthError('账号备份校验失败。', 'invalid')
        if db.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger')").fetchone():
            raise AuthError('账号备份包含不支持的数据库对象。', 'invalid')
        columns = {row[1] for row in db.execute('PRAGMA table_info(users)')}
        current = {'id','email','name','role','all_projects','project_ids','active','credential_revision','revision'}
        if columns not in (current, current | {'username'}):
            raise AuthError('账号备份格式不受支持。', 'invalid')
        for row in db.execute('SELECT email,active FROM users'):
            if row[0] is None:
                if row[1]:
                    raise AuthError('已激活账号不能缺少邮箱。', 'invalid')
            elif Accounts.email(row[0]) != row[0]:
                raise AuthError('账号邮箱格式无效。', 'invalid')
        if 'username' in columns:
            names = [row[0] for row in db.execute('SELECT username FROM users WHERE username IS NOT NULL')]
            if any(not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._]{2,29}', name) for name in names) or len(names) != len(set(names)):
                raise AuthError('账号用户名格式无效或重复。', 'invalid')
        with db:
            clear_transient_access(db)
        db.execute("VACUUM")


def clear_transient_access(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in ('invitations', 'ba_session', 'ba_verification', 'ba_rate_limit',
                  'remote_tokens', 'remote_drafts', 'remote_writes', 'remote_intakes', 'remote_attempts', 'remote_grants', 'remote_settings'):
        if table in tables:
            db.execute('DELETE FROM ' + table)
