"""Company events use the same records, validation, drafts and receipts as the website."""
import hashlib
import json
import re
import secrets
import time
import unicodedata

from remote_intake import require_intake
from team_auth import AuthError

TOOLS = {"search_company_events", "read_company_event", "submit_company_event", "save_company_event"}
LABELS = {"date": "实际日期", "type": "事件类型", "title": "标题", "summary": "进展摘要",
          "importance": "重要程度", "participants": "参与人", "location": "地点",
          "category": "活动分类", "organizers": "主办方", "body": "完整活动记录"}
CATEGORIES = {"fundraising": "融资与路演", "industry-recognition": "行业活动与荣誉",
              "product-launch": "产品发布", "company": "公司事务"}
EVENT_TYPES = {"contact", "meeting", "proposal", "agreement", "administrative", "decision",
               "payment", "milestone", "status_change", "other"}


def require_company(actor, token, *, write=False):
    if actor["role"] != "admin" and not actor["all_projects"]:
        raise AuthError("公司动态仅向可查看全部事项的成员开放。")
    if write:
        require_intake(actor, token)


def events(files):
    from workspace_service import parse_yaml
    return parse_yaml(files.get("company/events.yaml", "events: []"))["events"]


def revision(workspace, files, identity):
    from workspace_service import digest
    # Creation depends on the collection checked for duplicates, not digest(None).
    return workspace.record_revision(files, "company", identity) if identity else digest(events(files))


def fields(record=None):
    if not record:
        return {"date": "", "type": "other", "title": "", "summary": "", "importance": "normal",
                "participants": [], "location": "", "category": "", "organizers": [], "body": ""}
    return {**{key: record["event"].get(key, [] if key == "organizers" else "")
               for key in LABELS if key not in {"body", "location"}},
            "body": record["body"], "location": record["document"].get("location") or ""}


def read(workspace, identity):
    from workspace_service import parse_yaml
    files = workspace.read_files()
    record = workspace.record(files, "company", identity) if identity else None
    if identity and not record:
        raise AuthError("未找到这条公司动态。", "not_found")
    profiles = parse_yaml(files["people.yaml"])["people"]
    return {"id": identity, "revision": revision(workspace, files, identity), "fields": fields(record),
            "participants": [{key: person.get(key, "") for key in ("id", "name", "affiliation")}
                             for person in profiles if record and person["id"] in record["event"]["participants"]]}


def normalize(value):
    return "".join(unicodedata.normalize("NFKC", value).casefold().split())


def validate_payload(workspace, payload):
    from remote_access import exact, text
    exact(payload, LABELS, LABELS)
    for key, limit in {"date": 10, "type": 30, "title": 40, "summary": 200, "importance": 10,
                       "category": 100, "location": 1000, "body": 8000}.items():
        text(payload[key], limit, key in {"location", "body"})
    workspace.check_date(payload["date"])
    if payload["type"] not in EVENT_TYPES or payload["importance"] not in {"key", "normal"}:
        raise AuthError("事件类型或重要程度无效。", "invalid")
    for key in ("participants", "organizers"):
        value = payload[key]
        if not isinstance(value, list) or len(value) > 30:
            raise AuthError("参与人或主办方列表格式无效。", "invalid")
        for item in value:
            text(item, 160 if key == "participants" else 1000)
        if len(set(value)) != len(value):
            raise AuthError("参与人和主办方不能重复。", "invalid")
    if not payload["participants"]:
        raise AuthError("请从已有人员档案选择参与人。", "invalid")


def save(remote, request, actor, token, *, preview=False):
    require_company(actor, token, write=True)
    workspace, identity = remote.workspace, request.get("id", "")
    files = workspace.read_files()
    if identity and not workspace.record(files, "company", identity):
        raise AuthError("未找到这条公司动态。", "not_found")
    if request["revision"] != revision(workspace, files, identity):
        raise AuthError("公司动态已变化，请重新查询并读取最新版本。", "conflict")
    payload = request["payload"]
    validate_payload(workspace, payload)
    for event in events(files):
        if event["id"] != identity and event["date"] == payload["date"] and normalize(event["title"]) == normalize(payload["title"]):
            raise AuthError("同日同标题的公司动态已存在，请读取并核对已有记录：" + event["id"], "duplicate")
    # The workspace remains the only writer. It validates existing person references,
    # archives Markdown and records the actual account in its atomic snapshot.
    result = workspace.save({**request, "revision": workspace.record_revision(files, "company", identity)}, preview=preview)
    if not preview:
        result["revision"] = read(workspace, result["id"])["revision"]
    return result


