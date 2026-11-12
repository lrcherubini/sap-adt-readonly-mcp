// lib/config.mjs: the state directory is never inside a git work tree, and saying so costs one
// check per process, not one per read.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDir, assertOutsideGit } from '../lib/config.mjs';

const saved = process.env.LOCALAPPDATA;
const made = [];
after(() => {
  if (saved === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved;
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-state-'));
  made.push(dir);
  return dir;
}

function gitWorks() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    // No git on this machine: the check it would run has nothing to ask.
    return false;
  }
}

test('the directory is created, and checked once however often it is asked for', () => {
  process.env.LOCALAPPDATA = tempRoot();
  let checks = 0;
  const check = () => {
    checks += 1;
  };
  const dir = stateDir({ check });
  assert.equal(dir, path.join(process.env.LOCALAPPDATA, 'sap-adt'));
  assert.ok(fs.statSync(dir).isDirectory());
  for (let i = 0; i < 50; i++) stateDir({ check });
  assert.equal(checks, 1, 'one check for fifty-one asks');
});

test('another path is checked on its own, and a refusal is not remembered as a pass', () => {
  process.env.LOCALAPPDATA = tempRoot();
  const refuse = () => {
    throw new Error('Refusing to start: inside a work tree');
  };
  assert.throws(() => stateDir({ check: refuse }), /Refusing to start/);
  assert.throws(() => stateDir({ check: refuse }), /Refusing to start/, 'still refused the second time');
});

test('a directory inside a git work tree is refused', { skip: !gitWorks() && 'git is not installed' }, () => {
  const repo = tempRoot();
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  const inside = path.join(repo, 'state');
  fs.mkdirSync(inside);
  assert.throws(() => assertOutsideGit(inside), /Refusing to start: state directory .* is inside the git work tree/);
  assert.doesNotThrow(() => assertOutsideGit(tempRoot()));
});
