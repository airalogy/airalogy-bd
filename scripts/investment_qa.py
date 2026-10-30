"""Investment questions: editable Markdown and a separately approved answer.

All writes use Workspace's lock, validation, transaction journal and history.
Library access never grants access to source matters or attached file versions.
"""
from __future__ import annotations
import copy
import hashlib
import json
import re
import uuid
from datetime import date, datetime, timezone
import yaml
from team_auth import AuthError

ROOT = 'investment-qa/'
ID = re.compile(r'qa-[a-f0-9]{32}')
PATH = re.compile(r'investment-qa/(qa-[a-f0-9]{32})/(draft|recommended)\.md')
CATEGORIES = {'product':'产品', 'competition':'竞争与优势', 'market':'市场', 'business':'商业模式', 'finance':'经营与财务', 'fundraising':'融资计划', 'team':'团队', 'other':'其他'}
FIELDS = {'question', 'aliases', 'category', 'short_answer', 'body', 'data_as_of', 'sources', 'files'}
LABELS = {'question':'问题', 'aliases':'其他常见问法', 'category':'分类', 'short_answer':'简短回答', 'body':'详细回答', 'data_as_of':'数据截至日期', 'sources':'关联交流', 'files':'参考文件'}
READS = {'list', 'read', 'history', 'version'}
WRITES = {'save', 'publish', 'mark_stale', 'archive', 'unarchive', 'restore'}

class QAError(Exception):
    def __init__(self, message, code='invalid', details=None):
        super().__init__(message)
        self.code, self.details = code, details

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

def empty():
    return {'question':'', 'aliases':[], 'category':'other', 'short_answer':'', 'body':'', 'data_as_of':'', 'sources':[], 'files':[]}

def normalize(value):
    if isinstance(value, (date, datetime)): return value.isoformat()
    if isinstance(value, dict): return {k:normalize(v) for k,v in value.items()}
    if isinstance(value, list): return [normalize(v) for v in value]
    return value

def parse(text):
    match = re.match(r'\A---\n(.*?)\n---\s*\n?(.*)\Z', text, re.S)
    if not match: raise QAError('投资问答缺少资料信息。')
    try:
        metadata = normalize(yaml.safe_load(match[1]))
        if not isinstance(metadata, dict): raise QAError('投资问答资料信息格式无效。')
    except yaml.YAMLError as exc: raise QAError('投资问答资料信息格式无效。') from exc
    return {**metadata, 'body':match[2].strip()}

def document(value):
    return '---\n' + yaml.safe_dump({k:v for k,v in value.items() if k != 'body'}, allow_unicode=True, sort_keys=False, width=1000) + '---\n\n' + value['body'].strip() + '\n'

def identifier(value, allow_empty=False):
    if allow_empty and value == '': return value
    if not isinstance(value, str) or not ID.fullmatch(value): raise QAError('问答编号无效。')
    return value

def fields(value):
    return {key:value.get(key, empty()[key]) for key in FIELDS}

def validate_fields(value, *, publish=False):
    if not isinstance(value, dict) or set(value)-FIELDS: raise QAError('问答包含不支持的字段。')
    out = {**empty(), **value}
    for key, limit in [('question',300), ('short_answer',1200), ('body',8000), ('data_as_of',10)]:
        if not isinstance(out[key], str) or len(out[key]) > limit or '\x00' in out[key]: raise QAError(f'{LABELS[key]}格式或长度不正确。')
        out[key] = out[key].strip()
    if not out['question']: raise QAError('请填写问题。')
    if publish and not out['short_answer']: raise QAError('确认推荐版本前，请填写简短回答。')
    if not isinstance(out['category'],str) or out['category'] not in CATEGORIES: raise QAError('请选择有效的问答分类。')
    if not isinstance(out['aliases'], list) or len(out['aliases']) > 20 or any(not isinstance(v,str) or not v.strip() or len(v)>300 for v in out['aliases']): raise QAError('其他问法最多 20 条，每条不超过 300 字。')
    out['aliases'] = list(dict.fromkeys(v.strip() for v in out['aliases'] if v.strip()!=out['question']))
    if out['data_as_of']:
        try:
            if date.fromisoformat(out['data_as_of']).isoformat()!=out['data_as_of']: raise ValueError()
        except ValueError as exc: raise QAError('请填写有效的数据截至日期。') from exc
    for key, allowed, required in [('sources', {'project_id','event_id'}, {'project_id'}), ('files', {'file_id','version_id'}, {'file_id','version_id'})]:
        values=out[key]
        if not isinstance(values,list) or len(values)>30: raise QAError(f'{LABELS[key]}最多 30 项。')
        for item in values:
            if not isinstance(item,dict) or set(item)-allowed or required-set(item) or any(not isinstance(v,str) or len(v)>160 or not v for v in item.values()): raise QAError(f'{LABELS[key]}格式无效。')
        out[key]=list({digest(item):item for item in values}.values())
    return out

