// Configuration and state live OUTSIDE any git work tree, always.
//
// %LOCALAPPDATA%\sap-adt\
//   sap-adt.db    the environment store (lib/store.mjs): host, client, user, the installation's
//                 tables, variants, paths -- no secret. Written only by
//                 `npm run config`.
//   token         loopback bearer for the MCP endpoint (not a SAP credential)
//
// The SAP password is never stored: it is typed once per server start and kept in memory
// only. See docs/security.md.
//
// Nothing about a particular landscape is in this file: every value an installation chooses
// comes from the store (validated by lib/environment.mjs). No other file on the machine is read --
// not an IDE project, not a sibling checkout.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readEnvironment,
  installEnvironment,
  resolvePaths,
  settingOf,
  stateDirPath,
  storePath,
  ConfigError,
} from './environment.mjs';

/** Refuse to run if state would land inside a repository -- three secrets have leaked that way. */
export function assertOutsideGit(dir) {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (top) {
      throw new Error(
        `Refusing to start: state directory ${dir} is inside the git work tree ${top}. ` +
        `Credentials and cache must never sit in a repository.`
      );
    }
  } catch (e) {
    if (e.message?.startsWith('Refusing to start')) throw e;
    // git absent or "not a repository" -- which is exactly what we want.
  }
}

/**
 * A UTC timestamp that names one measurement run: `20261109T171502Z`. No colon, so it is a valid
 * file name on Windows; second precision, so two runs on one day never share a name.
 */
export const measurementStamp = (now = new Date()) =>
  now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

const MEASUREMENT_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

/**
 * Create the folder for ONE measurement run, `<root>/<name>-<stamp>`, and return its path.
 *
 * Every probe and measurement script writes through this, because a run that reuses a folder
 * overwrites the transcript of the run before it: two probe runs on one day once shared
 * `<name>-<date>` and the second destroyed the first one's summary. The folder is created
 * WITHOUT `recursive`, so an existing one is never reused: a second run in the same second gets
 * `-2`, `-3`, ... and after nine tries this throws rather than overwrite.
 */
/**
 * Where a script's `--out` transcript goes: a file of that NAME in a new measurement folder,
 * whatever path was typed. Measured 2026-11-09: `propose:table --out vbap.txt` wrote a reading
 * of the system into the repository root, untracked and unignored, one `git add` from history.
 */
export function measurementFile(name, file, opts = {}) {
  const base = path.basename(String(file ?? '').trim());
  if (!base || base === '.' || base === '..') throw new Error(`'${file}' is not a file name`);
  return path.join(newMeasurementDir(name, opts), base);
}

export function newMeasurementDir(name, { now = new Date(), root } = {}) {
  if (!MEASUREMENT_NAME.test(String(name))) {
    throw new Error(`measurement name '${name}' must match ${MEASUREMENT_NAME}`);
  }
  const base = root ?? path.join(stateDir(), 'measurements');
  fs.mkdirSync(base, { recursive: true });
  const stem = path.join(base, `${name}-${measurementStamp(now)}`);
  for (let i = 1; i <= 9; i++) {
    const dir = i === 1 ? stem : `${stem}-${i}`;
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`nine measurement folders named ${stem} already exist; nothing was overwritten`);
}

/** The state directories this process has already checked against a git work tree. */
const CHECKED = new Set();

/**
 * The state directory, created when absent and checked ONCE per process and path.
 *
 * The check starts a `git` process and waits for it. The audit trail asks for this directory at
 * every read, so an unmemoised check was one blocked event loop per ADT read. Where the
 * directory lies does not change while the process runs; a path not seen before is checked.
 */
export function stateDir({ check = assertOutsideGit } = {}) {
  const dir = stateDirPath();
  fs.mkdirSync(dir, { recursive: true });
  if (!CHECKED.has(dir)) {
    check(dir);
    CHECKED.add(dir);
  }
  return dir;
}

/**
 * One id per PROCESS, shared by the journal and the audit trail.
 *
 * It used to be generated inside `openJournal`, which made it an id per journal rather
 * than per process: a script that opened two of them wrote two ids, and the audit -- which
 * carried none at all -- could not be joined to either. Memoised here because "which run
 * was this" has to answer the same thing however many times the config is loaded, and
 * because both artefacts have to agree on it or the join is worse than no join.
 *
 * It is a random id, not a counter and not a name: it says two lines came from the same
 * process, and deliberately nothing else about the machine or the operator.
 */
