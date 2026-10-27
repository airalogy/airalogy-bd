import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, repository } from './image-release.mjs';

export function deploymentFiles(root, record) {
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json')));
  identity(record.version, record.revision);
  assert.equal(record.version, version);
  assert.equal(record.repository, repository);
  assert.match(record.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.image, `${repository}@${record.digest}`);
  assert.equal(record.tag, `${repository}:${version}`);
  assert.deepEqual(record.platforms.map(p => p.architecture).sort(), ['amd64', 'arm64']);
  const env = readFileSync(path.join(root, 'deploy/.env.example'), 'utf8').replace(/^BD_IMAGE=.*$/m, `BD_IMAGE=${record.image}`);
  return {
    'compose.yaml': readFileSync(path.join(root, 'deploy/compose.yaml'), 'utf8'),
    '.env.example': env,
    'bdctl': readFileSync(path.join(root, 'deploy/bdctl'), 'utf8'),
    'network_preflight.py': readFileSync(path.join(root, 'deploy/network_preflight.py'), 'utf8'),
    'image.json': JSON.stringify(record, null, 2) + '\n',
    'README.md': `# Airalogy BD ${version}\n\n镜像版本：\`${record.tag}\`，配置默认锁定测试通过的镜像摘要。支持 Linux amd64 / arm64。\n\n安装 Docker Engine、Compose v2、Python 3.10+ 和 iproute2，复制 \`.env.example\` 为 \`.env\`，将权限设为 600。设置 BD_PUBLIC_URL，并用 \`openssl rand -hex 32\` 生成一次 BETTER_AUTH_SECRET，独立妥善保管。设置并核对 BD_DOCKER_SUBNET 和云/VPC/VPN 网络配置；已有实例保留实际安全网段。网段冲突或无法检查时拒绝部署。\n\n\`\`\`sh\n./bdctl preflight\n./bdctl pull\n./bdctl run --rm bd init --id company-id --name 公司名称\n./bdctl run --rm bd account-init --email admin@example.com --name 管理员姓名\n./bdctl up -d\n\`\`\`\n\n已有实例只更新镜像配置；更新前备份资料并记录旧镜像摘要，不重复初始化管理员。单实例运行，用 HTTPS 反向代理接入仅绑定本机的 3100 端口。禁止删除持久卷；程序回退与数据恢复分别处理。配置密钥和业务资料不在此安装包内。\n\n完整部署、备份及恢复说明：https://github.com/airalogy/airalogy-bd/blob/v${version}/docs/server-deployment.md\n`,
  };
}
export function verifyExistingAsset(existing, digest) {
  if (!existing) return false;
  assert.equal(existing.digest, `sha256:${digest}`, 'Existing GitHub Release asset differs; refusing overwrite');
  return true;
}
export function prepareReleaseAssets(root, directory, record) {
  const files = deploymentFiles(root, record);
  const staging = path.join(directory, 'deploy'); mkdirSync(staging, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(staging, name), data);
  const bundle = `airalogy-bd-${record.version}-deploy.tar.gz`;
  // Normalized timestamps/owners make retries produce identical release assets.
  execFileSync('python3', ['-c', `import gzip,io,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1])
with open(sys.argv[2],'wb') as target, gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0) as gz, tarfile.open(fileobj=gz,mode='w') as archive:
 for name in sorted(['README.md','compose.yaml','.env.example','image.json','bdctl','network_preflight.py']):
  p=root/name; data=p.read_bytes(); info=tarfile.TarInfo(p.name); info.size=len(data); info.mode=0o755 if name=='bdctl' else 0o644; info.mtime=0; archive.addfile(info,io.BytesIO(data))
`, staging, path.join(directory, bundle)]);
  const npmFile = `airalogy-airalogy-bd-${record.version}.tgz`;
  const digest = file => createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex');
  assert.equal(readFileSync(path.join(directory, npmFile + '.sha256'), 'utf8').trim(), `${digest(npmFile)}  ${npmFile}`);
  const assets = [npmFile, npmFile + '.sha256', bundle, 'image.json'];
  writeFileSync(path.join(directory, 'SHA256SUMS'), assets.map(file => `${digest(file)}  ${file}\n`).join(''));
  assets.push('SHA256SUMS');
  return assets;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2]);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const record = JSON.parse(readFileSync(path.join(directory, 'image.json')));
  assert.equal(record.revision, process.env.GITHUB_SHA);
  const assets = prepareReleaseAssets(root, directory, record);
  const digest = file => createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex');
  const release = JSON.parse(execFileSync('gh', ['api', `repos/airalogy/airalogy-bd/releases/tags/v${record.version}`], { encoding: 'utf8' }));
  assert.equal(release.tag_name, `v${record.version}`);
  assert.equal(release.draft, false);
  for (const file of assets) {
    if (!verifyExistingAsset(release.assets.find(a => a.name === file), digest(file))) {
      execFileSync('gh', ['release', 'upload', `v${record.version}`, path.join(directory, file), '--repo', 'airalogy/airalogy-bd'], { stdio: 'inherit' });
    }
  }
}