def raw_record(files, identity):
    path=f'{ROOT}{identity}/draft.md'
    if path not in files: return None
    draft=parse(files[path]); recommended=parse(files[f'{ROOT}{identity}/recommended.md']) if f'{ROOT}{identity}/recommended.md' in files else None
    return {'id':identity, 'draft':draft, 'recommended':recommended,
            'status':'needs_update' if recommended and draft.get('needs_update') else 'ready' if recommended else 'draft',
            'archived':draft.get('archived',False), 'has_changes':recommended is None or fields(draft)!=fields(recommended)}

def identities(files):
    return sorted({m[1] for name in files if (m:=PATH.fullmatch(name)) and m[2]=='draft'})

def check_files(files):
    for name,text in files.items():
        if not name.startswith(ROOT): continue
        match=PATH.fullmatch(name)
        if not match: raise QAError('投资问答目录包含不支持的文件结构。')
        value=parse(text)
        allowed=FIELDS|{'id','updated_at','updated_by','archived','needs_update'} if match[2]=='draft' else FIELDS|{'id','approved_at','approved_by'}
        if set(value)-allowed or FIELDS-set(value) or value.get('id')!=match[1]: raise QAError('投资问答编号或资料字段无效。')
        validate_fields(fields(value),publish=match[2]=='recommended')
        stamp, author = ('updated_at','updated_by') if match[2]=='draft' else ('approved_at','approved_by')
        try:
            if not isinstance(value.get(stamp),str) or not datetime.fromisoformat(value[stamp]).tzinfo: raise ValueError()
        except ValueError as exc: raise QAError('问答修订时间无效。') from exc
        who=value.get(author)
        if not isinstance(who,dict) or set(who)!={'id','name'} or any(not isinstance(v,str) or not v or len(v)>200 for v in who.values()): raise QAError('问答修订人员信息无效。')
        for key in ('archived','needs_update'):
            if key in value and type(value[key]) is not bool: raise QAError('投资问答状态格式无效。')
        if match[2]=='recommended' and f'{ROOT}{match[1]}/draft.md' not in files: raise QAError('推荐回答缺少对应的问题档案。')

