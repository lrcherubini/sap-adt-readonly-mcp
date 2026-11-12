// `npm run config -- <command>`: the ONLY writer of the environment store.
//
// Every value is validated by lib/environment.mjs before it is written -- the same rules the
// server applies when it reads the store at start -- so nothing the CLI accepts can make the
// server refuse to start, and nothing the runtime fence would refuse can be stored.
//
// A tool that drives this module goes through `--json` and never opens the store itself: one
// writer, one validation. The JSON contract is stable:
//   success  { "ok": true,  "data": <command result> }
//   failure  { "ok": false, "error": { "code": "...", "message": "...", "key": "<setting>|null" } }
// and the process exits 0 on success, 1 on a refused value, 2 on a usage error.
//
// ---- Commands and their parameters ------------------------------------------------------------
//
// Global options, valid with every command, in any position:
//   --json          answer in the JSON contract above instead of text
//   --db <file>     use another store file (prepare or inspect one; the server reads only the
//                   default, %LOCALAPPDATA%\sap-adt\sap-adt.db)
//
// Settings (one key at a time; `keys` lists every key, its group, default and meaning):
//   keys                                  every known setting
//   list                                  the settings this installation has stored
//   get <key>                             stored value, or the default with source "default"
//   set <key> <value>                     validate and store; a list is "a;b;c" or JSON
//   unset <key>                           back to the default
//
// Customizing tables (the closed list adt_customizing may read):
//   table list                            standard (" ") + this installation's ("+")
//   table add <NAME> <why...>             add, or REPLACE an installation table of that name
//         [--key A,B]                     key columns, comma-separated
//         [--routine COL=GROUP]...        a VOFM routine column; repeatable
//   table remove <NAME>                   installation tables only
//   - a table already in the standard list (data/defaults/customizing-tables.json) is skipped
//     with a warning on `add` (data.skipped, data.warnings), and refused on `remove`: it leaves
//     the list by commit, not by config.
//
// ATC variants (what adt_atc_run may run; DEFAULT is always there):
//   atc list                              "*" marks atc.defaultVariant
//   atc add <NAME> <why...>               register a variant that exists in the system
//   atc remove <NAME>                     refused while it is atc.defaultVariant
//   - order matters: `atc add` first, then `set atc.defaultVariant <NAME>`; to drop the default,
//     point atc.defaultVariant elsewhere first.
//
// Callers (who a hosted server answers to; docs/security.md, "A token per caller"):
//   token list                            names and dates, never a token or its hash
//   token add <name>                      make a token, print it ONCE, store its SHA-256;
//                                         an existing name gets a new token and the old one dies
//   token remove <name>                   the caller's token stops working
//   - the server reads the callers at start: restart it after add or remove.
//   - callers are not part of export / import, and import --replace does not drop them.
//
// Whole environment (config.example.json shape):
//   export                                print it
//   export --out <file.json>              write it to a file (backup / review)
//   import <file.json>                    MERGE: write what the file names, keep the rest
//   import <file.json> --replace          REPLACE: drop settings, tables and variants the file
//                                         does not name, then write the file
//   - validated whole, one transaction: a refused value writes nothing and the message says so.
//   - standard tables in the file are skipped with a warning (data.warnings); the rest is written.
//   - the file does not carry secrets: host and user may be absent and set afterwards.
//
// Diagnosis:
//   doctor                                missing mandatory settings (host, client, user, system), an old
//                                         config.json, the catalogue (unset, not downloaded, > 35 days)
//
// Typical combinations:
//   first install     import my-env.json; set host <h>; set user <u>; doctor
//   switch system     export --out current.json; import other.json --replace; set host/user; doctor
//   go back           import current.json --replace
//   add a Z table     table add ZDEMO_T "why" --key BUKRS,ZDEMO_KEY; table list
//   other ATC default atc add ZDEMO_DEV "dev practices"; set atc.defaultVariant ZDEMO_DEV; atc list
//                     (unset, the default is the system check variant the server reads at start)
//   scripted          any command with --json, read `ok` and the exit code
//   dry preparation   any command with --db <scratch.db>, then export --db <scratch.db>

