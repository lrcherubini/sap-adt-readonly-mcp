// The environment layer: the store, the validation, the file format, the CLI and loadConfig.
//
// What is asserted is the promise of the "no hard-coded landscape" design: every value an
// installation supplies passes the same validation on the way in (CLI) and on the way out (the
// server at start), a store edited by hand cannot weaken a fence, and a fresh installation with
// nothing configured runs on the SAP-standard defaults alone.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, readAll, setSetting, writeAll, SCHEMA_VERSION } from '../lib/store.mjs';
import {
  SETTINGS,
  ConfigError,
  validateSetting,
  validateEnvironment,
  fromFileFormat,
  toFileFormat,
  readEnvironment,
  installEnvironment,
  resolvePaths,
  emptyEnvironment,
} from '../lib/environment.mjs';
import { main, runCommand, parseArgs, doctor } from '../lib/config-cli.mjs';
import { loadConfig, offlineConfig, systemLabel } from '../lib/config.mjs';
import { CUSTOMIZING_TABLES, STANDARD_CUSTOMIZING_TABLES } from '../lib/data-preview.mjs';
import { ATC_VARIANTS, DEFAULT_VARIANT as INITIAL_DEFAULT } from '../lib/atc.mjs';
import * as atc from '../lib/atc.mjs';
import { routeAuthority } from '../lib/adt-get.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-env-'));
const EXAMPLE = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));

afterEach(() => installEnvironment(emptyEnvironment()));

// ---- the store --------------------------------------------------------------

test('a new store is migrated to the current schema, and a newer one is refused', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.db');
  const db = openStore(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  assert.throws(() => openStore(file), /newer version/);
});

test('the store keeps values as JSON and writes a whole environment in one go', () => {
  const db = openStore(':memory:');
  setSetting(db, 'paths.precedentRoots', ['a', 'b']);
  setSetting(db, 'port', 443);
  writeAll(db, { customizingTables: [{ name: 'ZDEMO_T', why: 'a demo table for the test' }], atcVariants: [{ name: 'ZDEMO_V', why: 'a demo variant' }] });
  const all = readAll(db);
  assert.deepEqual(all.settings, { 'paths.precedentRoots': ['a', 'b'], port: 443 });
  assert.equal(all.customizingTables[0].name, 'ZDEMO_T');
  assert.equal(all.atcVariants[0].name, 'ZDEMO_V');
  db.close();
});

// ---- validation -------------------------------------------------------------

test('every setting validates its type and refuses what the runtime would refuse', () => {
  assert.equal(validateSetting('port', '443'), 443);
  assert.equal(validateSetting('client', '001'), '001');
  assert.equal(validateSetting('language', 'en'), 'EN');
  assert.equal(validateSetting('allowUnauthorizedTls', 'yes'), true);
  assert.equal(validateSetting('catalog.release', 'PCE2023_0'), 'PCE2023_0');
  assert.throws(() => validateSetting('catalog.release', '../etc'), /catalogue release/);
  assert.throws(() => validateSetting('repos.abapPrefix', 'abap-'), /not a setting/, 'no sibling checkout is configurable any more');
  assert.equal(validateSetting('valueHelp.namePattern', 'ZC_{entity}_VH'), 'ZC_{entity}_VH');
  for (const [key, bad, re] of [
    ['client', '1000', /3-digit/],
    ['client', '10', /3-digit/],
    ['port', '70000', /1 to 65535/],
    ['host', 'bad host', /host name/],
    ['host', 'x;rm -rf', /host name/],
    ['system', 'TOOLONG', /system id/],
    ['allowUnauthorizedTls', 'maybe', /true\/false/],
    ['valueHelp.namePattern', 'I_{entity}VH', /Z\/Y name pattern/],
    ['valueHelp.namePattern', 'ZI_VH', /\{entity\}/],
    ['valueHelp.labelPrefix', "it's", /no quote/],
    ['nope.key', 'x', /not a setting/],
  ]) {
    assert.throws(() => validateSetting(key, bad), (e) => e instanceof ConfigError && e.key === key && re.test(e.message), `${key}=${bad}`);
  }
});

test('every setting has a group and a sentence of documentation', () => {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    assert.ok(spec.group, `${key} has a group`);
    assert.ok(spec.doc && spec.doc.length > 15, `${key} is documented`);
  }
});

test('a default variant must be a listed one, checked across the environment', () => {
  assert.throws(() => validateEnvironment({ settings: { 'atc.defaultVariant': 'ZDEMO_GOV' } }), /not a listed variant/);
  const ok = validateEnvironment({ settings: { 'atc.defaultVariant': 'zdemo_gov' }, atcVariants: [{ name: 'ZDEMO_GOV', why: 'governance' }] });
  assert.equal(ok.settings['atc.defaultVariant'], 'ZDEMO_GOV');
});

