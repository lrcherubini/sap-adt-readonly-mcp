// lib/password-file.mjs and the logon of lib/session.mjs that uses it: a server without a
// terminal reads the password from one file, and never sends twice a password the system refused.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPasswordFile, stillRefused, PasswordFileError } from '../lib/password-file.mjs';
import { connect } from '../lib/session.mjs';
import { validateSetting } from '../lib/environment.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-pw-'));
  made.push(dir);
  return dir;
}
function fileWith(content, dir = tempDir()) {
  const file = path.join(dir, 'sap-password');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

test('the password is the content of the file, without the one line ending that closes it', () => {
  assert.equal(readPasswordFile(fileWith('Init1234!\n')).password, 'Init1234!');
  assert.equal(readPasswordFile(fileWith('Init1234!\r\n')).password, 'Init1234!');
  assert.equal(readPasswordFile(fileWith('  two words \n')).password, '  two words ', 'spaces are part of a password');
  assert.equal(readPasswordFile(fileWith('﻿Init1234!\r\n')).password, 'Init1234!', 'the byte-order mark Windows PowerShell writes is not part of it');
  const { changedAt } = readPasswordFile(fileWith('x'));
  assert.match(changedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('a file that is not the service s own secret is refused, and the reason names it', () => {
  assert.throws(() => readPasswordFile('sap-password'), /is not an absolute path/);
  assert.throws(() => readPasswordFile(path.join(tempDir(), 'missing')), /cannot be read \(ENOENT\)/);
  assert.throws(() => readPasswordFile(tempDir()), /is not a regular file/);
  assert.throws(() => readPasswordFile(fileWith('\n')), /is empty/);
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'secrets'));
  assert.throws(() => readPasswordFile(fileWith('x', path.join(repo, 'secrets'))), /inside the git work tree/);
  assert.ok(new PasswordFileError('x') instanceof Error);
});

test('on POSIX a file every user can read is refused; group access is the platform s to give', () => {
  const file = fileWith('x');
  const stat = (mode) => () => ({ isFile: () => true, mode, mtimeMs: 0 });
  assert.throws(() => readPasswordFile(file, { platform: 'linux', stat: stat(0o100644) }), /readable by every user of this machine \(mode 644\)/);
  assert.equal(readPasswordFile(file, { platform: 'linux', stat: stat(0o100440) }).password, 'x');
  assert.equal(readPasswordFile(file, { platform: 'win32', stat: stat(0o100666) }).password, 'x', 'Windows has no mode bits to judge');
});

test('a refused password is held against the file until the file changes', () => {
  const refusedAt = '2026-11-12T10:00:00.000Z';
  assert.equal(stillRefused({ count: 1, lastRefused: refusedAt }, '2026-11-12T09:00:00.000Z'), true, 'the file is older than the refusal');
  assert.equal(stillRefused({ count: 1, lastRefused: refusedAt }, refusedAt), true);
  assert.equal(stillRefused({ count: 1, lastRefused: refusedAt }, '2026-11-12T10:00:01.000Z'), false, 'the file was replaced after it');
  assert.equal(stillRefused({ count: 0, lastRefused: null }, '2026-11-12T09:00:00.000Z'), false);
  assert.equal(stillRefused(null, '2026-11-12T09:00:00.000Z'), false);
});

const CFG = { host: 'vhdemohost.example', port: 44300, client: '001', user: 'DEVUSER1' };
const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};
const confirm = async () => ({ message: 'system confirmed' });

test('with a password file the logon asks nobody, and the session says where the password came from', async () => {
  const sent = [];
  const createHttp = (cfg, opts) => {
    sent.push({ user: opts.user, password: opts.password });
    return { login: async () => {}, httpClient: { request: async () => ({}) } };
  };
  const cfg = { ...CFG, passwordFile: fileWith('Init1234!\n') };
  const session = await quiet(() => connect(cfg, { confirm, createHttp, refused: () => ({ count: 0, since: null, lastRefused: null }) }));
  assert.deepEqual(sent, [{ user: 'DEVUSER1', password: 'Init1234!' }]);
  assert.equal(session.credential, 'file');
  assert.equal(session.user, 'DEVUSER1');
});

test('a password the system refused is not sent again while the file is unchanged', async () => {
  const file = fileWith('wrong\n');
  const created = [];
  const createHttp = () => {
    created.push(1);
    return { login: async () => {}, httpClient: { request: async () => ({}) } };
  };
  const after = new Date(fs.statSync(file).mtimeMs + 60_000).toISOString();
  const refused = () => ({ count: 1, since: null, lastRefused: after });
  await assert.rejects(
    () => quiet(() => connect({ ...CFG, passwordFile: file }, { confirm, createHttp, refused })),
    /NOT logging on: the SAP system refused the password of DEVUSER1 .* has not changed since/
  );
  assert.deepEqual(created, [], 'no client was built: nothing reached the system');
  // The operator replaced the file after the refusal: one attempt is owed again.
  const before = new Date(fs.statSync(file).mtimeMs - 60_000).toISOString();
  await quiet(() => connect({ ...CFG, passwordFile: file }, { confirm, createHttp, refused: () => ({ count: 1, since: null, lastRefused: before }) }));
  assert.deepEqual(created, [1]);
});

test('a password file without a configured user is refused before anything is read', async () => {
  await assert.rejects(() => quiet(() => connect({ ...CFG, user: undefined, passwordFile: fileWith('x') }, { confirm })), /no SAP user/);
});

test('the setting takes an absolute path only', () => {
  const abs = path.join(tempDir(), 'sap-password');
  assert.equal(validateSetting('passwordFile', abs), abs);
  assert.throws(() => validateSetting('passwordFile', 'secrets/sap-password'), /not an absolute path/);
});
