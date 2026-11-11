// WHICH ROWS a transport carries -- the E071K key rows of one object, decoded.
//
// The transport organizer answers "which objects moved". It does not answer "which rows
// of TBZ3R moved", and for a customizing entry that is the whole question: `CDAT
// BUPAFLDMOD` names a maintenance object, and what actually travelled is four rows in
// three tables. `…/transportrequests/<carrier>/objectkeys?objName=..&objType=..` answers
// that, and this module reads it.
//
// MEASURED 2026-09-09 across 151 GETs over six requests and their tasks, cross-checked
// field by field against an export of E070/E071/E071K from the same system. Four
// measurements are load-bearing here, and each one is a defect if ignored:
//
//  1. ⚠️ ADDRESS THE CARRIER, NOT THE REQUEST. A task's keys do not answer on its parent
//     request: (task DEVK900116, TABU MASSFLDLST) -> 200 while (request DEVK900113, the
//     same object reached through that task) -> 400. And the object must be named as
//     tm:abap_object names it -- (CDAT BUPAFLDMOD) -> 200, while the physical table
//     (TABU TBZ3R) and the maintenance view (VDAT V_TBZ3R) both -> 400, even though those
//     are what E071K itself keys by.
//
//  2. ⚠️ A REPLY MIXES TWO KINDS OF KEY, AND ONLY `tk:position` SEPARATES THEM. With a
//     position it is a transported row; without one it is the object's key TEMPLATE. The
//     ACGR role object returns 28 template rows (AGR_1016, AGR_1250, AGR_TCODES …) and
//     E071K holds ZERO ACGR rows, so a parser that took every tk:tableKey as transported
//     would invent 28 entries per role. The wildcard is NOT the discriminator: 23
//     transported keys contain `*` (the seven UST12 rows carry FIELD="*", and they are in
//     the table) and 6 template keys do not.
//
//  3. ✅ THE DECLARED LAYOUT IS THE DDIC'S. tk:keyField carries name/type/length/offset,
//     and for AGR_TIMEB, TBZ3R and MASSFLDLST it reproduces the DDIC key fields in the
//     same order with the same lengths, offsets exactly cumulative; data element AGR_NAME
//     independently reports length 30. So the key is decoded from the payload, and no
//     second call is needed. `verifyOffsets` re-derives the offsets anyway and reports a
//     mismatch rather than trusting it silently.
//
//  4. ⚠️ `tk:type` IS THE ABAP INTERNAL TYPE CLASS, NOT THE DDIC DATA TYPE. MANDT is CLNT
//     in the DDIC and `C` here. Only C and N were seen on any transported key; the two
//     non-character fields in the whole population (AGR_HIER_BOR.UNIQUE_NR type I,
//     CFD_W_REP_SCN_SP.SEQUENCE_NUMBER type b) appear only in templates. Character-offset
//     slicing is therefore correct for everything measured -- and a non-character field is
//     REPORTED rather than sliced, because slicing an integer by characters yields garbage
//     without leaving a leftover to give it away.
//
// One more, about the answer's honesty: HTTP 400 with the six-byte body `I::000` means
// "no keys resolvable for this carrier and this object". It does NOT mean "this object has
// no keys" -- the same status is what a wrong carrier earns. Callers must not translate it
// into an assertion of emptiness, and `adt_transport` does not.

export const DRIFT_CODE = 'SHAPE_DRIFT';

/** Declared from the whole measured population, not from the first payload read. */
export const PROJECTION = {
  object: ['tk:objName', 'tk:objType', 'tk:objPgmId', 'tk:objDesc'],
  keySet: ['tk:isReadOnly'],
  key: ['tk:tableName', 'tk:value', 'tk:position', 'tk:viewName'],
  table: ['tk:name', 'tk:isStringTable'],
  field: ['tk:name', 'tk:type', 'tk:length', 'tk:offset', 'tk:postion', 'tk:label'],
  elements: [
    'tk:objectKeys',
    'tk:tableKeys',
    'tk:tableKey',
    'tk:tables',
    'tk:table',
    'tk:keyField',
    'atom:link',
  ],
};

/**
 * The type classes whose values a character offset addresses correctly.
 * Measured: only these ever occur on a transported key.
 */
const CHARACTER_TYPES = new Set(['C', 'N']);

