"""Progress supplements reuse owner-bound drafts and durable write receipts."""
import hashlib
import json
import re
import secrets
import time
from team_auth import AuthError
from progress_supplements import Supplements, FIELDS

READ = {"read_progress_supplements", "read_meeting_supplements"}
HISTORY = {"progress_supplement_history", "meeting_supplement_history"}
DIRECT = {"save_progress_supplement", "save_meeting_supplement"}
LEGACY = {"read_meeting_supplements", "meeting_supplement_history", "submit_meeting_supplement", "save_meeting_supplement"}
TOOLS = READ | HISTORY | DIRECT | {"submit_progress_supplement", "submit_meeting_supplement"}
LABELS = {"title": "补充标题", "date": "补充日期", "body": "补充正文"}


def tool(remote, op, args, actor, token, policy):
    from remote_access import exact, text
    policy.project(text(args.get("matter_id")))
    workspace = remote.workspace
    workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
    supplements = Supplements(workspace)
    target_key = "meeting_id" if op in LEGACY else "progress_id"
    base = {"action": "supplements", "kind": "supplement", "project_id": args["matter_id"], "event_id": text(args.get(target_key)), "id": text(args.get("id", ""), 160, True)}
    if op in READ | HISTORY:
        exact(args, {"matter_id", target_key, "id", "snapshot"} if op in READ else {"matter_id", target_key, "id", "offset", "version"}, {"matter_id", target_key})
        request = {**base, "operation": "read" if base["id"] else "list"} if op in READ else {**base, "operation": "version" if args.get("version") else "history"}
        result = supplements.execute({**request, **{k: args[k] for k in ("snapshot", "offset", "version") if k in args}})
        if op in LEGACY and "progress_title" in result:
            result["meeting_title"] = result.pop("progress_title")
        return result
    if not token["can_draft"] or actor["role"] == "viewer": raise AuthError("此连接只允许查询。")
    direct = op in DIRECT
    if direct and (not token["can_save"] or actor["role"] != "admin"):
        raise AuthError("此连接只允许提交草稿，请在网页确认。")
    exact(args, {"matter_id", target_key, "id", "revision", "request_id", "changes"}, {"matter_id", target_key, "revision", "request_id", "changes"})
    request_id = text(args["request_id"], 80)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id): raise AuthError("请提供至少 16 位唯一请求编号。", "invalid")
    signature = hashlib.sha256(json.dumps({"tool": op, "arguments": args}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    for table in ("remote_drafts", "remote_writes"):
        old = remote.db.execute("SELECT * FROM " + table + " WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone()
        if old:
            if old["fingerprint"] != signature: raise AuthError("同一请求编号不能用于不同内容或操作。", "conflict")
            return remote.write_receipt(old) if table == "remote_writes" else remote.receipt(old)
    current = supplements.read(base)
    exact(args["changes"], FIELDS)
    if not args["changes"]: raise AuthError("请提供补充内容。", "invalid")
    previous = {key: current.get("record", {}).get(key, "") for key in FIELDS}
    payload = {**previous, **args["changes"]}
    receipt_id, created = secrets.token_hex(16), int(time.time())
    # Service receipts are namespaced by connection to avoid collisions with web saves.
    saved = {**base, "operation": "save", "revision": text(args["revision"]), "request_id": receipt_id, "payload": payload}
    supplements.execute(saved, preview=True)
    table = "remote_writes" if direct else "remote_drafts"
    if remote.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] >= 2000 or (not direct and remote.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'", (actor["id"],)).fetchone()[0] >= 20):
        raise AuthError("请求记录已达上限，请先处理待确认修改。", "rate_limited")
    if not direct:
        matter, progress = supplements.context(workspace.read_files(), base)
        review = {"matterId": args["matter_id"], "matterName": matter[1]["name"], "counterparty": "",
                  "operation": "update_supplement" if base["id"] else "add_supplement",
                  "progressTitle": progress["event"]["title"] + " · " + (payload["title"] or "补充记录"), "progressDate": payload["date"],
                  "changes": [{"field": key, "label": LABELS[key], "before": previous[key] if base["id"] else None, "after": payload[key]} for key in ("title", "date", "body")]}
        with remote.db:
            remote.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)", (receipt_id, actor["id"], token["id"], actor["revision"], request_id, signature, args["matter_id"], json.dumps({"request": saved, "review": review}, ensure_ascii=False), created, min(created + 86400, token["expires"])))
        return remote.receipt(remote.db.execute("SELECT * FROM remote_drafts WHERE id=?", (receipt_id,)).fetchone())
    with remote.db:
        remote.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)", (receipt_id, actor["id"], token["id"], actor["revision"], request_id, signature, args["matter_id"], created, token["expires"]))
    remote.accounts.audit(actor, "remote." + op, receipt_id, "started")
    try:
        result = supplements.execute(saved)
        receipt = {"write_id": receipt_id, "request_id": request_id, "status": "saved", "id": result["id"], "revision": result["revision"], "history_version": result["status"]["version"], "message": "补充记录已保存，请回读核对。"}
        with remote.db:
            remote.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False), receipt_id))
    except Exception as exc:
        with remote.db: remote.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?", (receipt_id,))
        remote.accounts.audit(actor, "remote." + op, receipt_id, "failed")
        raise AuthError("保存结果需要核对，请保留请求编号并回读补充及历史，不要换编号重试。", "uncertain") from exc
    remote.accounts.audit(actor, "remote." + op, receipt_id, "success")
    return receipt
