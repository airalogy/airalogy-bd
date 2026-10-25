"""Verified local copies and optional private OSS backups, outside business data."""
from __future__ import annotations
import errno
import fcntl
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from file_backup import create_backup, backup_download, checksum
from file_library import LibraryError


class BackupManager:
    def __init__(self, workspace):
        self.workspace = workspace
        self.config_file = workspace.store / 'backup-config.json'
        self.state_file = workspace.store / 'backup-state.json'

    def config(self):
        defaults = {'enabled': os.environ.get('BD_BACKUP_ENABLED') == '1',
                    'directory': os.environ.get('BD_BACKUP_DIRECTORY', str(self.workspace.root.parent.parent / 'bd-backups')),
                    'interval_minutes': int(os.environ.get('BD_BACKUP_INTERVAL_MINUTES', '60')),
                    'oss_enabled': os.environ.get('BD_OSS_BACKUP') == '1',
                    'retention_days': int(os.environ.get('BD_BACKUP_RETENTION_DAYS', '0'))}
        config = {**defaults, **(json.loads(self.config_file.read_text()) if self.config_file.exists() else {})}
        if os.environ.get('BD_MODE') == 'server':
            config['directory'] = defaults['directory']
        return config

    def status(self):
        state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        return {**state, 'config': self.config(), 'server': os.environ.get('BD_MODE') == 'server',
                'oss_configured': all(os.environ.get(k) for k in ('BD_OSS_BUCKET', 'BD_OSS_ENDPOINT', 'BD_OSS_REGION'))}

    def directory(self, value):
        if not isinstance(value, str) or not value.strip() or not Path(value).is_absolute():
            raise LibraryError('请填写备份文件夹的完整路径。')
        target = Path(value).absolute()
        if any(part.is_symlink() for part in [target, *target.parents]):
            raise LibraryError('备份目录不能使用符号链接，请填写实际文件夹路径。')
        target = target.resolve()
        root = self.workspace.root.parent.resolve()
        if target == root or root in target.parents:
            raise LibraryError('请将备份放在工作区以外的独立文件夹，避免随工作区一起丢失。')
        if target.exists() and not target.is_dir():
            raise LibraryError('备份路径不是文件夹。')
        return target

    def configure(self, request):
        config = request.get('config', {})
        if not isinstance(config, dict): raise LibraryError('备份设置无效。')
        current = self.config()
        config = {key: config.get(key, current[key]) for key in current}
        if not isinstance(config['enabled'], bool) or type(config['interval_minutes']) is not int or config['interval_minutes'] not in {60, 1440} or type(config['oss_enabled']) is not bool:
            raise LibraryError('请选择有效的备份频率和目标。')
        if type(config['retention_days']) is not int or config['retention_days'] not in {0, 7, 30, 90, 365}:
            raise LibraryError('本地保留期请选择不自动清理、7、30、90 或 365 天。')
        if os.environ.get('BD_REQUEST_WEB') == '1' and os.environ.get('BD_MODE') == 'server' and config['directory'] != current['directory']:
            raise LibraryError('服务器备份目录由部署配置管理。')
        if config['oss_enabled']:
            from oss_backup import settings
            try: settings()
            except ValueError as error: raise LibraryError(str(error)) from error
        directory = self.directory(config['directory'])
        if request.get('revision') != self.revision():
            raise LibraryError('备份设置已发生变化，请刷新后重新保存。', 'conflict')
        self.workspace.atomic(self.config_file, json.dumps({**config, 'directory': str(directory)}, ensure_ascii=False))
        return self.status_with_revision()

    def revision(self):
        from workspace_service import digest
        return digest(self.config())

    def status_with_revision(self):
        return {**self.status(), 'revision': self.revision()}

    def save_state(self, state):
        state = {k:v for k,v in state.items() if k not in {'config', 'server', 'oss_configured', 'revision'}}
        self.workspace.atomic(self.state_file, json.dumps(state, ensure_ascii=False))

    def upload(self, path, key, fingerprint):
        # Release the business lock only after publishing an immutable verified archive.
        # A separate non-blocking backup lock prevents overlapping uploads.
        lock = getattr(self.workspace, 'lock', None)
        if lock: fcntl.flock(lock, fcntl.LOCK_UN)
        try:
            result = subprocess.run(['uv', 'run', '--cache-dir', os.environ.get('BD_CACHE_DIR', str(self.workspace.root.parent / '.uv-cache')), '--locked', str(Path(__file__).with_name('oss_backup.py'))],
                                    input=json.dumps({'path':str(path),'key':key,'sha256':fingerprint}), capture_output=True, text=True, timeout=240)
            try: response = json.loads(result.stdout)
            except ValueError: raise LibraryError('OSS 备份服务未能启动，请检查服务器运行环境。')
            if result.returncode or not response.get('ok'):
                raise LibraryError(response.get('error', 'OSS 备份未完成。'))
            return response['result']
        finally:
            if lock: fcntl.flock(lock, fcntl.LOCK_EX)

    def prune(self, directory, days, newest):
        if not days: return
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        pattern = re.compile(r'bd-' + re.escape(self.workspace.store.name) + r'-(\d{8}-\d{6})-[a-f0-9]{32}\.zip')
        for path in directory.iterdir():
            match = pattern.fullmatch(path.name)
            if match and path != newest and path.is_file() and not path.is_symlink():
                created = datetime.strptime(match[1], '%Y%m%d-%H%M%S').replace(tzinfo=timezone.utc)
                if created < cutoff: path.unlink()

    def run(self, force=False):
        with (self.workspace.store / 'backup-run.lock').open('a+') as run_lock:
            try: fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return self.status_with_revision()
            return self.run_locked(force)

    def run_locked(self, force):
        from workspace_service import digest
        config, state = self.config(), self.status()
        if not force and not config['enabled']: return self.status_with_revision()
        now = datetime.now(timezone.utc)
        if not force and state.get('last_attempt') and state.get('error') and (now-datetime.fromisoformat(state['last_attempt'])).total_seconds()<300:
            return self.status_with_revision()
        export = None
        try:
            self.workspace.recover()
            observed = self.workspace.observe('自动备份前留存资料', 'checkpoint')
            if observed['errors']: raise LibraryError('当前资料有格式问题，本次未生成新备份。已有备份仍然保留。')
            original_head = self.workspace.git('rev-parse','--verify','HEAD',repo=self.workspace.original_repo,check=False).strip() if self.workspace.original_repo else ''
            account_revision = ''
            account_file = self.workspace.root.parent / '.bd-auth' / 'accounts.sqlite3'
            if account_file.exists():
                from team_auth import Accounts
                accounts = Accounts(self.workspace.root)
                account_revision = digest({'users':[list(row) for row in accounts.db.execute('SELECT id,revision FROM users ORDER BY id')], 'audit':accounts.db.execute('SELECT MAX(id) FROM audit').fetchone()[0]})
                accounts.close()
            oss_target = None
            if config['oss_enabled']:
                from oss_backup import settings
                oss_target = settings()
            target_id = digest({'directory':config['directory'],'oss':oss_target})
            last = state.get('last_success') or {}
            if not force and not state.get('error') and last.get('target_id') == target_id:
                unchanged = last.get('version') == observed['version'] and last.get('original_head','') == original_head and last.get('account_revision','') == account_revision
                within = (now-datetime.fromisoformat(last['at'])).total_seconds() < config['interval_minutes']*60
                if unchanged or within: return self.status_with_revision()
            state.update(last_attempt=now.isoformat(), in_progress=True)
            self.save_state(state)
            target = self.directory(config['directory'])
            if str(target).startswith('/Volumes/') and (len(target.parts)<3 or not Path('/Volumes',target.parts[2]).is_mount()):
                raise LibraryError('备份磁盘未连接。连接后会自动重试。')
            target.mkdir(parents=True,exist_ok=True,mode=0o700)
            self.directory(str(target))
            pending = state.get('last_local_success') or {}
            pending_path = Path(pending.get('path', '/nonexistent'))
            reusable = (bool(oss_target) and state.get('error') and pending.get('target_id') == target_id
                        and pending.get('version') == observed['version'] and pending.get('original_head', '') == original_head
                        and pending.get('account_revision', '') == account_revision and pending_path.parent == target
                        and pending_path.is_file() and not pending_path.is_symlink() and checksum(pending_path) == pending.get('sha256'))
            if reusable:
                completed = pending.copy()
                destination, filename, fingerprint = pending_path, pending_path.name, pending['sha256']
            else:
                backup = create_backup(self.workspace)
                export = Path(backup_download(self.workspace,backup['id'])['path'])
                filename = f"bd-{self.workspace.store.name}-{now.strftime('%Y%m%d-%H%M%S')}-{backup['id']}.zip"
                destination = target / filename
                descriptor, temporary = tempfile.mkstemp(prefix='.bd-backup-',dir=target)
                try:
                    with os.fdopen(descriptor,'wb') as output, export.open('rb') as source:
                        shutil.copyfileobj(source,output);output.flush();os.fsync(output.fileno())
                    fingerprint = checksum(export)
                    if checksum(Path(temporary)) != fingerprint: raise LibraryError('备份写入校验失败。')
                    try: os.link(temporary,destination)
                    except OSError as error:
                        if error.errno not in {errno.EPERM,errno.ENOTSUP,errno.EOPNOTSUPP}: raise
                        reserved=os.open(destination,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(reserved)
                        try: os.replace(temporary,destination)
                        except Exception: destination.unlink(missing_ok=True);raise
                finally: Path(temporary).unlink(missing_ok=True)
                completed={'at':now.isoformat(),'directory':str(target),'path':str(destination),'size':destination.stat().st_size,'sha256':fingerprint,'version':observed['version'],'original_head':original_head,'account_revision':account_revision,'target_id':target_id}
                state['last_local_success']=completed.copy()
                self.save_state(state)
            if oss_target:
                workspace_id = json.loads((self.workspace.root/'generated/dashboard.json').read_text())['workspace']['id']
                # Hash the stable workspace ID, not the machine-dependent filesystem path.
                key=oss_target['prefix']+'/'+digest(workspace_id)[:16]+'/'+Path(filename).stem+'-'+uuid.uuid4().hex+'.zip'
                completed['oss']=self.upload(destination,key,fingerprint)
            completed['at']=datetime.now(timezone.utc).isoformat()
            state['last_success']=completed
            state['error']=''
            try:
                self.prune(target,config['retention_days'],destination)
                state['cleanup_error']=''
            except OSError: state['cleanup_error']='备份已成功，但部分过期本地副本未能清理。'
        except Exception as error:
            state.update(last_attempt=now.isoformat(),error=str(error) or '备份未完成，请检查配置、网络和可用空间。')
        finally:
            if export: export.unlink(missing_ok=True)
        state['in_progress']=False
        self.save_state(state)
        return self.status_with_revision()