const DECLARED = {
  'tk:objectKeys': new Set(PROJECTION.object),
  'tk:tableKeys': new Set(PROJECTION.keySet),
  'tk:tableKey': new Set(PROJECTION.key),
  'tk:table': new Set(PROJECTION.table),
  'tk:keyField': new Set(PROJECTION.field),
};
const DECLARED_ELEMENT = new Set(PROJECTION.elements);

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read one objectKeys document.
 *
 * @returns {{object: object, isReadOnly: boolean|null, keys: object[],
 *            tables: object[], counts: object, drift: object[]}}
 */
export function parseObjectKeys(xml) {
  const text = String(xml ?? '');
  const drift = [];
  const tables = new Map();
  const rawKeys = [];
  let object = {};
  let isReadOnly = null;

  // One pass, attribute-aware, so an undeclared attribute OR an undeclared element is
  // reported instead of vanishing. Measured: no element of this resource carries text.
  const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let currentTable = null;
  for (const m of text.matchAll(TAG)) {
    const closing = Boolean(m[1]);
    const tag = m[2];
    const selfClosed = Boolean(m[4]);

    if (!DECLARED_ELEMENT.has(tag)) {
      drift.push({ node: tag, attribute: null, kind: 'undeclared element' });
      continue;
    }
    if (closing) {
      if (tag === 'tk:table') currentTable = null;
      continue;
    }

    const attrs = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      const name = a[1];
      const value = unescapeXml(a[2]);
      const allowed = DECLARED[tag];
      // xmlns declarations are noise, not shape: they are dropped without a drift row.
      if (allowed && !allowed.has(name) && !name.startsWith('xmlns')) {
        drift.push({ node: tag, attribute: name, kind: 'undeclared attribute' });
        continue;
      }
      attrs[name] = value;
    }

    if (tag === 'tk:objectKeys') {
      object = {
        name: attrs['tk:objName'] ?? null,
        type: attrs['tk:objType'] ?? null,
        pgmid: attrs['tk:objPgmId'] ?? null,
        // Missing on 2 of 21 measured replies, so it is optional by measurement.
        desc: attrs['tk:objDesc'] ?? null,
      };
    } else if (tag === 'tk:tableKeys') {
      // Both true and false occur. It describes the CTS editor, not this reader.
      isReadOnly = attrs['tk:isReadOnly'] === 'true' ? true : attrs['tk:isReadOnly'] === 'false' ? false : null;
    } else if (tag === 'tk:tableKey') {
      rawKeys.push(attrs);
    } else if (tag === 'tk:table') {
      currentTable = {
        name: attrs['tk:name'] ?? null,
        isStringTable: attrs['tk:isStringTable'] === 'true',
        fields: [],
      };
      tables.set(currentTable.name, currentTable);
      // A table with no key fields is self-closed; it must be VISIBLE as a table with an
      // empty layout, not absent. (The same shape once cost a whole `tm:task`.)
      if (selfClosed) currentTable = null;
    } else if (tag === 'tk:keyField' && currentTable) {
      currentTable.fields.push({
        name: attrs['tk:name'] ?? null,
        type: attrs['tk:type'] ?? null,
        length: num(attrs['tk:length']),
        offset: num(attrs['tk:offset']),
        // `tk:postion` is spelled that way in the payload. Renamed on the way out, and the
        // misspelling is kept in PROJECTION so it is recognised rather than reported.
        position: num(attrs['tk:postion']),
      });
    }
  }

  const keys = rawKeys.map((k) => {
    const tableName = k['tk:tableName'] ?? null;
    const table = tables.get(tableName) ?? null;
    const value = k['tk:value'] ?? '';
    const position = k['tk:position'] ?? null;
    const decoded = decodeKey(value, table?.fields ?? []);
    for (const w of decoded.warnings) {
      drift.push({ node: 'tk:keyField', attribute: null, kind: w.kind, where: `${tableName} ${w.field ?? ''}`.trim() });
    }
    return {
      table: tableName,
      // E071K-VIEWNAME: the key was maintained through this view rather than on the table.
      // Measured on 8 transported and 0 template keys, so it is optional.
      view: k['tk:viewName'] ?? null,
      // ⚠️ The discriminator. See measurement 2 in the header.
      transported: position !== null,
      position: position === null ? null : num(position),
      value,
      fields: decoded.fields,
      undecoded: decoded.leftover,
      layoutKnown: decoded.layoutKnown,
    };
  });

  const counts = {
    keys: keys.length,
    transported: keys.filter((k) => k.transported).length,
    template: keys.filter((k) => !k.transported).length,
    tables: tables.size,
  };

  return { object, isReadOnly, keys, tables: [...tables.values()], counts, drift };
}

