"""Scoped Q&A tools sharing remote draft review and durable replay receipts."""
import hashlib
import json
import re
import secrets
import time
from investment_qa import InvestmentQA, fields, empty, LABELS
from team_auth import AuthError

TOOLS={'search_investment_qa','read_investment_qa','investment_qa_history','submit_investment_qa','save_investment_qa'}

def require_qa(actor, token):
    if not token['can_qa'] or not (actor['role']=='admin' or actor.get('qa_allowed')):
        raise AuthError('此连接尚未获准访问投资问答库。')

def tool(remote, op, args, actor, token):
    from remote_access import exact, text
    require_qa(actor,token)
    library=InvestmentQA(remote.workspace)
    if op=='search_investment_qa':
        exact(args,{'query','category','state','offset'})
        return library.execute({'operation':'list',**args})
    if op=='read_investment_qa':
        exact(args,{'id'}, {'id'})
        return library.execute({'operation':'read',**args})
    if op=='investment_qa_history':
        exact(args,{'id','offset','version'},{'id'})
        return library.execute({'operation':'version' if args.get('version') else 'history',**args})
    if actor['role']=='viewer' or not token['can_draft']: raise AuthError('此连接只能查询投资问答。')
    direct=op=='save_investment_qa'
    if direct and (actor['role']!='admin' or not token['can_save']): raise AuthError('此连接只允许提交修改草稿，请在网页确认。')
    exact(args,{'id','revision','changes','request_id'},{'revision','changes','request_id'})
    request_id=text(args['request_id'],80)
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',request_id): raise AuthError('请求编号格式无效。','invalid')
    signature=hashlib.sha256(json.dumps({'tool':op,'arguments':args},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    for table in ('remote_drafts','remote_writes'):
        old=remote.db.execute('SELECT * FROM '+table+' WHERE token_id=? AND request_id=?',(token['id'],request_id)).fetchone()
        if old:
            if old['fingerprint']!=signature: raise AuthError('同一请求编号不能用于不同内容或操作。','conflict')
            return remote.write_receipt(old) if table=='remote_writes' else remote.receipt(old)
    current=library.execute({'operation':'read','id':args.get('id','')})
    before=fields(current['record']['draft']) if current['record'] else empty()
    exact(args['changes'],LABELS)
    if not args['changes']: raise AuthError('请提供要修改的内容。','invalid')
    # Read responses carry display labels; strip them before accepting a partial edit.
    before['sources']=[{k:s[k] for k in ('project_id','event_id') if k in s} for s in before['sources']]
    before['files']=[{k:f[k] for k in ('file_id','version_id')} for f in before['files']]
    saved={'action':'qa','kind':'qa','operation':'save','id':args.get('id',''),'revision':text(args['revision']),'payload':{**before,**args['changes']}}
    preview=library.execute(saved,preview=True)
    if preview.get('saved') is False: raise AuthError('内容没有变化，无需提交。','invalid')
    identity,created=secrets.token_hex(16),int(time.time())
    if direct:
        if remote.db.execute('SELECT COUNT(*) FROM remote_writes').fetchone()[0]>=2000: raise AuthError('保存请求记录已达上限。','rate_limited')
        with remote.db:
            remote.db.execute("INSERT INTO remote_writes VALUES(?,?,?,?,?,?,?,'processing','',?,?)",(identity,actor['id'],token['id'],actor['revision'],request_id,signature,args.get('id',''),created,token['expires']))
        remote.workspace.actor={key:actor[key] for key in ('id','name','email')}
        remote.accounts.audit(actor,'remote.save_investment_qa',identity,'started')
        try:
            result=library.execute(saved)
            receipt={'write_id':identity,'request_id':request_id,'status':'saved','id':result['id'],'revision':result['revision'],'review_path':'/?qa='+result['id'],'message':'问答修订稿已保存并保留历史。推荐回答未改变，需由管理员在网页确认。'}
            with remote.db: remote.db.execute("UPDATE remote_writes SET state='saved',result=? WHERE id=?",(json.dumps(receipt,ensure_ascii=False),identity))
        except Exception as exc:
            with remote.db: remote.db.execute("UPDATE remote_writes SET state='uncertain' WHERE id=?",(identity,))
            remote.accounts.audit(actor,'remote.save_investment_qa',identity,'failed')
            raise AuthError('保存结果需要核对，请保留原请求编号并查询问答和历史，不要更换编号重试。','uncertain') from exc
        remote.accounts.audit(actor,'remote.save_investment_qa',identity,'success')
        return receipt
    if remote.db.execute("SELECT COUNT(*) FROM remote_drafts WHERE owner=? AND state='pending'",(actor['id'],)).fetchone()[0]>=20 or remote.db.execute('SELECT COUNT(*) FROM remote_drafts').fetchone()[0]>=2000: raise AuthError('待处理草稿过多，请先确认或驳回。','rate_limited')
    shown=preview['record']['draft']
    review={'matterId':'','matterName':'投资问答库','counterparty':'','operation':'investment_qa','progressTitle':shown['question'],'progressDate':'','changes':[]}
    for key in args['changes']:
        old=before.get(key) if current['record'] else None
        new=shown[key]
        if key=='sources':
            old=[s.get('matter_name',s['project_id']) for s in (current['record']['draft']['sources'] if current['record'] else [])]
            new=[s['matter_name']+(' · '+s['event_title'] if s.get('event_title') else '') for s in shown[key]]
        if key=='files':
            old=[f['title'] for f in (current['record']['draft']['files'] if current['record'] else [])]
            new=[f['title']+' · '+f['filename'] for f in shown[key]]
        review['changes'].append({'field':key,'label':LABELS[key],'before':old,'after':new})
    with remote.db:
        remote.db.execute("INSERT INTO remote_drafts VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",(identity,actor['id'],token['id'],actor['revision'],request_id,signature,args.get('id',''),json.dumps({'request':saved,'review':review},ensure_ascii=False),created,min(created+86400,token['expires'])))
    return remote.receipt(remote.db.execute('SELECT * FROM remote_drafts WHERE id=?',(identity,)).fetchone())