// ---- the file format --------------------------------------------------------

test('config.example.json is a valid environment and survives an export/import round trip', () => {
  const env = validateEnvironment(fromFileFormat(EXAMPLE));
  assert.ok(Object.keys(env.settings).length > 5);
  const again = validateEnvironment(fromFileFormat(JSON.parse(JSON.stringify(toFileFormat(env)))));
  assert.deepEqual(again, env);
});

test('the file format nests settings by their prefix and keeps the two tables apart', () => {
  const env = fromFileFormat({ $comment: 'ignored', client: '001', paths: { logs: 'x', $note: 'ignored' }, atc: { defaultVariant: 'DEFAULT' }, atcVariants: [{ name: 'ZDEMO_V', why: 'w' }], customizingTables: [] });
  assert.deepEqual(env.settings, { client: '001', 'paths.logs': 'x', 'atc.defaultVariant': 'DEFAULT' });
  assert.deepEqual(env.atcVariants, [{ name: 'ZDEMO_V', why: 'w' }]);
  assert.equal('ownership' in env, false);
});

// ---- installing: the fences follow the store ---------------------------------

test('installing an environment moves every fence, and an empty one restores the standard lists', () => {
  installEnvironment(validateEnvironment(fromFileFormat(EXAMPLE)));
  assert.ok(CUSTOMIZING_TABLES.has('ZDEMO_REGION'));
  assert.ok(ATC_VARIANTS.has('ZDEMO_DEV_PRACTICE'));
  assert.equal(atc.DEFAULT_VARIANT, 'DEFAULT', 'the example sets no default: the system check variant takes it at start');
  installEnvironment(validateEnvironment({ ...fromFileFormat(EXAMPLE), settings: { ...fromFileFormat(EXAMPLE).settings, 'atc.defaultVariant': 'ZDEMO_DEV_PRACTICE' } }));
  assert.equal(atc.DEFAULT_VARIANT, 'ZDEMO_DEV_PRACTICE', 'the live binding follows the install');
  installEnvironment(emptyEnvironment());
  assert.equal(CUSTOMIZING_TABLES.size, STANDARD_CUSTOMIZING_TABLES.size);
  assert.deepEqual([...ATC_VARIANTS.keys()], ['DEFAULT']);
  assert.equal(atc.DEFAULT_VARIANT, INITIAL_DEFAULT);
});

test('the only paths are the journal and the catalogue -- nothing else on the machine is read', () => {
  const repoRoot = path.join(tmp(), 'this-repo');
  const bare = resolvePaths({ settings: {} }, { repoRoot });
  assert.deepEqual(Object.keys(bare).sort(), ['catalog', 'catalogDir', 'logs', 'repoRoot']);
  assert.equal(bare.logs, path.join(repoRoot, 'logs'));
  assert.equal(bare.catalog, null, 'no release chosen: no catalogue, and nothing bundled in the repository');
  const chosen = resolvePaths({ settings: { 'catalog.release': 'PCE2023_0' } }, { repoRoot });
  assert.match(chosen.catalog, /sap-adt[\\/]catalog[\\/]objectReleaseInfo_PCE2023_0\.json$/, 'the catalogue lives in the state directory');
  assert.match(resolvePaths({ settings: { 'catalog.release': 'Latest' } }, { repoRoot }).catalog, /objectReleaseInfoLatest\.json$/);
});

// ---- reading the store at start ---------------------------------------------

test('a store edited by hand into an invalid state is refused at read, not trusted', () => {
  const file = path.join(tmp(), 'sap-adt.db');
  const db = openStore(file);
  db.prepare("INSERT INTO customizing_tables_extra (name, why) VALUES ('T683S', 'redefining a standard table')").run();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('client', '\"12345\"', 'x')").run();
  db.close();
  assert.throws(() => readEnvironment({ file }), /client/);
});

function withState(fn) {
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
  const base = tmp();
  process.env.LOCALAPPDATA = path.join(base, 'local');
  process.env.APPDATA = path.join(base, 'roaming');
  try {
    return fn(path.join(base, 'local', 'sap-adt'));
  } finally {
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
    process.env.APPDATA = saved.APPDATA;
  }
}

