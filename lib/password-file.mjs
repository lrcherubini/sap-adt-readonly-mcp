// The SAP password of a server nobody sits in front of: read from ONE file the operator names
// (docs/security.md, "A password file for a server without a terminal").
//
// A service has no terminal to type into. What it has is a file the platform puts in place for
// it -- a mounted secret, a credential of the service manager, a file only the service account
// can read. This module reads that file and refuses the ones that are not that:
//
//   - a relative path, which would follow the working directory;
//   - anything that is not a regular file, or is empty;
//   - a file inside a git work tree, one `git add` away from history;
//   - on POSIX, a file every user of the machine can read.
//
// And it holds the rule that protects the account across restarts. A typed password is tried
// once per start because a person is there to read the refusal. A file is tried by a supervisor
// that restarts the process for ever, and each restart would be one more failed logon. So a
// password the system refused is NOT sent again until the file changes: `stillRefused` compares
// the file's modification time with the last refusal the audit trail holds.

import fs from 'node:fs';
import path from 'node:path';
import { workTreeAbove } from './config.mjs';

export class PasswordFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PasswordFileError';
  }
}

/**
 * Read the password. Returns `{password, changedAt}` (the file's modification time, ISO), or
 * throws PasswordFileError naming what is wrong with the file. Never logs or returns the path's
 * content anywhere else.
 */
export function readPasswordFile(file, { platform = process.platform, stat = fs.statSync, read = fs.readFileSync } = {}) {
  const name = String(file ?? '').trim();
  if (!path.isAbsolute(name)) throw new PasswordFileError(`passwordFile: '${name}' is not an absolute path.`);
  let info;
  try {
    info = stat(name);
  } catch (e) {
    throw new PasswordFileError(`passwordFile: ${name} cannot be read (${e?.code ?? e?.message ?? e}).`);
  }
  if (!info.isFile()) throw new PasswordFileError(`passwordFile: ${name} is not a regular file.`);
  const tree = workTreeAbove(path.dirname(name));
  if (tree) throw new PasswordFileError(`passwordFile: ${name} is inside the git work tree ${tree}. A password never sits in a repository.`);
  // Windows has no mode bits worth reading: there the access list of the file is the operator's.
  if (platform !== 'win32' && (info.mode & 0o007) !== 0) {
    throw new PasswordFileError(`passwordFile: ${name} is readable by every user of this machine (mode ${(info.mode & 0o777).toString(8)}). Restrict it to the service account.`);
  }
  // One line ending is how an editor or `echo` closes the file; anything else is the password.
  const password = String(read(name, 'utf8')).replace(/\r?\n$/, '');
  if (!password) throw new PasswordFileError(`passwordFile: ${name} is empty. An empty password still counts as a failed logon, so it is not sent.`);
  return { password, changedAt: new Date(info.mtimeMs).toISOString() };
}

/**
 * Was this file's password already refused? True when the trail holds a refusal of this user
 * since its last successful start that is no older than the file: the file has not changed
 * since the system said no to it.
 */
export function stillRefused(prior, changedAt) {
  if (!prior?.count || !prior.lastRefused) return false;
  return Date.parse(prior.lastRefused) >= Date.parse(changedAt);
}
