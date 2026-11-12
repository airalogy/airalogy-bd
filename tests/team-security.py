# /// script
# requires-python = ">=3.10"
# dependencies = ["PyYAML>=6.0,<7"]
# ///
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch
import zipfile
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from team_auth import Accounts, AuthError, backup_accounts, validate_account_backup, public_user
from team_policy import Policy
from remote_access import RemoteAccess
from workspace_service import Workspace
from automatic_backup import BackupManager
from file_backup import create_backup, backup_download, restore_backup, checksum
from oss_backup import settings, upload

OSS = {'BD_OSS_REGION':'cn-hangzhou','BD_OSS_BUCKET':'test-private-bucket','BD_OSS_ENDPOINT':'https://oss-cn-hangzhou.aliyuncs.com','BD_OSS_PREFIX':'bd-backups'}


class ReleaseWorkflowTests(unittest.TestCase):
    def test_parallel_release_preserves_security_gates(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/publish.yml').read_text())
        jobs = workflow['jobs']
        def predecessors(name, visiting=()):
            self.assertNotIn(name, visiting, 'Release graph must be acyclic')
            needs = jobs[name].get('needs', [])
            needs = [needs] if isinstance(needs, str) else needs
            result = set(needs)
            for parent in needs:
                result.update(predecessors(parent, (*visiting, name)))
            return result
        for job in ('verify', 'package', 'image'):
            self.assertEqual(predecessors(job), {'source'})
            self.assertNotIn('permissions', jobs[job], 'Build jobs must remain read-only')
        self.assertTrue({'source', 'verify', 'package'} <= predecessors('publish'))
        self.assertNotIn('image', predecessors('publish'))
        self.assertTrue({'source', 'verify', 'image'} <= predecessors('publish-image'))
        self.assertNotIn('publish', predecessors('publish-image'))
        self.assertTrue({'verify', 'image', 'public-image'} <= predecessors('deployment-assets'))
        self.assertNotIn('publish', predecessors('deployment-assets'))
        self.assertTrue({'publish', 'package', 'deployment-assets'} <= predecessors('release-assets'))
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        for name, job in jobs.items():
            if 'write' in job.get('permissions', {}).values():
                self.assertEqual(job['environment'], 'npm')
                self.assertEqual(job['if'], "github.event_name == 'release'")
        final = jobs['release-assets']['steps'][-1]['run']
        early = jobs['deployment-assets']['steps'][-1]['run']
        self.assertIn('--deployment-only', early)
        self.assertNotIn('--deployment-only', final)


class EventUpdateTests(unittest.TestCase):
    def test_event_and_document_use_their_own_last_account_at_the_selected_version(self):
        with tempfile.TemporaryDirectory() as temp:
            content = Path(temp) / 'content'
            shutil.copytree(ROOT / 'fixtures/demo/content', content)
            workspace = Workspace(content)
            event_id = '2026-01-15-solution-meeting'
            query = {'kind':'progress', 'project_id':'project-demo-partnership', 'id':event_id}
            directory = 'counterparties/示例合作/matters/合作对接/'
            other = 'counterparties/星帆创投/matters/融资对接/events.yaml'
            # Event IDs are unique within each matter, not across all matters.
            other_file = content / other
            other_file.write_text(other_file.read_text().replace('2026-01-12-investment-contact', event_id))
            baseline = workspace.observe()
            self.assertIsNone(workspace.event_update(query, baseline)['update'])
            def change(path, old, new, name):
                before = workspace.read_files()
                after = {**before, path:before[path].replace(old, new)}
                self.assertNotEqual(before, after)
                workspace.actor = {'id':name, 'name':name, 'email':'member@example.invalid'} if name else None
                return workspace.commit(before, after, '修改示例记录', 'form' if name else 'external')['status']
            first = change(directory+'events.yaml', '双方讨论虚构合作范围', '双方核对合作范围', '示例甲')
            self.assertEqual(workspace.event_update(query, first)['update']['name'], '示例甲')
            body_path = directory+'meetings/20260115.md'
            text = (content/body_path).read_text()
            second = change(body_path, text, text+'\n补充会议结论。\n', '示例乙')
            self.assertEqual(workspace.event_update(query, second)['update']['name'], '示例乙')
            change(directory+'events.yaml', '建立初步联系', '补充首次沟通', '其他编辑')
            another = change(other, '建立投资对接', '补充投资对接', '受限账号')
            update = workspace.event_update(query, another)['update']
            self.assertEqual(set(update), {'name','at'})
            self.assertEqual(update['name'], '示例乙')
            self.assertEqual(workspace.event_update({**query,'snapshot':first['version']}, another)['update']['name'], '示例甲')
            self.assertIsNone(workspace.event_update({**query,'snapshot':baseline['version']}, another)['update'])
            company = change('company/events.yaml', '启动年度 BD 计划', '更新年度 BD 计划', '示例丙')
            company_query = {'kind':'company','id':'2026-01-12-annual-bd-plan'}
            self.assertEqual(workspace.event_update(company_query, company)['update']['name'], '示例丙')
            external = change(body_path, '补充会议结论', '补充会议安排', None)
            self.assertIsNone(workspace.event_update(query, external)['update'])


class QuestionAuthorizationTests(unittest.TestCase):
    def test_confirmation_preserves_editor_and_records_the_actual_confirmer(self):
        from investment_qa import InvestmentQA
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';shutil.copytree(ROOT/'fixtures/demo/content',content)
            workspace=Workspace(content);workspace.observe()
            editor={'id':'editor','name':'编辑甲','email':'editor@example.invalid','role':'editor','all_projects':False,'project_ids':[],'qa_allowed':True}
            publisher={**editor,'id':'publisher','name':'确认乙','qa_can_publish':True}
            def qa(actor):
                workspace.policy=Policy(workspace,actor);workspace.actor=actor
                return InvestmentQA(workspace)
            first=qa(editor).execute({'operation':'save','revision':qa(editor).execute({'operation':'read'})['revision'],'payload':{'question':'示例问题','short_answer':'示例回答'}})
            identity=first['id'];draft=qa(editor).execute({'operation':'read','id':identity})['record']['draft']
            self.assertEqual(draft['edited_by'],{'id':'editor','name':'编辑甲'})
            with self.assertRaises(AuthError):qa(editor).execute({'operation':'publish','id':identity,'revision':first['revision']})
            confirmed=qa(publisher).execute({'operation':'publish','id':identity,'revision':first['revision']})
            record=qa(publisher).execute({'operation':'read','id':identity})['record']
            self.assertEqual(record['recommended']['approved_by'],{'id':'publisher','name':'确认乙'})
            for value in (record['draft'],record['recommended']):
                self.assertEqual(value['edited_by'],draft['edited_by']);self.assertEqual(value['edited_at'],draft['edited_at'])
            with self.assertRaises(AuthError):qa(publisher).execute({'operation':'archive','id':identity,'revision':confirmed['revision']})
            with self.assertRaises(AuthError):qa({**publisher,'role':'viewer'}).execute({'operation':'publish','id':identity,'revision':confirmed['revision']})
            qa(publisher).execute({'operation':'mark_stale','id':identity,'revision':confirmed['revision']})
            self.assertEqual(qa(editor).execute({'operation':'read','id':identity})['record']['draft']['edited_by'],draft['edited_by'])
            historical=qa(publisher).execute({'operation':'version','id':identity,'version':confirmed['status']['version']})['record']
            self.assertEqual(historical['recommended']['approved_by']['id'],'publisher')
            history=qa(editor).execute({'operation':'history','id':identity})['versions']
            self.assertTrue(any(e['origin']=='qa_publish' and e['actor']['id']=='publisher' for e in history))
            self.assertTrue(any(e['origin']=='qa_save' and e['actor']['id']=='editor' for e in history))

    def test_file_sources_are_redacted_preserved_and_included_in_backups(self):
        from investment_qa import InvestmentQA, fields, raw_record
        from file_library import FileLibrary
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';shutil.copytree(ROOT/'fixtures/demo/content',content)
            workspace=Workspace(content);workspace.observe()
            library=FileLibrary(workspace)
            library.save({'operation':'upload','id':'','payload':{'title':'受限融资附件','organization':'示例机构','category':'bp','project_ids':['project-demo-investment'],'home_counterparty_id':'counterparty-13414ee5502c4f23','filename':'private-bp.txt','data':base64.b64encode(b'private example').decode(),'status':'draft'}})
            file=library.list()['files'][0]
            qa=InvestmentQA(workspace)
            saved=qa.execute({'operation':'save','revision':qa.execute({'operation':'read'})['revision'],'payload':{'question':'演示问题','short_answer':'共享回答','sources':[{'project_id':'project-demo-investment'}],'files':[{'file_id':file['id'],'version_id':file['current_version']}]}})
            qa.execute({'operation':'publish','id':saved['id'],'revision':saved['revision']})
            actor={'id':'editor','name':'编辑成员','email':'editor@example.invalid','role':'editor','all_projects':False,'project_ids':['project-demo-partnership'],'qa_allowed':True}
            workspace.policy=Policy(workspace,actor);workspace.actor=actor
            qa=InvestmentQA(workspace);view=qa.execute({'operation':'read','id':saved['id']})
            self.assertEqual(view['record']['draft']['files'],[])
            self.assertEqual(view['record']['recommended']['files'],[])
            self.assertNotIn(file['id'],json.dumps(view))
            self.assertNotIn('private-bp.txt',json.dumps(view))
            draft=fields(view['record']['draft']);draft['short_answer']='可见内容的修订'
            qa.execute({'operation':'save','id':saved['id'],'revision':view['revision'],'payload':draft})
            self.assertEqual(raw_record(workspace.read_files(),saved['id'])['draft']['files'],[{'file_id':file['id'],'version_id':file['current_version']}])
            with self.assertRaises(AuthError): workspace.policy.authorize({'action':'file_download','id':file['id']})
            actor['qa_allowed']=False
            with self.assertRaises(AuthError): InvestmentQA(workspace).execute({'operation':'read','id':saved['id']})
            workspace.policy=None
            backup=create_backup(workspace)
            with zipfile.ZipFile(backup_download(workspace,backup['id'])['path']) as archive:
                self.assertTrue(any(name.endswith('/'+saved['id']+'/draft.md') for name in archive.namelist()))
                self.assertTrue(any(name.endswith('/'+saved['id']+'/recommended.md') for name in archive.namelist()))


class AccountTests(unittest.TestCase):
    def test_question_confirmation_grants_are_explicit_scoped_and_revoked(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            invited=accounts.invite({'name':'管理员','email':'admin@example.invalid','role':'admin'},None,set(),bootstrap=True)
            admin_id=accounts.invitation(invited['token'])['user_id']
            admin={'id':admin_id,'name':'管理员','role':'admin'}
            self.assertTrue(accounts.qa_can_publish(admin_id))
            invite=accounts.invite({'name':'编辑','role':'editor','qa_allowed':True},admin,set())
            identity=accounts.invitation(invite['token'])['user_id']
            self.assertFalse(accounts.qa_can_publish(identity))
            def member():return accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
            for payload in ({'role':'viewer','qa_allowed':True,'qa_can_publish':True},{'role':'editor','qa_allowed':False,'qa_can_publish':True},{'role':'editor','qa_allowed':True,'qa_can_publish':1}):
                with self.assertRaises(AuthError): accounts.invite({'name':'无效权限',**payload},admin,set())
            with self.assertRaises(AuthError):accounts.update({**member(),'qa_can_publish':True}, {'id':identity,'role':'editor'},set())
            accounts.update({**member(),'active':False,'qa_can_publish':True,'remote_allowed_before':False},admin,set())
            self.assertTrue(member()['qa_can_publish'])
            self.assertTrue(any(change['field']=='qa_can_publish' and change['after']=='允许' for entry in accounts.audit_entries({})['entries'] for change in (entry['changes'] or [])))
            # A role downgrade clears confirmation even when an older client omits the new field.
            payload={**member(),'role':'viewer','active':False,'remote_allowed_before':False};payload.pop('qa_can_publish')
            accounts.update(payload,admin,set());self.assertFalse(accounts.qa_can_publish(identity))
            payload={**member(),'role':'editor','active':False,'remote_allowed_before':False};payload.pop('qa_can_publish')
            accounts.update(payload,admin,set());self.assertFalse(accounts.qa_can_publish(identity))
            accounts.update({**member(),'active':False,'qa_can_publish':True,'remote_allowed_before':False},admin,set())
            payload={**member(),'qa_allowed':False,'active':False,'remote_allowed_before':False};payload.pop('qa_can_publish')
            accounts.update(payload,admin,set());self.assertFalse(accounts.qa_can_publish(identity))
            self.assertEqual(accounts.db.execute('SELECT count(*) FROM qa_grants WHERE owner=?',(identity,)).fetchone()[0],0)
            accounts.db.execute("UPDATE users SET role='editor' WHERE id=?",(admin_id,));accounts.db.commit()
            self.assertFalse(accounts.qa_can_publish(admin_id),'Admin confirmation must not persist through demotion')
            accounts.close()

    def test_existing_library_grants_do_not_gain_confirmation(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            accounts.db.execute('DROP TABLE qa_grants')
            accounts.db.execute('CREATE TABLE qa_grants(owner TEXT PRIMARY KEY)')
            accounts.db.execute("INSERT INTO qa_grants VALUES('existing-editor')")
            accounts.db.commit();accounts.close()
            accounts=Accounts(content)
            self.assertEqual(tuple(accounts.db.execute('SELECT owner,can_publish FROM qa_grants').fetchone()),('existing-editor',0))
            accounts.close()

    def test_question_grants_survive_backups_but_credentials_do_not(self):
        from team_auth import backup_accounts, validate_account_backup
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            invitation=accounts.invite({'name':'管理员','email':'admin@example.invalid','role':'admin'},None,set(),bootstrap=True)
            identity=accounts.invitation(invitation['token'])['user_id']
            actor=accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
            self.assertTrue(actor['qa_allowed'])
            invitation=accounts.invite({'name':'编辑','role':'editor','qa_allowed':True,'qa_can_publish':True},actor,set())
            editor_id=accounts.invitation(invitation['token'])['user_id']
            self.assertTrue(accounts.qa_allowed(editor_id))
            self.assertTrue(accounts.qa_can_publish(editor_id))
            destination=Path(temp)/'copy.sqlite3'
            backup_accounts(content,destination);validate_account_backup(destination)
            with sqlite3.connect(destination) as backup:
                self.assertEqual(backup.execute('SELECT owner,can_publish FROM qa_grants').fetchall(),[(editor_id,1)])
                self.assertEqual(backup.execute('SELECT count(*) FROM invitations').fetchone()[0],0)
            accounts.db.execute("UPDATE users SET role='editor' WHERE id=?",(identity,));accounts.db.commit()
            self.assertFalse(accounts.qa_allowed(identity),'Implicit admin grants do not persist through demotion')
            accounts.close()

    def test_admin_remote_eligibility_follows_persisted_role(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            invitation=accounts.invite({'name':'管理员','email':'admin@example.invalid','role':'admin'},None,set(),bootstrap=True)
            identity=accounts.invitation(invitation['token'])['user_id']
            def member():
                return accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
            actor=member()
            remote=RemoteAccess(None,accounts)
            self.assertTrue(actor['remote_allowed'])
            self.assertTrue(remote.status(actor,True)['members'][0]['granted'])
            self.assertEqual(remote.status(actor)['tokens'],[])
            self.assertFalse(remote.settings()['enabled'])
            self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_grants').fetchone()[0],0)
            with self.assertRaisesRegex(AuthError,'尚未开启'):
                remote.browser({'operation':'issue','label':'No automatic access'},actor)
            for allowed in (True,False):
                with self.assertRaisesRegex(AuthError,'管理员默认'):
                    remote.browser({'operation':'grant','memberId':identity,'allowed':allowed},actor)
            # Existing administrators also gain eligibility on read, without a stored grant or credential.
            accounts.close();accounts=Accounts(content);remote=RemoteAccess(None,accounts)
            self.assertTrue(accounts.remote_allowed(identity))
            self.assertFalse(accounts.remote_allowed('unknown'))
            for role in ('editor','viewer'):
                invitation=accounts.invite({'name':role,'role':role},actor,set())
                other=accounts.invitation(invitation['token'])['user_id']
                self.assertFalse(accounts.remote_allowed(other))
                remote.browser({'operation':'configure','enabled':True,'revision':remote.settings()['revision']},actor)
                # A caller-supplied role cannot grant eligibility to an ordinary member.
                with self.assertRaisesRegex(AuthError,'尚未授权'):
                    remote.grant({'id':other,'role':'admin'})
            self.assertEqual(remote.status(actor)['tokens'],[])
            accounts.close()

    def test_admin_demotion_does_not_inherit_implicit_or_older_explicit_access(self):
        for older_grant in (False,True):
            with self.subTest(older_grant=older_grant),tempfile.TemporaryDirectory() as temp:
                content=Path(temp)/'content';content.mkdir()
                accounts=Accounts(content)
                actor={'id':'admin','name':'管理员','role':'admin'}
                invitation=accounts.invite({'name':'待激活管理员','role':'admin','remote_allowed':False},actor,set())
                identity=accounts.invitation(invitation['token'])['user_id']
                def member():
                    return accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
                self.assertTrue(member()['remote_allowed'])
                if older_grant:
                    with accounts.db:accounts.db.execute('INSERT INTO remote_grants VALUES(?)',(identity,))
                # A client omitting the separate permission must not carry the admin's access into a new role.
                values={k:v for k,v in member().items() if k not in {'remote_allowed','qa_allowed','qa_can_publish'}}
                accounts.update({**values,'role':'editor','active':False},actor,set())
                self.assertFalse(member()['remote_allowed'])
                self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_grants').fetchone()[0],0)
                # A deliberate ordinary-member grant remains supported, and promotion consumes no persistent grant.
                accounts.update({**member(),'active':False,'remote_allowed':True,'remote_allowed_before':False},actor,set())
                self.assertTrue(member()['remote_allowed'])
                accounts.update({**member(),'role':'admin','active':False,'remote_allowed_before':True},actor,set())
                self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_grants').fetchone()[0],0)
                accounts.update({**member(),'role':'viewer','active':False,'qa_can_publish':False,'remote_allowed':True,'remote_allowed_before':True},actor,set())
                self.assertTrue(member()['remote_allowed'])
                self.assertEqual(accounts.invitation(invitation['token'])['user_id'],identity)
                accounts.close()

    def test_member_invites_and_edits_keep_remote_permissions_atomic(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            actor={'id':'admin','name':'管理员','role':'admin'}
            remote=RemoteAccess(None,accounts)
            invitation=accounts.invite({'name':'工具成员','role':'editor','project_ids':['matter'],'remote_allowed':True},actor,{'matter'})
            identity=accounts.invitation(invitation['token'])['user_id']
            member=accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
            self.assertTrue(member['remote_allowed']);self.assertFalse(accounts.remote_enabled())
            self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_tokens').fetchone()[0],0)
            # Pending membership and remote permission are changed together, without consuming or extending the invitation.
            accounts.update({**member,'active':False,'role':'viewer','remote_allowed':False,'remote_allowed_before':True},actor,{'matter'})
            self.assertEqual(accounts.invitation(invitation['token'])['user_id'],identity)
            self.assertEqual(accounts.invitation(invitation['token'])['expires'],invitation['expires'])
            fresh=accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
            self.assertEqual(fresh['status'],'invited');self.assertFalse(fresh['remote_allowed'])
            # A parallel change through the former grant endpoint cannot be silently overwritten by an open member form.
            remote.browser({'operation':'grant','memberId':identity,'allowed':True},actor)
            with self.assertRaisesRegex(AuthError,'权限已变化'):
                accounts.update({**fresh,'active':False,'remote_allowed':False,'remote_allowed_before':False},actor,{'matter'})
            old_client={k:v for k,v in fresh.items() if k!='remote_allowed'}
            accounts.update({**old_client,'active':False},actor,{'matter'})
            self.assertTrue(accounts.remote_allowed(identity))
            self.assertEqual(accounts.invitation(invitation['token'])['expires'],invitation['expires'])
            before=accounts.db.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            with patch.object(accounts,'new_invitation',side_effect=RuntimeError('simulated invitation failure')):
                with self.assertRaises(RuntimeError):
                    accounts.invite({'name':'失败邀请','remote_allowed':True},actor,set())
            self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM users').fetchone()[0],before)
            self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_grants').fetchone()[0],1)
            for invalid in ('true',1,None):
                with self.assertRaises(AuthError):accounts.invite({'name':'无效权限','remote_allowed':invalid},actor,set())
            self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM users').fetchone()[0],before)
            accounts.close()

    def test_email_optional_invites_keep_identity_grants_and_survive_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            actor={'id':'admin','name':'管理员','role':'admin'}
            with self.assertRaises(AuthError):
                accounts.invite({'name':'管理员','role':'admin'},None,set(),bootstrap=True)
            first=accounts.invite({'name':'同名成员','role':'editor','project_ids':['matter']},actor,{'matter'})
            second=accounts.invite({'name':'同名成员','email':'  ','role':'viewer'},actor,{'matter'})
            one,two=accounts.invitation(first['token']),accounts.invitation(second['token'])
            self.assertNotEqual(one['user_id'],two['user_id'])
            self.assertIsNone(one['email']);self.assertIsNone(two['email'])
            with self.assertRaises(AuthError):
                accounts.invite({'name':'格式错误','email':'bad-address'},actor,set())
            replacement=accounts.reset(one['user_id'],actor)
            with self.assertRaises(AuthError):accounts.invite_info(first['token'])
            self.assertIsNone(accounts.invite_info(replacement['token'])['email'])
            backup=Path(temp)/'accounts.sqlite3'
            self.assertTrue(backup_accounts(content,backup));validate_account_backup(backup)
            with sqlite3.connect(backup) as db:
                row=db.execute('SELECT email,role,project_ids,active FROM users WHERE id=?',(one['user_id'],)).fetchone()
                self.assertEqual(row,(None,'editor','["matter"]',0))
                self.assertEqual(db.execute('SELECT COUNT(*) FROM invitations').fetchone()[0],0)
                db.execute('UPDATE users SET active=1 WHERE id=?',(one['user_id'],))
            with self.assertRaisesRegex(AuthError,'不能缺少邮箱'):validate_account_backup(backup)
            accounts.close()

    def test_required_email_schema_upgrade_preserves_members_and_references(self):
        for username in (False,True):
            with self.subTest(username=username), tempfile.TemporaryDirectory() as temp:
                content=Path(temp)/'content';content.mkdir()
                directory=Path(temp)/'.bd-auth';directory.mkdir()
                with sqlite3.connect(directory/'accounts.sqlite3') as db:
                    db.execute('''CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,
                        role TEXT NOT NULL,all_projects INTEGER NOT NULL,project_ids TEXT NOT NULL,active INTEGER NOT NULL,
                        credential_revision TEXT NOT NULL,revision TEXT NOT NULL''' + (',username TEXT' if username else '') + ')')
                    db.execute("INSERT INTO users(id,email,name,role,all_projects,project_ids,active,credential_revision,revision) VALUES('existing','existing@example.invalid','成员','editor',0,'[\"matter\"]',1,'credentials','permissions')")
                    if username:
                        db.execute("UPDATE users SET username='existing_member'")
                        db.execute('CREATE UNIQUE INDEX users_username_unique ON users(username COLLATE NOCASE)')
                    db.execute('CREATE TABLE invitations(digest TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL)')
                    db.execute("INSERT INTO invitations VALUES('digest','existing',9999999999)")
                    db.execute('CREATE TABLE ba_user(id TEXT PRIMARY KEY,memberId TEXT,credentialRevision TEXT)')
                    db.execute("INSERT INTO ba_user VALUES('provider-id','existing','credentials')")
                    db.row_factory=sqlite3.Row
                    before=dict(db.execute('SELECT * FROM users').fetchone())
                accounts=Accounts(content)
                self.assertEqual(dict(accounts.db.execute('SELECT * FROM users').fetchone()),before|({'username':None} if not username else {}))
                self.assertEqual(tuple(accounts.db.execute('SELECT * FROM invitations').fetchone()),('digest','existing',9999999999))
                self.assertEqual(tuple(accounts.db.execute('SELECT * FROM ba_user').fetchone()),('provider-id','existing','credentials'))
                self.assertEqual(accounts.db.execute('PRAGMA foreign_key_check').fetchall(),[])
                self.assertEqual(accounts.db.execute('PRAGMA foreign_keys').fetchone()[0],1)
                pending=accounts.invite({'name':'新成员'}, {'id':'admin','name':'管理员','role':'admin'},set())
                self.assertIsNone(accounts.invite_info(pending['token'])['email'])
                accounts.close()
                reopened=Accounts(content)
                self.assertEqual(reopened.db.execute("SELECT id FROM users WHERE email='existing@example.invalid'").fetchone()[0],'existing')
                reopened.close()

    def test_interrupted_username_binding_is_reconciled_before_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            accounts.invite({'email':'member@example.invalid','name':'成员','role':'admin'},None,set(),bootstrap=True)
            user=accounts.db.execute('SELECT * FROM users').fetchone()
            with accounts.db:
                accounts.db.execute('CREATE TABLE ba_user(memberId TEXT,credentialRevision TEXT,username TEXT)')
                accounts.db.execute('INSERT INTO ba_user VALUES(?,?,?)',(user['id'],user['credential_revision'],'member_name'))
            accounts.close()
            backup=Path(temp)/'accounts.sqlite3'
            self.assertTrue(backup_accounts(content,backup))
            with sqlite3.connect(backup) as db:
                self.assertEqual(db.execute('SELECT username FROM users').fetchone()[0],'member_name')

    def test_email_accounts_and_backups_gain_username_without_changing_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            invitation=accounts.invite({'email':'existing@example.invalid','name':'已有成员','role':'admin'},None,set(),bootstrap=True)
            before=dict(accounts.db.execute('SELECT * FROM users').fetchone())
            with accounts.db:
                accounts.db.execute('DROP INDEX users_username_unique')
                accounts.db.execute('ALTER TABLE users DROP COLUMN username')
            file=accounts.path;accounts.close()
            old_backup=Path(temp)/'old-accounts.sqlite3';shutil.copyfile(file,old_backup)
            validate_account_backup(old_backup)
            migrated=Accounts(content)
            after=dict(migrated.db.execute('SELECT * FROM users').fetchone())
            self.assertEqual(before,after)
            self.assertEqual(migrated.invite_info(invitation['token'])['email'],'existing@example.invalid')
            row=migrated.db.execute('SELECT * FROM users').fetchone()
            self.assertEqual(migrated.member_info(row)['status'],'invited')
            with patch('team_auth.time.time',return_value=time.time()+49*3600):
                self.assertEqual(migrated.member_info(row)['status'],'expired')
            migrated.close()

    def test_remote_state_is_removed_from_account_backups(self):
        with tempfile.TemporaryDirectory() as temp:
            content = Path(temp) / 'content'
            content.mkdir()
            accounts = Accounts(content)
            remote = RemoteAccess(None, accounts)
            marker = 'private-proposal-do-not-export-42'
            with accounts.db:
                accounts.db.execute("INSERT INTO remote_settings VALUES(1,1,'settings-revision')")
                accounts.db.execute("INSERT INTO remote_grants VALUES('member')")
                accounts.db.execute("INSERT INTO remote_tokens(id,digest,owner,binding,label,can_draft,expires,created,can_save,can_intake) VALUES('token-id','hash','member','revision','laptop',1,9999999999,1,0,1)")
                accounts.db.execute("INSERT INTO remote_drafts VALUES('draft','member','token-id','revision','request-id','fingerprint','matter',?,'pending',1,9999999999)", (marker,))
                accounts.db.execute("INSERT INTO remote_writes VALUES('write','member','token-id','revision','write-request','fingerprint','matter','saved',?,1,9999999999)", (marker,))
                accounts.db.execute("INSERT INTO remote_intakes VALUES('intake','member','token-id','revision',?,9999999999)", (marker,))
                accounts.db.execute("INSERT INTO remote_attempts VALUES('member',?)", (int(time.time()),))
            self.assertTrue(remote.settings()['enabled'])
            target = Path(temp) / 'remote-backup.sqlite3'
            self.assertTrue(backup_accounts(content, target))
            with sqlite3.connect(target) as backup:
                for table in ('remote_settings', 'remote_grants', 'remote_tokens', 'remote_drafts', 'remote_writes', 'remote_intakes', 'remote_attempts'):
                    self.assertEqual(backup.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0], 0)
            self.assertNotIn(marker.encode(), target.read_bytes())
            self.assertTrue(remote.settings()['enabled'], 'Backing up must not disable the live instance')
            accounts.close()

    def test_invitation_lifetime_scope_and_reissue(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            invitation=accounts.invite({'email':'admin@example.invalid','name':'管理员','role':'admin'},None,set(),bootstrap=True)
            self.assertNotIn('secret',accounts.invite_info(invitation['token']))
            with self.assertRaises(AuthError): accounts.invite({'email':'other@example.invalid'},None,set())
            with patch('team_auth.time.time',return_value=time.time()+49*3600):
                with self.assertRaises(AuthError): accounts.invite_info(invitation['token'])
            replacement=accounts.reset('admin@example.invalid',None,recovery=True)
            with self.assertRaises(AuthError): accounts.invite_info(invitation['token'])
            self.assertEqual(accounts.invite_info(replacement['token'])['email'],'admin@example.invalid')
            accounts.close()

    def test_account_backup_keeps_grants_audit_and_excludes_invitations(self):
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            accounts.invite({'email':'admin@example.invalid','name':'管理员','role':'admin'},None,set(),bootstrap=True)
            target=Path(temp)/'accounts-copy.sqlite3'
            self.assertTrue(backup_accounts(content,target))
            with sqlite3.connect(target) as backup:
                self.assertEqual(backup.execute('SELECT role FROM users').fetchone()[0],'admin')
                self.assertGreater(backup.execute('SELECT COUNT(*) FROM audit').fetchone()[0],0)
                self.assertEqual(backup.execute('SELECT COUNT(*) FROM invitations').fetchone()[0],0)
            accounts.close()


class MemberAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.content = Path(self.temp.name) / 'content'; self.content.mkdir()
        self.accounts = Accounts(self.content); self.addCleanup(lambda: self.accounts.close())
        self.actor = {'id':'admin','name':'实际管理员','role':'admin'}
        self.known = {'first':'合作事项','second':'投资事项'}
        self.invitation = self.accounts.invite({'name':'目标成员','role':'viewer','project_ids':['first']}, self.actor, self.known)
        self.identity = self.accounts.invitation(self.invitation['token'])['user_id']

    def member(self):
        member = self.accounts.member_info(self.accounts.db.execute('SELECT * FROM users WHERE id=?',(self.identity,)).fetchone())
        return member | {'remote_allowed_before':member['remote_allowed']}

    def entries(self, **request):
        return self.accounts.dispatch('team_audit', {'scope':'members',**request}, self.actor, self.known)

    def test_single_record_captures_real_actor_target_and_exact_changes(self):
        initial = self.entries()['entries']
        self.assertEqual(len(initial),1)
        self.assertEqual(initial[0]['subject'], {'id':self.identity,'name':'目标成员','username':None,'source':'recorded'})
        self.assertTrue(all(change['before'] is None for change in initial[0]['changes']))
        forged = {'actor':{'name':'伪造管理员'},'details':{'secret':'must-not-log'},'name':'伪造目标姓名','password':'must-not-log','token':'must-not-log'}
        self.accounts.update({**self.member(),**forged,'role':'editor','project_ids':['second'],'active':False,'remote_allowed':True,'remote_allowed_before':False}, self.actor, self.known)
        items = self.entries()['entries']; self.assertEqual(len(items),2)
        event = items[0]
        self.assertEqual(event['actor_name'],'实际管理员'); self.assertEqual(event['subject']['name'],'目标成员')
        changes={change['field']:change for change in event['changes']}
        self.assertEqual(set(changes),{'role','scope','remote_allowed'})
        self.assertEqual(changes['role']['before'],'只读成员'); self.assertEqual(changes['role']['after'],'编辑成员')
        self.assertEqual(changes['scope']['before'],{'all':False,'projects':[{'id':'first','name':'合作事项'}]})
        self.assertEqual(changes['scope']['after'],{'all':False,'projects':[{'id':'second','name':'投资事项'}]})
        self.assertEqual(changes['remote_allowed']['before'],'不允许'); self.assertEqual(changes['remote_allowed']['after'],'允许')
        self.assertNotIn('must-not-log',json.dumps(items));self.assertNotIn(self.invitation['token'],json.dumps(items))
        self.assertEqual(self.accounts.invitation(self.invitation['token'])['user_id'],self.identity)

    def test_names_are_snapshots_and_equal_names_do_not_hide_identity_changes(self):
        same_names={'first':'同名事项','second':'同名事项'}
        self.accounts.update({**self.member(),'active':False,'project_ids':['second']},self.actor,same_names)
        captured=self.entries()['entries'][0]
        scope=next(change for change in captured['changes'] if change['field']=='scope')
        self.assertNotEqual(scope['before'],scope['after'])
        with self.accounts.db:self.accounts.db.execute('UPDATE users SET name=?,username=? WHERE id=?',('改名成员','new_name',self.identity))
        self.known['first']='已改名事项'
        self.assertEqual(self.entries()['entries'][0],captured)

    def test_old_records_resolve_current_member_without_fabricating_changes(self):
        self.accounts.audit(self.actor,'account.permissions',self.identity)
        # Simulate a database created before structured audit details existed.
        with self.accounts.db:self.accounts.db.execute('ALTER TABLE audit DROP COLUMN details')
        self.accounts.close();self.accounts=Accounts(self.content)
        entry=self.entries()['entries'][0]
        self.assertEqual(entry['subject']['source'],'current');self.assertEqual(entry['subject']['name'],'目标成员')
        self.assertIsNone(entry['changes'])
        self.accounts.audit(self.actor,'account.permissions','missing-member')
        self.assertIsNone(self.entries()['entries'][0]['subject'])

    def test_filtered_cursor_pages_and_admin_boundary(self):
        for index in range(105):
            self.accounts.audit(self.actor,'account.permissions',self.identity)
            self.accounts.audit(self.actor,'remote.read_matter','token-id')
        first=self.entries();second=self.entries(before=first['next_before'])
        self.assertEqual(len(first['entries']),100);self.assertEqual(len(second['entries']),6);self.assertIsNone(second['next_before'])
        ids=[entry['id'] for page in (first,second) for entry in page['entries']]
        self.assertEqual(len(ids),len(set(ids)));self.assertEqual(ids,sorted(ids,reverse=True))
        self.assertTrue(all(entry['action'] in ('account.permissions','account.invite') for page in (first,second) for entry in page['entries']))
        self.assertTrue(any(entry['action']=='remote.read_matter' for entry in self.entries(scope='all')['entries']))
        for role in ('viewer','editor'):
            with self.assertRaises(AuthError): self.accounts.dispatch('team_audit',{},self.actor|{'role':role},self.known)
        for invalid in ({'before':True},{'before':'2'},{'before':0},{'before':2**63},{'scope':'unknown'}):
            with self.assertRaises(AuthError):self.entries(**invalid)

    def test_audit_failure_rolls_back_membership_and_invitation_changes(self):
        original=self.accounts.audit
        def failure(*args,**kwargs):
            original(*args,**kwargs)
            raise OSError('audit persistence failure')
        before=[tuple(row) for row in self.accounts.db.execute('SELECT * FROM users')]
        invitation=[tuple(row) for row in self.accounts.db.execute('SELECT * FROM invitations')]
        audit_count=self.accounts.db.execute('SELECT COUNT(*) FROM audit').fetchone()[0]
        actions=(lambda:self.accounts.invite({'name':'new','role':'editor','remote_allowed':True},self.actor,self.known),
                 lambda:self.accounts.update({**self.member(),'role':'editor','active':False,'remote_allowed':True,'remote_allowed_before':False},self.actor,self.known),
                 lambda:self.accounts.reset(self.identity,self.actor))
        for action in actions:
            with patch.object(self.accounts,'audit',side_effect=failure):
                with self.assertRaises(OSError):action()
            self.assertEqual([tuple(row) for row in self.accounts.db.execute('SELECT * FROM users')],before)
            self.assertEqual([tuple(row) for row in self.accounts.db.execute('SELECT * FROM invitations')],invitation)
            self.assertEqual(self.accounts.db.execute('SELECT COUNT(*) FROM audit').fetchone()[0],audit_count)
            self.assertFalse(self.accounts.remote_allowed(self.identity))

    def test_all_scope_deactivation_reset_and_backups_preserve_details(self):
        with self.accounts.db:self.accounts.db.execute('UPDATE users SET active=1 WHERE id=?',(self.identity,))
        self.accounts.update({**self.member(),'active':False,'all_projects':True},self.actor,self.known)
        changed={item['field']:item for item in self.entries()['entries'][0]['changes']}
        self.assertEqual(changed['scope']['after'],{'all':True,'projects':[]})
        self.assertEqual(changed['status']['before'],'待绑定验证器');self.assertEqual(changed['status']['after'],'已停用')
        result=self.accounts.reset(self.identity,self.actor)
        item=self.entries()['entries'][0];self.assertEqual(item['subject']['id'],self.identity)
        self.assertEqual(item['changes'][0]['after'],'待接受邀请')
        self.assertNotIn(result['token'],json.dumps(item))
        target=Path(self.temp.name)/'backup.sqlite3';backup_accounts(self.content,target)
        with sqlite3.connect(target) as backup:
            details=json.loads(backup.execute('SELECT details FROM audit ORDER BY id DESC LIMIT 1').fetchone()[0])
            self.assertEqual(details['subject']['name'],'目标成员')
            self.assertEqual(details['changes'],item['changes'])
        self.assertNotIn(result['token'].encode(),target.read_bytes())


class RemoteWriteTests(unittest.TestCase):
    """Fault injection at the durable save boundary; HTTP tests cover real MFA."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.content = Path(self.temp.name) / 'content'
        shutil.copytree(ROOT / 'fixtures/demo/content', self.content)
        self.workspace = Workspace(self.content)
        self.accounts = Accounts(self.content)
        self.addCleanup(self.accounts.close)
        self.accounts.invite({'email': 'writer@example.invalid', 'name': 'Test writer', 'role': 'admin'}, None, set(), bootstrap=True)
        with self.accounts.db: self.accounts.db.execute('UPDATE users SET active=1')
        self.actor = public_user(self.accounts.db.execute('SELECT * FROM users').fetchone())
        for method in ('enrolled', 'email_allowed'):
            mock = patch.object(self.accounts, method, return_value=True)
            mock.start(); self.addCleanup(mock.stop)
        self.remote = RemoteAccess(self.workspace, self.accounts)
        self.remote.browser({'operation': 'configure', 'enabled': True, 'revision': 'initial'}, self.actor)
        self.token = self.issue('direct')
        self.matter = 'project-demo-partnership'

    def issue(self, mode):
        return self.remote.browser({'operation': 'issue', 'label': 'Test AI client', 'accessMode': mode}, self.actor)

    def call(self, tool, arguments=None, token=None):
        return self.remote.rpc({'tool': tool, 'arguments': arguments or {}}, (token or self.token)['token'])

    def arguments(self):
        current = self.call('read_matter', {'matter_id': self.matter})
        return {'matter_id': self.matter, 'operation': 'add_progress', 'request_id': uuid.uuid4().hex,
                'revision': current['revision'], 'changes': {'date': '2026-10-27', 'title': 'Remote progress', 'summary': 'Discussed; not signed.'}}

    def count(self):
        return len(self.workspace.get_record({'kind': 'project', 'id': self.matter})['record']['events'])

    def test_question_opt_in_and_lost_acknowledgement_never_repeat(self):
        from investment_qa import InvestmentQA
        with self.assertRaises(AuthError): self.call('read_investment_qa',{'id':''})
        self.remote.browser({'operation':'allow_qa','tokenId':self.token['id'],'confirmed':True},self.actor)
        args={'request_id':uuid.uuid4().hex,'revision':self.call('read_investment_qa',{'id':''})['revision'],'changes':{'question':'故障注入示例问题','short_answer':'仅保存一次'}}
        original=InvestmentQA.execute
        def interrupted(library,request,*,preview=False):
            result=original(library,request,preview=preview)
            if request.get('operation')=='save' and not preview: raise RuntimeError('ack lost')
            return result
        with patch.object(InvestmentQA,'execute',interrupted):
            with self.assertRaises(AuthError) as caught: self.call('save_investment_qa',args)
            self.assertEqual(caught.exception.code,'uncertain')
        self.assertEqual(self.call('search_investment_qa')['total'],1)
        self.assertEqual(self.call('save_investment_qa',args)['status'],'uncertain')
        self.assertEqual(self.call('search_investment_qa')['total'],1)
        read_token=self.issue('read')
        self.remote.browser({'operation':'allow_qa','tokenId':read_token['id'],'confirmed':True},self.actor)
        with self.assertRaises(AuthError): self.call('submit_investment_qa',args,read_token)

    def test_receipt_survives_restart_and_draft_retention_window(self):
        args, before = self.arguments(), self.count()
        saved = self.call('save_progress', args)
        self.assertEqual(saved['status'], 'saved')
        update = self.workspace.event_update({'kind':'progress','project_id':self.matter,'id':saved['progress_id']}, self.workspace.observe())['update']
        self.assertEqual(update['name'], self.actor['name'])
        self.assertEqual(self.count(), before + 1)
        self.assertEqual(self.call('save_progress', args), saved)
        with patch('remote_access.time.time', return_value=time.time() + 2 * 86400):
            self.remote = RemoteAccess(self.workspace, self.accounts)
            self.assertEqual(self.call('save_progress', args), saved)
        self.assertEqual(self.count(), before + 1)
        with self.assertRaises(AuthError) as caught:
            self.call('submit_draft', args)
        self.assertEqual(caught.exception.code, 'conflict')
        self.assertEqual(self.accounts.db.execute('SELECT COUNT(*) FROM remote_drafts').fetchone()[0], 0)

    def test_lost_acknowledgement_never_repeats_business_write(self):
        args, before = self.arguments(), self.count()
        original = self.workspace.save
        def lost_ack(request, preview=False):
            result = original(request, preview=preview)
            if not preview: raise OSError('simulated lost acknowledgement')
            return result
        with patch.object(self.workspace, 'save', side_effect=lost_ack):
            with self.assertRaises(AuthError) as caught:
                self.call('save_progress', args)
        self.assertEqual(caught.exception.code, 'uncertain')
        self.assertEqual(self.count(), before + 1)
        self.remote = RemoteAccess(self.workspace, self.accounts)
        retry = self.call('save_progress', args)
        self.assertEqual(retry['status'], 'uncertain')
        self.assertEqual(self.count(), before + 1)
        with self.assertRaises(AuthError) as caught:
            self.call('save_progress', args | {'changes': args['changes'] | {'summary': 'different'}})
        self.assertEqual(caught.exception.code, 'conflict')

    def test_interruption_before_business_write_also_blocks_replay(self):
        args, before = self.arguments(), self.count()
        audit = self.accounts.audit
        def crash(actor, action, target, outcome='success'):
            if action == 'remote.save_progress' and outcome == 'started':
                raise RuntimeError('simulated interruption after durable claim')
            return audit(actor, action, target, outcome)
        with patch.object(self.accounts, 'audit', side_effect=crash):
            with self.assertRaises(RuntimeError): self.call('save_progress', args)
        self.remote = RemoteAccess(self.workspace, self.accounts)
        self.assertEqual(self.call('save_progress', args)['status'], 'uncertain')
        self.assertEqual(self.count(), before)

    def test_backend_checks_mode_and_live_role_independent_of_tool_listing(self):
        args, before = self.arguments(), self.count()
        for mode in ('read', 'draft'):
            token = self.issue(mode)
            self.assertFalse(self.call('access', token=token)['canSave'])
            with self.assertRaises(AuthError) as caught: self.call('save_progress', args, token)
            self.assertEqual(caught.exception.code, 'forbidden')
        # Defense in depth: even an unexpected role change without binding rotation denies writing.
        with self.accounts.db:
            self.accounts.db.execute("UPDATE users SET role='editor'")
            self.accounts.set_remote_allowed(self.actor['id'], True)
        self.assertFalse(self.call('access')['canSave'])
        with self.assertRaises(AuthError) as caught: self.call('save_progress', args)
        self.assertEqual(caught.exception.code, 'forbidden')
        self.assertEqual(self.count(), before)

    def test_expiry_revocation_disable_and_reset_invalidate_receipts(self):
        self.call('save_progress', self.arguments())
        with patch('remote_access.time.time', return_value=time.time() + 8 * 86400):
            self.remote = RemoteAccess(self.workspace, self.accounts)
            with self.assertRaises(AuthError) as caught: self.call('access')
            self.assertEqual(caught.exception.code, 'unauthenticated')
            self.assertEqual(self.accounts.db.execute('SELECT COUNT(*) FROM remote_writes').fetchone()[0], 0)
        for action in ('revoke', 'disable', 'reset'):
            self.token = self.issue('direct')
            self.call('save_progress', self.arguments())
            if action == 'revoke': self.remote.browser({'operation': 'revoke', 'tokenId': self.token['id']}, self.actor)
            elif action == 'disable':
                self.remote.browser({'operation': 'configure', 'enabled': False, 'revision': self.remote.settings()['revision']}, self.actor)
            else: self.accounts.reset(self.actor['email'], None, recovery=True)
            with self.assertRaises(AuthError): self.call('access')
            self.assertEqual(self.accounts.db.execute('SELECT COUNT(*) FROM remote_writes').fetchone()[0], 0)
            if action == 'disable':
                self.remote.browser({'operation': 'configure', 'enabled': True, 'revision': self.remote.settings()['revision']}, self.actor)

    def test_intake_backend_requires_opt_in_and_lost_ack_does_not_repeat(self):
        from remote_intake import Intake
        operations = {'operations': [{'ref': 'person', 'kind': 'person', 'changes': {'name': '录入收据测试', 'affiliation': '示例团队'}}]}
        with self.assertRaises(AuthError): self.call('prepare_intake', operations)
        self.remote.browser({'operation': 'allow_intake', 'tokenId': self.token['id'], 'confirmed': True}, self.actor)
        plan = self.call('prepare_intake', operations)
        args = {'intake_id': plan['intake_id'], 'request_id': uuid.uuid4().hex}
        original = Intake.save
        def lost_ack(intake, request, preview=False):
            result = original(intake, request, preview=preview)
            if not preview: raise OSError('simulated lost acknowledgement')
            return result
        with patch.object(Intake, 'save', new=lost_ack):
            with self.assertRaises(AuthError) as caught: self.call('save_intake', args)
        self.assertEqual(caught.exception.code, 'uncertain')
        self.assertIsNotNone(self.workspace.get_record({'kind': 'person', 'id': '录入收据测试'})['record'])
        version = self.workspace.observe()['version']
        self.remote = RemoteAccess(self.workspace, self.accounts)
        self.assertEqual(self.call('save_intake', args)['status'], 'uncertain')
        self.assertEqual(self.workspace.observe()['version'], version)
        self.assertEqual(self.accounts.db.execute('SELECT COUNT(*) FROM remote_intakes').fetchone()[0], 0)

    def test_existing_tokens_never_gain_direct_write_capability(self):
        with self.accounts.db:
            self.accounts.db.execute('DROP TABLE remote_tokens')
            self.accounts.db.execute('CREATE TABLE remote_tokens (id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, binding TEXT NOT NULL, label TEXT NOT NULL, can_draft INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)')
            self.accounts.db.execute("INSERT INTO remote_tokens VALUES('old','digest',?,?, 'existing',1,9999999999,1)", (self.actor['id'], self.actor['revision']))
        for _ in range(2):
            self.remote = RemoteAccess(self.workspace, self.accounts)
            old = self.accounts.db.execute("SELECT * FROM remote_tokens WHERE id='old'").fetchone()
            self.assertEqual(old['can_draft'], 1)
            self.assertEqual(old['can_save'], 0)
            self.assertEqual(old['can_intake'], 0)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.base=Path(self.temp.name).resolve()
        self.content=self.base/'workspace/content'
        shutil.copytree(ROOT/'fixtures/demo/content',self.content)
        self.workspace=Workspace(self.content)
        self.manager=BackupManager(self.workspace)
        self.manager.configure({'revision':self.manager.revision(),'config':{'enabled':True,'directory':str(self.base/'backups'),'interval_minutes':60}})

    def tearDown(self): self.temp.cleanup()

    def test_server_backup_directory_comes_from_deployment_not_old_local_settings(self):
        destination=str(self.base/'server-backups')
        with patch.dict(os.environ,{'BD_MODE':'server','BD_REQUEST_WEB':'1','BD_BACKUP_DIRECTORY':destination}):
            self.assertEqual(self.manager.config()['directory'],destination)
            with self.assertRaisesRegex(Exception,'部署配置'):
                self.manager.configure({'revision':self.manager.revision(),'config':{'directory':str(self.base/'arbitrary')}})

    def test_account_restore_revokes_sessions_and_preserves_grants(self):
        accounts=Accounts(self.content)
        invitation=accounts.invite({'name':'管理员','email':'admin@example.invalid','role':'admin'},None,set(),bootstrap=True)
        accounts.close()
        backup=create_backup(self.workspace)
        archive=backup_download(self.workspace,backup['id'])['path']
        target=self.base/'restored'
        restore_backup(archive,target)
        restored=Accounts(target/'content')
        with self.assertRaises(AuthError): restored.invite_info(invitation['token'])
        self.assertEqual(restored.db.execute('SELECT role FROM users').fetchone()[0],'admin')
        self.assertGreater(restored.db.execute('SELECT COUNT(*) FROM audit').fetchone()[0],0)
        restored.close()
        with zipfile.ZipFile(archive) as zipped:
            self.assertIn('accounts.sqlite3',zipped.namelist())
            self.assertFalse(any('.env' in x or 'backup-config' in x for x in zipped.namelist()))

    def test_oss_failure_preserves_verified_local_zip_and_previous_success(self):
        previous=self.manager.run(True)['last_success']
        with patch.dict(os.environ,OSS):
            self.manager.configure({'revision':self.manager.revision(),'config':{'oss_enabled':True,'retention_days':7}})
            old=self.base/'backups'/f'bd-{self.workspace.store.name}-20000101-000000-{"a"*32}.zip'
            old.write_bytes(b'old copy')
            with patch.object(self.manager,'upload',side_effect=RuntimeError('simulated offline')):
                failed=self.manager.run(True)
            self.assertEqual(failed['last_success'],previous)
            self.assertEqual(failed['error'],'simulated offline')
            self.assertTrue(old.exists())
            self.assertEqual(checksum(Path(failed['last_local_success']['path'])),failed['last_local_success']['sha256'])
            with patch.object(self.manager,'upload',return_value={'bucket':'test','key':'verified'}):
                completed=self.manager.run(True)
            self.assertFalse(completed['error']);self.assertFalse(old.exists())
            self.assertEqual(completed['last_success']['oss']['key'],'verified')
            self.assertEqual(completed['last_success']['path'],failed['last_local_success']['path'])

    def test_upload_releases_business_lock_and_reacquires_on_failure(self):
        self.workspace.lock=(self.workspace.store/'lock').open('a+')
        fcntl.flock(self.workspace.lock,fcntl.LOCK_EX)
        def transport(*args,**kwargs):
            with (self.workspace.store/'lock').open('a+') as concurrent:
                fcntl.flock(concurrent,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return SimpleNamespace(returncode=0,stdout=json.dumps({'ok':False,'error':'offline'}))
        try:
            with patch('automatic_backup.subprocess.run',side_effect=transport):
                with self.assertRaisesRegex(Exception,'offline'): self.manager.upload(self.base/'zip','key','hash')
            with (self.workspace.store/'lock').open('a+') as concurrent:
                with self.assertRaises(BlockingIOError): fcntl.flock(concurrent,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally: self.workspace.lock.close()

    def test_private_oss_checks_integrity_and_rejects_wrong_targets(self):
        target=self.base/'file.zip';target.write_bytes(b'example zip bytes')
        class Bucket:
            acl='private';corrupt=False
            def get_bucket_acl(self): return SimpleNamespace(acl=self.acl)
            def put_object_from_file(self,key,path,headers): self.headers=headers
            def head_object(self,key): return SimpleNamespace(content_length=1 if self.corrupt else target.stat().st_size,headers=self.headers)
        bucket=Bucket()
        with patch.dict(os.environ,OSS):
            result=upload(target,'bd-backups/example.zip',checksum(target),bucket)
            self.assertEqual(result['sha256'],checksum(target))
            self.assertEqual(bucket.headers['x-oss-object-acl'],'private')
            self.assertEqual(bucket.headers['x-oss-server-side-encryption'],'AES256')
            self.assertEqual(bucket.headers['Content-MD5'],base64.b64encode(hashlib.md5(target.read_bytes()).digest()).decode())
            bucket.acl='public-read'
            with self.assertRaisesRegex(ValueError,'私有'): upload(target,'bd-backups/example.zip',checksum(target),bucket)
            bucket.acl='private';bucket.corrupt=True
            with self.assertRaisesRegex(ValueError,'不一致'): upload(target,'bd-backups/example.zip',checksum(target),bucket)
            with self.assertRaisesRegex(ValueError,'校验失败'): upload(target,'bd-backups/example.zip','bad',bucket)
            with patch.dict(os.environ,{'BD_OSS_ENDPOINT':'https://attacker.invalid'}):
                with self.assertRaises(ValueError): settings()


class RemoteCompanyTests(unittest.TestCase):
    setUp = RemoteWriteTests.setUp
    issue = RemoteWriteTests.issue
    call = RemoteWriteTests.call

    def allow(self, token=None):
        self.remote.browser({'operation':'allow_intake','tokenId':(token or self.token)['id'],'confirmed':True},self.actor)

    def arguments(self, **changes):
        self.call('search_company_events', {'query':'中心成立大会','from':'2026-10-31','to':'2026-10-31'})
        return {'revision':self.call('read_company_event',{'id':''})['revision'], 'request_id':uuid.uuid4().hex,
                'changes':{'date':'2026-10-31','title':'参加示例中心成立大会','category':'industry-recognition',
                           'type':'milestone','summary':'示例公司被列为首期合作伙伴。','participants':['林岚','陈青'],
                           'organizers':['示例大学'],'location':'示例会场',
                           'body':'## 事件内容\n\n林岚参会，示例公司被列为首期合作伙伴。\n\n## 后续跟进\n\n建议联系对方争取官方证书或商谈框架协议。',**changes}}

    def test_standalone_round_trip_partial_update_and_readback(self):
        self.allow(); args=self.arguments(); before=self.workspace.read_files()
        saved=self.call('save_company_event',args)
        self.assertEqual(saved['status'],'saved')
        self.assertNotIn('matter_id',saved)
        after=self.workspace.read_files()
        self.assertEqual({k:v for k,v in before.items() if not k.startswith('company/')},
                         {k:v for k,v in after.items() if not k.startswith('company/')})
        opened=self.call('read_company_event',{'id':saved['id']})
        self.assertEqual(opened['revision'],saved['revision'])
        self.assertEqual(opened['fields'],{**args['changes'],'importance':'normal'})
        self.assertEqual([p['id'] for p in opened['participants']],['林岚','陈青'])
        self.assertNotIn('email',json.dumps(opened));self.assertNotIn('related_record',json.dumps(opened))
        self.assertEqual(self.call('save_company_event',args),saved)
        for query in ('中心成立大会','官方证书','陈青','示例会场','行业活动'):
            self.assertEqual(self.call('search_company_events',{'query':query})['events'][0]['id'],saved['id'])
        update={'id':saved['id'],'revision':opened['revision'],'request_id':uuid.uuid4().hex,'changes':{'summary':'补充参会记录，已列为首期合作伙伴。'}}
        changed=self.call('save_company_event',update)
        reread=self.call('read_company_event',{'id':saved['id']})
        self.assertEqual(reread['fields'],{**opened['fields'],**update['changes']})
        self.assertEqual(reread['revision'],changed['revision'])
        self.assertNotEqual(reread['revision'],opened['revision'])
        self.assertEqual(self.workspace.event_update({'kind':'company','id':saved['id']},self.workspace.observe())['update']['name'],self.actor['name'])
        with self.assertRaises(AuthError) as caught:
            self.call('save_company_event',{**update,'request_id':uuid.uuid4().hex,'changes':{'summary':'过期更新'}})
        self.assertEqual(caught.exception.code,'conflict')
        with self.assertRaises(AuthError):self.call('read_company_event',{'id':'missing'})

    def test_company_permissions_are_checked_in_backend(self):
        args=self.arguments()
        with self.assertRaises(AuthError):self.call('save_company_event',args)
        self.allow()
        draft=self.issue('draft');self.allow(draft)
        with self.assertRaises(AuthError):self.call('save_company_event',args,draft)
        readonly=self.issue('read')
        with self.assertRaises(AuthError):self.call('submit_company_event',args,readonly)
        for role in ('editor','viewer'):
            with self.accounts.db:
                self.accounts.db.execute('UPDATE users SET role=?,all_projects=1',(role,))
                self.accounts.set_remote_allowed(self.actor['id'],True)
            self.assertTrue(self.call('access')['canCompany'])
            self.assertEqual(self.call('read_company_event',{'id':'2026-01-12-annual-bd-plan'})['fields']['title'],'启动年度 BD 计划')
            for op in ('submit_company_event','save_company_event'):
                with self.assertRaises(AuthError):self.call(op,args)
            with self.accounts.db:self.accounts.db.execute('UPDATE users SET all_projects=0')
            self.assertFalse(self.call('access')['canCompany'])
            for op,params in [('search_company_events',{}),('read_company_event',{'id':'2026-01-12-annual-bd-plan'})]:
                with self.assertRaises(AuthError):self.call(op,params)

    def test_draft_review_conflict_revalidation_and_replay(self):
        self.allow();args=self.arguments();before=self.workspace.read_files()
        pending=self.call('submit_company_event',args)
        self.assertEqual(self.workspace.read_files(),before)
        self.assertEqual(self.call('submit_company_event',args),pending)
        review=self.remote.browser({'operation':'drafts'},self.actor)['drafts'][0]
        self.assertEqual(review['operation'],'add_company_event')
        self.assertEqual(review['matterId'],'')
        self.assertEqual(set(c['field'] for c in review['changes']),set(args['changes'])|{'importance'})
        saved=self.remote.browser({'operation':'confirm','draftId':pending['draftId'],'confirmed':True},self.actor)
        self.assertTrue(self.call('read_company_event',{'id':saved['id']})['fields']['body'].endswith('商谈框架协议。'))
        self.assertEqual(self.call('submit_company_event',args)['status'],'saved')
        with self.assertRaises(AuthError):self.call('save_company_event',args)
        fresh=self.arguments(title='另一个活动')
        pending=self.call('submit_company_event',fresh)
        self.call('save_company_event',self.arguments(title='并发新增活动'))
        with self.assertRaises(AuthError) as caught:
            self.remote.browser({'operation':'confirm','draftId':pending['draftId'],'confirmed':True},self.actor)
        self.assertEqual(caught.exception.code,'conflict')
        self.assertEqual(self.call('submit_company_event',fresh)['status'],'failed')
        next_draft=self.call('submit_company_event',self.arguments(title='授权撤销前的草稿'))
        with self.accounts.db:self.accounts.db.execute('UPDATE remote_tokens SET can_intake=0')
        with self.assertRaises(AuthError):
            self.remote.browser({'operation':'confirm','draftId':next_draft['draftId'],'confirmed':True},self.actor)

    def test_duplicate_checks_and_invalid_fields_leave_business_data_unchanged(self):
        self.allow();saved=self.call('save_company_event',self.arguments())
        baseline=self.workspace.read_files()
        duplicate=self.arguments(title=' 参加示例中心 成立大会 ')
        with self.assertRaises(AuthError) as caught:self.call('save_company_event',duplicate)
        self.assertEqual(caught.exception.code,'duplicate')
        from workspace_service import ServiceError
        for changes in ({'participants':['不存在的人员']},{'participants':['林岚','林岚']},
                        {'title':'字'*41},{'summary':'字'*201},{'date':'2026-02-30'},
                        {'type':'award'},{'participants':[]},{'participants':[{}]},
                        {'organizers':[{}]},{'category':''},{'actor':{'name':'伪造编辑'}}):
            with self.assertRaises((AuthError,ServiceError)):
                self.call('save_company_event',self.arguments(**{'title':'无效记录',**changes}))
            self.assertEqual(self.workspace.read_files(),baseline)
        for forbidden in ('matter_id','attachments','project_id'):
            with self.assertRaises(AuthError):self.call('submit_company_event',{**self.arguments(title='错误范围'),forbidden:[]})
        original=self.call('read_company_event',{'id':'2026-01-12-annual-bd-plan'})
        with self.assertRaises(AuthError) as caught:
            self.call('save_company_event',{'id':original['id'],'revision':original['revision'],'request_id':uuid.uuid4().hex,'changes':{'date':'2026-10-31','title':'参加示例中心成立大会'}})
        self.assertEqual(caught.exception.code,'duplicate')
        self.assertEqual(self.workspace.read_files(),baseline)

    def test_location_round_trips_without_optional_body_and_search_pagination(self):
        self.allow();saved=self.call('save_company_event',self.arguments(body='',location='会场 A',category='自定义类别'))
        record=self.call('read_company_event',{'id':saved['id']})
        self.assertEqual(record['fields']['body'],'');self.assertEqual(record['fields']['location'],'会场 A')
        # Seed a representative calendar through the canonical fixture, then query pagination.
        path=self.content/'company/events.yaml';contents=yaml.safe_load(path.read_text())
        contents['events'].extend({'id':f'2026-10-31-page-{i}','date':'2026-10-31','category':'test',
                                 'type':'milestone','title':f'分页活动 {i}','summary':'测试活动','participants':['林岚'],'importance':'normal'} for i in range(21))
        path.write_text(yaml.safe_dump(contents,allow_unicode=True,sort_keys=False))
        first=self.call('search_company_events',{'query':'分页活动','category':'test','from':'2026-10-31','to':'2026-10-31'})
        self.assertEqual(first['total'],21);self.assertEqual(len(first['events']),20);self.assertEqual(first['nextOffset'],20)
        last=self.call('search_company_events',{'query':'分页活动','offset':20})
        self.assertEqual(len(last['events']),1);self.assertIsNone(last['nextOffset'])
        self.assertNotIn(last['events'][0]['id'],[e['id'] for e in first['events']])
        self.assertEqual(self.call('search_company_events',{'query':'nothing'})['total'],0)
        for args in ({'offset':True},{'offset':-1},{'from':'2026-11-01','to':'2026-10-01'}):
            with self.assertRaises(AuthError):self.call('search_company_events',args)

    def test_lost_acknowledgement_and_connection_revocation(self):
        self.allow();args=self.arguments();original=self.workspace.save
        def interrupted(request,preview=False):
            result=original(request,preview=preview)
            if not preview:raise OSError('lost acknowledgement')
            return result
        with patch.object(self.workspace,'save',side_effect=interrupted):
            with self.assertRaises(AuthError) as caught:self.call('save_company_event',args)
        self.assertEqual(caught.exception.code,'uncertain')
        before=self.workspace.observe()['version']
        self.remote=RemoteAccess(self.workspace,self.accounts)
        self.assertEqual(self.call('save_company_event',args)['status'],'uncertain')
        self.assertEqual(self.workspace.observe()['version'],before)
        self.assertEqual(self.call('search_company_events',{'query':'中心成立大会'})['total'],1)
        self.remote.browser({'operation':'revoke','tokenId':self.token['id']},self.actor)
        with self.assertRaises(AuthError):self.call('save_company_event',args)


class MeetingSupplementTests(unittest.TestCase):
    setUp = RemoteWriteTests.setUp
    issue = RemoteWriteTests.issue
    call = RemoteWriteTests.call
    meeting = '2026-01-15-solution-meeting'

    def target(self, **extra):
        return {'matter_id':self.matter,'meeting_id':self.meeting,**extra}

    def args(self, **changes):
        current=self.call('read_meeting_supplements',self.target())
        return self.target(revision=current['revision'],request_id=uuid.uuid4().hex,changes={'title':'产业介绍草稿','date':'2026-01-16','body':'## 产业应用\n\n完整文案。\n\n- 数据整理\n- 过程记录',**changes})

    def service(self, actor, **request):
        from progress_supplements import Supplements
        self.workspace.actor=actor
        self.workspace.policy=Policy(self.workspace,actor)
        return Supplements(self.workspace).execute({'action':'supplements','project_id':self.matter,'event_id':self.meeting,**request})

    def test_independent_storage_identity_history_snapshots_and_activity(self):
        from workspace_service import ServiceError
        before=self.workspace.observe();files=self.workspace.read_files()
        # Give the meeting a real accountable editor before adding supplements.
        path='counterparties/示例合作/matters/合作对接/meetings/20260115.md'
        self.workspace.actor={**self.actor,'name':'会议编辑'}
        self.workspace.commit(files,{**files,path:files[path]+'\n原会议结论。\n'},'完善会议记录','form')
        files=self.workspace.read_files()
        query={'kind':'progress','id':self.meeting,'project_id':self.matter}
        byline=self.workspace.event_update(query,self.workspace.observe())
        data=json.loads((self.content/'generated/dashboard.json').read_text())
        args=self.args();saved=self.call('save_meeting_supplement',args)
        self.assertEqual(self.call('save_meeting_supplement',args),saved)
        after=self.workspace.read_files()
        self.assertEqual({k:v for k,v in after.items() if '/supplements/' not in k},files)
        self.assertEqual(json.loads((self.content/'generated/dashboard.json').read_text()),data)
        self.assertEqual(self.workspace.event_update(query,self.workspace.observe()),byline)
        opened=self.call('read_meeting_supplements',self.target(id=saved['id']))
        self.assertEqual(opened['record']['body'],args['changes']['body'])
        self.assertEqual(opened['record']['author'],{'id':self.actor['id'],'name':self.actor['name']})
        self.assertNotIn('email',json.dumps(opened))
        editor={**self.actor,'id':'second-editor','name':'另一位编辑','role':'editor','all_projects':False,'project_ids':[self.matter]}
        update=self.service(editor,operation='save',id=saved['id'],revision=opened['revision'],request_id=uuid.uuid4().hex,payload={**args['changes'],'body':'修订后全文。'})
        read=self.call('read_meeting_supplements',self.target(id=saved['id']))
        self.assertEqual(read['record']['author'],opened['record']['author'])
        self.assertEqual(read['record']['updated_by']['name'],'另一位编辑')
        history=self.call('meeting_supplement_history',self.target(id=saved['id']))['versions']
        self.assertEqual(len(history),2)
        self.assertEqual(history[0]['actor']['name'],'另一位编辑')
        old=self.call('meeting_supplement_history',self.target(id=saved['id'],version=saved['history_version']))
        self.assertEqual(old['record']['body'],args['changes']['body'])
        self.assertEqual(self.call('read_meeting_supplements',self.target(snapshot=before['version']))['items'],[])
        self.assertEqual(self.call('read_meeting_supplements',self.target(snapshot=saved['history_version']))['items'][0]['body'],args['changes']['body'])
        historical_history=self.service(self.actor,operation='history',id=saved['id'],snapshot=saved['history_version'])
        self.assertEqual(len(historical_history['versions']),1)
        with self.assertRaises(ServiceError):
            self.service(self.actor,operation='version',id=saved['id'],snapshot=saved['history_version'],version=update['status']['version'])

        # Another independent addition is not another business event.
        self.call('save_meeting_supplement',self.args(title='',body='独立背景材料'))
        self.assertEqual(len(self.call('read_meeting_supplements',self.target())['items']),2)
        self.assertEqual(self.workspace.event_update(query,self.workspace.observe()),byline)
        self.assertEqual(json.loads((self.content/'generated/dashboard.json').read_text()),data)
        # Stale per-record revisions and forged authors never overwrite a supplement.
        with self.assertRaises(ServiceError) as caught:
            self.service(editor,operation='save',id=saved['id'],revision=opened['revision'],request_id=uuid.uuid4().hex,payload=args['changes'])
        self.assertEqual(caught.exception.code,'conflict')
        with self.assertRaises(ServiceError):
            self.service(editor,operation='save',id=saved['id'],revision=read['revision'],request_id=uuid.uuid4().hex,payload={**args['changes'],'author':self.actor})
        with self.assertRaises(AuthError):
            self.service(editor,operation='save',snapshot=saved['history_version'],request_id=uuid.uuid4().hex)

    def test_drafts_permissions_replay_and_uncertain_outcome(self):
        from progress_supplements import Supplements
        from workspace_service import ServiceError
        args=self.args();draft_token=self.issue('draft')
        before=self.workspace.read_files()
        draft=self.call('submit_meeting_supplement',args,draft_token)
        self.assertEqual(self.call('submit_meeting_supplement',args,draft_token),draft)
        self.assertEqual(self.workspace.read_files(),before)
        with self.assertRaises(AuthError):self.call('save_meeting_supplement',args,draft_token)
        readonly=self.issue('read')
        with self.assertRaises(AuthError):self.call('submit_meeting_supplement',args,readonly)
        saved=self.remote.browser({'operation':'confirm','draftId':draft['draftId'],'confirmed':True},self.actor)
        self.assertEqual(self.call('submit_meeting_supplement',args,draft_token)['status'],'saved')
        self.assertEqual(self.call('read_meeting_supplements',self.target(id=saved['id']))['record']['author']['id'],self.actor['id'])
        for role in ('editor','viewer'):
            account={**self.actor,'role':role,'all_projects':False,'project_ids':['project-demo-investment']}
            for op in ('list','read','history','version','save'):
                with self.assertRaises(AuthError):self.service(account,operation=op,id=saved['id'],version=saved['status']['version'])
        viewer={**self.actor,'role':'viewer','all_projects':False,'project_ids':[self.matter]}
        self.assertEqual(len(self.service(viewer,operation='list')['items']),1)
        self.assertTrue(self.service(viewer,operation='history',id=saved['id'])['versions'])
        with self.assertRaises(AuthError):self.service(viewer,operation='save')
        with self.assertRaises(ServiceError) as caught:self.call('save_meeting_supplement',self.args())
        self.assertEqual(caught.exception.code,'duplicate')
        with self.assertRaises(AuthError):self.call('submit_meeting_supplement',{**args,'changes':{'body':'同编号不同内容'}},draft_token)
        stale=self.call('submit_meeting_supplement',self.args(body='待确认草稿'),draft_token)
        self.call('save_meeting_supplement',self.args(body='另一条补充'))
        with self.assertRaises(AuthError) as caught:self.remote.browser({'operation':'confirm','draftId':stale['draftId'],'confirmed':True},self.actor)
        self.assertEqual(caught.exception.code,'conflict')
        interrupted=self.args(body='响应丢失测试')
        original=Supplements.execute
        def lost_ack(service,request,*,preview=False):
            value=original(service,request,preview=preview)
            if not preview and request.get('operation')=='save':raise RuntimeError('lost ack')
            return value
        with patch.object(Supplements,'execute',lost_ack):
            with self.assertRaises(AuthError) as caught:self.call('save_meeting_supplement',interrupted)
        self.assertEqual(caught.exception.code,'uncertain')
        count=len(self.call('read_meeting_supplements',self.target())['items'])
        self.assertEqual(self.call('save_meeting_supplement',interrupted)['status'],'uncertain')
        self.assertEqual(len(self.call('read_meeting_supplements',self.target())['items']),count)

    def test_migration_preserves_meeting_and_complete_text_and_has_no_duplicate_event(self):
        from workspace_service import ServiceError
        body='# 简介草稿\n\n完整文案第一段。\n\n第二段包含 **重点** 与 CRO 描述。'
        current=self.workspace.get_record({'kind':'progress','id':'','project_id':self.matter})
        self.workspace.actor=self.actor
        added=self.workspace.save({'kind':'progress','id':'','project_id':self.matter,'revision':current['revision'],'payload':{'date':'2026-01-16','type':'other','title':'会后补充：面向 CRO 的平台简介草稿','summary':'会后形成介绍草稿。','importance':'normal','participants':['林岚','陈青'],'body':body}})
        before=self.workspace.read_files()
        meeting=self.workspace.record(before,'progress',self.meeting,self.matter)
        byline=self.workspace.event_update({'kind':'progress','id':self.meeting,'project_id':self.matter},self.workspace.observe())
        source=self.workspace.get_record({'kind':'progress','id':added['id'],'project_id':self.matter})
        revision=self.service(self.actor,operation='list')['revision']
        args={'operation':'migrate','source_id':added['id'],'source_revision':source['revision'],'revision':revision,'request_id':uuid.uuid4().hex,'confirmed':True}
        result=self.service(self.actor,**args)
        self.assertEqual(self.service(self.actor,**args),result)
        after=self.workspace.read_files()
        self.assertEqual(self.workspace.record(after,'progress',self.meeting,self.matter),meeting)
        self.assertEqual(self.workspace.event_update({'kind':'progress','id':self.meeting,'project_id':self.matter},self.workspace.observe()),byline)
        self.assertEqual(after['counterparties/示例合作/matters/合作对接/meetings/20260115.md'],before['counterparties/示例合作/matters/合作对接/meetings/20260115.md'])
        self.assertIsNone(self.workspace.record(after,'progress',added['id'],self.matter))
        supplement=self.service(self.actor,operation='read',id=result['id'])['record']
        self.assertEqual(supplement['body'],body)
        self.assertEqual(supplement['date'],'2026-01-16')
        self.assertEqual(supplement['source_progress_id'],added['id'])
        data=json.loads((self.content/'generated/dashboard.json').read_text())
        self.assertEqual(next(p for p in data['projects'] if p['id']==self.matter)['last_activity'],'2026-01-15')
        historical=self.workspace.historical({'version':added['status']['version']})
        self.assertIn(added['id'],[e['id'] for p in historical['data']['projects'] for e in p['events']])
        self.assertEqual(self.service(self.actor,operation='list',snapshot=added['status']['version'])['items'],[])
        self.assertEqual(self.service(self.actor,operation='list',snapshot=result['status']['version'])['items'][0]['body'],body)



class ProgressSupplementTests(unittest.TestCase):
    setUp = RemoteWriteTests.setUp
    issue = RemoteWriteTests.issue
    call = RemoteWriteTests.call
    service = MeetingSupplementTests.service
    meeting = '2026-01-05-initial-contact'

    def target(self, **extra):
        return {'matter_id':self.matter,'progress_id':self.meeting,**extra}

    def args(self, **changes):
        current=self.call('read_progress_supplements',self.target())
        return self.target(revision=current['revision'],request_id=uuid.uuid4().hex,changes={'date':'2026-01-20','body':'## 背景分析\n\n独立补充内容。',**changes})

    def test_every_progress_type_preserves_original_record_and_business_activity(self):
        for event_type in ('contact','meeting','proposal','agreement','administrative','decision','payment','milestone','status_change','other'):
            with self.subTest(event_type=event_type):
                # Separate business scenarios from the already tested rate limiter.
                with self.accounts.db: self.accounts.db.execute('DELETE FROM remote_attempts')
                current=self.workspace.get_record({'kind':'progress','id':'','project_id':self.matter})
                self.workspace.actor=self.actor
                added=self.workspace.save({'kind':'progress','id':'','project_id':self.matter,'revision':current['revision'],'payload':{
                    'date':'2026-01-19','type':event_type,'title':'补充测试 '+event_type,'summary':'记录已经发生的业务动作。',
                    'importance':'normal','participants':['林岚'],'body':'原会议正文。' if event_type=='meeting' else ''}})
                self.meeting=added['id']
                files=self.workspace.read_files()
                query={'kind':'progress','id':self.meeting,'project_id':self.matter}
                byline=self.workspace.event_update(query,self.workspace.observe())
                data=json.loads((self.content/'generated/dashboard.json').read_text())
                original=self.call('read_progress',self.target())
                args=self.args();saved=self.call('save_progress_supplement',args)
                self.assertEqual(self.call('save_progress_supplement',args),saved)
                after=self.workspace.read_files()
                self.assertEqual({k:after[k] for k in files},files)
                self.assertEqual(len(set(after)-set(files)),1)
                self.assertEqual(json.loads((self.content/'generated/dashboard.json').read_text()),data)
                self.assertEqual(self.workspace.event_update(query,self.workspace.observe()),byline)
                self.assertEqual(self.call('read_progress',self.target())['fields'],original['fields'])
                listing=self.call('read_progress_supplements',self.target())
                self.assertEqual(listing['progress_title'],'补充测试 '+event_type)
                self.assertEqual(listing['items'][0]['body'],args['changes']['body'])
                self.assertEqual(self.call('read_progress_supplements',self.target(snapshot=added['status']['version']))['items'],[])

    def test_generic_tools_edit_history_permissions_and_legacy_retries(self):
        from workspace_service import ServiceError
        args=self.args();draft_token=self.issue('draft')
        draft=self.call('submit_progress_supplement',args,draft_token)
        self.assertEqual(self.call('read_progress_supplements',self.target())['items'],[])
        saved=self.remote.browser({'operation':'confirm','draftId':draft['draftId'],'confirmed':True},self.actor)
        first=self.call('read_progress_supplements',self.target(id=saved['id']))
        update=self.target(id=saved['id'],revision=first['revision'],request_id=uuid.uuid4().hex,changes={'body':'修订后的背景分析。'})
        result=self.call('save_progress_supplement',update)
        self.assertEqual(self.call('save_progress_supplement',update),result)
        revised=self.call('read_progress_supplements',self.target(id=saved['id']))
        self.assertEqual(revised['record']['date'],args['changes']['date'])
        self.assertEqual(revised['record']['author'],first['record']['author'])
        self.assertEqual(self.call('progress_supplement_history',self.target(id=saved['id'],version=saved['status']['version']))['record'],first['record'])
        self.assertEqual(len(self.call('progress_supplement_history',self.target(id=saved['id']))['versions']),2)
        with self.assertRaises(ServiceError):self.call('save_progress_supplement',{**update,'request_id':uuid.uuid4().hex})
        with self.assertRaises(AuthError):self.call('save_progress_supplement',self.args(),draft_token)
        for role in ('editor','viewer'):
            account={**self.actor,'role':role,'all_projects':False,'project_ids':['project-demo-investment']}
            for op in ('list','read','history','version','save'):
                with self.assertRaises(AuthError):self.service(account,operation=op,id=saved['id'],version=saved['status']['version'])
        viewer={**self.actor,'role':'viewer','all_projects':False,'project_ids':[self.matter]}
        self.assertEqual(len(self.service(viewer,operation='list')['items']),1)
        with self.assertRaises(AuthError):self.service(viewer,operation='save')
        legacy_target={'matter_id':self.matter,'meeting_id':self.meeting}
        old=self.call('read_meeting_supplements',legacy_target)
        self.assertIn('meeting_title',old)
        legacy_args={**legacy_target,'revision':old['revision'],'request_id':uuid.uuid4().hex,'changes':{'date':'2026-01-21','body':'现有连接补充'}}
        legacy_saved=self.call('save_meeting_supplement',legacy_args)
        self.assertEqual(self.call('save_meeting_supplement',legacy_args),legacy_saved)
        with self.assertRaises(AuthError):
            self.call('save_progress_supplement',{**self.target(),'revision':old['revision'],'request_id':legacy_args['request_id'],'changes':legacy_args['changes']})
        self.assertEqual(len(self.call('read_progress_supplements',self.target())['items']),2)
        with self.assertRaises(ServiceError):self.call('read_progress_supplements',self.target(progress_id='absent'))
        with self.assertRaises(AuthError):self.call('read_progress_supplements',{**self.target(),'meeting_id':self.meeting})


class RecycleBinTests(unittest.TestCase):
    setUp = RemoteWriteTests.setUp
    issue = RemoteWriteTests.issue
    call = RemoteWriteTests.call
    meeting = '2026-01-15-solution-meeting'

    def service(self, operation, kind='progress', identity=None, actor=None, **extra):
        from recycle_bin import RecycleBin
        actor = actor or self.actor
        self.workspace.actor = {key: actor[key] for key in ("id", "name", "email")}
        self.workspace.policy = Policy(self.workspace, actor)
        query = {'action':'recycle','operation':operation,'kind':kind,'id':identity or self.meeting,'project_id':self.matter,**extra}
        self.workspace.policy.authorize(query)
        return RecycleBin(self.workspace).execute(query)

    def move(self, operation, kind='progress', identity=None):
        item = self.service('preview', kind, identity)
        request = {'revision':item['revision'],'request_id':uuid.uuid4().hex,'confirmed':True}
        return self.service(operation, kind, identity, **request), request

    def data(self):
        return json.loads((self.content/'generated/dashboard.json').read_text())

    def test_preserve_original_files_history_snapshots_supplements_and_restore(self):
        from recycle_bin import INDEX
        from workspace_service import ServiceError
        from progress_supplements import Supplements
        target = {'matter_id':self.matter,'meeting_id':self.meeting}
        original_files = self.workspace.read_files()
        meeting_path = 'counterparties/示例合作/matters/合作对接/meetings/20260115.md'
        self.workspace.actor = {**self.actor,'name':'原会议记录人'}
        self.workspace.commit(original_files,{**original_files,meeting_path:original_files[meeting_path]+'\n会议记录原文。\n'},'完善会议记录','form')
        opened = self.call('read_meeting_supplements', target)
        self.call('save_meeting_supplement',{**target,'revision':opened['revision'],'request_id':uuid.uuid4().hex,'changes':{'date':'2026-01-16','body':'会后文案完整保留。'}})
        baseline = self.workspace.observe(); before = self.workspace.read_files()
        data = self.data()
        query = {'kind':'progress','id':self.meeting,'project_id':self.matter}
        byline = self.workspace.event_update(query, baseline)
        self.assertEqual(byline['update']['name'],'原会议记录人')
        preview = self.service('preview')
        self.assertEqual(preview['counts']['supplements'], 1)
        archived, request = self.move('archive')
        self.assertEqual({k:v for k,v in self.workspace.read_files().items() if k!=INDEX},before)
        self.assertFalse(any(e['id']==self.meeting for p in self.data()['projects'] for e in p['events']))
        project = next(p for p in self.data()['projects'] if p['id']==self.matter)
        self.assertEqual(project['last_activity'],'2026-01-05')
        self.assertTrue(self.service('archive', **request)['replayed'])
        with self.assertRaises(ServiceError): self.service('archive', **{**request,'id':'other'})
        with self.assertRaises(ServiceError): self.workspace.get_record(query)
        with self.assertRaises(ServiceError): self.workspace.save({**query,'revision':'stale','payload':{}})
        with self.assertRaises(ServiceError): self.call('read_progress',{'matter_id':self.matter,'progress_id':self.meeting})
        with self.assertRaises(ServiceError): self.call('read_meeting_supplements',target)
        events = self.call('read_matter',{'matter_id':self.matter})['events']
        self.assertNotIn(self.meeting,[e['id'] for e in events])
        record = self.service('read')['record']
        self.assertEqual(record['body'],self.workspace.record(before,'progress',self.meeting,self.matter)['body'])
        self.assertEqual(self.service('list')['items'][0]['history'][0]['actor']['id'],self.actor['id'])
        self.move('restore')
        self.assertEqual(self.data(),data)
        self.assertEqual(self.workspace.event_update(query,self.workspace.observe()),byline)
        self.assertEqual(self.call('read_meeting_supplements',target)['items'][0]['body'],'会后文案完整保留。')
        self.assertEqual(Supplements(self.workspace).read({'project_id':self.matter,'event_id':self.meeting},self.workspace.version_files(baseline['version']))['items'][0]['body'],'会后文案完整保留。')
        historical = self.workspace.historical({'version':archived['status']['version']})
        self.assertFalse(any(e['id']==self.meeting for p in historical['data']['projects'] for e in p['events']))
        labels = [v['label'] for v in self.workspace.history_entries({})]
        self.assertTrue(any(v.startswith('移入回收站') for v in labels))
        self.assertTrue(any(v.startswith('从回收站恢复') for v in labels))

    def test_lost_acknowledgement_does_not_repeat_or_reapply_a_move(self):
        from workspace_service import ServiceError
        preview = self.service('preview')
        args = {'revision':preview['revision'],'request_id':uuid.uuid4().hex,'confirmed':True}
        commit = self.workspace.commit
        def lost(*values, **kwargs):
            commit(*values, **kwargs)
            raise ServiceError('模拟保存成功后连接中断。', 'storage')
        with patch.object(self.workspace, 'commit', side_effect=lost):
            with self.assertRaises(ServiceError): self.service('archive', **args)
        self.assertTrue(self.service('archive', **args)['replayed'])
        self.assertEqual(len(self.service('list')['items'][0]['history']), 1)
        self.move('restore')
        self.assertTrue(self.service('archive', **args)['replayed'])
        self.assertFalse(self.service('list')['items'][0]['archived'])

    def test_roles_conflicts_nested_restore_empty_matter_and_no_remote_delete(self):
        from workspace_service import ServiceError
        for role in ('editor','viewer'):
            actor = {**self.actor,'id':role,'role':role,'all_projects':True}
            for op in ('list','read','preview','archive','restore'):
                with self.assertRaises(AuthError): self.service(op,actor=actor)
        preview = self.service('preview')
        files = self.workspace.read_files()
        path = 'counterparties/示例合作/matters/合作对接/meetings/20260115.md'
        self.workspace.commit(files,{**files,path:files[path]+'\n补充会议事实。\n'},'修改原文','form')
        with self.assertRaises(ServiceError) as error: self.service('archive',revision=preview['revision'],request_id=uuid.uuid4().hex,confirmed=True)
        self.assertEqual(error.exception.code,'conflict')
        self.move('archive')
        self.move('archive','project',self.matter)
        self.assertNotIn(self.matter,[p['id'] for p in self.data()['projects']])
        self.assertNotIn(self.matter,[p['id'] for p in self.call('search_matters')['matters']])
        with self.assertRaises(AuthError): self.call('read_matter',{'matter_id':self.matter})
        with self.assertRaises(ServiceError): self.move('restore')
        with self.assertRaises(AuthError): self.call('archive_progress',{'matter_id':self.matter,'progress_id':self.meeting})
        self.move('restore','project',self.matter)
        project = next(p for p in self.data()['projects'] if p['id']==self.matter)
        self.assertNotIn(self.meeting,[e['id'] for e in project['events']])
        for event in project['events']: self.move('archive',identity=event['id'])
        project = next(p for p in self.data()['projects'] if p['id']==self.matter)
        self.assertEqual(project['events'],[])
        self.assertEqual(project['last_activity'],'')
        self.move('restore')
        self.assertEqual(len(next(p for p in self.data()['projects'] if p['id']==self.matter)['events']),1)

    def test_shared_attachments_keep_original_access_scope_and_bytes(self):
        from file_library import FileLibrary
        library=FileLibrary(self.workspace)
        self.workspace.actor=self.actor
        self.workspace.policy=Policy(self.workspace,self.actor)
        before=self.workspace.read_files()
        raw=self.workspace.record(before,'project',self.matter)
        result=library.save({'operation':'upload','payload':{'title':'共享附件','organization':'示例机构','category':'presentation','project_ids':[self.matter,'project-demo-investment'],'home_counterparty_id':raw['metadata']['primary_counterparty_id'],'status':'unspecified','filename':'shared.txt','data':base64.b64encode(b'original attachment').decode()}})
        index=library.list()['files']; item=next(x for x in index if x['id']==result['id'])
        source=library.download(item['id'],item['versions'][0]['id'])
        index_source=self.workspace.read_files()['files.yaml']
        self.move('archive','project',self.matter)
        self.assertEqual(library.download(item['id'],item['versions'][0]['id']),source)
        self.assertIn(item['id'],[x['id'] for x in library.list()['files']])
        partial=Policy(self.workspace,{**self.actor,'role':'editor','all_projects':False,'project_ids':['project-demo-investment']})
        self.assertFalse(partial.file_allowed(item),'Trashing a linked matter must never widen a shared-file ACL')
        all_projects=Policy(self.workspace,{**self.actor,'role':'editor','all_projects':True})
        self.assertTrue(all_projects.file_allowed(item))
        self.move('archive','project','project-demo-investment')
        self.assertNotIn(item['id'],[x['id'] for x in library.list()['files']])
        self.assertEqual(self.workspace.read_files()['files.yaml'],index_source)
        self.move('restore','project',self.matter)
        self.assertIn(item['id'],[x['id'] for x in library.list()['files']])


if __name__=='__main__': unittest.main(verbosity=2)