test('loadConfig builds the config from the store, and refuses without host or client', () => {
  withState((state) => {
    assert.throws(() => loadConfig(), /No SAP host/);
    const file = path.join(state, 'sap-adt.db');
    assert.equal(main(['set', 'host', 'dev.example.com', '--db', file], { out: () => {}, err: () => {} }), 0);
    assert.throws(() => loadConfig(), /No SAP client/);
    main(['import', fileURLOf('../config.example.json'), '--db', file], { out: () => {}, err: () => {} });
    const cfg = loadConfig();
    assert.equal(cfg.baseUrl, 'https://dev-system.example.com:44300', 'the imported file replaced the host set before');
    assert.equal(cfg.client, '001');
    assert.equal(cfg.allowUnauthorizedTls, false, 'certificates are verified unless the installation opts out');
    assert.equal(cfg.system, 'DEV');
    assert.equal(systemLabel(cfg), `the ${cfg.system}`);
    assert.equal(systemLabel({}), 'the SAP system');
    assert.ok(CUSTOMIZING_TABLES.has('ZDEMO_REGION'), 'loading the config installs the fences');
  });
});

test('an old config.json is not read silently: the server refuses, the offline sweeps warn', () => {
  withState((state) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'config.json'), '{"host":"x.example"}');
    assert.throws(() => loadConfig(), /npm run config -- import/);
    const warnings = [];
    const write = process.stderr.write;
    process.stderr.write = (m) => warnings.push(String(m));
    try {
      const cfg = offlineConfig();
      assert.equal(cfg.offline, true);
    } finally {
      process.stderr.write = write;
    }
    assert.match(warnings.join(''), /npm run config -- import/);
  });
});

const fileURLOf = (rel) => new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// ---- the CLI ----------------------------------------------------------------

test('the CLI speaks the JSON contract a driving tool reads, and refuses before writing', () => {
  const file = path.join(tmp(), 'sap-adt.db');
  const run = (...argv) => {
    const lines = [];
    const code = main([...argv, '--json', '--db', file], { out: (s) => lines.push(s), err: (s) => lines.push(s) });
    return { code, ...JSON.parse(lines.join('')) };
  };
  assert.deepEqual(run('set', 'client', '001'), { code: 0, ok: true, data: { key: 'client', value: '001' } });
  const bad = run('set', 'client', '1000');
  assert.equal(bad.code, 1);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.error).sort(), ['code', 'key', 'message']);
  assert.equal(bad.error.code, 'INVALID_VALUE');
  assert.equal(bad.error.key, 'client');
  assert.equal(run('get', 'client').data.effective, '001', 'the refused value was not written');
  assert.equal(run('get', 'port').data.source, 'default');
  assert.equal(run('bogus').code, 2);
  assert.equal(run('set', 'client').error.code, 'USAGE');

  assert.equal(run('table', 'add', 'ZDEMO_T', 'a demo table', '--key', 'A,B', '--routine', 'KOBED=PBED').data.name, 'ZDEMO_T');
  const std = run('table', 'add', 'T683S', 'a standard one');
  assert.equal(std.ok, true, 'a standard table is ignored with a warning, not refused');
  assert.equal(std.data.skipped, true);
  assert.match(std.data.warnings[0], /already in the standard list/);
  assert.ok(!run('table', 'list').data.some((t) => t.name === 'T683S' && t.origin === 'installation'));
  assert.equal(run('table', 'add', 'ZDEMO_U', 'bad group', '--routine', 'X=NOPE').error.code, 'INVALID_VALUE');
  assert.ok(run('table', 'list').data.some((t) => t.name === 'ZDEMO_T' && t.origin === 'installation'));
  assert.equal(run('table', 'remove', 'T683S').ok, false, 'a standard table leaves by commit, not by config');
  assert.equal(run('table', 'remove', 'ZDEMO_T').data.removed, true);

  assert.equal(run('set', 'atc.defaultVariant', 'ZDEMO_GOV').error.key, 'atc.defaultVariant', 'not listed yet');
  assert.equal(run('atc', 'add', 'ZDEMO_GOV', 'governance run').ok, true);
  assert.equal(run('set', 'atc.defaultVariant', 'ZDEMO_GOV').ok, true);
  assert.equal(run('atc', 'remove', 'ZDEMO_GOV').ok, false, 'the default cannot be removed');
  assert.equal(run('atc', 'list').data.defaultVariant, 'ZDEMO_GOV');

  assert.equal(run('ownership', 'list').error.code, 'USAGE', 'the ownership table is gone with the backlog scripts');
  assert.equal(run('import', '/nowhere.json').error.code, 'FILE_NOT_FOUND');

  const exported = run('export').data;
  assert.equal(exported.client, '001');
  assert.equal('ownership' in exported, false);
  const issues = run('doctor').data.issues;
  assert.ok(issues.some((i) => i.key === 'host'), 'doctor names what is missing');
  assert.ok(issues.some((i) => i.key === 'system'), 'the expected system id is mandatory too');
});

