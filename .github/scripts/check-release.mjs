import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

// Inputs come from GitHub event metadata and must never be evaluated as shell code.
export function checkRelease({ event, ref, tag, prerelease, version }) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (event === 'workflow_dispatch') {
    assert.equal(ref, 'refs/heads/main', 'Manual runs only verify main; they never publish');
    return false;
  }
  assert.equal(event, 'release');
  assert.equal(prerelease, 'false', 'Only stable releases can publish to latest');
  assert.equal(tag, `v${version}`, 'Release tag must match package.json');
  assert.equal(ref, `refs/tags/${tag}`, 'Release must run from its exact tag');
  return true;
}

if (process.env.GITHUB_ACTIONS === 'true' && process.argv[1]?.endsWith('/check-release.mjs')) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const publish = checkRelease({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, tag: process.env.RELEASE_TAG, prerelease: process.env.RELEASE_PRERELEASE, version });
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), process.env.GITHUB_SHA);
  git('merge-base', '--is-ancestor', 'HEAD', 'origin/main');
  if (publish) assert.equal(git('rev-parse', `refs/tags/v${version}^{commit}`), process.env.GITHUB_SHA);
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(publish ? `Verified stable release source: v${version}` : `Verification only: ${version}. No npm publication.`);
}
