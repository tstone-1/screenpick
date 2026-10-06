// Synthetic Git history only. Run with node --test tools/public-safe-push.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scanner = resolve('tools/public-safe-push.mjs');
const hookPath = resolve('.githooks/pre-push');
const zero = '0'.repeat(40);
const MARKER = 'SYNTHETIC-FORBIDDEN-MARKER';
const TRAILER = 'Synthetic-Trailer: an example value';
const POLICY = [
  '$ForbiddenPatterns = @(',
  `  '${MARKER}'`,
  ')',
  '$ForbiddenCommitMessagePatterns = @(',
  "  '^[ \\t]*Synthetic-Trailer:.*\\bexample\\b'  # synthetic",
  ')',
  ''
].join('\n');

// Each test gets its own throwaway repository and synthetic policy file.
function fixture(run, policyText = POLICY) {
  const root = mkdtempSync(join(tmpdir(), 'screenpick-push-test-'));
  const policy = join(root, 'policy.ps1');
  writeFileSync(policy, policyText);
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function scan(local, remote = zero, policyPath = policy) {
    return spawnSync(process.execPath, [scanner, policyPath], {
      cwd: root, input: `refs/heads/example ${local} refs/heads/example ${remote}\n`, encoding: 'utf8'
    });
  }
  function commit(content, message = 'Synthetic fixture') {
    writeFileSync(join(root, 'fixture.txt'), content);
    git('add', 'fixture.txt');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  try {
    git('init', '--initial-branch=main');
    run({ root, policy, git, scan, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function blocked(result, secret) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Forbidden content/);
  if (secret) assert.doesNotMatch(result.stderr, new RegExp(secret, 'i'));
}

test('push audit checks history and non-current refs, not working files', () => {
  fixture(({ root, git, scan, commit }) => {
    const clean = commit('clean text');
    assert.equal(scan(clean).status, 0);
    const bad = commit(MARKER);
    writeFileSync(join(root, 'fixture.txt'), 'clean working copy');
    const denied = scan(bad, clean);
    blocked(denied, MARKER);
    // Removal in a later commit cannot erase what the push publishes.
    const removed = commit('marker removed');
    assert.equal(scan(removed, clean).status, 1);
    // Once the bad commit is already remote, a clean update is admissible.
    assert.equal(scan(removed, bad).status, 0);
    git('tag', '-a', 'historical', bad, '-m', 'Synthetic tag');
    git('checkout', '--detach', clean);
    assert.equal(scan(bad).status, 1);
    assert.equal(scan(git('rev-parse', 'historical')).status, 1);
    assert.equal(scan(git('rev-parse', `${bad}:fixture.txt`)).status, 1);
    // Local replacement objects must not hide the real published history.
    git('replace', bad, clean);
    assert.equal(scan(bad).status, 1);
    git('replace', '-d', bad);
    assert.equal(scan(zero, bad).status, 0);
  });
});

test('the real hook forwards Git stdin to the scanner', () => {
  fixture(({ root, policy, git, commit }) => {
    commit('clean text');
    const bad = commit(MARKER);
    const policyDir = join(root, 'agent-memory', 'bin');
    mkdirSync(policyDir, { recursive: true });
    copyFileSync(policy, join(policyDir, 'audit-agent-memory.ps1'));
    mkdirSync(join(root, 'tools'));
    copyFileSync(scanner, join(root, 'tools', 'public-safe-push.mjs'));
    const shell = process.platform === 'win32'
      ? resolve(git('--exec-path'), '../../../bin/sh.exe') : '/bin/sh';
    const hooked = spawnSync(shell, [hookPath], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, USERPROFILE: root, HOME: root, SKIP_AGENT_MEMORY_AUDIT: '' },
      input: `refs/heads/other ${bad} refs/heads/other ${zero}\n`
    });
    assert.equal(hooked.status, 1, hooked.stderr);
    assert.match(hooked.stderr, /Forbidden content/);
  });
});

test('policy problems fail closed without echoing patterns', () => {
  fixture(({ root, policy, scan, commit }) => {
    const clean = commit('clean text');
    assert.equal(scan(clean).status, 0);
    assert.equal(scan(clean, zero, join(root, 'missing.ps1')).status, 1);
    writeFileSync(policy, POLICY.replace(`  '${MARKER}'\n`, ''));
    assert.equal(scan(clean).status, 1);
    writeFileSync(policy, POLICY.replace(MARKER, `[${MARKER}`));
    const invalid = scan(clean);
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stderr, /SYNTHETIC-FORBIDDEN-MARKER/);
  });
});

