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


class QuestionAuthorizationTests(unittest.TestCase):
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
    def test_question_grants_survive_backups_but_credentials_do_not(self):
        from team_auth import backup_accounts, validate_account_backup
        with tempfile.TemporaryDirectory() as temp:
            content=Path(temp)/'content';content.mkdir()
            accounts=Accounts(content)
            invitation=accounts.invite({'name':'管理员','email':'admin@example.invalid','role':'admin'},None,set(),bootstrap=True)
            identity=accounts.invitation(invitation['token'])['user_id']
            actor=accounts.member_info(accounts.db.execute('SELECT * FROM users WHERE id=?',(identity,)).fetchone())
            self.assertTrue(actor['qa_allowed'])
            invitation=accounts.invite({'name':'编辑','role':'editor','qa_allowed':True},actor,set())
            editor_id=accounts.invitation(invitation['token'])['user_id']
            self.assertTrue(accounts.qa_allowed(editor_id))
            destination=Path(temp)/'copy.sqlite3'
            backup_accounts(content,destination);validate_account_backup(destination)
            with sqlite3.connect(destination) as backup:
                self.assertEqual(backup.execute('SELECT owner FROM qa_grants').fetchall(),[(editor_id,)])
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
                values={k:v for k,v in member().items() if k!='remote_allowed'}
                accounts.update({**values,'role':'editor','active':False},actor,set())
                self.assertFalse(member()['remote_allowed'])
                self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_grants').fetchone()[0],0)
                # A deliberate ordinary-member grant remains supported, and promotion consumes no persistent grant.
                accounts.update({**member(),'active':False,'remote_allowed':True,'remote_allowed_before':False},actor,set())
                self.assertTrue(member()['remote_allowed'])
                accounts.update({**member(),'role':'admin','active':False,'remote_allowed_before':True},actor,set())
                self.assertEqual(accounts.db.execute('SELECT COUNT(*) FROM remote_grants').fetchone()[0],0)
                accounts.update({**member(),'role':'viewer','active':False,'remote_allowed':True,'remote_allowed_before':True},actor,set())
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


if __name__=='__main__': unittest.main(verbosity=2)