/**
 * Decompose a packed key with the layout the payload declares.
 *
 * Verifying rather than trusting: the offsets are re-derived cumulatively from the
 * declared lengths and a disagreement is reported. Measured agreement on every table
 * read, so a mismatch means the shape aged -- not that this arithmetic is wrong.
 */
export function decodeKey(value, fields) {
  const warnings = [];
  if (!fields?.length) {
    return { fields: [], leftover: '', layoutKnown: false, warnings };
  }
  const out = [];
  let running = 0;
  let covered = 0;
  for (const f of fields) {
    if (f.offset === null || f.length === null) {
      warnings.push({ kind: 'key field without offset or length', field: f.name });
      return { fields: [], leftover: value, layoutKnown: false, warnings };
    }
    if (f.offset !== running) {
      warnings.push({ kind: 'declared offset is not cumulative', field: f.name });
    }
    running += f.length;
    covered = Math.max(covered, f.offset + f.length);

    const slice = String(value).slice(f.offset, f.offset + f.length);
    const character = CHARACTER_TYPES.has(f.type);
    if (!character) {
      // Never slice what a character offset does not address. Reporting the raw span and
      // refusing to name a value is the honest answer; a wrong slice on an integer leaves
      // no leftover behind to reveal it.
      warnings.push({ kind: 'non-character key field, not decoded', field: f.name });
    }
    out.push({
      name: f.name,
      type: f.type,
      length: f.length,
      offset: f.offset,
      value: character ? slice.replace(/\s+$/, '') : null,
      raw: slice,
      decoded: character,
      // The measured meaning of `*` in a transported key: a generic range, not a gap.
      generic: character && slice.trim() === '*',
    });
  }
  const leftover = String(value).slice(covered);
  if (leftover.trim()) warnings.push({ kind: 'key value longer than its declared layout', field: null });
  return { fields: out, leftover, layoutKnown: true, warnings };
}

/** A one-line rendering of a decoded key: `TBZ3R: CLIENT=<nnn> OBJAP=BUPA …`. */
export function describeKey(key) {
  if (!key.layoutKnown) return `${key.table}: ${JSON.stringify(key.value)} (layout unknown)`;
  const parts = key.fields
    .filter((f) => f.decoded)
    .map((f) => `${f.name}=${f.value === '' ? '""' : f.value}`);
  const undecodable = key.fields.filter((f) => !f.decoded).map((f) => `${f.name}=?`);
  return `${key.table}: ${[...parts, ...undecodable].join(' ')}`;
}

/**
 * The object types measured to answer `400 I::000` for every carrier tried
 * -- 109 of the sweep's objects.
 *
 * Since the domain OBJFUNC was read (2026-09-10), this census is no longer what decides
 * whether an object is asked: the SYSTEM says so, on the entry itself -- `tm:obj_func="K"`
 * is "this entry has rows in the key list", and offline it matched E071K 136/136 and
 * 14/14 (lib/transport-requests.mjs, OBJ_FUNC). The census is kept as a FALSIFIER: a K on
 * one of these types, or transported keys on an entry that is not K, is SHAPE_DRIFT --
 * the measurement aged, and the reader is told instead of the answer quietly moving.
 *
 * It still decides in one case: an entry with NO tm:obj_func attribute at all. Measured,
 * absence is the blank of E071 (attribute omitted, like tm:wbtype) -- but the blank case
 * was never seen on a type outside this census with transported keys, only with key
 * TEMPLATES (ACGR, 28 of them, E071K holds none). So a blank entry of a census type is
 * skipped, and a blank entry of any other type is ATTEMPTED, because absence from a
 * census is not evidence. Every object says which of the three paths it took.
 */
