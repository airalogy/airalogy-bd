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


def public_user(row):
    return {key: row[key] for key in ("id", "email", "name", "role", "active", "revision")} | {
        "all_projects": bool(row["all_projects"]), "project_ids": json.loads(row["project_ids"]),
    }


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
                id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                role TEXT NOT NULL, all_projects INTEGER NOT NULL, project_ids TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 0, credential_revision TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS invitations (
                digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
                actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
                target TEXT NOT NULL, outcome TEXT NOT NULL);
        """)

    def close(self):
        self.db.close()

    def audit(self, actor, action, target="", outcome="success"):
        self.db.execute("INSERT INTO audit(at,actor_id,actor_name,action,target,outcome) VALUES(?,?,?,?,?,?)",
                        (int(time.time()), (actor or {}).get("id", "system"), (actor or {}).get("name", "系统"), action, str(target)[:250], outcome))
        self.db.commit()

    def session(self, token):
        # Better Auth has already verified the signed cookie in Node. Check its persisted
        # session again under the business lock so revocation wins over queued writes.
        if not token or not self.has_provider():
            raise AuthError("请登录后继续。", "unauthenticated")
        row = self.db.execute("""SELECT u.*,s.csrf,CAST(strftime('%s',s.expiresAt) AS INTEGER) AS expires FROM ba_session s
            JOIN ba_user b ON b.id=s.userId JOIN users u ON u.id=b.memberId
            WHERE s.token=? AND CAST(strftime('%s',s.expiresAt) AS INTEGER)>? AND u.active=1 AND b.twoFactorEnabled=1
            AND s.mfaVerified=1 AND s.permissionRevision=u.revision
            AND b.credentialRevision=u.credential_revision""", (token, int(time.time()))).fetchone()
        if not row:
            raise AuthError("登录已失效，请重新登录。", "unauthenticated")
        return public_user(row) | {"csrf": row["csrf"], "expires": row["expires"]}

    def has_provider(self):
        return bool(self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ba_session'").fetchone())

    def revoke(self, identity):
        for table in ("remote_tokens", "remote_drafts"):
            if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                self.db.execute("DELETE FROM " + table + " WHERE owner=?", (identity,))
        if self.has_provider():
            self.db.execute("DELETE FROM ba_session WHERE userId IN (SELECT id FROM ba_user WHERE memberId=?)", (identity,))
            self.db.execute("DELETE FROM ba_verification WHERE value IN (SELECT id FROM ba_user WHERE memberId=?)", (identity,))

    def enrolled(self, identity):
        return self.has_provider() and bool(self.db.execute("SELECT 1 FROM ba_user b JOIN users u ON u.id=b.memberId WHERE u.id=? AND b.credentialRevision=u.credential_revision AND b.twoFactorEnabled=1", (identity,)).fetchone())

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

    def invite(self, payload, actor, known, bootstrap=False):
        if not bootstrap:
            self.require_admin(actor)
        email = self.email(payload.get("email"))
        name = str(payload.get("name", "")).strip()
        if not 1 <= len(name) <= 100:
            raise AuthError("请填写成员姓名（不超过 100 个字符）。", "invalid")
        role, all_projects, projects = self.permissions(payload, known)
        with self.db:
            if bootstrap and self.db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                raise AuthError("管理员已初始化，请通过成员管理邀请其他账号。", "conflict")
            if self.db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
                raise AuthError("该邮箱已有账号，请在成员列表中重新签发邀请或重置登录。", "conflict")
            identity = secrets.token_hex(16)
            self.db.execute("INSERT INTO users(id,email,name,role,all_projects,project_ids,revision,credential_revision) VALUES(?,?,?,?,?,?,?,?)",
                            (identity, email, name, role, int(all_projects), json.dumps(projects), secrets.token_hex(16), secrets.token_hex(16)))
            invitation = self.new_invitation(identity)
        self.audit(actor, "account.invite", identity)
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
        row = self.db.execute("SELECT i.*,u.email,u.name FROM invitations i JOIN users u ON i.user_id=u.id WHERE i.digest=? AND i.expires>?", (fingerprint(token), int(time.time()))).fetchone()
        if not row:
            raise AuthError("邀请链接无效或已过期。", "unauthenticated")
        return row

    def invite_info(self, token):
        row = self.invitation(token)
        return {"email": row["email"], "name": row["name"], "expires": row["expires"]}

    def update(self, payload, actor, known):
        self.require_admin(actor)
        role, all_projects, projects = self.permissions(payload, known)
        if type(payload.get("active")) is not bool:
            raise AuthError("账号状态无效。", "invalid")
        with self.db:
            row = self.db.execute("SELECT * FROM users WHERE id=?", (payload.get("id"),)).fetchone()
            if not row or payload.get("revision") != row["revision"]:
                raise AuthError("成员信息已变化，请刷新后重试。", "conflict")
            if payload["active"] and not self.enrolled(row["id"]):
                raise AuthError("成员须先通过邀请设置登录信息。", "invalid")
            others = sum(self.enrolled(r[0]) for r in self.db.execute("SELECT id FROM users WHERE role='admin' AND active=1 AND id!=?", (row["id"],)).fetchall())
            if row["role"] == "admin" and row["active"] and not others and (role != "admin" or not payload["active"]):
                raise AuthError("至少保留一名已启用的管理员。", "conflict")
            self.db.execute("UPDATE users SET role=?,all_projects=?,project_ids=?,active=?,revision=? WHERE id=?",
                            (role, int(all_projects), json.dumps(projects), int(payload["active"]), secrets.token_hex(16), row["id"]))
            self.revoke(row["id"])
            self.db.execute("DELETE FROM invitations WHERE user_id=?", (row["id"],))
        self.audit(actor, "account.permissions", row["id"])
        return {"saved": True}

    def reset(self, identity, actor, recovery=False):
        if not recovery:
            self.require_admin(actor)
        row = self.db.execute("SELECT * FROM users WHERE id=? OR email=?", (identity, identity)).fetchone()
        if not row:
            raise AuthError("未找到成员。", "not_found")
        if not recovery and row["id"] == actor["id"]:
            raise AuthError("请由另一名管理员重置，或在服务器上使用账号恢复命令。", "invalid")
        with self.db:
            result = self.new_invitation(row["id"])
            self.revoke(row["id"])
            # Reject old provider credentials and pending MFA challenges immediately.
            self.db.execute("UPDATE users SET active=0,credential_revision=?,revision=? WHERE id=?", (secrets.token_hex(16), secrets.token_hex(16), row["id"]))
        self.audit(actor, "account.reset", row["id"])
        return result

    def dispatch(self, action, request, actor, known):
        if action == "auth_invite_info": return self.invite_info(request.get("token"))
        if action == "auth_session": return actor
        self.require_admin(actor)
        if action == "team_list":
            return {"users": [public_user(row) for row in self.db.execute("SELECT * FROM users ORDER BY name")]}
        if action == "team_invite": return self.invite(request, actor, known)
        if action == "team_update": return self.update(request, actor, known)
        if action == "team_reset": return self.reset(request.get("id"), actor)
        if action == "team_audit":
            return {"entries": [dict(row) for row in self.db.execute("SELECT * FROM audit WHERE id<? ORDER BY id DESC LIMIT 100", (int(request.get("before", 9223372036854775807)),))]}
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
        if columns != current:
            raise AuthError('账号备份格式不受支持。', 'invalid')
        with db:
            clear_transient_access(db)
        db.execute("VACUUM")


def clear_transient_access(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in ('invitations', 'ba_session', 'ba_verification', 'ba_rate_limit',
                  'remote_tokens', 'remote_drafts', 'remote_attempts', 'remote_grants', 'remote_settings'):
        if table in tables:
            db.execute('DELETE FROM ' + table)
