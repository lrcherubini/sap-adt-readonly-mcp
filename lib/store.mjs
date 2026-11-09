// The environment store: everything a deployment supplies, in ONE SQLite file outside any
// git work tree (%LOCALAPPDATA%\sap-adt\sap-adt.db by default).
//
// What lives here is what differs between two installations of this server -- host, client,
// user, the customer tables admitted to the data preview, the ATC variants, the catalogue
// release. What is the SAME everywhere (SAP-standard
// tables, OData roots, the DEFAULT variant) is NOT here: it ships as reviewable JSON under
// data/defaults/, because those lists are part of the read-only fence and are reviewed in a diff.
//
// Validation is NOT this module's job: lib/environment.mjs validates every value before it is
// written (the CLI) and again when it is read (the server), with the same rules the runtime
// fence applies. This module stores and returns plain values.
//
// `node:sqlite` ships with Node, so this adds no npm dependency and nothing runs at install
// (`npm ci --ignore-scripts` stays true). It still prints an ExperimentalWarning on import;
// that ONE warning is filtered while the module loads, every other warning is untouched.

const { DatabaseSync } = await importSqlite();

async function importSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message ?? '';
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Schema migrations, in order. `PRAGMA user_version` is the index of the last one applied, so
 * a database written by an older version is brought forward on open and never rewritten from
 * scratch. Append only: an applied migration is never edited.
 */
const MIGRATIONS = [
  `CREATE TABLE settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,          -- JSON
     updated_at TEXT NOT NULL
   );
   CREATE TABLE customizing_tables_extra (
     name            TEXT PRIMARY KEY,
     why             TEXT NOT NULL,
     routine_columns TEXT NOT NULL DEFAULT '{}',  -- JSON object column|regex -> VOFM group
     key_columns     TEXT NOT NULL DEFAULT '[]'   -- JSON array
   );
   CREATE TABLE atc_variants (
     name TEXT PRIMARY KEY,
     why  TEXT NOT NULL
   );`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Open (and migrate) a store. `file` is a path or ':memory:' (tests). */
export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `${file} was written by a newer version of this server (schema ${current}, this one knows ${MIGRATIONS.length}). ` +
        'Refusing to open it rather than misread it.'
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }
  return db;
}

const now = () => new Date().toISOString();

/** Everything the store holds, as plain values. Nothing here is validated. */
export function readAll(db) {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings ORDER BY key').all()) {
    settings[row.key] = JSON.parse(row.value);
  }
  return {
    settings,
    customizingTables: db
      .prepare('SELECT name, why, routine_columns, key_columns FROM customizing_tables_extra ORDER BY name')
      .all()
      .map((r) => ({ name: r.name, why: r.why, routineColumns: JSON.parse(r.routine_columns), keyColumns: JSON.parse(r.key_columns) })),
    atcVariants: db.prepare('SELECT name, why FROM atc_variants ORDER BY name').all().map((r) => ({ name: r.name, why: r.why })),
  };
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(value), now());
}

export function unsetSetting(db, key) {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
}

export function putCustomizingTable(db, { name, why, routineColumns = {}, keyColumns = [] }) {
  db.prepare(
    'INSERT INTO customizing_tables_extra (name, why, routine_columns, key_columns) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET why = excluded.why, routine_columns = excluded.routine_columns, key_columns = excluded.key_columns'
  ).run(name, why, JSON.stringify(routineColumns), JSON.stringify(keyColumns));
}

export function deleteCustomizingTable(db, name) {
  return db.prepare('DELETE FROM customizing_tables_extra WHERE name = ?').run(name).changes > 0;
}

export function putAtcVariant(db, { name, why }) {
  db.prepare('INSERT INTO atc_variants (name, why) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET why = excluded.why').run(name, why);
}

export function deleteAtcVariant(db, name) {
  return db.prepare('DELETE FROM atc_variants WHERE name = ?').run(name).changes > 0;
}

/** Write a whole environment (validated by the caller) in one transaction -- `config import`. */
/** Write an environment in one transaction. replace: drop every setting, table and variant first. */
export function writeAll(db, env, { replace = false } = {}) {
  db.exec('BEGIN');
  try {
    if (replace) {
      db.exec('DELETE FROM settings');
      db.exec('DELETE FROM customizing_tables_extra');
      db.exec('DELETE FROM atc_variants');
    }
    for (const [key, value] of Object.entries(env.settings ?? {})) setSetting(db, key, value);
    for (const t of env.customizingTables ?? []) putCustomizingTable(db, t);
    for (const v of env.atcVariants ?? []) putAtcVariant(db, v);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
