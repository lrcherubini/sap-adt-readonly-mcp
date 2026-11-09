// Finding the VDM name of a concept when the name of the field cannot reach it.
//
// The gap this closes, measured on the system: field `BaseUnit`, data element `MEINS`,
// domain `MEINS`, value table `T006`. Every concept the field yields -- BaseUnit,
// MEINS -- generates candidate names that exist in no catalogue, while the released
// answer is `I_UnitOfMeasureStdVH`. No amount of string work on the field gets there,
// because the VDM chose a different word. Guessing harder is not the fix; asking the
// system is.
//
// Two routes, cheapest first, both measured live:
//
//   1. TYPE-FILTERED REPOSITORY SEARCH -- the `type:ddls` pre-filter of the Eclipse ADT
//      search, which is `searchObject(query, 'DDLS/DF', max)` here. Anchored on the
//      concept:  I_UNITOFMEASURE*  ->  13 rows / 3.2 KB, and I_UnitOfMeasureStdVH is in
//      them. It finds names the offline form generator never builds (I_UnitOfMeasureTimeVH
//      is not a shape in NAME_FORMS), for ONE cheap call.
//
//   2. VALUE TABLE, WHERE-USED -- only when the concept word itself is wrong, which is
//      exactly the BaseUnit case:
//        T006 --where-used--> 15,963 rows, of which 57 are DDLS/DF and exactly ONE is
//                             released: I_UnitOfMeasure   (the VDM interface view)
//        I_UnitOfMeasure ---> feed that NAME back in as a concept: route 1 and the
//                             offline forms both reach I_UnitOfMeasureStdVH.
//      This one costs two ADT calls and a 3.4 MB reply, so it runs last and only when
//      route 1 came back empty.
//
// ⚠️ Measured gotcha of route 1: the cap truncates ALPHABETICALLY, so a leading-wildcard
// query silently loses the answer -- `*UNITOFMEASURE*` capped at 60 returns 60 rows that
// stop at I_PRODUNITOFMEASURE..., with I_UNITOFMEASURESTDVH cut off and no indication
// that anything was dropped. The query is therefore anchored (`I_CONCEPT*`), never
// `*CONCEPT*`, and truncation is reported when it happens.
//
// ⚠️ What either route returns is a NAME, not an answer. Everything found here re-enters
// the same pipeline as any other candidate: checked against the release catalogue, read,
// and tiered on its own signals. Nothing skips the queue for having been found the
// expensive way.

import { summarizeUsage } from './usage.mjs';

/** Types that can carry a VDM concept view. */
const CDS = ['DDLS/DF'];

/** VDM prefixes worth anchoring a search on. */
const PREFIXES = ['I', 'C'];

/** A concept word out of an entity name: `I_UnitOfMeasure` -> `UNITOFMEASURE`. */
export function conceptFromName(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/^\/[^/]+\//, '') // /DMBE/I_X -> I_X
    .replace(/^[IC]_/, '')
    .replace(/[^A-Z0-9]/g, '');
}

/** VH-shaped names first, then the shortest -- the plain concept view before its satellites. */
const searchRank = (name) => {
  const n = String(name).toUpperCase();
  return (/(STDVH|VH|VALUEHELP)$/.test(n) ? 0 : 1) * 1000 + n.length;
};

/**
 * Route 1: ask the system for the entities whose name starts with the concept.
 *
 * @param {object} api guarded ADT client
 * @param {string} concept e.g. 'UNITOFMEASURE'
 * @param {object} catalog loaded release catalogue
 * @param {{calls:number}} spent mutable ADT call counter
 * @param {{max?:number}} opts
 * @returns {Promise<{ok:boolean, concept:string, queries:string[], hits:number,
 *                    truncated:boolean, names:string[], reason?:string}>}
 */
