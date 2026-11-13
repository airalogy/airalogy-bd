"""Task access follows existing owner-bound MCP grants, drafts and receipts."""
import hashlib
import json
import re
import secrets
import time
from team_auth import AuthError
from matter_tasks import Tasks, FIELDS, STATES

TOOLS = {"search_tasks", "read_task", "task_history", "task_assignees", "submit_task", "save_task"}
LABELS = {"title":"待办内容","body":"说明","state":"状态","assignee_id":"负责人","due_date":"截止日期","source_progress_id":"来源进展","completion_note":"完成备注"}


def tool(remote, op, args, actor, token, policy):
    from remote_access import exact, text
    workspace = remote.workspace
    workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
    tasks = Tasks(workspace)
    if op == "search_tasks":
        exact(args, {"matter_id","query","state","scope","due","assignee_id","offset","snapshot"})
        return tasks.execute({"operation":"list", **{("project_id" if k=="matter_id" else k):v for k,v in args.items()}})
    policy.project(text(args.get("matter_id")))
    base = {"action":"tasks", "kind":"task", "project_id":args["matter_id"], "id":text(args.get("id", ""),160,True)}
    if op in {"read_task","task_history","task_assignees"}:
        exact(args, {"matter_id","id","snapshot","offset","version"}, {"matter_id"})
        operation = "read" if op=="read_task" else "assignees" if op=="task_assignees" else "version" if args.get("version") else "history"
        return tasks.execute({**base,"operation":operation, **{k:args[k] for k in ("snapshot","offset","version") if k in args}})
    if not token["can_draft"] or actor["role"] == "viewer": raise AuthError("此连接只允许查询。")
    direct = op == "save_task"
    if direct and (not token["can_save"] or actor["role"] != "admin"):
        raise AuthError("此连接只允许提交草稿，请在网页确认。")
    exact(args, {"matter_id", "id", "revision", "request_id", "changes", "completion_event"}, {"matter_id", "revision", "request_id", "changes"})
    request_id = text(args["request_id"], 80)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id): raise AuthError("请提供至少 16 位唯一请求编号。", "invalid")
    signature = hashlib.sha256(json.dumps({"tool": op, "arguments": args}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    for table in ("remote_drafts", "remote_writes"):
        old = remote.db.execute("SELECT * FROM " + table + " WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone()
        if old:
            if old["fingerprint"] != signature: raise AuthError("同一请求编号不能用于不同内容或操作。", "conflict")
            return remote.write_receipt(old) if table == "remote_writes" else remote.receipt(old)
    current = tasks.read(base)
    exact(args["changes"], FIELDS)
    if not args["changes"]: raise AuthError("请提供待办内容。", "invalid")
    previous = current["fields"]
    payload = {**previous, **args["changes"]}
    receipt_id, created = secrets.token_hex(16), int(time.time())
    # Service receipts are namespaced by connection to avoid collisions with web saves.
    saved = {**base, "operation": "save", "revision": text(args["revision"]), "request_id": receipt_id, "payload": payload, **({"completion_event":args["completion_event"]} if "completion_event" in args else {})}
    tasks.execute(saved, preview=True)
    table = "remote_writes" if direct else "remote_drafts"
    if remote.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] >= 2000 or (not direct and remote.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'", (actor["id"],)).fetchone()[0] >= 20):
        raise AuthError("请求记录已达上限，请先处理待确认修改。", "rate_limited")
    if not direct:
        matter = tasks.context(workspace.read_files(), args["matter_id"])
        people={p["id"]:p["name"] for p in tasks.assignees(args["matter_id"])}
        if current.get("record") and current["record"].get("assignee"):people[current["record"]["assignee"]["id"]]=current["record"]["assignee"]["name"]
        def display(key,value):
            if key=="state":return STATES.get(value,value)
            if key=="assignee_id":return people.get(value,"未分配")
            if key=="source_progress_id" and value:
                record=workspace.record(workspace.read_files(),"progress",value,args["matter_id"])
                return record["event"]["title"] if record else "未关联"
            return value
        review = {"matterId":args["matter_id"],"matterName":matter[1]["name"],"counterparty":"","operation":"update_task" if base["id"] else "add_task",
                  "progressTitle":payload["title"],"progressDate":payload.get("due_date") or "未设期限",
                  "changes":[{"field":key,"label":LABELS[key],"before":display(key,previous[key]) if base["id"] else None,"after":display(key,payload[key])} for key in ("title","state","assignee_id","due_date","source_progress_id","body","completion_note")]}
        if args.get("completion_event"):
            event=args["completion_event"]["payload"]
            from workspace_service import parse_yaml
            names={p["id"]:p["name"] for p in parse_yaml(workspace.read_files()["people.yaml"])["people"]}
            review["changes"].append({"field":"completion_event","label":"同时新增业务进展","before":None,"after":{**event,"participants":[names.get(p,p) for p in event.get("participants",[])]}})
        with remote.db:
            remote.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)", (receipt_id, actor["id"], token["id"], actor["revision"], request_id, signature, args["matter_id"], json.dumps({"request": saved, "review": review}, ensure_ascii=False), created, min(created + 86400, token["expires"])))
        return remote.receipt(remote.db.execute("SELECT * FROM remote_drafts WHERE id=?", (receipt_id,)).fetchone())
    with remote.db:
        remote.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)", (receipt_id, actor["id"], token["id"], actor["revision"], request_id, signature, args["matter_id"], created, token["expires"]))
    remote.accounts.audit(actor, "remote." + op, receipt_id, "started")
    try:
        result = tasks.execute(saved)
        receipt = {"write_id": receipt_id, "request_id": request_id, "status": "saved", "id": result["id"], "revision": result["revision"], "history_version": result["status"]["version"], "message": "待办已保存，请回读核对。"}
        with remote.db:
            remote.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False), receipt_id))
    except Exception as exc:
        with remote.db: remote.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?", (receipt_id,))
        remote.accounts.audit(actor, "remote." + op, receipt_id, "failed")
        raise AuthError("保存结果需要核对，请保留请求编号并回读待办及历史，不要换编号重试。", "uncertain") from exc
    remote.accounts.audit(actor, "remote." + op, receipt_id, "success")
    return receipt
