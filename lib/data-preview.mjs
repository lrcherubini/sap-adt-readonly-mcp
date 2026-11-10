// The data preview of the ADT, fenced to a closed list of customizing tables.
//
// This is the FIRST POST this server sends. `docs/security.md` records the decision of
// 2026-09-08 ("never about the contents of a table") and its reversal of 2026-09-12 for a
// closed list -- the tables the report ZDEMO_PRICING_RPT reads to say WHERE a VOFM routine is used,
// plus the copy-control and VOFM tables themselves. The fence is this module, and it is on
// the CLIENT: the server answers any table (measured: `SELECT VBELN FROM VBAK` -> 200).
//
// MEASURED 2026-09-12 on the development system (measurement; docs/adt-api-reference.md):
//   - `POST /sap/bc/adt/datapreview/freestyle?rowNumber=N`, body `text/plain` = the SELECT
//     without INTO/UP TO: the server appends `INTO TABLE @DATA(LT_RESULT) UP TO N ROWS` and
//     echoes the statement it ran in `executedQueryString`.
//   - The one media type: 406 on `application/xml` names exactly
//     `application/vnd.sap.adt.datapreview.table.v1+xml`; `application/*` is answered with it.
//   - Shape: `tableData > totalRows, isHanaAnalyticalView, executedQueryString,
//     queryExecutionTime, columns*`; each `columns > metadata/@name @type @description
//     @keyAttribute @colType @isKeyFigure` + `dataSet > data*` -- COLUMN-MAJOR: the n-th
//     `data` of every column is row n. `totalRows` is the count WITHOUT the row cap (T683S:
//     9784 with 5 returned). `description` repeats the name; `keyAttribute` is "false" on
//     every key column of T683S; `colType` is empty on all 137 columns seen.
//   - Nothing held: no lock, no transport, nothing in SM12 -- the user's reading, before
//     and after. 480-560 ms per call on a 9784-row table.
//   - NUMC columns come back at their full width: T683S.KOBED/KOFRM/KOFRA are 7 digits
//     (`0000002`), TVCPA.GRBED/GRU* are 3 (`303`). A literal in WHERE is compared as the
//     ABAP SELECT compares it, so a routine number has to be sent at the column's width.
//
// ⚠️ MEASURED 2026-10-01 on the development system: EACH LINE OF THE BODY KEEPS ITS FIRST 255 CHARACTERS; THE
// REST OF THE LINE IS DROPPED IN SILENCE. Three one-line reads of T683S through adt_customizing:
//   - 257 chars, the cut inside the last literal  -> 400 "The text literal "'0000996   INTO
//     TABLE @DAT" is longer than 255 characters" (the 2026-09-30 failure of a 16-routine IN list);
//   - 267 chars, the cut inside the IN list        -> 400 "INTO" is invalid here;
//   - 271 chars, the cut right after `KSCHL <> 'QQQ'` -> **200**, 36 rows, and the echoed
//     executedQueryString ends at `'QQQ'` -- `AND KVEWE = 'X'` was never run, every row
//     returned has KVEWE = 'A'. A WRONG ANSWER WITH STATUS 200.
// The limit is per LINE, not per statement: the Eclipse Data Preview sends one field per line
// (371 characters, longest line 35, ABAP Communication Log captured by the owner the same day)
// and the echo comes back whole, the lines joined by one blank. So `buildSelect` breaks the
// statement between tokens into lines of at most MAX_LINE, and `assertRanAsSent` refuses rows
// whose executedQueryString is not the statement sent. Line breaks are LF; whether Eclipse
// sends LF or CRLF the log does not show -- the echo check is what makes that safe.
//
// Deliberately NOT a general SQL door: one table, listed fields or `*`, a WHERE of
// `=`/`<>`/`IN` on identifiers, a row cap. No join, no subquery, no aggregate, no `;`,
// no comment -- the grammar cannot express them, so nothing has to be filtered out.

import { readFileSync } from 'node:fs';
import { groupOf } from './vofm-groups.mjs';

