#!/usr/bin/env node
// npm run release [-- --apply | --tag]
//
// Reads the commits since the latest v* tag, chooses the next SemVer version from their
// Conventional Commits types (lib/release.mjs) and prints the CHANGELOG entry.
//
// IT WRITES NOTHING WITHOUT --apply. With it, it sets the version in package.json and
// package-lock.json, puts the entry at the top of CHANGELOG.md and commits those three files (by
// name, nothing else) as `chore(release): vX.Y.Z`. It refuses, before writing anything, when
// something is already staged, when one of the three files has changes of its own, or when the
// tag exists. The commit goes through the repository's hooks like any other.
//
// It does not tag that commit: main takes it through a pull request merged by rebase, which gives
// it a new id, and a protected tag cannot be moved afterwards. Once merged, `--tag` on main tags
// HEAD `vX.Y.Z`, and only when HEAD is the release commit of the version in package.json.
// It never pushes.
//
// Runs in the current directory, which npm sets to the package root.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify, nextVersion, renderEntry, prependEntry, setVersion, releaseBase } from '../lib/release.mjs';

const apply = process.argv.includes('--apply');
const tagMode = process.argv.includes('--tag');
const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const read = (name) => {
  const file = path.join(root, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

if (tagMode) {
  const version = JSON.parse(read('package.json')).version;
  const want = `chore(release): v${version}`;
  const subject = git('log', '-1', '--format=%s').trim();
  if (subject !== want) {
    console.error(`tag refused: HEAD is "${subject}", not "${want}". Check out the merged release commit.`);
    process.exit(2);
  }
  if (git('tag', '--list', `v${version}`).trim()) {
    console.error(`tag refused: v${version} already exists.`);
    process.exit(2);
  }
  git('tag', `v${version}`);
  const head = git('rev-parse', '--short', 'HEAD').trim();
  console.log(`Tagged ${head} v${version}. Not pushed. To publish: git push origin v${version}`);
  process.exit(0);
}

let tag;
try {
  tag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*').trim();
} catch (e) {
  console.error(`no v* tag to release from (${e.stderr?.toString().trim() || e.message}).`);
  console.error('Tag the baseline first, on the commit that carries the current version:');
  console.error('  git tag v<version in package.json> <commit>');
  process.exit(2);
}

const pkgText = read('package.json');
const current = JSON.parse(pkgText).version;
const RS = '\x1e';
const US = '\x1f';
// An untagged release: count from its release commit, or its commits would be released twice.
const since = git('log', `${tag}..HEAD`, `--format=%H${US}%s`)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [hash, subject] = l.split(US);
    return { hash, subject };
  });
const { base, by } = releaseBase(tag, current, since);
const from = by === 'tag' ? tag : `chore(release): v${current} (${base.slice(0, 7)}, not tagged yet)`;
if (tag !== `v${current}`) {
  console.log(`note: the latest tag is ${tag}, package.json says ${current}; bumping ${current} from ${from}.`);
}
const commits = git('log', `${base}..HEAD`, `--format=%H${US}%B${RS}`)
  .split(RS)
  .map((r) => r.replace(/^\s+/, ''))
  .filter(Boolean)
  .map((r) => {
    const [hash, message] = r.split(US);
    return { hash, message };
  });

const groups = classify(commits);
const { bump, version } = nextVersion(current, groups);
console.log(`${commits.length} commit(s) since ${from}, ${groups.skipped.length} not conventional`);
for (const s of groups.skipped) console.log(`   skipped ${s.hash.slice(0, 7)} ${s.subject}`);
if (!version) {
  console.log('\nNothing to release: no breaking change, feat, fix, perf or revert since the tag.');
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const entry = renderEntry(version, date, groups);
console.log(`\n${current} -> ${version} (${bump})\n\n${entry}`);

if (!apply) {
  console.log('Dry run. Add --apply to write package.json, package-lock.json and CHANGELOG.md.');
  process.exit(0);
}

// Refuse before anything is written: a release commit carries the three files and nothing else.
const lock = read('package-lock.json');
const files = ['package.json', ...(lock !== null ? ['package-lock.json'] : []), 'CHANGELOG.md'];
const refuse = (why) => {
  console.error(`release refused: ${why}. Nothing was written.`);
  process.exit(2);
};
const staged = git('diff', '--cached', '--name-only').trim();
if (staged) refuse(`something is already staged (${staged.split('\n').join(', ')}); commit or unstage it first`);
const dirty = git('status', '--porcelain', '--', ...files).trim();
if (dirty) refuse(`${dirty.split('\n').map((l) => l.slice(3)).join(', ')} has changes of its own; commit them first`);
if (git('tag', '--list', `v${version}`).trim()) refuse(`tag v${version} already exists`);

fs.writeFileSync(path.join(root, 'package.json'), setVersion(pkgText, version));
if (lock !== null) fs.writeFileSync(path.join(root, 'package-lock.json'), setVersion(lock, version));
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), prependEntry(read('CHANGELOG.md'), entry));
git('add', '--', ...files);
git('commit', '-q', '-m', `chore(release): v${version}`, '--', ...files);
const head = git('rev-parse', '--short', 'HEAD').trim();
console.log(`Committed ${head} chore(release): v${version} (${files.join(', ')}). Not tagged, not pushed.`);
console.log('Push the branch, merge its pull request by rebase, then on the updated main:');
console.log('  npm run release -- --tag');
