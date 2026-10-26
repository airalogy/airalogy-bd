import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'ghcr.io/airalogy/airalogy-bd';
const source = 'https://github.com/airalogy/airalogy-bd';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function identity(version, revision, architecture) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(revision, /^[a-f0-9]{40}$/);
  if (architecture !== undefined) assert.ok(['amd64', 'arm64'].includes(architecture));
  return { version, revision, ...(architecture && { architecture }) };
}
export function checkImage(image, expected) {
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, expected.architecture);
  assert.match(image.Id, digestPattern);
  assert.equal(image.Config.User, '10001:10001');
  const labels = image.Config.Labels;
  assert.equal(labels['org.opencontainers.image.version'], expected.version);
  assert.equal(labels['org.opencontainers.image.revision'], expected.revision);
  assert.equal(labels['org.opencontainers.image.source'], source);
  return image.Id;
}
export function checkRecord(record, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value, `Image ${key} differs from release`);
  identity(record.version, record.revision, record.architecture);
  assert.match(record.image_id, digestPattern);
  if (record.archive_sha256 !== undefined) assert.match(record.archive_sha256, /^[a-f0-9]{64}$/);
  if (record.digest !== undefined) assert.match(record.digest, digestPattern);
  return record;
}
export function checkIndex(manifest, records) {
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.architecture).sort(), ['amd64', 'arm64']);
  assert.equal(manifest.manifests?.length, 2, 'Version must include exactly both tested platforms');
  for (const record of records) {
    const entry = manifest.manifests.find(m => m.platform?.os === 'linux' && m.platform?.architecture === record.architecture);
    assert.equal(entry?.digest, record.digest, 'Existing image tag differs from tested images; refusing overwrite');
  }
}
function command(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 600000, maxBuffer: 16000000, ...options });
  assert.equal(result.status, 0, `${args[0]} ${args.slice(1).join(' ')} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
}
async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function descriptorFromResult(result) {
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    assert.match(value.digest, digestPattern);
    return value;
  }
  // Authentication/network failures must not be mistaken for an unused tag.
  const message = String(result.stderr || result.error || '');
  if (/manifest unknown|not found/i.test(message) && !/unauthorized|denied|timeout|timed out|TLS|connection|no such host/i.test(message)) return null;
  throw new Error(`Cannot check existing image: ${message}`);
}
export function isMissingPackage(result) {
  if (result.status === 0 || !/HTTP 404/.test(result.stderr || '')) return false;
  try { return JSON.parse(result.stdout).message === 'Package not found.'; } catch { return false; }
}
function descriptor(ref, bootstrap = false) {
  const result = spawnSync('docker', ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', ref], { encoding: 'utf8', timeout: 120000 });
  try { return descriptorFromResult(result); } catch (error) {
    // GHCR may deny pull before a repository's first push. Only the same workflow's
    // package-write token and an explicit GitHub package-not-found response allow bootstrap.
    if (bootstrap && process.env.GITHUB_ACTIONS === 'true' && process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY === 'airalogy/airalogy-bd' && /denied|unauthorized|403/.test(result.stderr || '')) {
      const response = spawnSync('gh', ['api', 'orgs/airalogy/packages/container/airalogy-bd'], { encoding: 'utf8', timeout: 30000 });
      if (isMissingPackage(response)) return null;
    }
    throw error;
  }
}
function rawManifest(ref) {
  return JSON.parse(command(['docker', 'buildx', 'imagetools', 'inspect', '--raw', ref]));
}
export async function exportImage(image, directory, expected) {
  mkdirSync(directory, { recursive: true });
  const inspected = JSON.parse(command(['docker', 'image', 'inspect', image]))[0];
  const image_id = checkImage(inspected, expected);
  command(['docker', 'image', 'save', '--output', path.join(directory, 'image.tar'), image]);
  command(['gzip', '-n', path.join(directory, 'image.tar')]);
  const record = { ...expected, image_id, archive_sha256: await checksum(path.join(directory, 'image.tar.gz')) };
  writeFileSync(path.join(directory, 'image.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
export async function loadImage(directory, expected) {
  const record = checkRecord(JSON.parse(readFileSync(path.join(directory, 'image.json'))), expected);
  assert.equal(await checksum(path.join(directory, 'image.tar.gz')), record.archive_sha256, 'Image archive integrity mismatch');
  command(['docker', 'image', 'load', '--input', path.join(directory, 'image.tar.gz')]);
  const inspected = JSON.parse(command(['docker', 'image', 'inspect', record.image_id]))[0];
  assert.equal(checkImage(inspected, expected), record.image_id);
  return record;
}
// repo is injectable for isolated local-registry tests; the release CLI always uses GHCR.
export function pushImage(record, repo = repository) {
  checkRecord(record, identity(record.version, record.revision, record.architecture));
  const ref = `${repo}:${record.version}-${record.architecture}`;
  let remote = descriptor(ref, repo === repository);
  if (!remote) {
    command(['docker', 'image', 'tag', record.image_id, ref]);
    command(['docker', 'image', 'push', ref]);
    remote = descriptor(ref);
  }
  assert.ok(remote);
  assert.equal(rawManifest(`${repo}@${remote.digest}`).config?.digest, record.image_id, 'Existing architecture tag differs from tested image; refusing overwrite');
  return { ...record, digest: remote.digest };
}
export function mergeImages(records, expected, repo = repository) {
  for (const record of records) checkRecord(record, expected);
  assert.deepEqual(records.map(r => r.architecture).sort(), ['amd64', 'arm64']);
  for (const record of records) {
    assert.match(record.digest, digestPattern);
    assert.equal(rawManifest(`${repo}@${record.digest}`).config?.digest, record.image_id);
  }
  const ref = `${repo}:${expected.version}`;
  let remote = descriptor(ref);
  if (!remote) {
    command(['docker', 'buildx', 'imagetools', 'create', '--tag', ref,
      '--annotation', `index:org.opencontainers.image.version=${expected.version}`,
      '--annotation', `index:org.opencontainers.image.revision=${expected.revision}`,
      '--annotation', `index:org.opencontainers.image.source=${source}`,
      ...records.map(r => `${repo}@${r.digest}`)]);
    remote = descriptor(ref);
  }
  assert.ok(remote);
  checkIndex(rawManifest(`${repo}@${remote.digest}`), records);
  return { ...expected, repository: repo, tag: ref, digest: remote.digest, image: `${repo}@${remote.digest}`, platforms: records };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, target, output] = process.argv.slice(2);
  const expected = identity(process.env.RELEASE_VERSION, process.env.RELEASE_REVISION, process.env.IMAGE_ARCH);
  if (action === 'export') {
    assert.ok(expected.architecture);
    await exportImage(target, output, expected);
  } else if (action === 'push') {
    assert.ok(expected.architecture);
    const record = pushImage(await loadImage(target, expected));
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, `${expected.architecture}.json`), JSON.stringify(record, null, 2) + '\n');
  } else if (action === 'merge') {
    assert.equal(expected.architecture, undefined);
    const records = ['amd64', 'arm64'].map(arch => JSON.parse(readFileSync(path.join(target, `${arch}.json`))));
    const record = mergeImages(records, expected);
    writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `image=${record.image}\n`, { flag: 'a' });
  } else throw new Error('Use export IMAGE DIRECTORY, push DIRECTORY OUTPUT, or merge DIRECTORY OUTPUT');
}
