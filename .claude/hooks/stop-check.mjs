#!/usr/bin/env node
// Claude Code Stop hook: a turn that changed files does not end on a red suite.
//
// Exit 0 lets the turn end; exit 2 sends the reason on stderr back to Claude, which keeps
// working. Plain Node, no dependency, same on Windows and elsewhere.
//
//   - nothing changed in the working tree      -> exit 0 (questions and reviews stay free)
//   - the tree is exactly as it was last green -> exit 0 (no second run of the same state)
//   - otherwise `node --test tests/*.test.mjs` -> exit 0 when green, 2 with the failures when red

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(import.meta.dirname, '..', '..');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {}; // no or malformed input: decide from the tree alone
  }
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

const input = readStdin();
// Claude is already continuing because of this hook: let the harness's own cap decide.
if (input.stop_hook_active) process.exit(0);

const status = git(['status', '--porcelain', '--untracked-files=all']);
if (status === null) process.exit(0); // not a git checkout: nothing to compare against
if (status.trim() === '') process.exit(0);

// Fingerprint of the current state: the diff plus the content of untracked files.
const hash = crypto.createHash('sha256');
hash.update(status);
hash.update(git(['diff', 'HEAD', '--no-color']) ?? '');
for (const line of status.split('\n')) {
  if (!line.startsWith('?? ')) continue;
  const file = path.join(ROOT, line.slice(3).trim());
  try {
    hash.update(fs.readFileSync(file));
  } catch {
    hash.update(`unreadable:${file}`); // a vanished file still changes the fingerprint
  }
}
const fingerprint = hash.digest('hex');
const stamp = path.join(
  os.tmpdir(),
  `sap-adt-stop-check-${crypto.createHash('sha1').update(ROOT).digest('hex').slice(0, 12)}`
);
try {
  if (fs.readFileSync(stamp, 'utf8') === fingerprint) process.exit(0);
} catch {
  // no stamp yet: run the suite
}

const run = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (run.status === 0) {
  try {
    fs.writeFileSync(stamp, fingerprint);
  } catch {
    // the stamp only saves a rerun; failing to write it costs time, not correctness
  }
  process.exit(0);
}

const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
const failures = out
  .split('\n')
  .filter((l) => /^\s*(?:✖ |not ok )/.test(l))
  .slice(0, 40)
  .join('\n');
process.stderr.write(
  'npm test is red, so this turn cannot end yet (Check step of the PDCA in CLAUDE.md).\n' +
    `Failing:\n${failures || '(no test names parsed)'}\n\nLast output:\n${out.slice(-4000)}\n`
);
process.exit(2);
