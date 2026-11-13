"""Reference knowledge is independent of counterparties, opportunities and activity dates."""
import base64
import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from team_auth import AuthError

UPLOAD_SCOPE = 'reference-library'
PATH = re.compile(r'references/(case-[0-9a-f]{32})/README\.md')
SOURCES = {'roadshow':'路演', 'exchange':'交流', 'event':'活动听闻', 'article':'公开资料', 'other':'其他'}
DEFAULT = dict(title='', organization='', observed_on=None, source_type='roadshow', source_name='', source_url='', tags=[], summary='', body='', insights='', attachment_ids=[], archived=False)
FIELDS = set(DEFAULT)
READS = {'list','read','history','version'}


def fail(message, code='invalid'):
    from workspace_service import ServiceError
    raise ServiceError(message, code)


def authorize(workspace, write=False):
    policy = workspace.policy
    if policy and not (policy.admin or policy.actor['all_projects']):
        raise AuthError('参考案例仅向可查看全部事项的成员开放。')
    if write and policy and policy.actor['role']=='viewer':
        raise AuthError('只读成员不能维护参考案例。')


def records(files):
    from workspace_service import parse_md
    return [{**metadata,'body':body} for path,text in sorted(files.items()) if PATH.fullmatch(path) for metadata,body in [parse_md(text)]]