class InvestmentQA:
    def __init__(self, workspace):
        self.workspace=workspace
        self.policy=workspace.policy
        self.actor=self.policy.actor if self.policy else None

    @property
    def admin(self): return not self.actor or self.actor['role']=='admin'

    @property
    def editor(self): return not self.actor or self.actor['role']!='viewer'

    def authorize(self, operation):
        if self.actor and not (self.admin or self.actor.get('qa_allowed')): raise AuthError('尚未获授权访问投资问答库。')
        if operation not in READS|WRITES: raise QAError('未知的投资问答操作。')
        if operation in WRITES|{'history','version'} and not self.editor: raise AuthError('只读成员只能查看推荐回答。')
        if operation in {'publish','archive','unarchive'} and not self.admin: raise AuthError('推荐版本确认和归档由管理员管理。')

    def source_allowed(self, source):
        return self.admin or source['project_id'] in self.policy.allowed

    def file_allowed(self, reference, files):
        from file_library import index_from
        item=next((x for x in index_from(files)['files'] if x['id']==reference['file_id']),None)
        return bool(item and not item['archived'] and (self.admin or self.policy.file_allowed(item)))

    def redact(self, value, files):
        from file_library import index_from
        out=copy.deepcopy(value)
        out['sources']=[];out['files']=[];out['restricted_references']=False
        for source in value.get('sources',[]):
            record=self.workspace.record(files,'project',source['project_id']) if self.source_allowed(source) else None
            event=next((e for e in (record or {}).get('events',[]) if e['id']==source.get('event_id')),None)
            if not record or (source.get('event_id') and not event):
                out['restricted_references']=True;continue
            out['sources'].append({**source,'matter_name':record['metadata']['name'],**({'event_title':event['title'],'date':event['date']} if event else {})})
        index=index_from(files)['files']
        for ref in value.get('files',[]):
            if not self.file_allowed(ref, files): out['restricted_references']=True;continue
            item=next(x for x in index if x['id']==ref['file_id']);version=next((v for v in item['versions'] if v['id']==ref['version_id']),None)
            if not version: out['restricted_references']=True;continue
            out['files'].append({**ref,'title':item['title'],'filename':version['filename']})
        return out

    def present(self, record, files):
        if not record: return None
        value={**record, 'revision':digest(record)}
        value['draft']=self.redact(record['draft'],files) if self.editor else None
        value['recommended']=self.redact(record['recommended'],files) if record['recommended'] else None
        preferred=record['recommended'] or record['draft']
        value['question']=preferred['question'];value['category']=preferred['category'];value['aliases']=preferred['aliases']
        value['updated_at']=record['draft'].get('updated_at','')
        if not self.editor: value['has_changes']=False
        return value

    def references(self, incoming, existing, files):
        from file_library import index_from
        # Editing prose must not expose or silently remove references the editor cannot inspect.
        for key in ('sources','files'):
            def permitted(ref):
                return bool(self.source_allowed(ref) and self.workspace.record(files,'project',ref['project_id'])) if key=='sources' else self.file_allowed(ref,files)
            for ref in incoming[key]:
                if not permitted(ref): raise AuthError('只能关联有权访问的会议和文件。')
                if key=='sources':
                    record=self.workspace.record(files,'project',ref['project_id'])
                    if not record or (ref.get('event_id') and not any(e['id']==ref['event_id'] for e in record['events'])): raise QAError('关联交流已不存在，请重新选择。','conflict')
                else:
                    item=next((x for x in index_from(files)['files'] if x['id']==ref['file_id']),None)
                    if not item or not any(v['id']==ref['version_id'] for v in item['versions']): raise QAError('参考文件版本已不存在，请重新选择。','conflict')
            incoming[key]+=copy.deepcopy([ref for ref in existing.get(key,[]) if not permitted(ref)])
            incoming[key]=list({digest(ref):ref for ref in incoming[key]}.values())
        return incoming

    def execute(self, request, *, preview=False):
        op=request.get('operation','list');self.authorize(op)
        files=self.workspace.read_files()
        identity=identifier(request.get('id',''),allow_empty=op in {'list','save','read'})
        record=raw_record(files,identity) if identity else None
        if op=='list':
            query=request.get('query','');category=request.get('category','');state=request.get('state','');offset=request.get('offset',0)
            if not isinstance(query,str) or len(query)>300 or not isinstance(category,str) or not isinstance(state,str) or category not in {'',*CATEGORIES} or state not in {'','draft','ready','needs_update','changed','archived'}: raise QAError('问答筛选条件无效。')
            try: offset=int(offset)
            except (ValueError,TypeError) as exc: raise QAError('分页条件无效。') from exc
            if not 0<=offset<=100000: raise QAError('分页条件无效。')
            items=[]
            for key in identities(files):
                raw=raw_record(files,key)
                if raw['archived'] != (state=='archived') or (raw['archived'] and not self.editor): continue
                view=self.present(raw,files);preferred=view['recommended'] or view['draft'] or view
                search=[preferred]
                if self.editor and view['draft']: search.append(view['draft'])
                if query.strip().casefold() not in ' '.join(' '.join(str(d.get(k,'')) for k in ('question','aliases','short_answer','body')) for d in search).casefold(): continue
                if category and not any(d.get('category')==category for d in search): continue
                if state in {'draft','ready','needs_update'} and raw['status']!=state: continue
                if state=='changed' and (not self.editor or not raw['has_changes']): continue
                items.append(view)
            items.sort(key=lambda x:x['updated_at'],reverse=True)
            return {'items':items[offset:offset+30], 'total':len(items), 'next_offset':offset+30 if len(items)>offset+30 else None, 'can_edit':self.editor, 'can_publish':self.admin}
        if op=='read':
            if identity and (not record or (record['archived'] and not self.editor)): raise QAError('未找到可访问的问答。','not_found')
            return {'record':self.present(record,files), 'revision':digest(record), 'can_edit':self.editor, 'can_publish':self.admin}
        if not record and op!='save': raise QAError('未找到问答。','not_found')
        if op=='history':
            history=self.workspace.history({'kind':'qa','id':identity,'offset':request.get('offset',0)})
            # Source file paths and account emails are not needed in the library history.
            for entry in history['versions']:
                if not str(entry.get('origin','')).startswith('qa_'): entry['label']='资料快照'
                if entry.get('actor'): entry['actor']={k:entry['actor'][k] for k in ('id','name') if k in entry['actor']}
            return history
        if op=='version':
            historical=raw_record(self.workspace.version_files(request.get('version','')),identity)
            return {'record':self.present(historical,files), 'version':request.get('version')}
        if request.get('revision')!=digest(record): raise QAError('问答已被其他人修改，请重新读取最新版本；当前输入仍可保留。','conflict')
        if record and record['archived'] and op!='unarchive': raise QAError('请先恢复已归档的问答。','conflict')
        after=dict(files);identity=identity or 'qa-'+uuid.uuid4().hex
        path=f'{ROOT}{identity}/draft.md';approved_path=f'{ROOT}{identity}/recommended.md'
        current=record['draft'] if record else empty()
        value=copy.deepcopy(current)
        actor={k:self.workspace.actor[k] for k in ('id','name') if k in (self.workspace.actor or {})} or {'id':'local','name':'本地维护'}
        now=datetime.now(timezone.utc).isoformat()
        if op in {'save','restore'}:
            payload=request.get('payload')
            if op=='restore':
                historic=raw_record(self.workspace.version_files(request.get('version','')),identity)
                if not historic: raise QAError('该版本中没有这条问答。','not_found')
                payload=fields(historic['draft'])
                payload['sources']=[s for s in payload['sources'] if self.source_allowed(s)]
                payload['files']=[f for f in payload['files'] if self.file_allowed(f,files)]
            payload=validate_fields(payload)
            normalized=lambda text: ''.join(text.casefold().split())
            incoming={normalized(v) for v in [payload['question'],*payload['aliases']]}
            for other in identities(files):
                if other==identity: continue
                other_record=raw_record(files,other)
                if other_record['archived']: continue
                for version in (other_record['draft'],other_record['recommended']):
                    if version and incoming & {normalized(v) for v in [version['question'],*version['aliases']]}: raise QAError('已有相同问题或问法，请先搜索并补充已有问答。','duplicate')
            payload=self.references(payload,current,files)
            if record and fields(current)==payload: return {'saved':False,'id':identity,'revision':digest(record),'message':'内容没有变化。'}
            value.update(payload)
        elif op=='publish':
            validate_fields(fields(current),publish=True)
            after[approved_path]=document({**fields(current),'id':identity,'approved_at':now,'approved_by':actor})
            value['needs_update']=False
        elif op=='mark_stale':
            if not record['recommended']: raise QAError('此问答尚无推荐回答，可继续完善修订稿。')
            value['needs_update']=True
        elif op in {'archive','unarchive'}:
            if op=='unarchive':
                key=lambda text: ''.join(text.casefold().split())
                restored={key(v) for version in (record['draft'],record['recommended']) if version for v in [version['question'],*version['aliases']]}
                for other in identities(files):
                    item=raw_record(files,other)
                    if other==identity or item['archived']: continue
                    existing={key(v) for version in (item['draft'],item['recommended']) if version for v in [version['question'],*version['aliases']]}
                    if restored & existing: raise QAError('在用问答已有相同问题或问法，请先整理重复内容再恢复。','duplicate')
            value['archived']=op=='archive'
        value.update(id=identity,updated_at=now,updated_by=actor)
        value.setdefault('needs_update',False);value.setdefault('archived',False)
        after[path]=document(value)
        check_files(after)
        if preview: return {'id':identity,'revision':digest(record),'record':self.present(raw_record(after,identity),after)}
        labels={'save':'保存投资问答修订稿','publish':'确认投资问答推荐版本','mark_stale':'标记投资问答待更新','archive':'归档投资问答','unarchive':'恢复投资问答','restore':'从历史恢复投资问答修订稿'}
        result=self.workspace.commit(files,after,labels[op], 'qa_'+op)
        return {**result,'id':identity,'revision':digest(raw_record(after,identity)),'message':labels[op]+'已完成。'}
