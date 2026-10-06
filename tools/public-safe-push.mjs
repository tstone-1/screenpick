// Invoked by .githooks/pre-push: node tools/public-safe-push.mjs <policy.ps1>
// stdin is Git's four-field pre-push ref list. Inspect Git objects, never the
// working copy. Policy values stay in the private shared policy, not this repo.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const limit = 256 * 1024 * 1024;
function git(args, input) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { input, maxBuffer: limit });
  if (result.error || result.status !== 0) {
    throw new Error(`Git object inspection failed (${args[0]}).`);
  }
  return result.stdout;
}

try {
  const policy = readFileSync(process.argv[2], 'utf8');
  // Parse one PowerShell array of single-quoted regex strings into RegExps.
  function parseList(name, flags, label) {
    const block = policy.match(new RegExp(`^\\$${name}\\s*=\\s*@\\(\\s*\\r?\\n([\\s\\S]*?)^\\)`, 'm'));
    if (!block) throw new Error(`Cannot read the ${label} list.`);
    const list = [];
    for (const line of block[1].split(/\r?\n/)) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const entry = line.match(/^\s*'((?:[^']|'')*)'\s*,?\s*(?:#.*)?$/);
      if (!entry) throw new Error('Unsupported policy syntax; inspection refused.');
      try {
        list.push(new RegExp(entry[1].replaceAll("''", "'"), flags));
      } catch {
        throw new Error('Unsupported policy expression; inspection refused.');
      }
    }
    if (!list.length) throw new Error(`The ${label} list is empty.`);
    return list;
  }
  const patterns = parseList('ForbiddenPatterns', 'i', 'public-safe pattern');
  // Commit-message rules are line-anchored, hence the multiline flag.
  const messagePatterns = parseList('ForbiddenCommitMessagePatterns', 'im', 'public-safe commit-message pattern');

  // Decode a blob: UTF-16 with a BOM is text; any other NUL byte means binary.
  function decode(content) {
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
      return content.subarray(2).toString('utf16le');
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
      const swapped = Buffer.from(content.subarray(2));
      if (swapped.length % 2) return null;
      return swapped.swap16().toString('utf16le');
    }
    return content.includes(0) ? null : content.toString('utf8');
  }

  const objects = new Set();
  const zero = /^0+$/;
  for (const line of readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || ![fields[1], fields[3]].every(id => /^[0-9a-f]{40,64}$/.test(id))) {
      throw new Error('Invalid pre-push ref input.');
    }
    const [, local, , remote] = fields;
    if (zero.test(local)) continue; // Deleting a ref publishes no objects.
    const args = ['rev-list', '--objects', '--no-object-names', local];
    if (!zero.test(remote)) {
      // If the remote tip is not available locally, scan the whole new history.
      const known = spawnSync('git', ['--no-replace-objects', 'cat-file', '-e', remote]);
      if (known.error) throw known.error;
      if (known.status === 0) args.push(`^${remote}`);
    }
    for (const id of git(args).toString('ascii').trim().split('\n').filter(Boolean)) objects.add(id);
  }
  if (objects.size) {
    const bytes = git(['cat-file', '--batch'], [...objects].join('\n') + '\n');
    let offset = 0;
    for (const expected of objects) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) throw new Error('Incomplete object header.');
      const [id, type, sizeText] = bytes.subarray(offset, end).toString('ascii').split(' ');
      const size = Number(sizeText);
      if (id !== expected || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid object header.');
      offset = end + 1;
      const content = bytes.subarray(offset, offset + size);
      if (content.length !== size || bytes[offset + size] !== 10) throw new Error('Incomplete object body.');
      offset += size + 1;
      // Trees contain binary names/IDs. Also scan commit/tag messages, which
      // are published content and can leak values even when every file is clean.
      if (type === 'tree') continue;
      const text = decode(content);
      if (text === null) continue;
      let hit = patterns.some(pattern => pattern.test(text));
      if (!hit && (type === 'commit' || type === 'tag')) {
        // Headers (tree, author, tagger...) are not message text.
        const split = text.search(/\r?\n\r?\n/);
        const message = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
        hit = messagePatterns.some(pattern => pattern.test(message));
      }
      if (hit) {
        // Never print the matching content: it may itself be a secret.
        throw new Error(`Forbidden content in pushed ${type} ${id}.`);
      }
    }
  }
  console.log(`[pre-push] OK - checked ${objects.size} newly reachable objects.`);
} catch (error) {
  console.error(`[pre-push] BLOCKED - ${error.message}`);
  process.exitCode = 1;
}
