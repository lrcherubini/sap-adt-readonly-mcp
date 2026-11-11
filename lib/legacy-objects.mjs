// Legacy objects: the application log objects created in SLG0 and the check variants created in
// transaction SCI. Both work in the system and neither is an ADT repository object, so an ADT
// search for APLO or CHKV never lists them (docs/adt-api-reference.md, "Two kinds of one object"
// and "Legacy objects in their tables"). adt_search reads them from their standard tables through
// the data preview, inside its fence (docs/security.md, "Legacy objects", 2026-11-09):
//
//   APLO  BALOBJ (every log object) minus TADIR R3TR APLO (the ADT ones) = created in SLG0;
//         texts from BALOBJT. Measured: 16 Z rows, 4 APLO, 12 legacy.
//   CHKV  SCICHKV_HD rows with IS_CHKV blank = created in SCI; global (CIUSER blank) and local
//         (CIUSER set) read apart so the owner is never selected; texts of the global ones from
//         SCICHKV_TX. The system check variant can be a LOCAL variant (seen on the dev system).
//
// A read that fails, or reaches the row cap, makes the answer `complete: false`. An empty list is
// "none" only when every read succeeded and was complete.

import {
  buildSelect,
  previewPost,
  parsePreview,
  truncationOf,
  assertRanAsSent,
  LIKE_PATTERN,
  MAX_ROWS,
} from './data-preview.mjs';

/** 'APLO' | 'CHKV' for a facet of those types, else null. */
export function legacyKindOf(objectType) {
  const t = String(objectType ?? '').toUpperCase().split('/')[0];
  return t === 'APLO' || t === 'CHKV' ? t : null;
}

const EXACT = /^[A-Z0-9_/]{1,30}$/;

/** The WHERE condition on `field` for a search query: LIKE for a pattern, = for a name, or null. */
export function conditionFor(field, query) {
  const q = String(query ?? '').trim().toUpperCase();
  if (q.includes('*')) return LIKE_PATTERN.test(q) ? { field, op: 'LIKE', value: q } : null;
  return EXACT.test(q) ? { field, op: '=', value: q } : null;
}

/** ISO logon language -> the one-letter SAP language key the text tables store. */
const SAP_LANGUAGE = { EN: 'E', DE: 'D', PT: 'P', ES: 'S', FR: 'F', IT: 'I', JA: 'J', NL: 'N', ZH: '1', RU: 'R', PL: 'L', CS: 'C' };

export const GUIDANCE = Object.freeze({
  APLO:
    'An application log object created in transaction SLG0: a row of table BALOBJ, not an ADT ' +
    'repository object, so Eclipse ADT cannot open or edit it. Maintain it in SLG0 (subobjects ' +
    'there too). To manage it as a development object, create an Application Log Object (APLO) in ' +
    'the ADT with the same purpose; SLG0 then shows it as modifiable only through the ADT.',
  CHKV:
    'A check variant created in transaction SCI: SAP documents that the ADT cannot display or edit ' +
    'it, yet the ATC runs it by name (adt_atc_run can run it if it is in the configured set). ' +
    'Maintain it in SCI. SAP recommends ADT-based check variants (CHKV): create one in Eclipse ADT ' +
    '(New > ABAP Test Cockpit > Check Variant) to manage the checks as a repository object.',
});

/**
 * Read the legacy objects of one kind matching `query`. `rawClient` is the session's raw client;
 * `gap` files a journal row, `audit` records one read. Never throws for a failed read: the answer
 * says what was not read.
 */