import fs from 'node:fs';
import path from 'node:path';
import {
  SETTINGS,
  ConfigError,
  validateSetting,
  validateEnvironment,
  fromFileFormat,
  toFileFormat,
  storePath,
  legacyConfigPath,
  resolvePaths,
} from './environment.mjs';
import {
  openStore,
  readAll,
  setSetting,
  unsetSetting,
  putCustomizingTable,
  deleteCustomizingTable,
  putAtcVariant,
  deleteAtcVariant,
  writeAll,
  listCallers,
  putCaller,
  deleteCaller,
} from './store.mjs';
import { CALLER_NAME, LOCAL_CALLER, newCallerToken } from './auth.mjs';
import { STANDARD_CUSTOMIZING_TABLES, CUSTOMIZING_TABLES, installCustomizingTables } from './data-preview.mjs';
import { assertOutsideGit } from './config.mjs';
import { catalogStatus } from './catalog.mjs';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `npm run config -- <command> [--json] [--db <file>]

  keys                              every setting, its group, default and meaning
  list                              the settings this installation has
  get <key>                         one setting (or its default)
  set <key> <value>                 validate and store one setting (a list: "a;b;c" or JSON)
  unset <key>                       remove one setting (back to its default)
  table list                        customizing tables: standard + this installation's
  table add <NAME> <why> [--key A,B] [--routine COL=GROUP ...]
  table remove <NAME>
  atc list | atc add <NAME> <why> | atc remove <NAME>
  token list | token add <name> | token remove <name>
                                    the callers of a hosted server; add prints the token once
  import <file.json> [--replace]    validate a whole file (config.example.json shape) and store it;
                                    merges by default, --replace drops what the file does not name
  export [--out <file.json>]        the whole environment in that shape
  doctor                            validate the store and say what is missing
`;

