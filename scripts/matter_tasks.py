"""Matter-owned action items; task maintenance is separate from business activity."""
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from team_auth import AuthError

STATES = {'pending':'待处理', 'in_progress':'进行中', 'waiting':'等待对方', 'completed':'已完成', 'cancelled':'已取消'}
ACTIVE = {'pending', 'in_progress', 'waiting'}
FIELDS = {'title', 'body', 'state', 'assignee_id', 'due_date', 'source_progress_id', 'completion_note'}
READS = {'list', 'read', 'assignees', 'history', 'version'}
ID = re.compile(r'task-[0-9a-f]{32}')
DEFAULT = dict(title='', body='', state='pending', assignee_id=None, due_date=None, source_progress_id=None, completion_note='')


def fail(message, code='invalid'):
    from workspace_service import ServiceError
    raise ServiceError(message, code)


def records(files, directory):
    from workspace_service import parse_md
    return [{**metadata, 'body':body} for path,text in sorted(files.items()) if path.startswith(directory+'/tasks/') and path.endswith('.md') for metadata,body in [parse_md(text)]]


def validate(files, projects):
    from workspace_service import Workspace, parse_yaml
    seen=set()
    for project,(directory,_,_) in projects.items():
        events={e['id'] for e in parse_yaml(files[directory+'/events.yaml'])['events']}
        for item in records(files,directory):
            identity=item.get('id')
            if not isinstance(identity,str) or not ID.fullmatch(identity) or identity in seen or directory+'/tasks/'+identity+'.md' not in files:fail('待办标识或保存位置无效。')
            seen.add(identity)
            if item.get('project_id')!=project:fail('待办必须归属于所在事项。')
            if not isinstance(item.get('state'),str) or item['state'] not in STATES:fail('待办状态无效。')
            for field,limit,required in [('title',200,True),('body',10000,False),('completion_note',3000,False)]:
                value=item.get(field)
                if not isinstance(value,str) or len(value)>limit or (required and not value.strip()):fail('待办内容格式无效。')
            if item.get('due_date') is not None:Workspace.check_date(item['due_date'])
            for field in ('source_progress_id','completion_progress_id'):
                if item.get(field) is not None and item[field] not in events:fail('待办关联的进展必须属于同一事项。')
            for field in ('author','updated_by','assignee','completed_by'):
                actor=item.get(field)
                if actor is None and field in ('assignee','completed_by'):continue
                if not isinstance(actor,dict) or set(actor)!={'id','name'} or not all(isinstance(v,str) and v for v in actor.values()):fail('待办账号信息无效。')
            for field in ('created_at','updated_at','completed_at'):
                if field=='completed_at' and item.get(field) is None:continue
                try:
                    if not datetime.fromisoformat(item[field]).tzinfo:raise ValueError()
                except (KeyError,TypeError,ValueError):fail('待办保存时间无效。')
            if (item['state']=='completed') != bool(item.get('completed_by') and item.get('completed_at')):fail('完成状态与完成记录不一致。')
            if item['state']!='completed' and (item.get('completed_by') or item.get('completed_at') or item['completion_note']):fail('未完成的待办不能包含完成记录。')