export async function searchConceptEntities(api, concept, catalog, spent, opts = {}) {
  const max = opts.max ?? 50;
  const queries = PREFIXES.map((p) => `${p}_${concept}*`);
  const names = [];
  let hits = 0;
  let truncated = false;
  for (const query of queries) {
    let rows;
    try {
      rows = await api.searchObject(query, CDS[0], max);
      spent.calls++;
    } catch (e) {
      spent.calls++;
      return { ok: false, concept, queries, hits, truncated, names, reason: `${query}: ${e.message ?? e}` };
    }
    hits += rows.length;
    if (rows.length >= max) truncated = true;
    for (const r of rows) {
      const name = r['adtcore:name'] ?? r.name;
      // Released-only, decided offline: the system search knows nothing about Clean
      // Core, and half of what it returns is another application's model.
      if (name && catalog?.isReleased?.(name) && !names.includes(name)) names.push(name);
    }
  }
  names.sort((a, b) => searchRank(a) - searchRank(b));
  return {
    ok: names.length > 0,
    concept,
    queries,
    hits,
    truncated,
    names,
    ...(names.length
      ? {}
      : {
          reason:
            `${hits} CDS entities start with ${queries.join(' or ')} and none of them is ` +
            'released' + (truncated ? ` (the search hit its cap of ${max}, so the list is partial)` : ''),
        }),
  };
}

/**
 * The released CDS entities that read a DDIC table, best first.
 *
 * Ranking is deliberate: a name WITHOUT a namespace prefix and without an underscore
 * salad is the VDM view; `/DMBE/I_UNIT_OF_MEASURE` and `SEPMRA_I_QUANTITYUNIT` are other
 * applications' or demo content reading the same table, and they must never outrank it.
 */
export function conceptViewsFrom(rows, catalog, { cap = 10 } = {}) {
  const summary = summarizeUsage(rows, { cap: 1000, types: CDS });
  const released = summary.rows.filter((r) => catalog?.isReleased?.(r.name));
  const score = (name) => {
    const n = String(name).toUpperCase();
    let s = 0;
    if (n.startsWith('/')) s += 10; // another namespace: someone else's model
    if (/^(DEMO|SEPM|SADL|ESH_|SEPMRA)/.test(n)) s += 8; // demo / framework content
    if (!/^[IC]_/.test(n)) s += 4; // not a VDM name shape at all
    s += (n.match(/_/g) || []).length; // I_UNIT_OF_MEASURE loses to I_UNITOFMEASURE
    return s;
  };
  const ranked = [...released].sort((a, b) => score(a.name) - score(b.name));
  return {
    total: summary.total,
    cdsCallers: summary.kept,
    released: released.length,
    views: ranked.slice(0, cap).map((r) => ({ name: r.name, package: r.package })),
  };
}

/**
 * Route 2: ask the system which released CDS entity models the concept behind a value
 * table.
 *
 * @param {object} api guarded ADT client
 * @param {string} table the domain's value table, e.g. 'T006'
 * @param {object} catalog loaded release catalogue
 * @param {{calls:number}} spent mutable ADT call counter
 * @param {{resolve:Function, cap?:number}} deps `resolve` is resolveObject, injected so
 *        this module stays testable without the tools layer
 * @returns {Promise<{ok:boolean, table:string, concept?:string, views?:object[],
 *                    scanned?:number, reason?:string, cite?:string}>}
 */
export async function conceptFromValueTable(api, table, catalog, spent, deps = {}) {
  const resolve = deps.resolve;
  if (!table) return { ok: false, table, reason: 'the field has no value table to search from' };
  let hit;
  try {
    ({ hit } = await resolve(api, table, 'TABL/DT', 'metadata'));
    spent.calls++;
  } catch (e) {
    spent.calls++;
    return { ok: false, table, reason: `${table} did not resolve: ${e.message ?? e}` };
  }

  let rows;
  try {
    rows = await api.usageReferences(hit['adtcore:uri']);
    spent.calls++;
  } catch (e) {
    spent.calls++;
    return { ok: false, table, reason: `where-used on ${table} failed: ${e.message ?? e}` };
  }

  const found = conceptViewsFrom(rows, catalog, { cap: deps.cap ?? 10 });
  if (!found.views.length) {
    return {
      ok: false,
      table,
      scanned: found.total,
      reason:
        `${found.total} objects read ${table}, ${found.cdsCallers} of them CDS, and none ` +
        'of those is released. The concept has no released CDS model to point at',
    };
  }
  return {
    ok: true,
    table,
    concept: found.views[0].name,
    views: found.views,
    scanned: found.total,
    cite: `where-used on ${table}: ${found.cdsCallers} CDS callers, ${found.released} released`,
  };
}