/** Parse argv into { command, args, flags }. Flags: --json, --replace, --db <f>, --out <f>, --key <a,b>, --routine C=G (repeatable). */
export function parseArgs(argv) {
  const args = [];
  const flags = { json: false, replace: false, routine: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--replace') flags.replace = true;
    else if (a === '--db' || a === '--out' || a === '--key') {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a === '--routine') {
      if (i + 1 >= argv.length) throw new UsageError('--routine needs COLUMN=GROUP');
      flags.routine.push(argv[++i]);
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else args.push(a);
  }
  return { command: args[0], args: args.slice(1), flags };
}

function openWritable(file) {
  if (file !== ':memory:') {
    const dir = path.dirname(path.resolve(file));
    fs.mkdirSync(dir, { recursive: true });
    assertOutsideGit(dir);
  }
  return openStore(file);
}

const need = (args, n, usage) => {
  if (args.length < n) throw new UsageError(`usage: ${usage}`);
};

/** The settings with their effective value and where it came from. */
function settingsView(env) {
  return Object.entries(SETTINGS).map(([key, spec]) => ({
    key,
    group: spec.group,
    value: env.settings[key] ?? null,
    default: spec.default ?? null,
    effective: env.settings[key] ?? spec.default ?? null,
    source: key in env.settings ? 'store' : spec.default !== undefined ? 'default' : 'unset',
    doc: spec.doc,
  }));
}

/** What a fresh store or a partly filled one still lacks, plus anything that does not hold. */
export function doctor(env, { legacy = null, resolve = resolvePaths, now = Date.now() } = {}) {
  const issues = [];
  const add = (level, key, message) => issues.push({ level, key, message });
  for (const key of ['host', 'client', 'user', 'system']) {
    if (!(key in env.settings)) add('warn', key, `${key} is not set: the server refuses to start without it (npm run config -- set ${key} <value>)`);
  }
  if (legacy) add('warn', null, `an old config.json sits at ${legacy}: import it once (npm run config -- import "${legacy}") and delete it`);
  const paths = resolve(env);
  // The release gate: without a catalogue nothing is recommended or classified, and a stale one
  // answers for a SAP state that has moved on.
  const catalog = catalogStatus(paths.catalog ?? null, { release: env.settings['catalog.release'] ?? null, now });
  if (!env.settings['catalog.release']) add('warn', 'catalog.release', 'no catalogue release chosen: npm run sync:catalog -- --list, then npm run config -- set catalog.release <release>');
  else if (!catalog.installed) add('warn', 'catalog.release', `the ${catalog.release} catalogue is not downloaded: npm run sync:catalog`);
  else if ((catalog.ageDays ?? 0) > 35) add('warn', 'catalog.release', `the catalogue is ${catalog.ageDays} days old: npm run sync:catalog`);
  return issues;
}

/**
 * Run one command against the store at `file`. Returns `{ data, text }`; throws ConfigError
 * (refused value), UsageError (bad command line) or an Error (anything else).
 */
export function runCommand({ command, args, flags }, { file = flags.db ?? storePath(), legacy = fs.existsSync(legacyConfigPath()) ? legacyConfigPath() : null } = {}) {
  if (!command || command === 'help') return { data: { usage: USAGE }, text: USAGE };

  if (command === 'keys') {
    const data = Object.entries(SETTINGS).map(([key, s]) => ({ key, group: s.group, default: s.default ?? null, doc: s.doc }));
    return { data, text: data.map((k) => `${k.key.padEnd(28)} ${k.default === null ? '' : `[${JSON.stringify(k.default)}] `}${k.doc}`).join('\n') };
  }

  const db = openWritable(file);
  try {
    const current = () => validateEnvironment(readAll(db));
    switch (command) {
      case 'list': {
        const data = settingsView(current()).filter((s) => s.source === 'store');
        return { data, text: data.map((s) => `${s.key.padEnd(28)} ${JSON.stringify(s.value)}`).join('\n') || '(no settings stored)' };
      }
      case 'get': {
        need(args, 1, 'get <key>');
        const view = settingsView(current()).find((s) => s.key === args[0]);
        if (!view) throw new ConfigError(`${args[0]}: not a setting of this server (npm run config -- keys)`, args[0]);
        return { data: view, text: `${view.key} = ${JSON.stringify(view.effective)} (${view.source})` };
      }
      case 'set': {
        need(args, 2, 'set <key> <value>');
        const [key, ...rest] = args;
        const value = validateSetting(key, rest.join(' '));
        // Cross-checks that need the rest of the environment, before writing.
        validateEnvironment({ ...readAll(db), settings: { ...readAll(db).settings, [key]: value } });
        setSetting(db, key, value);
        return { data: { key, value }, text: `${key} = ${JSON.stringify(value)}` };
      }
      case 'unset': {
        need(args, 1, 'unset <key>');
        if (!SETTINGS[args[0]]) throw new ConfigError(`${args[0]}: not a setting of this server`, args[0]);
        const removed = unsetSetting(db, args[0]);
        return { data: { key: args[0], removed }, text: removed ? `${args[0]} removed` : `${args[0]} was not set` };
      }
      case 'table': {
        const sub = args[0];
        if (sub === 'list') {
          const env = current();
          installCustomizingTables(env.customizingTables);
          const data = [...CUSTOMIZING_TABLES].map(([name, spec]) => ({ name, origin: STANDARD_CUSTOMIZING_TABLES.has(name) ? 'standard' : 'installation', ...spec }));
          installCustomizingTables([]);
          return { data, text: data.map((t) => `${t.origin === 'standard' ? ' ' : '+'} ${t.name.padEnd(16)} ${t.why}`).join('\n') };
        }
        if (sub === 'add') {
          need(args, 3, 'table add <NAME> <why> [--key A,B] [--routine COL=GROUP]');
          const routineColumns = {};
          for (const r of flags.routine) {
            const eq = r.indexOf('=');
            if (eq < 1) throw new UsageError(`--routine ${r}: expected COLUMN=GROUP`);
            routineColumns[r.slice(0, eq)] = r.slice(eq + 1);
          }
          const entry = { name: args[1], why: args.slice(2).join(' '), routineColumns, keyColumns: flags.key ? flags.key.split(',').map((s) => s.trim()).filter(Boolean) : undefined };
          const env = readAll(db);
          const others = env.customizingTables.filter((t) => t.name !== String(args[1]).toUpperCase());
          const [validated] = validateEnvironment({ ...env, customizingTables: [...others, entry] }).customizingTables.slice(-1);
          if (STANDARD_CUSTOMIZING_TABLES.has(validated.name)) {
            const warning = `${validated.name} is already in the standard list (data/defaults/customizing-tables.json): ignored`;
            return { data: { ...validated, skipped: true, warnings: [warning] }, text: `warning: ${warning}` };
          }
          putCustomizingTable(db, validated);
          return { data: validated, text: `+ ${validated.name}: ${validated.why}` };
        }
        if (sub === 'remove') {
          need(args, 2, 'table remove <NAME>');
          const name = String(args[1]).toUpperCase();
          if (STANDARD_CUSTOMIZING_TABLES.has(name)) throw new ConfigError(`${name} is standard: it leaves the list by commit, not by config`, 'customizingTables');
          const removed = deleteCustomizingTable(db, name);
          return { data: { name, removed }, text: removed ? `- ${name}` : `${name} was not an installation table` };
        }
        throw new UsageError('usage: table list | table add <NAME> <why> | table remove <NAME>');
      }
      case 'atc': {
        const sub = args[0];
        if (sub === 'list') {
          const env = current();
          const data = { variants: [{ name: 'DEFAULT', origin: 'standard' }, ...env.atcVariants.map((v) => ({ ...v, origin: 'installation' }))], defaultVariant: env.settings['atc.defaultVariant'] ?? 'DEFAULT' };
          return { data, text: data.variants.map((v) => `${v.name === data.defaultVariant ? '*' : ' '} ${v.name}${v.why ? `  ${v.why}` : ''}`).join('\n') };
        }
        if (sub === 'add') {
          need(args, 3, 'atc add <NAME> <why>');
          const [v] = validateEnvironment({ ...readAll(db), atcVariants: [{ name: args[1], why: args.slice(2).join(' ') }] }).atcVariants;
          if (v.name === 'DEFAULT') throw new ConfigError('DEFAULT is standard', 'atcVariants');
          putAtcVariant(db, v);
          return { data: v, text: `+ ${v.name}` };
        }
        if (sub === 'remove') {
          need(args, 2, 'atc remove <NAME>');
          const name = String(args[1]).toUpperCase();
          if (readAll(db).settings['atc.defaultVariant'] === name) throw new ConfigError(`${name} is the default variant: set atc.defaultVariant to another first`, 'atc.defaultVariant');
          const removed = deleteAtcVariant(db, name);
          return { data: { name, removed }, text: removed ? `- ${name}` : `${name} was not an installation variant` };
        }
        throw new UsageError('usage: atc list | atc add <NAME> <why> | atc remove <NAME>');
      }
      case 'token': {
        const sub = args[0];
        if (sub === 'list') {
          // The hash stays in the store: a list that printed it would be one more copy of it.
          const data = listCallers(db).map((c) => ({ name: c.name, createdAt: c.createdAt }));
          return { data, text: data.map((c) => `${c.name.padEnd(40)} ${c.createdAt}`).join('\n') || '(no caller: only the local token opens the server)' };
        }
        if (sub === 'add') {
          need(args, 2, 'token add <name>');
          const name = String(args[1]).trim().toLowerCase();
          if (!CALLER_NAME.test(name) || name === LOCAL_CALLER) {
            throw new ConfigError(`callers: '${args[1]}' is not a caller name (lower-case letters, digits, . _ -, at most 40; '${LOCAL_CALLER}' is the local token)`, 'callers');
          }
          const replaced = listCallers(db).some((c) => c.name === name);
          const { token, tokenSha256 } = newCallerToken();
          putCaller(db, { name, tokenSha256 });
          return {
            data: { name, token, replaced },
            text:
              `+ ${name}${replaced ? ' (its earlier token no longer works)' : ''}\n${token}\n` +
              'This token is shown ONCE and is not stored: hand it to its caller now. Restart the server to admit it.',
          };
        }
        if (sub === 'remove') {
          need(args, 2, 'token remove <name>');
          const name = String(args[1]).trim().toLowerCase();
          const removed = deleteCaller(db, name);
          return { data: { name, removed }, text: removed ? `- ${name} (restart the server to stop admitting its token)` : `${name} was not a caller` };
        }
        throw new UsageError('usage: token list | token add <name> | token remove <name>');
      }
      case 'import': {
        need(args, 1, 'import <file.json>');
        const doc = JSON.parse(fs.readFileSync(args[0], 'utf8'));
        const incoming = fromFileFormat(doc);
        // A standard table needs no registration: skip it with a warning instead of refusing the file.
        const warnings = [];
        incoming.customizingTables = incoming.customizingTables.filter((t) => {
          const name = String(t?.name ?? '').toUpperCase();
          if (!STANDARD_CUSTOMIZING_TABLES.has(name)) return true;
          warnings.push(`${name} is already in the standard list: ignored`);
          return false;
        });
        const replace = flags.replace === true;
        // Validate the result: what the store will hold after the import (merged unless --replace).
        const before = replace ? { settings: {}, customizingTables: [], atcVariants: [] } : readAll(db);
        const merged = {
          settings: { ...before.settings, ...incoming.settings },
          customizingTables: [...before.customizingTables.filter((t) => !incoming.customizingTables.some((n) => String(n.name).toUpperCase() === t.name)), ...incoming.customizingTables],
          atcVariants: [...before.atcVariants.filter((v) => !incoming.atcVariants.some((n) => String(n.name).toUpperCase() === v.name)), ...incoming.atcVariants],
        };
        let valid;
        try {
          valid = validateEnvironment(merged);
        } catch (e) {
          if (e instanceof ConfigError) e.message = `${e.message}\nnothing was written: the store is unchanged`;
          throw e;
        }
        // A table stored before the standard list grew to include it is not written again.
        const tables = valid.customizingTables.filter((t) => !STANDARD_CUSTOMIZING_TABLES.has(t.name));
        writeAll(db, {
          settings: Object.fromEntries(Object.keys(incoming.settings).map((k) => [k, valid.settings[k]])),
          customizingTables: tables,
          atcVariants: valid.atcVariants,
        }, { replace });
        const data = { mode: replace ? 'replace' : 'merge', settings: Object.keys(incoming.settings).length, customizingTables: incoming.customizingTables.length, atcVariants: incoming.atcVariants.length, warnings };
        const head = `${replace ? 'replaced the store with' : 'imported'} ${data.settings} setting(s), ${data.customizingTables} table(s), ${data.atcVariants} variant(s)`;
        return { data, text: [...warnings.map((w) => `warning: ${w}`), head].join('\n') };
      }
      case 'export': {
        const doc = toFileFormat(current());
        const text = JSON.stringify(doc, null, 2) + '\n';
        if (flags.out) {
          fs.writeFileSync(flags.out, text);
          return { data: { file: flags.out }, text: `written ${flags.out}` };
        }
        return { data: doc, text: text.trimEnd() };
      }
      case 'doctor': {
        const issues = doctor(current(), { legacy });
        return { data: { store: file, issues }, text: [`store: ${file}`, ...issues.map((i) => `${i.level.toUpperCase().padEnd(5)} ${i.key ? `${i.key}: ` : ''}${i.message}`)].join('\n') + (issues.length ? '' : '\nall good') };
      }
      default:
        throw new UsageError(`unknown command '${command}'\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

/** The CLI entry: prints text or the JSON contract, returns the exit code. */
export function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), file } = {}) {
  let parsed = { flags: { json: argv.includes('--json') } };
  try {
    parsed = parseArgs(argv);
    const result = runCommand(parsed, file ? { file } : undefined);
    out(parsed.flags.json ? JSON.stringify({ ok: true, data: result.data }) + '\n' : result.text + '\n');
    return 0;
  } catch (e) {
    const code = e instanceof ConfigError ? 'INVALID_VALUE' : e instanceof UsageError ? 'USAGE' : e instanceof SyntaxError ? 'BAD_JSON' : e?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'ERROR';
    const error = { code, message: e?.message ?? String(e), key: e?.key ?? null };
    if (parsed.flags.json) out(JSON.stringify({ ok: false, error }) + '\n');
    else err(`${error.message}\n`);
    return code === 'USAGE' ? 2 : 1;
  }
}
