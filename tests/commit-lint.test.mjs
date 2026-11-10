// Conventional Commits: the linter the commit-msg hook runs, and the hook itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lintMessage, parseMessage, cleanMessage, TYPES, MAX_HEADER } from '../lib/commit-lint.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

test('every listed type, with and without a scope, passes', () => {
  for (const t of TYPES) {
    assert.deepEqual(lintMessage(`${t}: say what changed`), [], t);
    assert.deepEqual(lintMessage(`${t}(guard): say what changed`), [], t);
  }
});

test('the repository message shape passes: header, body, co-author trailer', () => {
  const msg = `fix(guard): refuse an unlisted member\n\nWhy it matters, in prose.\nMore.\n\n${TRAILER}\n`;
  assert.deepEqual(lintMessage(msg), []);
  const p = parseMessage(msg);
  assert.equal(p.type, 'fix');
  assert.equal(p.scope, 'guard');
  assert.equal(p.breaking, false);
  assert.deepEqual(p.body, ['Why it matters, in prose.', 'More.']);
  assert.deepEqual(p.footers, [{ token: 'Co-Authored-By', value: TRAILER.slice(16) }]);
});

test('a breaking change is read from the bang and from the footer', () => {
  assert.equal(parseMessage('feat(tools)!: rename adt_search').breaking, true);
  assert.equal(parseMessage('feat!: drop a tool').breaking, true);
  const footer = 'feat: change a result\n\nBody.\n\nBREAKING CHANGE: the field moved';
  assert.equal(parseMessage(footer).breaking, true);
  assert.equal(parseMessage('feat: add\n\nBREAKING CHANGE is only prose here').breaking, false);
});

test('a body paragraph that is not all footers stays body', () => {
  const p = parseMessage('docs: x\n\nFirst.\n\nPlain line\nKey: value');
  assert.deepEqual(p.footers, []);
  assert.deepEqual(p.body, ['First.', '', 'Plain line', 'Key: value']);
});

test('the header problems are named', () => {
  const one = (m) => lintMessage(m).join(' | ');
  assert.match(one('Read the stored switch state'), /is not "type\(scope\)!: subject"/);
  assert.match(one('feature: add a tool'), /unknown type "feature"/);
  assert.match(one('fix:no space'), /is not "type/);
  assert.match(one('fix: '), /subject after the colon is empty/);
  assert.match(one('fix:  two spaces'), /only one space/);
  assert.match(one('fix: ends with a period.'), /ends with a period/);
  assert.match(one('Fix: capital type'), /is not "type/);
  assert.match(one(`fix: ${'x'.repeat(MAX_HEADER)}`), /the limit is 100/);
  assert.match(one('fix: header\nno blank line'), /blank line must follow/);
  assert.deepEqual(lintMessage(`fix: ${'x'.repeat(MAX_HEADER - 5)}`), []);
});

test('an empty message, or one of comments only, is rejected', () => {
  assert.deepEqual(lintMessage(''), ['the message is empty']);
  assert.deepEqual(lintMessage('# Please enter the commit message\n#\n'), ['the message is empty']);
});

test('git comments, the verbose diff and CRLF are ignored', () => {
  const text = '\r\nfix: x\r\n\r\nBody.  \r\n# a comment\r\n# ------------------------ >8 ' +
    '------------------------\r\ndiff --git a b\r\n';
  assert.deepEqual(cleanMessage(text), ['fix: x', '', 'Body.']);
  assert.deepEqual(lintMessage(text), []);
});

test('messages git writes itself are not linted', () => {
  for (const m of ['Merge branch main', 'Revert "fix: x"', 'fixup! fix: x', 'squash! fix: x']) {
    assert.deepEqual(lintMessage(m), [], m);
  }
});

test('the script exits 0 on a good message, 1 on a bad one, 2 without a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitlint-'));
  const run = (args) => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'lint-commit.mjs'), ...args], {
        stdio: 'pipe',
      });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  const good = path.join(dir, 'good');
  const bad = path.join(dir, 'bad');
  fs.writeFileSync(good, 'feat(tooling): lint commits\n');
  fs.writeFileSync(bad, 'Lint commits\n');
  assert.equal(run([good]), 0);
  assert.equal(run([bad]), 1);
  assert.equal(run([]), 2);
  assert.equal(run([path.join(dir, 'missing')]), 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the commit-msg hook runs the linter and is pinned to LF', () => {
  const hook = fs.readFileSync(path.join(ROOT, '.githooks', 'commit-msg'), 'utf8');
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.match(hook, /scripts\/lint-commit\.mjs" "\$1"/);
  assert.ok(!hook.includes('\r'), 'a CRLF hook fails on its shebang');
  const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\.githooks\/\* text eol=lf$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['lint:commit'], 'node scripts/lint-commit.mjs');
});