export const DATA_PREVIEW_PATH = '/sap/bc/adt/datapreview/freestyle';
/** Measured by 406: the only media type the resource lists. */
export const DATA_PREVIEW_ACCEPT = 'application/vnd.sap.adt.datapreview.table.v1+xml';
export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;
/** Measured: what the server keeps of each line of the body; the rest of the line is dropped (see above). */
export const MAX_LINE = 255;
/** The parser declares this drift, tools/customizing.mjs files it (same split as transport-requests). */
export const DRIFT_CODE = 'SHAPE_DRIFT';

/**
 * ⚠️ THE DELIVERY CLASS IS NOT THE ENTRY CRITERION, and a rule over it was measured and refused
 * (docs/security.md). Two readings close it. The class does not even describe this list:
 * `T683S` is `C`, but `TFRM` and `TVCPA` are `G` and `T681` is `W` -- a SYSTEM table -- so a
 * "class C" rule drops tables the consumer needs, and widening it to `C+E+G+W` admits nearly the
 * whole dictionary. And class `C` says nothing about content: a customer table of class `C` can
 * hold sensitive personal data (a recruitment table with date of birth and ethnicity fields is
 * class `C` as easily as a table of time-sheet constants). A table enters this list because a
 * named consumer needs it and a person read its fields -- `npm run propose:table -- <TABLE>`
 * prints that evidence and the entry to add.
 *
 * The closed list has two layers, and both are closed:
 *   - the SAP-standard tables, in data/defaults/customizing-tables.json -- versioned, reviewed in
 *     a diff, the same in every installation;
 *   - the installation's own tables (customer Z/Y tables), added with `npm run config -- table
 *     add` into the environment store and installed at start by `installCustomizingTables`,
 *     through the SAME validation. Nothing reaches the list any other way.
 * `why` is the consumer that needs the table; `routineColumns` maps the columns that carry a VOFM
 * routine NUMBER to the VOFM group (`grpze` of lib/vofm-groups.mjs) -- a regex source matches
 * several columns of one family. `keyColumns` (optional) is what the usage sweep prints as the
 * row's key; absent, the first columns after MANDT are used, since a transparent table lists its
 * key first.
 */
const IDENT = /^[A-Z0-9_/]{1,30}$/;

export class CustomizingTableViolation extends Error {
  constructor(message, key) {
    super(message);
    this.name = 'CustomizingTableViolation';
    this.key = key;
  }
}