class Tasks:
    def __init__(self,workspace):self.workspace=workspace

    def authorize(self,request):
        op=request.get('operation','list');policy=self.workspace.policy
        if not isinstance(op,str) or not isinstance(request.get('project_id',''),str) or not isinstance(request.get('id',''),str):fail('待办操作参数无效。')
        if op not in READS|{'save'}:raise AuthError('未知的待办操作。','invalid')
        if policy:
            if request.get('project_id') and not (policy.admin and op in READS and request.get('snapshot')):policy.project(request['project_id'])
            if op not in READS and policy.actor['role']=='viewer':raise AuthError('只读成员不能修改待办。')
        if op not in READS and (request.get('snapshot') or request.get('version')):fail('历史待办仅供查看。')
        if op not in {'list'} and not request.get('project_id'):fail('请选择所属事项。')

    def context(self,files,project):
        from recycle_bin import require_active
        require_active(files,project)
        matter=self.workspace.projects(files).get(project)
        if not matter:fail('未找到所属事项。','not_found')
        return matter

    def raw(self,files,request):
        from workspace_service import digest
        matter=self.context(files,request['project_id']);items=records(files,matter[0])
        item=next((x for x in items if x['id']==request.get('id')),None)
        if request.get('id') and not item:fail('未找到这条待办。','not_found')
        return {'record':item,'revision':digest(item if item else items)}

    @staticmethod
    def fields(item):
        if not item:return dict(DEFAULT)
        return {**{k:item[k] for k in FIELDS-{'assignee_id'}},'assignee_id':(item.get('assignee') or {}).get('id')}

    def decorate(self,item,files):
        from workspace_service import digest
        from recycle_bin import hidden
        project=item['project_id'];matter=self.context(files,project)
        source=self.workspace.record(files,'progress',item['source_progress_id'],project) if item['source_progress_id'] else None
        return {**item,'revision':digest(item),'matter_name':matter[1]['name'],'source_title':source['event']['title'] if source else '',
                'source_archived':bool(source and hidden(files,project,item['source_progress_id']))}

    def read(self,request,files=None):
        files=self.workspace.read_files() if files is None else files
        result=self.raw(files,request)
        result['fields']=self.fields(result['record'])
        result['progress_revision']=self.workspace.record_revision(files,'progress','',request['project_id'])
        if result['record']:result['record']=self.decorate(result['record'],files)
        return result

    def assignees(self,project):
        self.context(self.workspace.read_files(),project)
        if not self.workspace.policy:return [{'id':'local','name':'本地操作'}]
        from team_auth import Accounts
        accounts=Accounts(self.workspace.root)
        try:
            return [{'id':r['id'],'name':r['name']} for r in accounts.db.execute("SELECT id,name,role,all_projects,project_ids FROM users WHERE active=1 AND role IN ('admin','editor') ORDER BY name,id") if r['role']=='admin' or r['all_projects'] or project in json.loads(r['project_ids'])]
        finally:accounts.close()

    def listing(self,request,files):
        from workspace_service import parse_yaml
        from recycle_bin import hidden
        policy=self.workspace.policy
        actor=(policy.actor if policy else self.workspace.actor) or {'id':'local'}
        projects=self.workspace.projects(files)
        allowed=set(projects) if not policy or (policy.admin and request.get('snapshot')) else policy.allowed
        if request.get('project_id'):self.context(files,request['project_id']);allowed&={request['project_id']}
        query=request.get('query','');state=request.get('state','active');scope=request.get('scope','all');due=request.get('due','all')
        if not isinstance(query,str) or len(query)>300 or not all(isinstance(v,str) for v in (state,scope,due)) or state not in set(STATES)|{'all','active'} or scope not in {'all','mine'} or due not in {'all','overdue','week','undated'}:fail('待办筛选条件无效。')
        assignee=request.get('assignee_id','')
        if not isinstance(assignee,str) or len(assignee)>160:fail('负责人筛选无效。')
        try:offset=int(request.get('offset',0))
        except (TypeError,ValueError):fail('页码无效。')
        if offset<0:fail('页码无效。')
        today=datetime.now(ZoneInfo(parse_yaml(files['workspace.yaml']).get('timezone','Asia/Shanghai'))).date()
        week=(today+timedelta(days=7)).isoformat();today=today.isoformat()
        items=[];owners={}
        for project in sorted(allowed):
            if project not in projects or hidden(files,project):continue
            for raw in records(files,projects[project][0]):
                owner=(raw['assignee'] or {}).get('id','')
                if owner:owners[owner]=raw['assignee']
                if scope=='mine' and owner!=actor['id']:continue
                if assignee and (owner if assignee!='unassigned' else not owner)!=(assignee if assignee!='unassigned' else True):continue
                item=self.decorate(raw,files)
                if query.strip().casefold() not in ' '.join([item['title'],item['body'],item['completion_note'],item['matter_name'],(item['assignee'] or {}).get('name','')]).casefold():continue
                items.append(item)
        counts={'active':sum(t['state'] in ACTIVE for t in items),'completed':sum(t['state']=='completed' for t in items),'cancelled':sum(t['state']=='cancelled' for t in items),'overdue':sum(t['state'] in ACTIVE and bool(t['due_date']) and t['due_date']<today for t in items)}
        items=[t for t in items if state=='all' or (t['state'] in ACTIVE if state=='active' else t['state']==state)]
        if due=='overdue':items=[t for t in items if t['state'] in ACTIVE and t['due_date'] and t['due_date']<today]
        elif due=='week':items=[t for t in items if t['due_date'] and today<=t['due_date']<=week]
        elif due=='undated':items=[t for t in items if not t['due_date']]
        items.sort(key=lambda t:(t['state'] not in ACTIVE,t['due_date'] or '9999-12-31',t['created_at'],t['id']))
        return {'items':items[offset:offset+50],'total':len(items),'next_offset':offset+50 if len(items)>offset+50 else None,'counts':counts,'today':today,'current_user_id':actor['id'],'assignees':sorted(owners.values(),key=lambda a:(a['name'],a['id']))}

    def history(self,request,files):
        self.raw(files,request)
        if not request.get('id'):fail('请选择一条待办。')
        workspace=self.workspace;ceiling=request.get('snapshot');allowed=None
        if ceiling:
            if not re.fullmatch(r'local:[0-9a-f]{40,64}',ceiling):return {'versions':[],'has_more':False}
            allowed=set(workspace.git('rev-list',ceiling.split(':',1)[1]).splitlines())
        entries=[]
        for version in workspace.history_entries({'kind':'task','id':request['id']}):
            if not version['version'].startswith('local:') or (allowed is not None and version['version'].split(':',1)[1] not in allowed):continue
            if request.get('operation')=='version' and version['version']!=request.get('version'):continue
            from workspace_service import ServiceError
            try:item=self.raw(workspace.version_files(version['version']),request)['record']
            except ServiceError:continue
            if not item:continue
            safe={k:version[k] for k in ('version','at','label')}
            safe['actor']={k:version['actor'][k] for k in ('id','name')} if version.get('actor') else None
            if request.get('operation')=='version':return {'record':item,'version':safe}
            entries.append(safe)
        if request.get('operation')=='version':fail('未找到这条待办的历史版本。','not_found')
        try:offset=int(request.get('offset',0))
        except (TypeError,ValueError):fail('页码无效。')
        if offset<0:fail('页码无效。')
        return {'versions':entries[offset:offset+40],'has_more':len(entries)>offset+40}

    def execute(self,request,*,preview=False):
        from workspace_service import digest,markdown
        from recycle_bin import require_active
        self.authorize(request);workspace=self.workspace;op=request.get('operation','list')
        if op=='assignees':return {'items':self.assignees(request['project_id'])}
        files=workspace.version_files(request['snapshot']) if request.get('snapshot') else workspace.read_files()
        if op=='list':return self.listing(request,files)
        if op=='read':return self.read(request,files)
        if op in {'history','version'}:return self.history(request,files)
        actor=workspace.actor or {'id':'local','name':'本地操作'};actor={k:actor[k] for k in ('id','name')}
        rid=request.get('request_id','')
        if not isinstance(rid,str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',rid):fail('请提供至少 16 位唯一请求编号。')
        receipt=workspace.store/'task-requests'/(digest([actor['id'],rid])+'.json');signature=digest(request)
        if receipt.exists() and not preview:
            old=json.loads(receipt.read_text())
            if old['signature']!=signature:fail('同一请求编号不能用于不同内容。','conflict')
            if old.get('result'):return old['result']
            fail('保存结果需要核对，请保留请求编号并回读待办和历史。','uncertain')
        current=self.raw(files,request)
        if request.get('revision')!=current['revision']:fail('待办已被修改，请读取最新内容并比较后保存。','conflict')
        previous=current['record'];payload=request.get('payload')
        if not isinstance(payload,dict) or set(payload)!=FIELDS:fail('待办字段无效。')
        payload=dict(payload)
        for field,limit,required in [('title',200,True),('body',10000,False),('completion_note',3000,False)]:
            value=payload[field]
            if not isinstance(value,str) or len(value)>limit or (required and not value.strip()):fail('请填写待办内容（最多 200 字）；说明最多 10000 字，完成备注最多 3000 字。')
            payload[field]=value.strip()
        if not isinstance(payload['state'],str) or payload['state'] not in STATES:fail('待办状态无效。')
        if payload['due_date'] is not None:workspace.check_date(payload['due_date'])
        if payload['source_progress_id'] is not None:
            if not isinstance(payload['source_progress_id'],str) or not workspace.record(files,'progress',payload['source_progress_id'],request['project_id']):fail('请选择同一事项的来源进展。')
            if not previous or previous['source_progress_id']!=payload['source_progress_id']:require_active(files,request['project_id'],payload['source_progress_id'])
        assignee_id=payload.pop('assignee_id');assignee=None
        if assignee_id is not None:
            if not isinstance(assignee_id,str):fail('负责人无效。')
            if previous and (previous['assignee'] or {}).get('id')==assignee_id:assignee=previous['assignee']
            else:
                assignee=next((a for a in self.assignees(request['project_id']) if a['id']==assignee_id),None)
                if not assignee:fail('负责人须为能编辑本事项的已启用团队成员。')
        matter=self.context(files,request['project_id']);identity=request.get('id') or 'task-'+uuid.uuid4().hex
        if any(t['id']!=identity and t['state'] in ACTIVE and payload['state'] in ACTIVE and t['title'].casefold()==payload['title'].casefold() and t['source_progress_id']==payload['source_progress_id'] for t in records(files,matter[0])):fail('本事项已有相同的未完成待办，请先查看已有记录。','duplicate')
        now=datetime.now(timezone.utc).isoformat();done=payload['state']=='completed';was_done=bool(previous and previous['state']=='completed')
        if not done:payload['completion_note']=''
        metadata={**payload,'id':identity,'project_id':request['project_id'],'assignee':assignee,'author':previous['author'] if previous else actor,'created_at':previous['created_at'] if previous else now,'updated_by':actor,'updated_at':now,
                  'completed_at':previous['completed_at'] if done and was_done else now if done else None,'completed_by':previous['completed_by'] if done and was_done else actor if done else None,'completion_progress_id':previous.get('completion_progress_id') if previous else None}
        after=dict(files);completion=request.get('completion_event')
        if completion is not None:
            if not done or was_done:fail('仅在本次标记完成时可以同时记录进展。')
            if not isinstance(completion,dict) or set(completion)!={'revision','payload'} or not isinstance(completion['payload'],dict):fail('同时记录的进展格式无效。')
            from workspace_service import EVENT_FIELDS
            event=completion['payload']
            if set(event)-EVENT_FIELDS-{'body','location'}:fail('请仅填写进展内容及已有参与人。')
            if workspace.policy:workspace.policy.references(event)
            # The candidate composes both changes; it never commits a partial completion.
            saved=workspace.save({'kind':'progress','project_id':request['project_id'],'revision':completion['revision'],'payload':event},candidate=after)
            after=saved['files'];metadata['completion_progress_id']=saved['id']
        body=metadata.pop('body')
        after[matter[0]+'/tasks/'+identity+'.md']=markdown(metadata,body)
        errors,_=workspace.stage(after)
        if errors:fail('待办未通过资料校验。','validation')
        if preview:return {'valid':True}
        receipt.parent.mkdir(mode=0o700,exist_ok=True);workspace.atomic(receipt,json.dumps({'signature':signature}))
        if workspace.actor is None:workspace.actor={**actor,'email':''}
        label=('新增待办：' if not previous else '完成待办：' if done and not was_done else '重新打开待办：' if was_done and not done else '修改待办：')+metadata['title']
        result=workspace.commit(files,after,label,'form');result.update(id=identity,revision=self.raw(workspace.read_files(),{**request,'id':identity})['revision'],completion_progress_id=metadata['completion_progress_id'])
        workspace.atomic(receipt,json.dumps({'signature':signature,'result':result},ensure_ascii=False))
        return result