test('a policy without the commit-message list is refused', () => {
  const firstOnly = `$ForbiddenPatterns = @(\n  '${MARKER}'\n)\n`;
  fixture(({ policy, scan, commit }) => {
    const clean = commit('clean text');
    const missing = scan(clean);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /BLOCKED.*commit-message/);
    // Control: the same repository passes once the list exists.
    writeFileSync(policy, POLICY);
    assert.equal(scan(clean).status, 0);
    // An empty second list is refused as well.
    writeFileSync(policy, `${firstOnly}$ForbiddenCommitMessagePatterns = @(\n)\n`);
    assert.equal(scan(clean).status, 1);
  }, firstOnly);
});

test('a first-list marker in a commit message is blocked', () => {
  fixture(({ scan, commit }) => {
    assert.equal(scan(commit('clean text', 'Synthetic fixture')).status, 0);
    const bad = commit('clean text 2', `Synthetic subject\n\nbody mentions ${MARKER}`);
    blocked(scan(bad), MARKER);
  });
});

test('a first-list marker in an annotated tag message is blocked', () => {
  fixture(({ git, scan, commit }) => {
    const clean = commit('clean text');
    git('tag', '-a', 'good', '-m', 'Synthetic tag');
    assert.equal(scan(git('rev-parse', 'good')).status, 0);
    git('tag', '-a', 'bad', clean, '-m', `Synthetic tag ${MARKER}`);
    blocked(scan(git('rev-parse', 'bad')), MARKER);
  });
});

test('first-list patterns match case-insensitively', () => {
  fixture(({ git, scan, commit }) => {
    commit('clean text');
    const lower = commit(MARKER.toLowerCase());
    blocked(scan(git('rev-parse', `${lower}:fixture.txt`)), MARKER);
  });
});

test('second-list patterns are line-anchored in messages, case-insensitive, and skip blobs', () => {
  fixture(({ git, scan, commit }) => {
    const clean = commit('clean text', 'Synthetic subject\n\nbody line\nSynthetic-Trailer: a plain value');
    assert.equal(scan(clean).status, 0);
    const bad = commit('clean text 2', `Synthetic subject\n\nbody line\n  ${TRAILER.toUpperCase()}\nlast line`);
    blocked(scan(bad, clean), TRAILER);
    // The same text in a file is not a commit message.
    const blob = commit(`line one\n${TRAILER}\n`);
    assert.equal(scan(git('rev-parse', `${blob}:fixture.txt`)).status, 0);
  });
});

test('UTF-16 text blobs are scanned, binary blobs with NUL bytes are not', () => {
  fixture(({ root, git, scan, commit }) => {
    commit('clean text');
    const write = (bytes) => {
      writeFileSync(join(root, 'fixture.txt'), bytes);
      git('add', 'fixture.txt');
      git('commit', '-m', 'Synthetic fixture');
      return git('rev-parse', 'HEAD:fixture.txt');
    };
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`text ${MARKER}`, 'utf16le')]);
    blocked(scan(write(le)), MARKER);
    const be = Buffer.from(le.subarray(2)).swap16();
    blocked(scan(write(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))), MARKER);
    // Control: UTF-16 with a BOM but no marker is fine.
    const harmless = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('harmless text', 'utf16le')]);
    assert.equal(scan(write(harmless)).status, 0);
    // Binary content (NUL, no BOM) stays skipped.
    const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0, 0, 1]), Buffer.from(MARKER), Buffer.from([0, 2])]);
    assert.equal(scan(write(binary)).status, 0);
  });
});
