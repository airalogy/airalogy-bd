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
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from team_auth import Accounts, AuthError, backup_accounts, validate_account_backup
from team_policy import Policy
from remote_access import RemoteAccess
from workspace_service import Workspace
from automatic_backup import BackupManager
from file_backup import create_backup, backup_download, restore_backup, checksum
from oss_backup import settings, upload

OSS = {'BD_OSS_REGION':'cn-hangzhou','BD_OSS_BUCKET':'test-private-bucket','BD_OSS_ENDPOINT':'https://oss-cn-hangzhou.aliyuncs.com','BD_OSS_PREFIX':'bd-backups'}


class AccountTests(unittest.TestCase):
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
                accounts.db.execute("INSERT INTO remote_tokens VALUES('token-id','hash','member','revision','laptop',1,9999999999,1)")
                accounts.db.execute("INSERT INTO remote_drafts VALUES('draft','member','token-id','revision','request-id','fingerprint','matter',?,'pending',1,9999999999)", (marker,))
                accounts.db.execute("INSERT INTO remote_attempts VALUES('member',?)", (int(time.time()),))
            self.assertTrue(remote.settings()['enabled'])
            target = Path(temp) / 'remote-backup.sqlite3'
            self.assertTrue(backup_accounts(content, target))
            with sqlite3.connect(target) as backup:
                for table in ('remote_settings', 'remote_grants', 'remote_tokens', 'remote_drafts', 'remote_attempts'):
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
