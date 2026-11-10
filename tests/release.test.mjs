// SemVer from Conventional Commits: the bump, the CHANGELOG entry, the version files, and the
// release script driven against a throwaway git repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classify,
  nextVersion,
  parseVersion,
  renderEntry,
  prependEntry,
  setVersion,
  releaseBase,
  CHANGELOG_HEAD,
} from '../lib/release.mjs';

test('the base is the tag, or the release commit of a version not tagged yet', () => {
  const log = [
    { hash: 'c3', subject: 'feat: later' },
    { hash: 'c2', subject: 'chore(release): v0.2.0' },
    { hash: 'c1', subject: 'feat: in 0.2.0' },
  ];
  assert.deepEqual(releaseBase('v0.2.0', '0.2.0', log), { base: 'v0.2.0', by: 'tag' });
  assert.deepEqual(releaseBase('v0.1.0', '0.2.0', log), { base: 'c2', by: 'release commit' });
  assert.deepEqual(releaseBase('v0.1.0', '0.3.0', log), { base: 'v0.1.0', by: 'tag' }, 'no release commit: the tag');
});

const ROOT = path.join(import.meta.dirname, '..');
let n = 0;
const c = (message) => ({ hash: `${String(++n).padStart(7, '0')}${'f'.repeat(33)}`, message });
const bump = (current, ...messages) => nextVersion(current, classify(messages.map(c)));

test('a version is MAJOR.MINOR.PATCH and nothing else', () => {
  assert.deepEqual(parseVersion('1.20.3'), [1, 20, 3]);
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-rc.1', '']) assert.throws(() => parseVersion(bad));
});

test('the bump: breaking is major, feat minor, fix/perf/revert patch', () => {
  assert.deepEqual(bump('1.4.2', 'fix: a', 'feat!: b'), { bump: 'major', version: '2.0.0' });
  assert.deepEqual(bump('1.4.2', 'fix: a\n\nBREAKING CHANGE: moved'), {
    bump: 'major',
    version: '2.0.0',
  });
  assert.deepEqual(bump('1.4.2', 'fix: a', 'feat(tools): b'), { bump: 'minor', version: '1.5.0' });
  assert.deepEqual(bump('1.4.2', 'fix: a'), { bump: 'patch', version: '1.4.3' });
  assert.deepEqual(bump('1.4.2', 'perf: a'), { bump: 'patch', version: '1.4.3' });
  assert.deepEqual(bump('1.4.2', 'revert: a'), { bump: 'patch', version: '1.4.3' });
});

test('while the major is 0, a breaking change is minor', () => {
  assert.deepEqual(bump('0.1.0', 'feat!: rename a tool'), { bump: 'minor', version: '0.2.0' });
  assert.deepEqual(bump('0.1.7', 'fix: a'), { bump: 'patch', version: '0.1.8' });
});

test('docs, tests, chores and old-style commits release nothing on their own', () => {
  const none = { bump: null, version: null };
  assert.deepEqual(bump('1.0.0', 'docs: a', 'test: b', 'chore(release): v1.0.0'), none);
  assert.deepEqual(bump('1.0.0', 'Read the stored switch state', 'Merge branch x'), none);
  assert.deepEqual(bump('1.0.0'), none);
});

test('classify sorts by section and keeps the non-conventional ones apart', () => {
  const g = classify(['feat(a): x', 'docs: y', 'Plain sentence', 'fix!: z', 'Merge x'].map(c));
  assert.deepEqual(g.feat.map((i) => i.subject), ['x']);
  assert.deepEqual(g.other.map((i) => i.type), ['docs']);
  assert.deepEqual(g.breaking.map((i) => [i.type, i.subject]), [['fix', 'z']]);
  assert.deepEqual(g.skipped.map((i) => i.subject), ['Plain sentence', 'Merge x']);
  assert.equal(g.fix.length, 0);
});

test('the entry lists each section once, with scope, type where needed, and short hash', () => {
  const g = classify(
    [
      { hash: 'a'.repeat(40), message: 'feat(tools): add a tool' },
      { hash: 'b'.repeat(40), message: 'fix: a bug' },
      { hash: 'c'.repeat(40), message: 'docs(readme): a page' },
      { hash: 'd'.repeat(40), message: 'refactor!: rename' },
    ]
  );
  assert.equal(
    renderEntry('0.2.0', '2026-01-02', g),
    [
      '## [0.2.0] - 2026-01-02',
      '',
      '### Breaking changes',
      '',
      '- refactor: rename (ddddddd)',
      '',
      '### Features',
      '',
      '- **tools**: add a tool (aaaaaaa)',
      '',
      '### Fixes',
      '',
      '- a bug (bbbbbbb)',
      '',
      '### Other changes',
      '',
      '- docs: **readme**: a page (ccccccc)',
      '',
    ].join('\n')
  );
});