let RUN_ID = null;
export function runId() {
  RUN_ID ??= crypto.randomBytes(3).toString('hex');
  return RUN_ID;
}

/** What every config object carries beyond connection and paths: the installation's choices. */
function installationBlock(env) {
  return {
    system: settingOf(env, 'system') ?? null,
    catalogRelease: settingOf(env, 'catalog.release') ?? null,
    valueHelp: {
      namePattern: settingOf(env, 'valueHelp.namePattern'),
      labelPrefix: settingOf(env, 'valueHelp.labelPrefix'),
    },
  };
}

/** The label for "the SAP system" in answers and generated files: the configured id, or words. */
export const systemLabel = (cfg) => (cfg?.system ? `the ${cfg.system}` : 'the SAP system');

const legacyMessage = (file) =>
  `${file} is the configuration format of an earlier version. Import it once into the ` +
  `environment store: npm run config -- import "${file}"`;

/**
 * Configuration for the scripts that never touch SAP (report, logs:prune, sync:catalog).
 *
 * Requiring a host -- and therefore a logon -- to read the journal back would be ceremony that
 * buys nothing. The store is read when it exists; when it does not, the defaults are enough.
 * Nothing here reads a credential.
 */
export function offlineConfig(overrides = {}) {
  let env;
  try {
    env = readEnvironment();
  } catch (e) {
    // A store that exists but does not validate is NOT replaced by defaults in silence: the
    // script would run on settings the operator does not believe it runs on.
    throw new ConfigError(`the environment store could not be used (${e?.message ?? e}); fix it with npm run config -- doctor`, e?.key);
  }
  if (env.legacy) process.stderr.write(`[sap-adt] ${legacyMessage(env.legacy)}\n[sap-adt] running with the DEFAULT settings, not yours.\n`);
  installEnvironment(env);
  return {
    offline: true,
    // The configured client: the audit trail records it for offline runs too.
    client: env.settings.client ?? null,
    budget: { reads: 0 },
    run: runId(),
    ...installationBlock(env),
    ...overrides,
    paths: { ...resolvePaths(env), ...(overrides.paths ?? {}) },
  };
}

export function loadConfig() {
  stateDir();
  const env = readEnvironment({ file: storePath() });
  if (env.legacy) throw new ConfigError(legacyMessage(env.legacy));
  installEnvironment(env);
  const s = (key) => settingOf(env, key);
  const cfg = {
    host: env.settings.host,
    port: s('port'),
    client: env.settings.client,
    user: env.settings.user,
    language: s('language'),
    // Opt-in only: a certificate that does not chain is refused unless the installation says
    // otherwise (docs/security.md). NODE_EXTRA_CA_CERTS is the better answer for an internal CA.
    allowUnauthorizedTls: s('allowUnauthorizedTls'),
    mcpPort: s('mcpPort'),
    // `reads` is a NOTICE, not a cap. lib/audit.mjs counts reads AFTER they return, so
    // nothing there can refuse one; a real cap belongs before the route and changes what
    // this server promises (docs/security.md). Named here so the key stops reading as a
    // limit somebody forgot to enforce.
    budget: { reads: s('budget.reads') },
    // How long a shutdown may spend saying goodbye to the SAP system before it stops waiting.
    shutdownMs: s('shutdownMs'),
    run: runId(),
    ...installationBlock(env),
    paths: resolvePaths(env),
  };
  if (!cfg.host) throw new ConfigError('No SAP host: run `npm run config -- set host <host>`.', 'host');
  if (!cfg.client) throw new ConfigError('No SAP client: run `npm run config -- set client <nnn>`.', 'client');
  if (!cfg.user) throw new ConfigError('No SAP user: run `npm run config -- set user <user>`.', 'user');
  cfg.baseUrl = `https://${cfg.host}:${cfg.port}`;
  return cfg;
}

/** Loopback bearer: guards the local port, is NOT a SAP credential. Generated once. */
export function loopbackToken() {
  const file = path.join(stateDir(), 'token');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}
