"""Reference cases share the account-bound MCP review and direct-save flow."""
import hashlib
import json
import re
import secrets
import time
from team_auth import AuthError
from reference_cases import ReferenceCases, FIELDS, SOURCES, UPLOAD_SCOPE, authorize
from staged_uploads import UploadStore

TOOLS={'search_reference_cases','read_reference_case','reference_case_history','submit_reference_case','save_reference_case','prepare_reference_upload'}
LABELS={'title':'案例标题','organization':'公司或案例主体','observed_on':'了解日期','source_type':'了解渠道','source_name':'来源说明','source_url':'来源链接','tags':'标签','summary':'摘要','body':'了解内容','insights':'对我们的启发','attachment_ids':'保留附件','archived':'已归档'}


def tool(remote,op,args,actor,token,policy):
    from remote_access import exact,text
    workspace=remote.workspace;authorize(workspace)
    workspace.actor={k:actor[k] for k in ('id','name','email')}
    cases=ReferenceCases(workspace)
    if op=='search_reference_cases':
        exact(args,{'query','source_type','tag','state','offset','snapshot'})
        return cases.execute({'operation':'list',**args})
    base={'action':'references','kind':'reference','id':text(args.get('id',''),160,True)}
    if op in {'read_reference_case','reference_case_history'}:
        exact(args,{'id','snapshot','offset','version'})
        return cases.execute({**base,'operation':'read' if op=='read_reference_case' else 'version' if args.get('version') else 'history',**{k:args[k] for k in ('snapshot','offset','version') if k in args}})
    authorize(workspace,True)
    if not token['can_draft']:raise AuthError('此连接只允许查询。')
    if op=='prepare_reference_upload':
        exact(args,{'filename','size','sha256'},{'filename','size','sha256'})
        value=UploadStore(workspace).prepare(UPLOAD_SCOPE,args['filename'],args['size'],args['sha256'])
        return {**value,'upload_path':'/api/mcp/uploads','method':'POST','multipart_fields':['upload_id','file'],'instructions':'Upload actual bytes with the same Bearer credential outside model context. Use this server origin only. Then add the upload_id to attachments on submit_reference_case/save_reference_case. A local path is not an upload.'}
    direct=op=='save_reference_case'
    if direct and (actor['role']!='admin' or not token['can_save']):raise AuthError('此连接只允许提交草稿，请在网页确认。')
    exact(args,{'id','revision','request_id','changes','attachments'},{'revision','request_id','changes'})
    rid=text(args['request_id'],80)
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',rid):raise AuthError('请提供至少 16 位唯一请求编号。','invalid')
    signature=hashlib.sha256(json.dumps({'tool':op,'arguments':args},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    for table in ('remote_drafts','remote_writes'):
        old=remote.db.execute('SELECT * FROM '+table+' WHERE token_id=? AND request_id=?',(token['id'],rid)).fetchone()
        if old:
            if old['fingerprint']!=signature:raise AuthError('同一请求编号不能用于不同内容或操作。','conflict')
            return remote.write_receipt(old) if table=='remote_writes' else remote.receipt(old)
    current=cases.raw(workspace.read_files(),base['id']);exact(args['changes'],FIELDS)
    if not args['changes'] and not args.get('attachments'):raise AuthError('请提供案例内容或附件。','invalid')
    payload={**current['fields'],**args['changes']};receipt_id=secrets.token_hex(16);created=int(time.time())
    saved={**base,'operation':'save','revision':text(args['revision']),'request_id':receipt_id,'payload':payload,'attachments':args.get('attachments',[])}
    cases.execute(saved,preview=True)
    table='remote_writes' if direct else 'remote_drafts'
    if remote.db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]>=2000 or (not direct and remote.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'",(actor['id'],)).fetchone()[0]>=20):raise AuthError('请求记录已达上限，请先处理待确认修改。','rate_limited')
    if not direct:
        names={f['id']:f['title'] for f in current['attachments']}
        def display(k,v):
            if k=='attachment_ids':return [names.get(i,i) for i in v]
            if k=='source_type':return SOURCES.get(v,v)
            if k=='archived':return '是' if v else '否'
            return v
        uploads=UploadStore(workspace)
        attachments=[]
        for a in saved['attachments']:
            value=uploads.read(a['upload_id'])
            attachments.append({'mode':'upload','file_id':'','version_id':'','upload_id':a['upload_id'],'title':a.get('title') or value['filename'],'filename':value['filename'],'size':value['size'],'version_number':1,'status':'unspecified','note':a.get('note','')})
        review={'matterId':'','matterName':'参考案例','counterparty':payload['organization'],'operation':'update_reference' if base['id'] else 'add_reference','progressTitle':payload['title'],'progressDate':payload['observed_on'] or '未填日期','attachments':attachments,'changes':[{'field':k,'label':LABELS[k],'before':display(k,current['fields'][k]) if base['id'] else None,'after':display(k,payload[k])} for k in LABELS]}
        uploads.claim([a['upload_id'] for a in saved['attachments']],receipt_id)
        with remote.db:remote.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",(receipt_id,actor['id'],token['id'],actor['revision'],rid,signature,UPLOAD_SCOPE,json.dumps({'request':saved,'review':review},ensure_ascii=False),created,min(created+86400,token['expires'])))
        return remote.receipt(remote.db.execute('SELECT * FROM remote_drafts WHERE id=?',(receipt_id,)).fetchone())
    with remote.db:remote.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)",(receipt_id,actor['id'],token['id'],actor['revision'],rid,signature,UPLOAD_SCOPE,created,token['expires']))
    remote.accounts.audit(actor,'remote.'+op,receipt_id,'started')
    try:
        result=cases.execute(saved)
        receipt={'write_id':receipt_id,'request_id':rid,'status':'saved','id':result['id'],'revision':result['revision'],'history_version':result['status']['version'],'message':'参考案例已保存，请用 read_reference_case 回读核对。'}
        with remote.db:remote.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?",(json.dumps(receipt,ensure_ascii=False),receipt_id))
    except Exception as exc:
        with remote.db:remote.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?",(receipt_id,))
        remote.accounts.audit(actor,'remote.'+op,receipt_id,'failed')
        raise AuthError('保存结果需要核对，请保留请求编号并回读案例及历史。','uncertain') from exc
    remote.accounts.audit(actor,'remote.'+op,receipt_id,'success')
    return receipt
