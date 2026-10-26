import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRelease } from '../.github/scripts/check-release.mjs';

const release = { event: 'release', ref: 'refs/tags/v1.2.3', tag: 'v1.2.3', prerelease: 'false', version: '1.2.3' };
test('npm publication requires an exact stable version tag', () => {
  assert.equal(checkRelease(release), true);
  for (const change of [
    { tag: 'v1.2.4' }, { tag: 'v1.2.3; echo unsafe' }, { ref: 'refs/heads/main' },
    { prerelease: 'true' }, { event: 'push' }, { version: '01.2.3' }, { version: '1.2.3-beta.1' },
  ]) assert.throws(() => checkRelease({ ...release, ...change }));
});
test('manual workflow checks main without granting publication', () => {
  assert.equal(checkRelease({ ...release, event: 'workflow_dispatch', ref: 'refs/heads/main' }), false);
  assert.throws(() => checkRelease({ ...release, event: 'workflow_dispatch' }));
  assert.throws(() => checkRelease({ ...release, event: 'workflow_dispatch', ref: 'refs/heads/feature' }));
});
