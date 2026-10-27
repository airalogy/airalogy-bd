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
    'image.json': JSON.stringify(record, null, 2) + '\n',
    'README.md': `# Airalogy BD ${version}\n\n镜像版本：\`${record.tag}\`，配置默认锁定测试通过的镜像摘要。支持 Linux amd64 / arm64。\n\n安装 Docker Engine 和 Compose v2，复制 \`.env.example\` 为 \`.env\`，将权限设为 600。设置 BD_PUBLIC_URL，并用 \`openssl rand -hex 32\` 生成一次 BETTER_AUTH_SECRET，独立妥善保管。\n\n\`\`\`sh\ndocker compose pull\ndocker compose run --rm bd init --id company-id --name 公司名称\ndocker compose run --rm bd account-init --email admin@example.com --name 管理员姓名\ndocker compose up -d\n\`\`\`\n\n已有实例只更新镜像配置；更新前备份资料并记录旧镜像摘要，不重复初始化管理员。单实例运行，用 HTTPS 反向代理接入仅绑定本机的 3100 端口。禁止删除持久卷；程序回退与数据恢复分别处理。配置密钥和业务资料不在此安装包内。\n\n完整部署、备份及恢复说明：https://github.com/airalogy/airalogy-bd/blob/v${version}/docs/server-deployment.md\n`,
  };
}
export function verifyExistingAsset(existing, digest) {
  if (!existing) return false;
  assert.equal(existing.digest, `sha256:${digest}`, 'Existing GitHub Release asset differs; refusing overwrite');
  return true;
}
const digestFile = (directory, file, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(readFileSync(path.join(directory, file))).digest(encoding);

export function prepareDeploymentAssets(root, directory, record) {
  const files = deploymentFiles(root, record);
  const staging = path.join(directory, 'deploy'); mkdirSync(staging, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(staging, name), data);
  const bundle = `airalogy-bd-${record.version}-deploy.tar.gz`;
  // Normalized timestamps/owners make retries produce identical release assets.
  execFileSync('python3', ['-c', `import gzip,io,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1])
with open(sys.argv[2],'wb') as target, gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0) as gz, tarfile.open(fileobj=gz,mode='w') as archive:
 for name in sorted(['README.md','compose.yaml','.env.example','image.json']):
  p=root/name; data=p.read_bytes(); info=tarfile.TarInfo(p.name); info.size=len(data); info.mode=0o644; info.mtime=0; archive.addfile(info,io.BytesIO(data))
`, staging, path.join(directory, bundle)]);
  const digest = file => digestFile(directory, file);
  const assets = [bundle, 'image.json'];
  writeFileSync(path.join(directory, 'DEPLOY-SHA256SUMS'), assets.map(file => `${digest(file)}  ${file}\n`).join(''));
  writeFileSync(path.join(directory, 'deployment-ready.json'), JSON.stringify({
    schema_version: 1, status: 'deployment-ready', version: record.version, revision: record.revision,
    image: record.image, sha256: Object.fromEntries(assets.map(file => [file, digest(file)])),
  }, null, 2) + '\n');
  // The readiness receipt is uploaded last, after all deployment assets exist.
  return [...assets, 'DEPLOY-SHA256SUMS', 'deployment-ready.json'];
}
export function prepareReleaseAssets(root, directory, record) {
  const deployment = prepareDeploymentAssets(root, directory, record);
  const npmFile = `airalogy-airalogy-bd-${record.version}.tgz`;
  const digest = file => digestFile(directory, file);
  assert.equal(readFileSync(path.join(directory, npmFile + '.sha256'), 'utf8').trim(), `${digest(npmFile)}  ${npmFile}`);
  const assets = [...deployment, npmFile, npmFile + '.sha256'];
  writeFileSync(path.join(directory, 'SHA256SUMS'), assets.map(file => `${digest(file)}  ${file}\n`).join(''));
  assets.push('SHA256SUMS');
  writeFileSync(path.join(directory, 'publication.json'), JSON.stringify({
    schema_version: 1, status: 'complete', version: record.version, revision: record.revision,
    image: record.image, npm: { name: '@airalogy/airalogy-bd', version: record.version,
      integrity: 'sha512-' + digestFile(directory, npmFile, 'sha512', 'base64') },
    sha256: Object.fromEntries(assets.map(file => [file, digest(file)])),
  }, null, 2) + '\n');
  // Only the final job (after npm and public image verification) calls this path.
  return [...assets, 'publication.json'];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2]);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const record = JSON.parse(readFileSync(path.join(directory, 'image.json')));
  assert.equal(record.revision, process.env.GITHUB_SHA);
  assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--deployment-only'));
  const assets = process.argv[3] === '--deployment-only'
    ? prepareDeploymentAssets(root, directory, record) : prepareReleaseAssets(root, directory, record);
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
