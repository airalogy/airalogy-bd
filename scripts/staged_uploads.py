"""Private, short-lived uploads. Bytes are never business records until a save succeeds.

All calls run under the workspace lock. IDs are opaque, but are not credentials:
every access also checks the current account/connection binding and matter.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import time
from pathlib import Path

from file_library import EXTENSIONS, MAX_BYTES, LibraryError, text


class UploadStore:
    def __init__(self, workspace):
        self.workspace = workspace
        self.root = workspace.store / "uploads"
        if self.root.is_symlink():
            raise LibraryError("暂存目录无效。", "unsafe_path")
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.scope = workspace.upload_scope

    def path(self, identity, suffix):
        if not isinstance(identity, str) or not re.fullmatch(r"upload-[a-f0-9]{32}", identity):
            raise LibraryError("上传编号无效。")
        path = self.root / (identity + suffix)
        if path.is_symlink():
            raise LibraryError("暂存文件无效。", "unsafe_path")
        return path

    def remove(self, identity):
        for suffix in (".json", ".bin"):
            self.path(identity, suffix).unlink(missing_ok=True)

    def cleanup(self):
        records = []
        for path in self.root.glob("upload-*.json"):
            value = json.loads(self.path(path.stem, ".json").read_text())
            if value["expires"] <= int(time.time()):
                self.remove(value["upload_id"])
            else:
                records.append(value)
        # A killed upload may leave bytes before its metadata is published.
        for path in self.root.glob("upload-*.bin"):
            if not self.path(path.stem, ".json").exists():
                self.path(path.stem, ".bin").unlink()
        return records

    def prepare(self, matter, filename, size, sha256):
        filename = text(filename, "文件名", limit=180)
        if "/" in filename or "\\" in filename or Path(filename).suffix.lower() not in EXTENSIONS:
            raise LibraryError("请选择 PDF、Office 文档、图片、文本或 ZIP 文件。")
        if type(size) is not int or not 0 < size <= MAX_BYTES:
            raise LibraryError("单个文件须非空且不超过 50 MB。", "too_large")
        if not isinstance(sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise LibraryError("请提供文件的 SHA-256 指纹。")
        if matter not in self.workspace.projects(self.workspace.read_files()):
            raise LibraryError("请选择现有事项。")
        if self.workspace.policy:
            self.workspace.policy.project(matter)
        records = self.cleanup()
        owned = [v for v in records if v["scope"]["owner"] == self.scope["owner"]]
        if len(owned) >= 20 or sum(v["size"] for v in owned) + size > 250 * 1024 * 1024 or sum(v["size"] for v in records) + size > 1024 * 1024 * 1024:
            raise LibraryError("暂存文件已达上限，请移除不用的上传或等待到期。", "rate_limited")
        now = int(time.time())
        value = {"upload_id": "upload-" + secrets.token_hex(16), "scope": self.scope, "matter_id": matter,
                 "filename": filename, "size": size, "sha256": sha256, "ready": False,
                 "expires": min(now + 86400, self.scope.get("expires", now + 86400))}
        self.workspace.atomic(self.path(value["upload_id"], ".json"), json.dumps(value))
        return self.public(value)

    def read(self, identity, matter=None):
        self.cleanup()
        path = self.path(identity, ".json")
        if not path.is_file():
            raise LibraryError("上传已失效或已使用，请重新上传。", "upload_expired")
        value = json.loads(path.read_text())
        if value["scope"] != self.scope or (matter is not None and value["matter_id"] != matter):
            raise LibraryError("不能访问其他账号、连接或事项的上传。", "forbidden")
        if self.workspace.policy:
            self.workspace.policy.project(value["matter_id"])
        return value

    @staticmethod
    def public(value):
        return {k: value[k] for k in ("upload_id", "matter_id", "filename", "size", "sha256", "ready", "expires")}

    def write(self, identity, filename, encoded):
        value = self.read(identity)
        if filename != value["filename"] or not isinstance(encoded, str) or len(encoded) > (MAX_BYTES + 2) // 3 * 4:
            raise LibraryError("文件与上传申请不符。")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise LibraryError("文件内容读取失败。")
        if len(data) != value["size"] or hashlib.sha256(data).hexdigest() != value["sha256"]:
            raise LibraryError("文件大小或指纹与上传申请不符。")
        target = self.path(identity, ".bin")
        if value["ready"]:
            if not target.is_file() or target.read_bytes() != data:
                raise LibraryError("暂存文件内容已改变，请重新上传。", "conflict")
            return self.public(value)
        with target.open("wb") as stream:
            os.chmod(target, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        value["ready"] = True
        self.workspace.atomic(self.path(identity, ".json"), json.dumps(value))
        return self.public(value)

    def bytes(self, identity, matter):
        value = self.read(identity, matter)
        if value.get("claim") and value["claim"] != getattr(self.workspace, "upload_claim", None):
            raise LibraryError("此上传已关联另一份待确认草稿。", "conflict")
        path = self.path(identity, ".bin")
        if not value["ready"] or not path.is_file():
            raise LibraryError("文件尚未上传完成。")
        data = path.read_bytes()
        if len(data) != value["size"] or hashlib.sha256(data).hexdigest() != value["sha256"]:
            raise LibraryError("暂存文件校验失败，请重新上传。", "conflict")
        return value, data

    def claim(self, identities, claim):
        for identity in identities:
            value = self.read(identity)
            if claim is not None and value.get("claim") and value["claim"] != claim:
                raise LibraryError("此上传已关联另一份待确认草稿。", "conflict")
            value["claim"] = claim
            self.workspace.atomic(self.path(identity, ".json"), json.dumps(value))

    def dispatch(self, request):
        if request["action"] == "upload_discard":
            self.read(request.get("upload_id"))
            self.remove(request["upload_id"])
            return {"discarded": True}
        encoded = request.get("data")
        if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES + 2) // 3 * 4:
            raise LibraryError("单个文件不能超过 50 MB。", "too_large")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise LibraryError("文件内容读取失败。")
        value = self.prepare(request.get("project_id"), request.get("filename"), len(data), hashlib.sha256(data).hexdigest())
        return self.write(value["upload_id"], value["filename"], encoded)
