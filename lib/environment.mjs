// The environment: what one installation of this server supplies, validated in ONE place.
//
// Two layers, and nothing about a particular SAP landscape is hard-coded in the code:
//   1. data/defaults/*.json   SAP-standard knowledge, versioned and reviewed in a diff
//                              (loaded by the modules that own each list);
//   2. the environment store  this installation's values (lib/store.mjs, one SQLite file in
//                              %LOCALAPPDATA%\sap-adt\), written ONLY through
//                              `npm run config` -- which validates with the rules below;
//
// The same validation runs when a value is written (the CLI refuses it) and when it is read (the
// server refuses to start on it), so the fence the runtime applies is never weaker than what the
// store holds -- a row edited by hand into the SQLite file is caught at the next start.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, readAll } from './store.mjs';
import { installCustomizingTables, validateCustomizingTable } from './data-preview.mjs';
import { installAtcVariants, validateAtcVariant } from './atc.mjs';
import { RELEASE_RE, releaseFileName } from './catalog.mjs';

export class ConfigError extends Error {
  constructor(message, key) {
    super(message);
    this.name = 'ConfigError';
    this.key = key;
  }
}

const fail = (key, msg) => {
  throw new ConfigError(`${key}: ${msg}`, key);
};

// ---- value types: each takes the raw value (a string from the CLI, or JSON) and returns the
// normalized value, or throws ConfigError naming the key.

const str = (re, what) => (key, v) => {
  const s = String(v ?? '').trim();
  if (!re.test(s)) fail(key, `'${s}' is not ${what}`);
  return s;
};
const upper = (re, what) => (key, v) => str(re, what)(key, String(v ?? '').toUpperCase());
const int = (min, max) => (key, v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n < min || n > max) fail(key, `'${v}' is not an integer from ${min} to ${max}`);
  return n;
};
const bool = (key, v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  return fail(key, `'${v}' is not true/false`);
};
const aPath = (key, v) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > 400 || /[\0\r\n]/.test(s)) fail(key, `'${s}' is not a path`);
  return s;
};
/** A list: a JSON array, or a string with entries separated by ';' (the CLI form). */
const list = (item) => (key, v) => {
  let arr = v;
  if (typeof v === 'string') {
    const t = v.trim();
    arr = t.startsWith('[') ? JSON.parse(t) : t.split(';').map((x) => x.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr)) fail(key, 'is not a list (a JSON array, or entries separated by ";")');
  return arr.map((x, i) => item(`${key}[${i}]`, x));
};

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;

/**
 * Every key the store may hold. `doc` is what `npm run config -- keys` shows;
 * `default` is what the server uses when the key is absent (undefined = no default: the feature
 * that needs it says "not configured").
 */