export const TYPES_MEASURED_WITHOUT_KEYS = new Set([
  'DDLS', 'DEVC', 'DOMA', 'DTEL', 'FUGR', 'TABL', 'CINC', 'CLSD', 'CPRI', 'CPRO', 'CPUB',
]);

/**
 * Whether to ask the keys of one object, and on whose word.
 *
 * @returns {{ask:boolean, by:'objFunc'|'census'|'unmeasured', drift?:object}}
 *   `by` names the evidence: `objFunc` = the entry's own tm:obj_func decided;
 *   `census` = no attribute, the type is in TYPES_MEASURED_WITHOUT_KEYS; `unmeasured` =
 *   no attribute and no census, so it is attempted.
 */
export function keyDecision(obj) {
  const code = obj?.objFunc?.code;
  const inCensus = TYPES_MEASURED_WITHOUT_KEYS.has(obj?.type);
  if (code === 'K') {
    return {
      ask: true,
      by: 'objFunc',
      ...(inCensus
        ? {
            drift: {
              node: 'tm:abap_object',
              attribute: 'tm:obj_func',
              kind: 'obj_func K on a type measured without keys',
              where: `${obj.type} ${obj.name}`,
            },
          }
        : {}),
    };
  }
  if (code !== undefined && code !== null) return { ask: false, by: 'objFunc' };
  return inCensus ? { ask: false, by: 'census' } : { ask: true, by: 'unmeasured' };
}

/** From the measured envelope: 26 keys in the largest single reply, 164 over six requests. */
export const MAX_KEY_LOOKUPS = 25;
/** The most lookups one call may ask for: every one is an ADT call. */
export const KEY_LOOKUPS_CEILING = 100;
export const MAX_KEYS_PER_OBJECT = 200;
/** The most keys listed per object in one answer. */
export const KEYS_PER_OBJECT_CEILING = 2000;
/** Why an object's keys were not read: a closed list. */
export const KEY_REASONS = Object.freeze(['400', 'budget', 'error']);

/**
 * Ask the keys of many objects, one carrier at a time.
 *
 * @param fetchKeys  async (carrier, object) => {body}. Injected so this is testable
 *                   without HTTP and so the ONE place that speaks to ADT stays in
 *                   lib/adt-get.mjs.
 * @param objects    the union produced by unionObjects(), `sources` included -- that
 *                   field is what names the carrier, and getting the carrier wrong is
 *                   indistinguishable from "no keys".
 */