/** Validate one table entry; returns the normalized entry or throws. Used for defaults AND extras. */
export function validateCustomizingTable(entry, { origin = 'entry' } = {}) {
  const fail = (msg, key = 'name') => {
    throw new CustomizingTableViolation(`${origin}: ${msg}`, key);
  };
  if (!entry || typeof entry !== 'object') fail('not an object');
  const name = String(entry.name ?? '').toUpperCase();
  if (!IDENT.test(name)) fail(`table name '${entry.name}' is not an identifier (A-Z 0-9 _ /, 1-30 chars)`);
  const why = String(entry.why ?? '').trim();
  if (!why) fail(`${name}: 'why' is required -- the consumer that needs the table`, 'why');
  if (why.length > 300) fail(`${name}: 'why' is longer than 300 characters`, 'why');
  const routineColumns = {};
  for (const [column, group] of Object.entries(entry.routineColumns ?? {})) {
    if (!IDENT.test(column)) {
      try {
        new RegExp(column);
      } catch (e) {
        fail(`${name}: routine column '${column}' is neither an identifier nor a valid regex source (${e.message})`, 'routineColumns');
      }
    }
    // Only a group lib/vofm-groups.mjs knows: a typo here would make the usage sweep read the
    // column against a group that does not exist and report "no usage".
    if (!groupOf(group)) fail(`${name}: routine column '${column}' names '${group}', not a VOFM group (lib/vofm-groups.mjs)`, 'routineColumns');
    routineColumns[column] = String(group);
  }
  const keyColumns = entry.keyColumns === undefined ? undefined : entry.keyColumns;
  if (keyColumns !== undefined) {
    if (!Array.isArray(keyColumns) || keyColumns.some((c) => !IDENT.test(String(c).toUpperCase()))) {
      fail(`${name}: keyColumns must be an array of identifiers`, 'keyColumns');
    }
  }
  // A FIELD ALLOWLIST (2026-11-09, docs/security.md): a table whose other columns must never be
  // read -- a user id, a change author -- lists the columns a SELECT may name. `*` then means
  // exactly these. `filterOnly` columns may appear in a WHERE and never in the select list (the
  // owner of a local check variant decides which rows are read, and is never returned).
  const idents = (key) => {
    const v = entry[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.length || v.some((c) => !IDENT.test(String(c).toUpperCase()))) {
      fail(`${name}: ${key} must be a non-empty array of identifiers`, key);
    }
    return v.map((c) => String(c).toUpperCase());
  };
  const fields = idents('fields');
  const filterOnly = idents('filterOnly');
  if (filterOnly && !fields) fail(`${name}: filterOnly needs a fields allowlist`, 'filterOnly');
  if (filterOnly?.some((c) => fields.includes(c))) fail(`${name}: a filterOnly column is also a selectable field`, 'filterOnly');
  const out = { why, routineColumns };
  if (keyColumns?.length) out.keyColumns = keyColumns.map((c) => String(c).toUpperCase());
  if (fields) out.fields = fields;
  if (filterOnly) out.filterOnly = filterOnly;
  return [name, out];
}

function loadStandard() {
  const file = new URL('../data/defaults/customizing-tables.json', import.meta.url);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const entries = doc.tables.map((t) => validateCustomizingTable(t, { origin: 'data/defaults/customizing-tables.json' }));
  const names = new Set();
  for (const [n] of entries) {
    if (names.has(n)) throw new CustomizingTableViolation(`data/defaults/customizing-tables.json lists ${n} twice`, 'name');
    names.add(n);
  }
  return entries;
}

const STANDARD = loadStandard();
/** The SAP-standard names, frozen: an installation can add tables, never redefine these. */
export const STANDARD_CUSTOMIZING_TABLES = Object.freeze(new Set(STANDARD.map(([n]) => n)));
/** The live list the fence checks: standard + the installation's tables. */
export const CUSTOMIZING_TABLES = new Map(STANDARD);

/**
 * Install the installation's own tables (from the environment store). Replaces any previous
 * install, so calling it twice never accumulates. A name that is already standard, or an entry
 * the validation refuses, throws -- the server does not start on a fence it cannot vouch for.
 */
export function installCustomizingTables(extra = []) {
  const validated = extra.map((t) => validateCustomizingTable(t, { origin: 'customizing table' }));
  for (const [n] of validated) {
    if (STANDARD_CUSTOMIZING_TABLES.has(n)) {
      throw new CustomizingTableViolation(`customizing table: ${n} is already in the standard list (data/defaults/customizing-tables.json)`, 'name');
    }
  }
  CUSTOMIZING_TABLES.clear();
  for (const [n, spec] of STANDARD) CUSTOMIZING_TABLES.set(n, spec);
  for (const [n, spec] of validated) CUSTOMIZING_TABLES.set(n, spec);
  return CUSTOMIZING_TABLES;
}

