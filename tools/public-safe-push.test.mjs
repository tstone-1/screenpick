// Synthetic Git history only. Run with node --test tools/public-safe-push.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('push audit checks history and non-current refs, not working files', () => {
  const root = mkdtempSync(join(tmpdir(), 'screenpick-push-test-'));
  const scanner = resolve('tools/public-safe-push.mjs');
  const policy = join(root, 'policy.ps1');
  writeFileSync(policy, "$ForbiddenPatterns = @(\n 'SYNTHETIC_PRIVATE_MARKER'\n)\n");
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const zero = '0'.repeat(40);
  function scan(local, remote = zero, policyPath = policy) {
    return spawnSync(process.execPath, [scanner, policyPath], {
      cwd: root, input: `refs/heads/example ${local} refs/heads/example ${remote}\n`, encoding: 'utf8'
    });
  }
  function commit(text) {
    writeFileSync(join(root, 'fixture.txt'), text);
    git('add', 'fixture.txt');
    git('commit', '-m', 'Synthetic fixture');
    return git('rev-parse', 'HEAD');
  }
  try {
    git('init', '--initial-branch=main');
    const clean = commit('clean text');
    assert.equal(scan(clean).status, 0);
    const bad = commit('SYNTHETIC_PRIVATE_MARKER');
    writeFileSync(join(root, 'fixture.txt'), 'clean working copy');
    const denied = scan(bad, clean);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /Forbidden content/);
    assert.doesNotMatch(denied.stderr, /SYNTHETIC_PRIVATE_MARKER/);
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
    // The real hook must forward Git's stdin to the scanner, including when
    // the checkout itself is clean and the pushed ref is not checked out.
    const policyDir = join(root, 'agent-memory', 'bin');
    mkdirSync(policyDir, { recursive: true });
    copyFileSync(policy, join(policyDir, 'audit-agent-memory.ps1'));
    mkdirSync(join(root, 'tools'));
    copyFileSync(scanner, join(root, 'tools', 'public-safe-push.mjs'));
    const shell = process.platform === 'win32'
      ? resolve(git('--exec-path'), '../../../bin/sh.exe') : '/bin/sh';
    const hooked = spawnSync(shell, [resolve('.githooks/pre-push')], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, USERPROFILE: root, HOME: root, SKIP_AGENT_MEMORY_AUDIT: '' },
      input: `refs/heads/other ${bad} refs/heads/other ${zero}\n`
    });
    assert.equal(hooked.status, 1, hooked.stderr);
    assert.match(hooked.stderr, /Forbidden content/);
    assert.equal(scan(zero, bad).status, 0);
    assert.equal(scan(clean, zero, join(root, 'missing.ps1')).status, 1);
    writeFileSync(policy, '$ForbiddenPatterns = @(\n)\n');
    assert.equal(scan(clean).status, 1);
    writeFileSync(policy, "$ForbiddenPatterns = @(\n '[SYNTHETIC_PRIVATE_MARKER'\n)\n");
    const invalid = scan(clean);
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stderr, /SYNTHETIC_PRIVATE_MARKER/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