export async function collectObjectKeys(fetchKeys, objects, requestNumber, opts = {}) {
  const maxLookups = Math.min(capOf(opts.maxLookups, MAX_KEY_LOOKUPS), KEY_LOOKUPS_CEILING);
  const maxKeys = Math.min(capOf(opts.maxKeysPerObject, MAX_KEYS_PER_OBJECT), KEYS_PER_OBJECT_CEILING);
  // A page of the objects to ask, counted over the askable ones in list order: `offset` starts
  // after the ones an earlier call asked, and `nextOffset` is the first one this call did not.
  const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;

  const results = [];
  const drift = [];
  const skippedByType = new Map();
  let lookups = 0;
  let notAttempted = 0;
  let beforeOffset = 0;
  let askable = -1;
  let nextOffset = null;

  for (const obj of objects) {
    const decision = keyDecision(obj);
    if (decision.drift) drift.push(decision.drift);
    if (!decision.ask) {
      const k = `${obj.type}|${decision.by}`;
      const row = skippedByType.get(k) ?? { type: obj.type, by: decision.by, count: 0 };
      row.count += 1;
      skippedByType.set(k, row);
      continue;
    }
    askable += 1;
    if (askable < offset) {
      beforeOffset += 1;
      continue;
    }
    if (lookups >= maxLookups) {
      notAttempted += 1;
      if (nextOffset === null) nextOffset = askable;
      continue;
    }

    const carriers = carriersOf(obj, requestNumber);
    const tried = [];
    let answer = null;
    let lastRefusal = null;
    let outOfBudget = false;
    for (const carrier of carriers) {
      if (lookups >= maxLookups) {
        outOfBudget = true;
        break;
      }
      lookups += 1;
      tried.push(carrier);
      let res;
      try {
        res = await fetchKeys(carrier, obj);
      } catch (e) {
        const status = e?.status ?? null;
        lastRefusal = { carrier, status, message: e?.message ?? String(e) };
        // ⚠️ 400 is also what a WRONG CARRIER earns, so it is a reason to try the next
        // carrier -- never a conclusion about the object.
        if (status === 400) continue;
        break;
      }
      const doc = parseObjectKeys(res?.body ?? res ?? '');
      for (const d of doc.drift) drift.push({ ...d, where: `${obj.type} ${obj.name}` });
      answer = { carrier, doc };
      break;
    }

    if (!answer) {
      // The reason, from a closed list: every carrier tried answered 400, the budget ran out
      // before every carrier was tried (the object is asked again on the next page), or an
      // error other than 400 stopped it.
      const reason = outOfBudget ? 'budget' : lastRefusal?.status === 400 ? '400' : 'error';
      if (outOfBudget && nextOffset === null) nextOffset = askable;
      results.push({
        pgmid: obj.pgmid,
        type: obj.type,
        name: obj.name,
        askedBy: decision.by,
        carriersTried: tried,
        carriersNotTried: carriers.length - tried.length,
        status: lastRefusal?.status ?? null,
        reason,
        keys: null,
        // The sentence exists because the measurement forced it: the same status means
        // "wrong carrier" and "this object carries no table keys", and the resource does
        // not distinguish them.
        note:
          reason === 'budget'
            ? 'the lookup budget ran out before every carrier of this object was tried'
            : reason === '400'
              ? 'no keys resolvable for this object on any carrier tried -- this is NOT ' +
                'evidence that the object carries none'
              : `the keys could not be read: ${lastRefusal?.message ?? 'no answer'}`,
      });
      continue;
    }

    const keys = answer.doc.keys.slice(0, maxKeys);
    if (decision.by !== 'objFunc' && answer.doc.counts.transported > 0) {
      // The system did not say K and yet rows moved. Not an error in the answer -- the
      // rows are real -- but the predicate this sweep now rests on has a counter-example.
      drift.push({
        node: 'tk:tableKey',
        attribute: 'tk:position',
        kind: 'transported keys on an entry without obj_func K',
        where: `${obj.type} ${obj.name}`,
      });
    }
    results.push({
      pgmid: obj.pgmid,
      type: obj.type,
      name: obj.name,
      askedBy: decision.by,
      carrier: answer.carrier,
      status: 200,
      isReadOnly: answer.doc.isReadOnly,
      counts: answer.doc.counts,
      keys: keys.map((k) => ({
        table: k.table,
        ...(k.view ? { view: k.view } : {}),
        // ⚠️ Both kinds are returned, and this flag is the only thing that separates
        // them. A template is the object's key LAYOUT, not a row that moved.
        transported: k.transported,
        ...(k.transported ? { position: k.position } : {}),
        decoded: describeKey(k),
        fields: k.fields.map((f) => ({
          name: f.name,
          ...(f.decoded ? { value: f.value } : { raw: f.raw, notDecoded: f.type }),
          ...(f.generic ? { generic: true } : {}),
        })),
        ...(k.undecoded.trim() ? { undecoded: k.undecoded } : {}),
        ...(k.layoutKnown ? {} : { layoutKnown: false }),
      })),
      keysTotal: answer.doc.keys.length,
      truncated: answer.doc.keys.length > keys.length,
      ...(answer.doc.keys.length > keys.length ? { narrowBy: ['maxKeysPerObject'] } : {}),
    });
  }

  return {
    objects: results,
    lookups,
    maxLookups,
    maxKeys,
    offset,
    beforeOffset,
    nextOffset,
    drift,
    skipped: [...skippedByType.values()].sort(
      (a, b) => b.count - a.count || a.type.localeCompare(b.type)
    ),
    notAttempted,
  };
}

/**
 * ⚠️ The carrier is the task the object is attributed to, not the request that owns the
 * task -- measured, and the single most expensive thing to get wrong here. When an object
 * IS in the request's own list, the request is tried first and the task is the fallback.
 */
export function carriersOf(object, requestNumber) {
  const out = [];
  for (const s of object.sources ?? []) {
    const carrier = s === 'request' ? requestNumber : s;
    if (carrier && !out.includes(carrier)) out.push(carrier);
  }
  return out.length ? out : [requestNumber];
}

const capOf = (given, fallback) => {
  const n = Number(given);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