def normalized(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def validate_fields(payload):
    from workspace_service import Workspace
    from file_library import text
    if not isinstance(payload,dict) or set(payload)!=FIELDS:fail('参考案例字段无效。')
    result=dict(payload)
    for key,limit in {'title':200,'organization':100,'source_name':300,'source_url':2000,'summary':1000,'body':20000,'insights':10000}.items():
        result[key]=text(payload[key], {'title':'案例标题','organization':'公司或案例主体'}.get(key,'内容'), required=key in {'title','organization'}, limit=limit)
    if result['source_url']:
        url=urlparse(result['source_url'])
        if url.scheme not in {'https','http'} or not url.hostname or url.username or url.password or any(c.isspace() for c in result['source_url']):fail('来源链接须为有效的 HTTP 或 HTTPS 地址。')
    if result['observed_on'] is not None:Workspace.check_date(result['observed_on'])
    if not isinstance(result['source_type'],str) or result['source_type'] not in SOURCES:fail('请选择了解渠道。')
    if not isinstance(result['tags'],list) or len(result['tags'])>12:fail('最多填写 12 个标签。')
    result['tags']=list(dict.fromkeys(text(t,'标签',limit=30) for t in result['tags']))
    if type(result['archived']) is not bool:fail('归档状态无效。')
    if not isinstance(result['attachment_ids'],list) or len(result['attachment_ids'])>40 or any(not isinstance(x,str) or not re.fullmatch(r'file-[0-9a-f]{32}',x) for x in result['attachment_ids']) or len(set(result['attachment_ids']))!=len(result['attachment_ids']):fail('附件关联无效，最多保留 40 份附件。')
    return result


def validate(files):
    from file_library import index_from
    from workspace_service import parse_md
    index={f['id']:f for f in index_from(files)['files']}
    for path,text in files.items():
        if not path.startswith('references/'):continue
        match=PATH.fullmatch(path)
        if not match:fail('参考案例保存位置无效。')
        meta,body=parse_md(text);item={**meta,'body':body}
        if item.get('id')!=match[1]:fail('参考案例标识与保存位置不一致。')
        validate_fields({k:item.get(k) for k in FIELDS})
        for identity in item['attachment_ids']:
            if identity not in index or index[identity].get('reference_id')!=item['id']:fail('附件必须属于当前参考案例。')
        for field in ('author','updated_by'):
            if not isinstance(item.get(field),dict) or set(item[field])!={'id','name'} or not all(isinstance(v,str) and v for v in item[field].values()):fail('参考案例账号信息无效。')
        for field in ('created_at','updated_at'):
            try:
                if not datetime.fromisoformat(item[field]).tzinfo:raise ValueError()
            except (KeyError,TypeError,ValueError):fail('参考案例保存时间无效。')


class ReferenceCases:
    def __init__(self,workspace):self.workspace=workspace

    def raw(self,files,identity):
        from file_library import index_from
        from workspace_service import digest
        items=records(files);item=next((r for r in items if r['id']==identity),None)
        if identity and not item:fail('未找到这条参考案例。','not_found')
        attachments=[f for f in index_from(files)['files'] if item and f['id'] in item['attachment_ids']]
        return {'record':item,'fields':{k:item[k] for k in FIELDS} if item else dict(DEFAULT), 'attachments':attachments,'revision':digest([item,attachments] if item else items)}

    def history(self,request,files):
        self.raw(files,request.get('id',''))
        if not request.get('id'):fail('请选择参考案例。')
        ceiling=request.get('snapshot');allowed=None
        if ceiling:
            if not re.fullmatch(r'local:[0-9a-f]{40,64}',ceiling):return {'versions':[],'has_more':False}
            allowed=set(self.workspace.git('rev-list',ceiling.split(':',1)[1]).splitlines())
        entries=[]
        for entry in self.workspace.history_entries({'kind':'reference','id':request['id']}):
            if not entry['version'].startswith('local:') or (allowed is not None and entry['version'].split(':',1)[1] not in allowed):continue
            if request.get('operation')=='version' and entry['version']!=request.get('version'):continue
            from workspace_service import ServiceError
            try:value=self.raw(self.workspace.version_files(entry['version']),request['id'])
            except ServiceError:continue
            public={k:entry[k] for k in ('version','at','label')}
            public['actor']={k:entry['actor'][k] for k in ('id','name')} if entry.get('actor') else None
            if request.get('operation')=='version':return {**value,'version':public}
            entries.append(public)
        if request.get('operation')=='version':fail('未找到参考案例的历史版本。','not_found')
        offset=self.offset(request)
        return {'versions':entries[offset:offset+40],'has_more':len(entries)>offset+40}

    @staticmethod
    def offset(request):
        try:value=int(request.get('offset',0))
        except (TypeError,ValueError):fail('页码无效。')
        if not 0<=value<=100000:fail('页码无效。')
        return value

    def execute(self,request,*,preview=False):
        from workspace_service import digest,markdown
        from file_library import FileLibrary
        from staged_uploads import UploadStore
        workspace=self.workspace;op=request.get('operation','list')
        if not isinstance(op,str) or op not in READS|{'save'}:fail('未知的参考案例操作。')
        authorize(workspace,op=='save')
        if op=='save' and (request.get('snapshot') or request.get('version')):fail('历史案例仅供查看。')
        identity=request.get('id','')
        if not isinstance(identity,str) or (identity and not re.fullmatch(r'case-[a-f0-9]{32}',identity)):fail('参考案例标识无效。')
        files=workspace.version_files(request['snapshot']) if request.get('snapshot') else workspace.read_files()
        if op=='list':
            query=request.get('query','');source=request.get('source_type','');tag=request.get('tag','');state=request.get('state','active')
            if not all(isinstance(v,str) for v in (query,source,tag,state)) or len(query)>300 or len(tag)>30 or (source and source not in SOURCES) or state not in {'active','archived','all'}:fail('筛选条件无效。')
            terms=normalized(query).split();items=records(files)
            tags=sorted({t for item in items for t in item['tags']})
            items=[r for r in items if (state=='all' or r['archived']==(state=='archived')) and (not source or r['source_type']==source) and (not tag or tag in r['tags']) and all(t in normalized(' '.join([r[k] for k in ('organization','title','summary','body','insights','source_name')]+r['tags'])) for t in terms)]
            items.sort(key=lambda r:(r['observed_on'] or '',r['updated_at'],r['id']),reverse=True)
            offset=self.offset(request)
            return {'items':[{k:v for k,v in r.items() if k not in {'body','insights'}} for r in items[offset:offset+30]],'total':len(items),'tags':tags,'next_offset':offset+30 if len(items)>offset+30 else None}
        if op=='read':return self.raw(files,identity)
        if op in {'history','version'}:return self.history(request,files)
        actor=workspace.actor or {'id':'local','name':'本地操作'};actor={k:actor[k] for k in ('id','name')}
        rid=request.get('request_id','')
        if not isinstance(rid,str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',rid):fail('请提供至少 16 位唯一请求编号。')
        receipt=workspace.store/'reference-requests'/(digest([actor['id'],rid])+'.json');signature=digest(request)
        if receipt.exists() and not preview:
            old=json.loads(receipt.read_text())
            if old['signature']!=signature:fail('同一请求编号不能用于不同内容。','conflict')
            if old.get('result'):return old['result']
            fail('保存结果需要核对，请保留请求编号并回读案例。','uncertain')
        current=self.raw(files,identity);previous=current['record']
        if current['revision']!=request.get('revision'):fail('参考案例已变化，请核对最新内容后保存。','conflict')
        payload=validate_fields(request.get('payload'))
        if payload['archived']!=(previous or {}).get('archived',False) and workspace.policy and not workspace.policy.admin:raise AuthError('参考案例的归档与恢复由管理员操作。')
        if any(i['id']!=identity and normalized(i['organization'])==normalized(payload['organization']) and normalized(i['title'])==normalized(payload['title']) and i['observed_on']==payload['observed_on'] for i in records(files)):fail('同一公司、日期和标题的案例已存在，请先查看已有记录。','duplicate')
        if any(i not in (previous or {}).get('attachment_ids',[]) for i in payload['attachment_ids']):fail('只能保留当前案例的既有附件。')
        identity=identity or 'case-'+uuid.uuid4().hex
        now=datetime.now(timezone.utc).isoformat()
        metadata={**payload,'id':identity,'created_at':previous['created_at'] if previous else now,'author':previous['author'] if previous else actor,'updated_at':now,'updated_by':actor}
        body=metadata.pop('body');path=f'references/{identity}/README.md';after={**files,path:markdown(metadata,body)}
        attachments=request.get('attachments',[])
        if not isinstance(attachments,list) or len(attachments)>10:fail('每次最多添加 10 个附件。')
        library=FileLibrary(workspace);writes=[];uploads=UploadStore(workspace) if attachments else None;seen=set()
        hashes={v['sha256'] for f in current['attachments'] if f['id'] in payload['attachment_ids'] for v in f['versions']}
        for a in attachments:
            if not isinstance(a,dict) or set(a)-{'upload_id','title','category','note'} or not isinstance(a.get('upload_id'),str) or not a['upload_id'] or a['upload_id'] in seen:fail('附件参数无效或重复。')
            seen.add(a['upload_id']);value,data=uploads.bytes(a['upload_id'],UPLOAD_SCOPE)
            if value['sha256'] in hashes:fail('该文件已在本案例中，请勿重复上传。','duplicate')
            hashes.add(value['sha256'])
            after,file_id,_,pending=library.prepare({'operation':'upload','payload':{'title':a.get('title') or value['filename'][:100],'category':a.get('category','presentation'),'notes':'','note':a.get('note',''),'organization':payload['organization'],'project_ids':[],'home_counterparty_id':'','reference_id':identity,'filename':value['filename'],'data':base64.b64encode(data).decode()}},after)
            writes.extend(pending);metadata['attachment_ids']=[*metadata['attachment_ids'],file_id]
        after[path]=markdown(metadata,body)
        errors,_=workspace.stage(after,verify_attachments=not bool(attachments))
        if errors:fail('参考案例未通过资料校验：'+errors[0],'validation')
        if preview:return {'valid':True,'attachments':[{'upload_id':a['upload_id'],'filename':uploads.read(a['upload_id'])['filename']} for a in attachments]}
        receipt.parent.mkdir(mode=0o700,exist_ok=True);workspace.atomic(receipt,json.dumps({'signature':signature}))
        for relative,data in writes:library.put(relative,data)
        if workspace.actor is None:workspace.actor={**actor,'email':''}
        result=workspace.commit(files,after,('修改参考案例：' if previous else '新增参考案例：')+metadata['title'],'form')
        result.update(id=identity,revision=self.raw(workspace.read_files(),identity)['revision'])
        workspace.atomic(receipt,json.dumps({'signature':signature,'result':result},ensure_ascii=False))
        for a in attachments:uploads.remove(a['upload_id'])
        return result