test('a new CHANGELOG gets its head; the next entry goes above the previous one', () => {
  const first = prependEntry(null, '## [0.2.0] - d1\n\n- a\n');
  assert.equal(first, `${CHANGELOG_HEAD}\n## [0.2.0] - d1\n\n- a\n`);
  assert.equal(prependEntry('', '## x\n'), `${CHANGELOG_HEAD}\n## x\n`);
  const second = prependEntry(first, '## [0.3.0] - d2\n\n- b\n');
  assert.equal(second, `${CHANGELOG_HEAD}\n## [0.3.0] - d2\n\n- b\n\n## [0.2.0] - d1\n\n- a\n`);
  assert.equal(prependEntry('# Changelog\n', '## x\n'), '# Changelog\n\n## x\n');
});

test('line endings are kept as found, CRLF or LF', () => {
  const crlf = prependEntry('# Changelog\r\n\r\n## [0.1.0] - d\r\n', '## [0.2.0] - e\n');
  assert.equal(crlf, '# Changelog\r\n\r\n## [0.2.0] - e\r\n\r\n## [0.1.0] - d\r\n');
  const json = setVersion('{\r\n  "version": "0.1.0"\r\n}\r\n', '0.2.0');
  assert.equal(json, '{\r\n  "version": "0.2.0"\r\n}\r\n');
});

test('setVersion sets both lockfile fields and rejects a bad version', () => {
  const lock = JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } });
  const out = JSON.parse(setVersion(lock, '0.2.0'));
  assert.equal(out.version, '0.2.0');
  assert.equal(out.packages[''].version, '0.2.0');
  assert.throws(() => setVersion(lock, 'v0.2.0'));
});

test('the repository version is SemVer, the lockfile agrees, and npm formatting round-trips', () => {
  for (const name of ['package.json', 'package-lock.json']) {
    const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    const { version } = JSON.parse(text);
    parseVersion(version);
    assert.equal(setVersion(text, version), text, `${name} would be reformatted by a release`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.scripts.release, 'node scripts/release.mjs');
});

test('the release script against a scratch repository: no tag, dry run, apply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Dev User', '-c', 'user.email=dev@example.com',
      '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  const run = (...args) => {
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'release.mjs'), ...args],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, out };
    } catch (e) {
      return { status: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  const commit = (msg) => git('commit', '-q', '--allow-empty', '-m', msg);
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "demo",\n  "version": "0.1.0"\n}\n');
    git('add', 'package.json');
    commit('Initial commit, before the convention');

    const noTag = run();
    assert.equal(noTag.status, 2);
    assert.match(noTag.out, /Tag the baseline first/);

    git('tag', 'v0.1.0');
    assert.match(run().out, /Nothing to release/);

    commit('docs: a page');
    commit('fix(guard): a bug');
    commit('feat(tools): a tool');
    commit('Old-style sentence');
    const dry = run();
    assert.equal(dry.status, 0);
    assert.match(dry.out, /4 commit\(s\) since v0\.1\.0, 1 not conventional/);
    assert.match(dry.out, /0\.1\.0 -> 0\.2\.0 \(minor\)/);
    assert.match(dry.out, /Dry run/);
    assert.ok(!fs.existsSync(path.join(dir, 'CHANGELOG.md')), 'a dry run writes nothing');

    const applied = run('--apply');
    assert.equal(applied.status, 0);
    assert.match(applied.out, /git tag v0\.2\.0/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.2.0');
    const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    assert.ok(log.startsWith(CHANGELOG_HEAD));
    assert.match(log, /### Features\n\n- \*\*tools\*\*: a tool/);
    assert.match(log, /### Fixes\n\n- \*\*guard\*\*: a bug/);
    assert.match(log, /- docs: a page/);
    assert.ok(!log.includes('Old-style'));
    assert.equal(git('tag').trim(), 'v0.1.0', 'the script never tags');

    // Released and committed, not tagged: the next release counts from the release commit only.
    git('add', 'package.json', 'CHANGELOG.md');
    commit('chore(release): v0.2.0');
    commit('fix(tools): after the release');
    const next = run();
    assert.equal(next.status, 0);
    assert.match(next.out, /from chore\(release\): v0\.2\.0 \([0-9a-f]{7}, not tagged yet\)/);
    assert.match(next.out, /1 commit\(s\) since chore\(release\): v0\.2\.0/);
    assert.match(next.out, /0\.2\.0 -> 0\.2\.1 \(patch\)/);
    assert.doesNotMatch(next.out, /a tool/, 'a commit of 0.2.0 is not released again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