export const SETTINGS = Object.freeze({
  host: { type: str(HOST, 'a host name'), group: 'connection', doc: 'SAP application server host (HTTPS, the ICF /sap/bc/adt node)' },
  port: { type: int(1, 65535), default: 44300, group: 'connection', doc: 'HTTPS port (44300 is the SAP default for instance 00)' },
  client: { type: str(/^\d{3}$/, 'a 3-digit client'), group: 'connection', doc: 'SAP client (no default: it is always an installation choice)' },
  user: { type: upper(/^[A-Z0-9_.@-]{1,40}$/, 'a SAP user name'), group: 'connection', doc: 'SAP user (the password is never stored: it is typed at every start)' },
  language: { type: upper(/^[A-Z]{2}$/, 'a 2-letter logon language'), default: 'EN', group: 'connection', doc: 'logon language of the SAP session (texts come back in it)' },
  system: { type: upper(/^[A-Z][A-Z0-9]{2}$/, 'a 3-character SAP system id'), group: 'connection', doc: 'system id the host must answer as before the password is asked (required to log on; also the label in answers)' },
  allowUnauthorizedTls: { type: bool, default: false, group: 'connection', doc: 'accept a certificate that does not chain to a trusted CA (an internal CA without NODE_EXTRA_CA_CERTS); see docs/security.md' },
  passwordFile: {
    type: (k, v) => {
      const s = aPath(k, v);
      if (!path.isAbsolute(s)) fail(k, `'${s}' is not an absolute path`);
      return s;
    },
    group: 'connection',
    doc: 'file the SAP password is read from when no one is there to type it (a mounted secret, a service credential); unset: typed at every start. See docs/security.md',
  },
  mcpPort: { type: int(1024, 65535), default: 2237, group: 'server', doc: 'loopback port of the MCP endpoint' },
  'budget.reads': { type: int(0, 1000000), default: 200, group: 'server', doc: 'reads per run before the audit raises a notice (a notice, not a cap)' },
  shutdownMs: { type: int(0, 600000), default: 5000, group: 'server', doc: 'how long a shutdown may wait for the SAP logout' },

  'catalog.release': { type: str(RELEASE_RE, 'a catalogue release as SAP names it (Latest, PCELatest, PCE2025_2, PCE2023_0, ...)'), group: 'catalog', doc: 'Clean Core catalogue release to download and use: the one matching the system (npm run sync:catalog -- --list)' },

  'atc.defaultVariant': { type: upper(/^[A-Z0-9_/]{1,30}$/, 'a check variant name'), group: 'atc', doc: 'variant adt_atc_run uses when none is named; unset: the system check variant read at start, else DEFAULT (must be listed: DEFAULT or one added with `atc add`)' },

  'paths.logs': { type: aPath, group: 'paths', doc: 'journal folder (default: logs/ in this repository, git-ignored; relative to it)' },
  'valueHelp.namePattern': {
    type: (k, v) => {
      const s = str(/^[ZY][A-Za-z0-9_]*\{entity\}[A-Za-z0-9_]*$/, 'a Z/Y name pattern containing {entity}')(k, v);
      if (s.replace('{entity}', '').length > 25) fail(k, 'leaves too little room for the entity name (a CDS name has 30 characters)');
      return s;
    },
    default: 'ZI_{entity}VH',
    group: 'value help',
    doc: 'name adt_value_help proposes for a value help of your own',
  },
  'valueHelp.labelPrefix': { type: str(/^[^'\r\n]{0,40}$/, 'a label prefix (no quote)'), default: 'Value help - ', group: 'value help', doc: '@EndUserText.label prefix of the proposed value help' },
});

function wrap(key, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${key}: ${e.message}`, key);
  }
}

/** Validate one setting; returns the normalized value. Unknown keys are refused. */
export function validateSetting(key, value) {
  const spec = SETTINGS[key];
  if (!spec) throw new ConfigError(`${key}: not a setting of this server (npm run config -- keys)`, key);
  return spec.type(key, value);
}

/** Validate a whole environment as read from the store or an import file. */
export function validateEnvironment(env) {
  const settings = {};
  for (const [k, v] of Object.entries(env.settings ?? {})) settings[k] = validateSetting(k, v);
  const customizingTables = (env.customizingTables ?? []).map((t) =>
    wrap('customizingTables', () => {
      const [name, spec] = validateCustomizingTable(t, { origin: 'customizing table' });
      return { name, ...spec };
    })
  );
  const atcVariants = (env.atcVariants ?? []).map((v) =>
    wrap('atcVariants', () => {
      const [name, why] = validateAtcVariant(v);
      return { name, why };
    })
  );
  const listed = new Set(['DEFAULT', ...atcVariants.map((v) => v.name)]);
  if (settings['atc.defaultVariant'] && !listed.has(settings['atc.defaultVariant'])) {
    throw new ConfigError(`atc.defaultVariant: ${settings['atc.defaultVariant']} is not a listed variant (atc add it first)`, 'atc.defaultVariant');
  }
  return { settings, customizingTables, atcVariants };
}

/**
 * The import/export file format (config.example.json): nested objects for readability --
 * `{ "paths": { "logs": "..." } }` is the setting `paths.logs` -- plus two lists that are
 * tables, not settings: `customizingTables` and `atcVariants`.
 * Keys starting with `$` are comments.
 */
export function fromFileFormat(doc) {
  const settings = {};
  let customizingTables = [];
  let atcVariants = [];
  for (const [k, v] of Object.entries(doc ?? {})) {
    if (k.startsWith('$')) continue;
    if (k === 'customizingTables') customizingTables = v;
    else if (k === 'atcVariants') atcVariants = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [sk, sv] of Object.entries(v)) if (!sk.startsWith('$')) settings[`${k}.${sk}`] = sv;
    } else settings[k] = v;
  }
  return { settings, customizingTables, atcVariants };
}

/** The inverse of fromFileFormat: what `npm run config -- export` writes. */
export function toFileFormat(env) {
  const doc = {};
  for (const [k, v] of Object.entries(env.settings ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const dot = k.indexOf('.');
    if (dot < 0) doc[k] = v;
    else (doc[k.slice(0, dot)] ??= {})[k.slice(dot + 1)] = v;
  }
  if (env.customizingTables?.length) doc.customizingTables = env.customizingTables;
  if (env.atcVariants?.length) doc.atcVariants = env.atcVariants;
  return doc;
}

// ---- where the store lives

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

/** The one variable of the environment this server reads: a place, never a value of the landscape. */
export const STATE_DIR_VARIABLE = 'SAP_ADT_STATE_DIR';

/**
 * Where the state lives. `SAP_ADT_STATE_DIR` names it outright -- a service account or a
 * container has no profile folder worth relying on, and a mounted volume has a path of its
 * own. Without it: the profile folder of the user. A relative place is refused in both cases,
 * because it would follow the working directory, which is usually the repository.
 */
export function stateDirPath(env = process.env) {
  const named = String(env[STATE_DIR_VARIABLE] ?? '').trim();
  if (named) {
    if (!path.isAbsolute(named)) throw new ConfigError(`${STATE_DIR_VARIABLE}: '${named}' is not an absolute path`, STATE_DIR_VARIABLE);
    return path.resolve(named);
  }
  const base = env.LOCALAPPDATA ?? (env.HOME ? path.join(env.HOME, '.local/share') : null);
  if (!base || !path.isAbsolute(base)) {
    throw new ConfigError(
      `no place for the state directory: neither LOCALAPPDATA nor HOME names an absolute path. Set ${STATE_DIR_VARIABLE} to one.`,
      STATE_DIR_VARIABLE
    );
  }
  return path.join(base, 'sap-adt');
}
export const storePath = () => path.join(stateDirPath(), 'sap-adt.db');
export const legacyConfigPath = () => path.join(stateDirPath(), 'config.json');

/** An empty environment: what a fresh installation has. */
export const emptyEnvironment = () => ({ settings: {}, customizingTables: [], atcVariants: [] });

/**
 * Read the environment from the store, validated. No store file = empty environment, plus a
 * `legacy` flag when an old config.json sits next to where the store would be (the caller decides
 * whether that is an error -- it is for the server, a warning for the scripts).
 */
export function readEnvironment({ file = storePath() } = {}) {
  if (file !== ':memory:' && !fs.existsSync(file)) {
    return { ...emptyEnvironment(), source: null, legacy: fs.existsSync(legacyConfigPath()) ? legacyConfigPath() : null };
  }
  const db = openStore(file);
  try {
    return { ...validateEnvironment(readAll(db)), source: file, legacy: null };
  } finally {
    db.close();
  }
}

/** Install the lists that live in other modules (the fences) from a validated environment. */
export function installEnvironment(env) {
  const s = env.settings ?? {};
  installCustomizingTables(env.customizingTables ?? []);
  installAtcVariants(env.atcVariants ?? [], s['atc.defaultVariant']);
}

/** The value of a setting, or its default (undefined when it has none). */
export const settingOf = (env, key) => env.settings?.[key] ?? SETTINGS[key]?.default;

/**
 * The `paths` block of the config object: the journal folder and the catalogue. Nothing else on
 * the machine is read -- every source comes from the SAP system.
 */
export function resolvePaths(env, { repoRoot = REPO_ROOT } = {}) {
  const s = env.settings ?? {};
  return {
    repoRoot,
    // The journal (lib/journal.mjs): inside the repository on purpose, git-ignored -- analysis
    // metadata, never a credential and never SAP source.
    logs: s['paths.logs'] ? path.resolve(repoRoot, s['paths.logs']) : path.join(repoRoot, 'logs'),
    // The catalogue lives in the state directory, outside the repository, downloaded and
    // refreshed on purpose by scripts/sync-catalog.mjs (docs/security.md). No release set = no
    // catalogue = the tools that need one say so (CATALOG_MISSING), never "released".
    catalogDir: path.join(stateDirPath(), 'catalog'),
    catalog: s['catalog.release'] ? path.join(stateDirPath(), 'catalog', releaseFileName(s['catalog.release'])) : null,
  };
}