export async function readLegacyObjects(rawClient, kind, query, { language, gap = () => {}, audit = () => {}, rows = MAX_ROWS } = {}) {
  const table = kind === 'APLO' ? 'BALOBJ' : 'SCICHKV_HD';
  const nameField = kind === 'APLO' ? 'OBJECT' : 'CHECKVNAME';
  const cond = conditionFor(nameField, query);
  const base = { kind: kind === 'APLO' ? 'SLG0' : 'SCI', guidance: GUIDANCE[kind] };
  if (!cond) {
    return { ...base, objects: [], complete: false, incomplete: { code: 'NOT_READ', reason: 'query is not a name or a name with * wildcards' }, note: `'${query}' is not a name or a name with * wildcards: the legacy table was not searched` };
  }
  // Which table read was cut at `rows`: the data preview has no offset, so the rest is reached
  // only by a narrower query (`narrowBy`).
  const capped = [];
  const read = async (t, fields, where) => {
    const built = buildSelect({ table: t, fields, where, rows });
    let out;
    try {
      out = await previewPost(rawClient, built.sql, built.rows);
    } finally {
      audit(`${t} rows<=${built.rows}`, out?.bytes ?? 0);
    }
    const parsed = parsePreview(out.body);
    assertRanAsSent(built.sql, parsed.executedQuery);
    if (truncationOf(parsed, built.rows) !== false) capped.push(t);
    return parsed.rows;
  };
  try {
    if (kind === 'APLO') {
      const all = await read('BALOBJ', ['OBJECT'], [cond]);
      const adt = new Set(
        (await read('TADIR', ['OBJ_NAME'], [
          { field: 'PGMID', value: 'R3TR' },
          { field: 'OBJECT', value: 'APLO' },
          conditionFor('OBJ_NAME', query),
        ])).map((r) => r.OBJ_NAME)
      );
      const legacy = all.map((r) => r.OBJECT).filter((n) => !adt.has(n));
      const texts = legacy.length
        ? await read('BALOBJT', ['SPRAS', 'OBJECT', 'OBJTXT'], [{ field: 'OBJECT', op: 'IN', value: legacy }])
        : [];
      const objects = legacy.map((name) => ({ name, description: pickText(texts.filter((t) => t.OBJECT === name), 'SPRAS', 'OBJTXT', language) }));
      return { ...base, table: 'BALOBJ', objects, adtObjectsMatched: adt.size, ...cappedAt(capped, rows) };
    }
    // NULL: ABAP has none, the database does. A column added to a table after its rows were
    // written can hold NULL there, and `IS_CHKV = ' '` does not match NULL -- such a variant would
    // vanish from the answer in silence. So IS_CHKV (not a key) is READ, never filtered on, and a
    // row is legacy unless it says 'X'. Key columns (CIUSER, CHECKVNAME) are NOT NULL in the
    // database, so filtering on them is exact.
    const notChkv = (rows) => rows.filter((r) => r.IS_CHKV !== 'X');
    const global = notChkv(await read('SCICHKV_HD', ['CHECKVNAME', 'CHECKVID', 'IS_CHKV'], [cond, { field: 'CIUSER', value: ' ' }]));
    const local = notChkv(await read('SCICHKV_HD', ['CHECKVNAME', 'IS_CHKV'], [cond, { field: 'CIUSER', op: '<>', value: ' ' }]));
    const ids = [...new Set(global.map((r) => r.CHECKVID))];
    const texts = ids.length
      ? await read('SCICHKV_TX', ['LANGUAGE', 'CHECKVID', 'TEXT'], [{ field: 'CIUSER', value: ' ' }, { field: 'CHECKVID', op: 'IN', value: ids }])
      : [];
    const objects = global.map((r) => ({
      name: r.CHECKVNAME,
      scope: 'global',
      description: pickText(texts.filter((t) => t.CHECKVID === r.CHECKVID), 'LANGUAGE', 'TEXT', language),
    }));
    for (const name of new Set(local.map((r) => r.CHECKVNAME))) {
      objects.push({ name, scope: 'local', description: null });
    }
    return {
      ...base,
      table: 'SCICHKV_HD',
      objects,
      ...cappedAt(capped, rows),
      scopeNote: 'a local variant belongs to one user (never named here); the ATC runs it only for its owner or when it is the system check variant',
    };
  } catch (e) {
    gap({
      code: 'LEGACY_OBJECTS_NOT_READ',
      subject: `${kind} ${query}`,
      detail: `${e?.name ?? 'Error'}: HTTP ${e?.status ?? '?'}: ${e?.message}`,
      impact: `the ${base.kind} ${kind === 'APLO' ? 'log objects' : 'check variants'} matching this query were not read: the ADT hits stand, and NOTHING is said about the legacy ones`,
      fallback: kind === 'APLO' ? 'transaction SLG0' : 'transaction SCI',
    });
    return { ...base, objects: [], complete: false, incomplete: { code: 'NOT_READ', reason: String(e?.message ?? e).slice(0, 200) }, note: `not read: ${e?.message ?? e}` };
  }
}

/** Complete, or the tables a read was cut in, with the way to the rest. */
const cappedAt = (tables, rows) =>
  tables.length
    ? { complete: false, incomplete: { code: 'CAP_REACHED', tables: [...new Set(tables)], limit: rows, truncated: true, narrowBy: ['query'] } }
    : { complete: true };

/** The text in the logon language, else English, else any text, else null. */
function pickText(rows, langField, textField, language) {
  const want = SAP_LANGUAGE[String(language ?? '').toUpperCase()] ?? String(language ?? '').toUpperCase();
  const by = (l) => rows.find((r) => r[langField] === l)?.[textField];
  return by(want) || by('E') || rows.find((r) => r[textField])?.[textField] || null;
}
