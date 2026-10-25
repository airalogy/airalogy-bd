#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["oss2>=2.19,<3"]
# ///
"""OSS transport; credentials come exclusively from the deployment environment."""
from __future__ import annotations
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def settings():
    region = os.environ.get("BD_OSS_REGION", "")
    bucket = os.environ.get("BD_OSS_BUCKET", "")
    endpoint = os.environ.get("BD_OSS_ENDPOINT", "")
    prefix = os.environ.get("BD_OSS_PREFIX", "bd-backups").strip("/")
    url = urlparse(endpoint)
    expected = {f"oss-{region}.aliyuncs.com", f"oss-{region}-internal.aliyuncs.com"}
    if not re.fullmatch(r"[a-z0-9-]+", region) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
        raise ValueError("请在服务器环境中设置有效的 OSS 地域和存储空间。")
    if url.scheme != "https" or url.hostname not in expected or url.port not in {None, 443} or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
        raise ValueError("OSS Endpoint 必须是对应地域的阿里云 HTTPS 地址。")
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", prefix):
        raise ValueError("OSS 备份前缀无效。")
    return {"region": region, "bucket": bucket, "endpoint": endpoint, "prefix": prefix}


def make_bucket(config):
    import oss2
    from oss2.credentials import EnvironmentVariableCredentialsProvider
    return oss2.Bucket(oss2.ProviderAuthV4(EnvironmentVariableCredentialsProvider()), config["endpoint"], config["bucket"], region=config["region"], connect_timeout=30, enable_crc=True)


def upload(path, key, expected_sha, client=None):
    config = settings()
    if not key.startswith(config["prefix"] + "/") or ".." in key.split("/") or "\\" in key:
        raise ValueError("OSS 备份位置无效。")
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise ValueError("未找到待上传的完整备份。")
    sha, md5 = hashlib.sha256(), hashlib.md5()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(block); md5.update(block)
    if sha.hexdigest() != expected_sha:
        raise ValueError("上传前备份校验失败。")
    bucket = client or make_bucket(config)
    if bucket.get_bucket_acl().acl != "private":
        raise ValueError("请先将 OSS 存储空间设为私有，再启用备份。")
    headers = {"Content-MD5": base64.b64encode(md5.digest()).decode(), "Content-Type": "application/zip", "x-oss-meta-sha256": expected_sha,
               "x-oss-forbid-overwrite": "true", "x-oss-object-acl": "private", "x-oss-server-side-encryption": "AES256"}
    bucket.put_object_from_file(key, str(path), headers=headers)
    remote = bucket.head_object(key)
    if remote.content_length != path.stat().st_size or remote.headers.get("x-oss-meta-sha256") != expected_sha:
        raise ValueError("OSS 上传后的大小或校验信息不一致，未标记为成功。")
    return {"bucket": config["bucket"], "key": key, "size": path.stat().st_size, "sha256": expected_sha}


def main():
    request = json.load(sys.stdin)
    try:
        result = upload(request["path"], request["key"], request["sha256"])
        print(json.dumps({"ok": True, "result": result}))
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
    except Exception as error:
        # SDK exceptions can include signed requests. Never return those to the UI or logs.
        status = getattr(error, "status", None)
        print(json.dumps({"ok": False, "error": f"OSS 备份未完成（{type(error).__name__}" + (f"，HTTP {status}" if isinstance(status, int) else "") + "）。请检查凭据权限、网络和存储空间配置。"}, ensure_ascii=False))

if __name__ == "__main__": main()