/** What a WHERE value may contain: what a customizing key holds. The quote is the one char doubled, never refused. */
const VALUE = /^[A-Za-z0-9_ \/.:*+\-']{0,60}$/;
const OPS = new Set(['=', '<>', 'IN', 'LIKE']);

/**
 * LIKE (2026-11-09, docs/security.md; measured: LIKE and ESCAPE are accepted and the echo is the
 * statement sent). The caller never writes a LIKE pattern: it sends a SEARCH pattern -- a name
 * with `*` anywhere -- from an alphabet with no quote, blank, `#`, `%`, parenthesis or operator,
 * so it can neither close the literal nor add a condition. The module writes the literal: `*`
 * becomes `%`, and the name's own `_` (a LIKE wildcard: `Z_%` matched every Z name, measured)
 * is escaped with `#`. ESCAPE is always written, and always `'#'`.
 */
export const LIKE_PATTERN = /^[A-Z0-9_/*]{1,30}$/;
export function likeLiteral(pattern) {
  const p = String(pattern ?? '').toUpperCase();
  if (!LIKE_PATTERN.test(p)) {
    throw new SelectViolation(`search pattern '${String(pattern).slice(0, 40)}' is not a name with * wildcards (${LIKE_PATTERN}).`);
  }
  return `'${p.replace(/_/g, '#_').replace(/\*/g, '%')}' ESCAPE '#'`;
}

export class SelectViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelectViolation';
  }
}

const ident = (s, what) => {
  const v = String(s ?? '').toUpperCase();
  if (!IDENT.test(v)) throw new SelectViolation(`${what} '${s}' is not an identifier (A-Z 0-9 _ /, 1-30 chars).`);
  return v;
};
const literal = (v) => {
  const s = String(v ?? '');
  if (!VALUE.test(s)) throw new SelectViolation(`value '${s.slice(0, 40)}' carries a character the grammar does not allow.`);
  return `'${s.replace(/'/g, "''")}'`;
};

/**
 * Lay atoms out the way the reader would write them: blank-separated, a line break wherever
 * the next atom would push the line past MAX_LINE. An atom is never split, so no literal and
 * no identifier straddles a break. Continuation lines are indented: a `*` or `"` at column 1
 * is an ABAP comment, and no line has to be read twice to know it is not one.
 */
function layout(atoms) {
  const lines = [];
  let line = '';
  for (const a of atoms) {
    if (line && line.length + 1 + a.length > MAX_LINE) {
      lines.push(line);
      line = `  ${a}`;
    } else {
      line = line ? `${line} ${a}` : a;
    }
  }
  lines.push(line);
  const long = lines.find((l) => l.length > MAX_LINE);
  // Unreachable through this grammar (an identifier is <= 30, a value <= 60 doubled); kept so a
  // grammar change cannot reopen the silent cut.
  if (long) throw new SelectViolation(`a line of ${long.length} characters cannot be sent: the data preview keeps ${MAX_LINE} per line and drops the rest in silence.`);
  return lines.join('\n');
}

/**
 * Build the SELECT the data preview runs, from a closed grammar. Returns `{ sql, rows,
 * table }`; throws `SelectViolation` before any socket for a table outside the list, a bad
 * identifier, an operator not in {=, <>, IN, LIKE}, a value outside the allowed characters, a field
 * outside the table's allowlist, or a
 * row count outside 1..MAX_ROWS. A statement that fits one line is one line; a longer one is
 * broken between tokens into lines of at most MAX_LINE (the server cuts each line there).
 */
