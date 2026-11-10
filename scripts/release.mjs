#!/usr/bin/env node
// npm run release [-- --apply]
//
// Reads the commits since the latest v* tag, chooses the next SemVer version from their
// Conventional Commits types (lib/release.mjs) and prints the CHANGELOG entry.
//
// IT WRITES NOTHING WITHOUT --apply. With it, it sets the version in package.json and
// package-lock.json and puts the entry at the top of CHANGELOG.md. It never commits, tags or
// pushes: it prints those commands, and the owner runs them.
//
// Runs in the current directory, which npm sets to the package root.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify, nextVersion, renderEntry, prependEntry, setVersion } from '../lib/release.mjs';

const apply = process.argv.includes('--apply');
const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const read = (name) => {
  const file = path.join(root, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

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
if (tag !== `v${current}`) {
  console.log(`note: the latest tag is ${tag}, package.json says ${current}; bumping ${current}.`);
}

const RS = '\x1e';
const US = '\x1f';
const commits = git('log', `${tag}..HEAD`, `--format=%H${US}%B${RS}`)
  .split(RS)
  .map((r) => r.replace(/^\s+/, ''))
  .filter(Boolean)
  .map((r) => {
    const [hash, message] = r.split(US);
    return { hash, message };
  });

const groups = classify(commits);
const { bump, version } = nextVersion(current, groups);
console.log(`${commits.length} commit(s) since ${tag}, ${groups.skipped.length} not conventional`);
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

fs.writeFileSync(path.join(root, 'package.json'), setVersion(pkgText, version));
const lock = read('package-lock.json');
if (lock !== null) fs.writeFileSync(path.join(root, 'package-lock.json'), setVersion(lock, version));
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), prependEntry(read('CHANGELOG.md'), entry));
console.log('Written. Review, then:');
console.log('  git add package.json package-lock.json CHANGELOG.md');
console.log(`  git commit -m "chore(release): v${version}"`);
console.log(`  git tag v${version}`);