def tool(remote, op, args, actor, token):
    from remote_access import exact, text
    require_company(actor, token)
    workspace = remote.workspace
    if op == "search_company_events":
        exact(args, {"query", "category", "from", "to", "offset"})
        query = text(args.get("query", ""), 300, True).casefold().split()
        category = text(args.get("category", ""), 100, True)
        start, end, offset = args.get("from", ""), args.get("to", ""), args.get("offset", 0)
        for value in (start, end):
            text(value, 10, True)
            if value: workspace.check_date(value)
        if start and end and start > end:
            raise AuthError("开始日期不能晚于结束日期。", "invalid")
        if type(offset) is not int or not 0 <= offset <= 100000:
            raise AuthError("页码无效。", "invalid")
        files, matches = workspace.read_files(), []
        for event in events(files):
            record = workspace.record(files, "company", event["id"])
            value = fields(record)
            searchable = " ".join([value["title"], value["summary"], value["body"], value["location"],
                                   value["category"], CATEGORIES.get(value["category"], ""),
                                   *value["participants"], *value["organizers"]]).casefold()
            if (category and category != value["category"]) or (start and value["date"] < start) or (end and value["date"] > end):
                continue
            if all(term in searchable for term in query):
                matches.append({"id": event["id"], **{key: value[key] for key in LABELS if key != "body"}})
        matches.sort(key=lambda event: (-int(event["date"].replace("-", "")), event["id"]))
        return {"events": matches[offset:offset + 20], "total": len(matches),
                "nextOffset": offset + 20 if len(matches) > offset + 20 else None}
    if op == "read_company_event":
        exact(args, {"id"}, {"id"})
        return read(workspace, text(args["id"], 160, True))
    require_company(actor, token, write=True)
    direct = op == "save_company_event"
    if direct and not token["can_save"]:
        raise AuthError("此连接只允许提交草稿，请在网页确认。")
    exact(args, {"id", "revision", "request_id", "changes"}, {"revision", "request_id", "changes"})
    identity = text(args.get("id", ""), 160, True)
    request_id = text(args["request_id"], 80)
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
        raise AuthError("请提供至少 16 位唯一请求编号。", "invalid")
    signature = hashlib.sha256(json.dumps({"tool": op, "arguments": args}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    for table in ("remote_drafts", "remote_writes"):
        old = remote.db.execute("SELECT * FROM " + table + " WHERE token_id=? AND request_id=?", (token["id"], request_id)).fetchone()
        if old:
            if old["fingerprint"] != signature:
                raise AuthError("同一请求编号不能用于不同内容或操作。", "conflict")
            return remote.write_receipt(old) if table == "remote_writes" else remote.receipt(old)
    current = read(workspace, identity)
    exact(args["changes"], LABELS)
    if not args["changes"]:
        raise AuthError("请提供要修改的内容。", "invalid")
    payload = {**current["fields"], **args["changes"]}
    saved = {"action": "save", "kind": "company", "id": identity,
             "revision": text(args["revision"]), "payload": payload}
    save(remote, saved, actor, token, preview=True)
    if identity and payload == current["fields"]:
        raise AuthError("内容没有变化，无需提交。", "invalid")
    table = "remote_writes" if direct else "remote_drafts"
    if remote.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] >= 2000 or (not direct and remote.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'", (actor["id"],)).fetchone()[0] >= 20):
        raise AuthError("请求记录已达上限，请先处理待确认修改或等待到期。", "rate_limited")
    receipt_id, created = secrets.token_hex(16), int(time.time())
    if not direct:
        from workspace_service import parse_yaml
        names = {person["id"]: person["name"] for person in parse_yaml(workspace.read_files()["people.yaml"])["people"]}
        def display(key, value):
            return [names.get(person, person) for person in value] if key == "participants" and value else value
        review = {"matterId": "", "matterName": "公司动态", "counterparty": "",
                  "operation": "update_company_event" if identity else "add_company_event",
                  "progressTitle": payload["title"], "progressDate": payload["date"],
                  "changes": [{"field": key, "label": LABELS[key],
                               "before": display(key, current["fields"][key]) if identity else None,
                               "after": display(key, payload[key])}
                              for key in (args["changes"] if identity else LABELS)]}
        with remote.db:
            remote.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
                              (receipt_id, actor["id"], token["id"], actor["revision"], request_id, signature, "",
                               json.dumps({"request": saved, "review": review}, ensure_ascii=False), created, min(created + 86400, token["expires"])))
        return remote.receipt(remote.db.execute("SELECT * FROM remote_drafts WHERE id=?", (receipt_id,)).fetchone())
    with remote.db:
        remote.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)",
                          (receipt_id, actor["id"], token["id"], actor["revision"], request_id, signature, "", created, token["expires"]))
    workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
    remote.accounts.audit(actor, "remote.save_company_event", receipt_id, "started")
    try:
        result = save(remote, saved, actor, token)
        receipt = {"write_id": receipt_id, "request_id": request_id, "status": "saved", "id": result["id"],
                   "revision": result["revision"], "history_version": result["status"]["version"],
                   "message": "公司动态已正式保存，可用 read_company_event 回读核对。"}
        with remote.db:
            remote.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?", (json.dumps(receipt, ensure_ascii=False), receipt_id))
    except Exception as exc:
        with remote.db:
            remote.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?", (receipt_id,))
        remote.accounts.audit(actor, "remote.save_company_event", receipt_id, "failed")
        raise AuthError("保存结果需要核对，请保留原请求编号，查询公司动态及修改历史，不要更换编号重试。", "uncertain") from exc
    remote.accounts.audit(actor, "remote.save_company_event", receipt_id, "success")
    return receipt
