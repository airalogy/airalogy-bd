import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, checkImage, checkRecord, checkIndex, descriptorFromResult, isMissingPackage, repository } from '../.github/scripts/image-release.mjs';
import { deploymentFiles, prepareDeploymentAssets, prepareReleaseAssets, verifyExistingAsset } from '../.github/scripts/release-assets.mjs';

const revision = 'a'.repeat(40), hash = 'sha256:' + 'b'.repeat(64);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const expected = identity(version, revision, 'arm64');
const image = { Id: hash, Os: 'linux', Architecture: 'arm64', Config: { User: '10001:10001', Labels: {
  'org.opencontainers.image.version': version,
  'org.opencontainers.image.revision': revision,
  'org.opencontainers.image.source': 'https://github.com/airalogy/airalogy-bd',
} } };
test('release image identity rejects wrong version, source, privilege, platform or revision', () => {
  assert.equal(checkImage(image, expected), hash);
  for (const mutate of [
    x => { x.Os = 'windows'; }, x => { x.Architecture = 'amd64'; }, x => { x.Config.User = 'root'; },
    x => { x.Config.Labels['org.opencontainers.image.version'] = '0.0.0'; },
    x => { x.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40); },
    x => { x.Config.Labels['org.opencontainers.image.source'] = 'https://example.com/unrelated'; },
  ]) { const invalid = structuredClone(image); mutate(invalid); assert.throws(() => checkImage(invalid, expected)); }
  for (const args of [['v1.2.3', revision], ['1.2.3', 'main'], ['1.2.3', revision, 'unknown']]) assert.throws(() => identity(...args));
  assert.throws(() => checkRecord({ ...expected, revision: 'c'.repeat(40), image_id: hash }, expected));
});
test('registry checks distinguish absent tags from authentication and network errors', () => {
  assert.equal(descriptorFromResult({ status: 1, stderr: 'manifest unknown' }), null);
  assert.equal(descriptorFromResult({ status: 0, stdout: JSON.stringify({ digest: hash }) }).digest, hash);
  for (const stderr of ['unauthorized: not found', 'denied: not found', 'TLS handshake timeout', 'connection failed', 'no such host']) {
    assert.throws(() => descriptorFromResult({ status: 1, stderr }));
  }
  assert.ok(isMissingPackage({ status: 1, stderr: 'HTTP 404', stdout: '{"message":"Package not found."}' }));
  for (const result of [{ status: 1, stderr: 'HTTP 401', stdout: '{"message":"Bad credentials"}' }, { status: 1, stderr: 'HTTP 404', stdout: '{"message":"Not Found"}' }, { status: 1, stderr: 'network timeout', stdout: '' }]) assert.equal(isMissingPackage(result), false);
});
const platforms = ['amd64', 'arm64'].map((architecture, i) => ({ version, revision, architecture, image_id: hash, digest: 'sha256:' + String(i + 1).repeat(64) }));
const index = { manifests: platforms.map(p => ({ digest: p.digest, platform: { os: 'linux', architecture: p.architecture } })) };
test('version manifests require both tested architectures and cannot overwrite a different digest', () => {
  checkIndex(index, platforms);
  assert.throws(() => checkIndex({ manifests: index.manifests.slice(0, 1) }, platforms));
  assert.throws(() => checkIndex(index, [platforms[0], platforms[0]]));
  const changed = structuredClone(index); changed.manifests[1].digest = hash;
  assert.throws(() => checkIndex(changed, platforms));
});
test('deployment bundle locks the release digest and never enables source builds', () => {
  const record = { version, revision, repository, tag: `${repository}:${version}`, digest: hash, image: `${repository}@${hash}`, platforms };
  const files = deploymentFiles(fileURLToPath(new URL('..', import.meta.url)), record);
  assert.match(files['.env.example'], new RegExp(`^BD_IMAGE=${repository}@${hash}$`, 'm'));
  assert.match(files['.env.example'], /^BETTER_AUTH_SECRET=$/m);
  assert.ok(!files['compose.yaml'].includes('build:'));
  assert.ok(!files['.env.example'].includes('RELEASE_VERSION'));
  assert.equal(JSON.parse(files['image.json']).version, version);
  assert.throws(() => deploymentFiles(fileURLToPath(new URL('..', import.meta.url)), { ...record, version: '0.0.0' }));
  assert.equal(verifyExistingAsset(undefined, 'b'.repeat(64)), false);
  assert.equal(verifyExistingAsset({ digest: hash }, 'b'.repeat(64)), true);
  assert.throws(() => verifyExistingAsset({ digest: hash }, 'c'.repeat(64)));
});
test('release archives are reproducible, extractable and protect npm artifact integrity', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = mkdtempSync(path.join(tmpdir(), 'bd-release-assets-'));
  const record = { version, revision, repository, tag: `${repository}:${version}`, digest: hash, image: `${repository}@${hash}`, platforms };
  try {
    writeFileSync(path.join(directory, 'image.json'), JSON.stringify(record));
    const deployment = prepareDeploymentAssets(root, directory, record);
    assert.equal(deployment.at(-1), 'deployment-ready.json');
    assert.equal(existsSync(path.join(directory, 'publication.json')), false);
    const ready = JSON.parse(readFileSync(path.join(directory, 'deployment-ready.json')));
    assert.equal(ready.status, 'deployment-ready');
    assert.equal(ready.revision, revision);
    for (const [file, digest] of Object.entries(ready.sha256)) {
      assert.equal(createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex'), digest);
    }
    const earlyBundle = readFileSync(path.join(directory, `airalogy-bd-${version}-deploy.tar.gz`));
    const npmFile = `airalogy-airalogy-bd-${version}.tgz`;
    const data = Buffer.from('synthetic package artifact');
    const digest = createHash('sha256').update(data).digest('hex');
    writeFileSync(path.join(directory, npmFile), data);
    writeFileSync(path.join(directory, npmFile + '.sha256'), `${digest}  ${npmFile}\n`);
    writeFileSync(path.join(directory, 'image.json'), JSON.stringify(record));
    const assets = prepareReleaseAssets(root, directory, record);
    const bundle = path.join(directory, `airalogy-bd-${version}-deploy.tar.gz`);
    const first = readFileSync(bundle);
    assert.ok(assets.includes('SHA256SUMS'));
    assert.equal(assets.at(-1), 'publication.json');
    assert.deepEqual(first, earlyBundle, 'Early deployment and final release must use identical bundles');
    const complete = JSON.parse(readFileSync(path.join(directory, 'publication.json')));
    assert.equal(complete.status, 'complete');
    assert.equal(complete.image, record.image);
    assert.equal(complete.npm.integrity, 'sha512-' + createHash('sha512').update(data).digest('base64'));
    for (const [file, digest] of Object.entries(complete.sha256)) {
      assert.equal(createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex'), digest);
    }
    assert.match(execFileSync('tar', ['-xOf', bundle, '.env.example'], { encoding: 'utf8' }), new RegExp(`^BD_IMAGE=${repository}@${hash}$`, 'm'));
    prepareReleaseAssets(root, directory, record);
    assert.deepEqual(readFileSync(bundle), first);
    writeFileSync(path.join(directory, npmFile), 'tampered');
    assert.throws(() => prepareReleaseAssets(root, directory, record));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