test('an import is validated whole: one bad value and nothing is written', () => {
  const dir = tmp();
  const file = path.join(dir, 'sap-adt.db');
  const src = path.join(dir, 'in.json');
  fs.writeFileSync(src, JSON.stringify({ client: '001', port: 99999, customizingTables: [{ name: 'ZDEMO_T', why: 'a demo table' }] }));
  assert.throws(() => runCommand(parseArgs(['import', src]), { file }), /port/);
  const env = readEnvironment({ file });
  assert.deepEqual(env.settings, {});
  assert.deepEqual(env.customizingTables, []);
});

test('a refused import says nothing was written', () => {
  const dir = tmp();
  const src = path.join(dir, 'in.json');
  fs.writeFileSync(src, JSON.stringify({ port: 99999 }));
  const lines = [];
  assert.equal(main(['import', src, '--db', path.join(dir, 'sap-adt.db')], { out: () => {}, err: (x) => lines.push(x) }), 1);
  assert.match(lines.join(''), /nothing was written: the store is unchanged/);
});

test('an import skips a standard table with a warning and stores the rest', () => {
  const dir = tmp();
  const file = path.join(dir, 'sap-adt.db');
  const src = path.join(dir, 'in.json');
  fs.writeFileSync(src, JSON.stringify({ client: '250', customizingTables: [{ name: 'T683S', why: 'standard' }, { name: 'ZDEMO_T', why: 'a demo table' }] }));
  const r = runCommand(parseArgs(['import', src]), { file });
  assert.equal(r.data.customizingTables, 1);
  assert.match(r.text, /^warning: T683S is already in the standard list: ignored/);
  const env = readEnvironment({ file });
  assert.equal(env.settings.client, '250');
  assert.deepEqual(env.customizingTables.map((t) => t.name), ['ZDEMO_T']);
});

test('import merges by default; --replace drops what the file does not name', () => {
  const dir = tmp();
  const file = path.join(dir, 'sap-adt.db');
  const first = path.join(dir, 'a.json');
  const second = path.join(dir, 'b.json');
  fs.writeFileSync(first, JSON.stringify({ host: 'a.example.com', client: '001', system: 'AAA', atc: { defaultVariant: 'ZDEMO_A' }, atcVariants: [{ name: 'ZDEMO_A', why: 'a' }], customizingTables: [{ name: 'ZDEMO_T', why: 'a demo table' }] }));
  fs.writeFileSync(second, JSON.stringify({ client: '250', atcVariants: [{ name: 'ZDEMO_B', why: 'b' }] }));
  runCommand(parseArgs(['import', first]), { file });

  const merged = runCommand(parseArgs(['import', second]), { file });
  assert.equal(merged.data.mode, 'merge');
  let env = readEnvironment({ file });
  assert.equal(env.settings.host, 'a.example.com', 'a merge keeps what the file does not name');
  assert.deepEqual(env.atcVariants.map((v) => v.name).sort(), ['ZDEMO_A', 'ZDEMO_B']);
  assert.deepEqual(env.customizingTables.map((t) => t.name), ['ZDEMO_T']);

  const replaced = runCommand(parseArgs(['import', second, '--replace']), { file });
  assert.equal(replaced.data.mode, 'replace');
  assert.match(replaced.text, /replaced the store with 1 setting/);
  env = readEnvironment({ file });
  assert.deepEqual(env.settings, { client: '250' });
  assert.deepEqual(env.atcVariants.map((v) => v.name), ['ZDEMO_B']);
  assert.deepEqual(env.customizingTables, []);
});

test('doctor says when the catalogue is not chosen, not downloaded, or older than 35 days', () => {
  const base = { host: 'h', client: '001', user: 'U' };
  const env = (settings) => ({ settings: { ...base, ...settings }, customizingTables: [], atcVariants: [] });
  assert.match(doctor(env({})).find((i) => i.key === 'catalog.release').message, /no catalogue release chosen/);
  const dir = tmp();
  const file = path.join(dir, 'objectReleaseInfo_PCE2023_0.json');
  const resolve = () => ({ catalog: file });
  assert.match(doctor(env({ 'catalog.release': 'PCE2023_0' }), { resolve }).find((i) => i.key === 'catalog.release').message, /not downloaded/);
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(path.join(dir, 'PROVENANCE.json'), JSON.stringify({ syncedAt: '2026-09-01T00:00:00Z' }));
  const now = Date.parse('2026-11-08T00:00:00Z');
  assert.match(doctor(env({ 'catalog.release': 'PCE2023_0' }), { resolve, now }).find((i) => i.key === 'catalog.release').message, /68 days old/);
  assert.equal(doctor(env({ 'catalog.release': 'PCE2023_0' }), { resolve, now: Date.parse('2026-09-10T00:00:00Z') }).some((i) => i.key === 'catalog.release'), false, 'a fresh catalogue is fine');
  assert.ok(!doctor(env({})).some((i) => /ownership|repos\.|paths\./.test(`${i.key} ${i.message}`)));
});