export function buildSelect({ table, fields, where, rows } = {}) {
  const t = ident(table, 'table');
  if (!CUSTOMIZING_TABLES.has(t)) {
    throw new SelectViolation(
      `table ${t} is not in the customizing allow-list (${[...CUSTOMIZING_TABLES.keys()].join(', ')}); ` +
        'the list is closed (data/defaults/customizing-tables.json plus the tables this installation ' +
        'added) and docs/security.md says why. To propose it: ' +
        `\`npm run propose:table -- ${t}\` prints its delivery class, its field list and the entry to ` +
        'add -- a standard table by commit, reviewed in a diff; a customer table with ' +
        '`npm run config -- table add`. Never by a rule.'
    );
  }
  // Atoms: the pieces a line break may fall between. Commas ride on the atom before them, and
  // `F IN (` rides on the first value, so a statement that fits one line reads exactly as
  // `SELECT A, B FROM T WHERE F IN ('1', '2')`.
  const spec = CUSTOMIZING_TABLES.get(t);
  const atoms = ['SELECT'];
  if (fields !== undefined && fields !== null) {
    if (!Array.isArray(fields) || !fields.length) throw new SelectViolation('fields must be a non-empty array, or absent for *.');
    const cols = fields.map((f) => ident(f, 'field'));
    const outside = spec.fields ? cols.filter((c) => !spec.fields.includes(c)) : [];
    if (outside.length) {
      throw new SelectViolation(`${t} may be read only for ${spec.fields.join(', ')} (docs/security.md); not ${outside.join(', ')}.`);
    }
    atoms.push(...cols.map((c, i) => (i < cols.length - 1 ? `${c},` : c)));
  } else if (spec.fields) {
    // `*` on a table with an allowlist is the allowlist, never every column.
    atoms.push(...spec.fields.map((c, i) => (i < spec.fields.length - 1 ? `${c},` : c)));
  } else {
    atoms.push('*');
  }
  atoms.push('FROM', t);
  const conds = [];
  for (const c of where ?? []) {
    const f = ident(c?.field, 'where.field');
    if (spec.fields && !spec.fields.includes(f) && !spec.filterOnly?.includes(f)) {
      throw new SelectViolation(`${t} may be filtered only on ${[...spec.fields, ...(spec.filterOnly ?? [])].join(', ')}; not ${f}.`);
    }
    const op = String(c?.op ?? '=').toUpperCase();
    if (!OPS.has(op)) throw new SelectViolation(`operator '${c?.op}' is not one of =, <>, IN, LIKE.`);
    if (op === 'LIKE') {
      if (Array.isArray(c.value)) throw new SelectViolation(`LIKE on ${f} takes one search pattern, not an array.`);
      conds.push([`${f} LIKE ${likeLiteral(c.value)}`]);
    } else if (op === 'IN') {
      if (!Array.isArray(c.value) || !c.value.length) throw new SelectViolation(`IN on ${f} needs a non-empty array of values.`);
      const vals = c.value.map(literal);
      conds.push(vals.map((v, i) => `${i === 0 ? `${f} IN (` : ''}${v}${i < vals.length - 1 ? ',' : ')'}`));
    } else {
      if (Array.isArray(c.value)) throw new SelectViolation(`${op} on ${f} takes one value, not an array.`);
      conds.push([`${f} ${op} ${literal(c.value)}`]);
    }
  }
  conds.forEach((cond, i) => atoms.push(i === 0 ? 'WHERE' : 'AND', ...cond));
  const n = rows === undefined || rows === null ? DEFAULT_ROWS : Number(rows);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw new SelectViolation(`rows must be an integer from 1 to ${MAX_ROWS}.`);
  return { table: t, rows: n, sql: layout(atoms) };
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Refuse rows the server did not select the way they were asked. The reply echoes the
 * statement it ran (`executedQueryString`: the SELECT sent, then the `INTO TABLE ... UP TO N
 * ROWS .` it appends, spaced its own way). If that echo does not start with the statement
 * sent, the server ran something else -- measured: a truncated WHERE, status 200.
 * An absent echo cannot prove anything either, so it is refused the same way.
 */
export function assertRanAsSent(sql, executedQuery) {
  const sent = squash(sql);
  const ran = squash(executedQuery);
  if (executedQuery !== null && executedQuery !== undefined && ran.startsWith(`${sent} INTO `)) return;
  const err = new Error(
    executedQuery === null || executedQuery === undefined
      ? 'the data preview answered without executedQueryString: no proof the statement sent is the one that ran; rows refused'
      : `the data preview ran a different statement than the one sent -- rows refused. Sent: ${sent} | ran: ${ran}`
  );
  err.name = 'QueryAltered';
  throw err;
}

/**
 * The POST. Takes the RAW client (the guarded one has no such method, by design), a SQL
 * built by `buildSelect` and nothing else -- the function refuses a string that does not
 * start with `SELECT ` and a table it cannot see in the allow-list, so a caller that
 * bypasses `buildSelect` still cannot reach another table through it.
 */
export async function previewPost(rawClient, sql, rows) {
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new SelectViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  }
  // The shape is checked on the statement with its line breaks folded (buildSelect breaks a
  // long one); a line the server would cut, or one that opens like an ABAP comment, is refused.
  const text = String(sql);
  const lines = text.split('\n');
  const m = /^SELECT .+ FROM ([A-Z0-9_/]{1,30})(?: WHERE .+)?$/.exec(squash(text));
  if (!m || !CUSTOMIZING_TABLES.has(m[1]) || /[\r;]/.test(text) || lines.some((l) => l.length > MAX_LINE || /^[*"]/.test(l))) {
    throw new SelectViolation('previewPost accepts only a SELECT built by buildSelect on an allow-listed table.');
  }
  // The second statement of the field allowlist: a SELECT that did not come from buildSelect
  // still cannot name a column the table does not admit, or `*`.
  const allowed = CUSTOMIZING_TABLES.get(m[1]).fields;
  if (allowed) {
    const list = /^SELECT (.+?) FROM /.exec(squash(text))?.[1] ?? '';
    const cols = list.split(',').map((c) => c.trim());
    if (cols.some((c) => !allowed.includes(c))) {
      throw new SelectViolation(`previewPost: ${m[1]} may be read only for ${allowed.join(', ')}.`);
    }
  }
  const n = Number(rows);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw new SelectViolation(`rows must be an integer from 1 to ${MAX_ROWS}.`);
  const url = `${DATA_PREVIEW_PATH}?rowNumber=${n}`;
  const t0 = Date.now();
  let res;
  try {
    res = await http.request(url, {
      method: 'POST',
      headers: { Accept: DATA_PREVIEW_ACCEPT, 'Content-Type': 'text/plain' },
      body: sql,
    });
  } catch (e) {
    const status = [e?.err, e?.status, e?.response?.status].map(Number).find((x) => Number.isInteger(x) && x >= 100) ?? null;
    const err = new Error(`ADT answered ${status ?? 'no readable status'} for the data preview of ${m[1]}: ${e?.localizedMessage || e?.message || e}`);
    err.status = status;
    err.url = url;
    err.cause = e;
    throw err;
  }
  const body = String(res?.body ?? '');
  return { url, table: m[1], status: Number(res?.status ?? 0), contentType: res?.headers?.['content-type'] ?? null, body, bytes: Buffer.byteLength(body, 'utf8'), ms: Date.now() - t0 };
}

// --- the parser -------------------------------------------------------------------------

// `message` is measured (2026-11-09, docs/adt-api-reference.md, "A literal with FIELDS breaks the
// count"): it comes with `totalRows` 0 when the server could not count the statement, and the
// rows stand. It is known, so it is not drift; it makes the count unknown instead.
const KNOWN_ELEMENTS = new Set(['tableData', 'totalRows', 'isHanaAnalyticalView', 'executedQueryString', 'queryExecutionTime', 'columns', 'metadata', 'dataSet', 'data', 'message']);
const KNOWN_META_ATTRS = new Set(['name', 'type', 'description', 'keyAttribute', 'colType', 'isKeyFigure']);
const unescapeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const text = (xml, el) => {
  const m = new RegExp(`<dataPreview:${el}>([^<]*)</dataPreview:${el}>`).exec(xml);
  return m ? unescapeXml(m[1]) : null;
};

/**
 * Whether a parsed reply may be cut: `true` when the count says so, `'possible'` when the count is
 * unknown and as many rows came back as were asked, `false` otherwise. Every reader of the data
 * preview decides "complete" through this, so an unknown count can never read as "all rows".
 */
export function truncationOf(parsed, rowsAsked) {
  if (parsed.totalRows !== null) return parsed.totalRows > parsed.rows.length;
  return parsed.rows.length >= Number(rowsAsked) ? 'possible' : false;
}

/**
 * Column-major XML -> `{ totalRows, executedQuery, executionTime, columns, rows, drift }`.
 * `rows` are objects keyed by column name, row-major, as many as the shortest column
 * (a column with a different count is drift). Elements and metadata attributes outside
 * the measured set are reported in `drift`, never dropped in silence.
 */
export function parsePreview(xml) {
  const s = String(xml ?? '');
  const drift = [];
  const seen = {};
  for (const m of s.matchAll(/<dataPreview:([A-Za-z]+)[\s/>]/g)) seen[m[1]] = (seen[m[1]] ?? 0) + 1;
  for (const [el, count] of Object.entries(seen)) if (!KNOWN_ELEMENTS.has(el)) drift.push({ node: el, count });

  const columns = [];
  for (const m of s.matchAll(/<dataPreview:columns>([\s\S]*?)<\/dataPreview:columns>/g)) {
    const chunk = m[1];
    const meta = {};
    const metaTag = /<dataPreview:metadata\b([^>]*)\/?>/.exec(chunk)?.[1] ?? '';
    for (const a of metaTag.matchAll(/dataPreview:([A-Za-z]+)="([^"]*)"/g)) {
      if (!KNOWN_META_ATTRS.has(a[1])) drift.push({ node: 'metadata', attribute: a[1], count: 1 });
      meta[a[1]] = unescapeXml(a[2]);
    }
    const values = [...chunk.matchAll(/<dataPreview:data>([^<]*)<\/dataPreview:data>|<dataPreview:data\/>/g)].map((d) => (d[1] === undefined ? '' : unescapeXml(d[1])));
    columns.push({
      name: meta.name ?? null,
      type: meta.type ?? null,
      description: meta.description ?? null,
      keyAttribute: meta.keyAttribute === 'true',
      colType: meta.colType ?? '',
      isKeyFigure: meta.isKeyFigure === 'true',
      values,
    });
  }
  const counts = new Set(columns.map((c) => c.values.length));
  if (counts.size > 1) drift.push({ node: 'dataSet', count: counts.size, where: `columns disagree on the row count: ${[...counts].join('/')}` });
  const n = columns.length ? Math.min(...counts) : 0;
  const rows = Array.from({ length: n }, (_, i) => Object.fromEntries(columns.map((c) => [c.name, c.values[i]])));
  const total = text(s, 'totalRows');
  // A count the reply contradicts is no count: with a `message` the server answered 0 beside the
  // rows it returned (measured), and fewer than the rows in hand is impossible. Unknown, never 0.
  const counted = total === null ? null : Number(total);
  const countUnknown = Boolean(seen.message) || (counted !== null && counted < rows.length);
  return {
    totalRows: countUnknown ? null : counted,
    ...(countUnknown ? { countNote: `the server's row count is not usable here (it answered ${counted ?? 'none'}${seen.message ? ' with a message' : ''}): the total is unknown` } : {}),
    executedQuery: text(s, 'executedQueryString'),
    executionTime: text(s, 'queryExecutionTime'),
    columns: columns.map(({ values, ...c }) => c),
    rows,
    drift,
  };
}

/**
 * Which columns of `table` carry a routine number of which VOFM group, resolved against
 * the columns the server actually returned -- so a declared `/^GRU/` names real columns
 * and a declared column the table does not have is reported, not assumed.
 */
export function routineColumnsOf(table, columnNames) {
  const spec = CUSTOMIZING_TABLES.get(String(table).toUpperCase());
  if (!spec) return { columns: [], missing: [] };
  const out = [];
  const missing = [];
  for (const [key, grpze] of Object.entries(spec.routineColumns)) {
    const isRe = !IDENT.test(key);
    const hits = columnNames.filter((c) => (isRe ? new RegExp(key).test(c) : c === key));
    if (!hits.length) missing.push(key);
    for (const c of hits) out.push({ column: c, grpze });
  }
  return { columns: out, missing };
}

/** A routine number at the width the column returns it (NUMC): `903` in a 7-wide column is `0000903`. */
export const padRoutine = (number, width) => String(number).padStart(Math.max(1, Number(width) || 1), '0');
