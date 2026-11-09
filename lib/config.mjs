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

export function stateDir() {
  const dir = stateDirPath();
  fs.mkdirSync(dir, { recursive: true });
  assertOutsideGit(dir);
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
