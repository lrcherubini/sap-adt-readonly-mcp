// Resolving a name to an ADT URI, when one name means several things.
//
// SAP reuses a technical name across object types constantly, and the first two
// attempts at this both failed for the opposite reason:
//
//   1. Take the first exact-name match. `adt_read_source I_CompanyCodeVH` then
//      returned a CDBO metadata blob where the caller expected CDS source -- wrong
//      content under a right-looking name.
//   2. Refuse whenever more than one type matches. That refuses the *normal* case:
//      measured on the system, `I_PLANTVH` comes back as DDLS/DF **and** STOB/DO, and
//      `I_COMPANYCODEVH` as CDBO + DDLS/DF + STOB/DO -- same package, and the URIs
//      prove the kinship, because the STOB URI is the DDL source URI with a fragment
//      (/ddic/ddl/sources/i_plantvh/source/main#name=i_plantvh). Those are facets of
//      one object: the DDL source, the generated entity, the data-browser view. Every
//      CDS view has them, so rule 2 refused every CDS view.
//
// So: group the hits into logical objects first, then pick the facet that fits the
// caller's intent. Only genuinely distinct objects are worth a warning, and only an
// undecidable tie is worth a refusal.

/** Facet preference per intent, best first. Anything unlisted sorts last. */
const PREFERENCE = {
  // Reading source: the DDL source is the only facet that *has* source. The two include facets
  // sort last on purpose -- they are here so an include RESOLVES, not so it wins a tie against
  // the object that owns it.
  source: [
    'DDLS/DF',
    'CLAS/OC',
    'PROG/P',
    'FUGR/F',
    'TABL/DT',
    'STOB/DO',
    'CDBO',
    'PROG/I',
    'FUGR/I',
  ],
  // Reading metadata / structure: same order works, the base object carries it.
  metadata: ['DDLS/DF', 'CLAS/OC', 'TABL/DT', 'DTEL/DE', 'STOB/DO', 'CDBO'],
};

const upper = (s) => (s ?? '').toUpperCase();

/**
 * The identity of the underlying object, as far as the ADT URI reveals it.
 * `/ddic/ddl/sources/i_plantvh/source/main#name=i_plantvh` and
 * `/ddic/ddl/sources/i_plantvh` collapse to the same key.
 */
export function objectKey(hit) {
  const uri = hit['adtcore:uri'] ?? '';
  const base = uri
    .split('#')[0]
    .replace(/\/source\/main$/, '')
    .replace(/\/$/, '');
  // The data-browser facet lives under a different collection (/databrowser/objects/)
  // for the same object, so URI alone cannot join it; fall back to name + package.
  if (!base) return `${upper(hit['adtcore:name'])}@${upper(hit['adtcore:packageName'])}`;
  return `${base.toLowerCase()}|${upper(hit['adtcore:packageName'])}`;
}

/** Group exact-name hits into logical objects (facets of one object land together). */
export function groupFacets(hits) {
  const byName = new Map();
  for (const hit of hits) {
    // Join on name+package first: that is what makes the CDBO facet, which sits in
    // another ADT collection, group with its DDL source.
    const key = `${upper(hit['adtcore:name'])}@${upper(hit['adtcore:packageName'])}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(hit);
  }
  return [...byName.values()];
}

function pickFacet(facets, intent) {
  const order = PREFERENCE[intent] ?? PREFERENCE.metadata;
  const ranked = [...facets].sort((a, b) => {
    const ia = order.indexOf(a['adtcore:type']);
    const ib = order.indexOf(b['adtcore:type']);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  return ranked[0];
}

/**
 * Choose one hit out of the exact-name matches.
 *
 * @returns {{hit: object, facets: string[], alternatives: object[], warning?: string}}
 * @throws when the choice is genuinely undecidable.
 */
export function resolveFacets(exact, intent = 'metadata') {
  const groups = groupFacets(exact);

  if (groups.length === 1) {
    const facets = groups[0];
    const hit = pickFacet(facets, intent);
    return {
      hit,
      facets: facets.map((f) => f['adtcore:type']),
      alternatives: [],
    };
  }

  // Genuinely distinct objects: different packages, or unrelated types. Rank them,
  // answer with the best, and say out loud what else carries this name -- refusing
  // here would be unhelpful, and silence would be dishonest.
  const order = PREFERENCE[intent] ?? PREFERENCE.metadata;
  const best = groups
    .map((facets) => pickFacet(facets, intent))
    .sort((a, b) => {
      const ia = order.indexOf(a['adtcore:type']);
      const ib = order.indexOf(b['adtcore:type']);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    });

  const chosen = best[0];
  const rest = best.slice(1);
  const chosenRank = order.indexOf(chosen['adtcore:type']);
  const nextRank = order.indexOf(rest[0]['adtcore:type']);

  // A tie between two unlisted types is the one case where guessing is worse than
  // asking: nothing in the preference order separates them.
  if (chosenRank === -1 && nextRank === -1) {
    throw new Error(
      `'${chosen['adtcore:name']}' names ${groups.length} unrelated objects and none ` +
        `of their types (${best.map((h) => h['adtcore:type']).join(', ')}) is one this ` +
        `server knows how to rank. Pass objectType to say which one you mean.`
    );
  }

  return {
    hit: chosen,
    facets: groups
      .find((g) => g.some((h) => h === chosen))
      .map((f) => f['adtcore:type']),
    alternatives: rest,
    warning:
      `'${chosen['adtcore:name']}' also names ${rest.length} other object(s) in this ` +
      `system: ${rest
        .map((h) => `${h['adtcore:type']} in ${h['adtcore:packageName'] ?? '?'}`)
        .join(', ')}. Answered with ${chosen['adtcore:type']} in ` +
      `${chosen['adtcore:packageName'] ?? '?'}; pass objectType to choose another.`,
  };
}

// The ADT quick search accepts SOME type strings as a facet filter and silently returns nothing
// for others. An empty result is indistinguishable from "does not exist", so passing an
// unsupported type turns a working lookup into a confident false negative.
//
// MEASURED 2026-09-12, fourteen facets, four readings each (docs/adt-api-reference.md, "Quick
// search facets"). Two causes, and they are different:
//   - the library strips the facet before the request leaves (`abap-adt-api` search.js:
//     `objType.replace(/\/.*$/, '')`), so `FUGR/FF` reaches the ADT as `FUGR` and the function
//     module is not a function group -- while a raw GET with `objectType=FUGR%2FFF` DOES return
//     it. Unsearchable through the library, searchable by the ADT: the `quickSearch` route
//     sends the whole facet -- and the reply then carries no description (measured: 285
//     bytes against 341 for the same hit, the difference being the attribute).
//   - `FUGR/I` returns nothing with the full facet AND with the stripped one, for two includes
//     the same search returns, as FUGR/I, with no filter at all. The index itself does not
//     filter that facet. Not curable by sending the facet.
// Rule: do not filter by type when the type is one of these. Resolve without a filter and pick
// the facet -- that is what PREFERENCE is for. `SEARCHABLE_TYPES_MEASURED` is the other half of
// the same measurement, and its test keeps this set from growing by symmetry.
//
// The second cause has a cure and the first has none, so they are two lists: a FACET_ONLY type
// is asked straight through the `quickSearch` route (lib/adt-get.mjs), which sends the facet
// whole -- at the measured price that the reply carries no description.
export const UNSEARCHABLE_REASON = new Map([
  ['FUGR/I', 'the ADT index does not filter this facet (measured with objectType=FUGR/I and =FUGR, both empty)'],
]);
export const UNSEARCHABLE_TYPES = new Set(UNSEARCHABLE_REASON.keys());
export const FACET_ONLY_TYPES = new Map([
  ['FUGR/FF', 'the client library strips the facet to FUGR and the index answers nothing; the ADT answers objectType=FUGR/FF'],
]);
export const FOUND_BY_FACET_CODE = 'FOUND_BY_FACET';

/**
 * Parse `adtcore:objectReferences` -- the quick search reply, measured -- into the
 * same hit shape the client library produces, so the resolver does not care which asked.
 * `adtcore:description` is absent when the request carried a facet; it is reported as null,
 * never as ''.
 */
export function parseObjectReferences(xml) {
  const hits = [];
  for (const m of String(xml ?? '').matchAll(/<adtcore:objectReference\b([^>]*)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[a[1]] = a[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    }
    hits.push({
      'adtcore:uri': attrs['adtcore:uri'] ?? null,
      'adtcore:type': attrs['adtcore:type'] ?? null,
      'adtcore:name': attrs['adtcore:name'] ?? null,
      'adtcore:packageName': attrs['adtcore:packageName'] ?? null,
      'adtcore:description': attrs['adtcore:description'] ?? null,
    });
  }
  return hits;
}

/** Facets measured to filter correctly through the library, one object each. */
export const SEARCHABLE_TYPES_MEASURED = new Map([
  ['PROG/I', 'MV45AFZZ'],
  ['FUGR/F', 'V05C'],
  ['CLAS/OC', 'CL_FDP_EF_PURCHASE_ORD_DPC_EXT'],
  ['PROG/P', 'SAPMV45A'],
  ['DDLS/DF', 'I_PLANTVH'],
  ['TABL/DT', 'VBBE'],
  ['DTEL/DE', 'ZDEMO_DE_BASE'],
  ['DEVC/K', 'ZDEMO_FIN'],
  ['STOB/DO', 'I_PLANTVH'],
  ['CDBO', 'I_COMPANYCODEVH'],
  ['DDLX/EX', 'ZC_DEMOROSTERMONITOR'], // round 14 step 7: 1 hit with the facet, 4 without
]);

// THE QUICK SEARCH CAN SAY "NOTHING" FOR AN OBJECT THAT EXISTS -- and an empty search reads
// exactly like "does not exist". Measured three times on the system: `RV64A953` (VOFM routine, a
// normal TADIR entry, 2026-09-12) and `PCBO1KZ0`/`PCBO1NZ0` (HR includes with no main program,
// 2026-09-12) all answer `[]` to the search and 200 to the direct URI. The cause is not measured
// yet; what IS measured is that most of the gaps the journal recorded in its first weeks
// were "not found" verdicts of this search. So, for the types whose URI is a pure function of
// the name, an empty search is a question and the URI is the second half of the answer.
//
// Only these four: a FUGR/I URI needs the group name, which the include name does not carry,
// and a DDLS URI is derivable but has never been measured to be invisible.
export const DERIVABLE_URI = new Map([
  ['PROG/P', (n) => `/sap/bc/adt/programs/programs/${n}`],
  ['PROG/I', (n) => `/sap/bc/adt/programs/includes/${n}`],
  ['CLAS/OC', (n) => `/sap/bc/adt/oo/classes/${n}`],
  ['FUGR/F', (n) => `/sap/bc/adt/functions/groups/${n}`],
]);

/** The gap code filed when the URI answered and the search did not. See lib/journal-codes.mjs. */
export const FOUND_BY_URI_CODE = 'FOUND_BY_URI';

const encoded = (name) => encodeURIComponent(String(name).toLowerCase());

/**
 * The URIs to try when the search came back empty, in the order the intent prefers.
 * With an explicit type, only that type's URI (or none, if it is not derivable).
 */
export function derivableUris(name, type, intent = 'metadata') {
  const n = encoded(name);
  if (type) {
    const build = DERIVABLE_URI.get(type.toUpperCase());
    return build ? [{ type: type.toUpperCase(), uri: build(n) }] : [];
  }
  const order = PREFERENCE[intent] ?? PREFERENCE.metadata;
  const ranked = [...DERIVABLE_URI.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
  return ranked.map((t) => ({ type: t, uri: DERIVABLE_URI.get(t)(n) }));
}

/**
 * Resolve an object name to its ADT hit. Exact name match only -- no guessing at the
 * name; the ambiguity handled here is about *type*, never about spelling.
 *
 * When the search finds nothing, the derivable URIs are read directly (`objectStructure`,
 * one GET each, stopping at the first that answers). A hit found that way carries
 * `foundBy: 'uri'` and the `structure` already read, so the caller does not read it
 * twice -- and, when `opts.journal` is given, files FOUND_BY_URI so the case stays
 * visible instead of being cured in silence. The package is NOT known on that path:
 * objectStructure keeps only the root attributes, and `adtcore:packageRef` is a child.
 *
 * @returns {{hit: object, facets: string[], alternatives: object[], warning?: string,
 *            foundBy: 'search'|'uri', structure?: object, searchSaid?: string}}
 */
export async function resolveObject(api, name, type, intent = 'metadata', opts = {}) {
  if (type && UNSEARCHABLE_TYPES.has(type.toUpperCase())) {
    throw new Error(
      `'${type}' is not a searchable ADT facet -- the quick search returns an empty list for it ` +
        `(${UNSEARCHABLE_REASON.get(type.toUpperCase())}), which is NOT the same as the object ` +
        `not existing. Resolve '${name}' without a type filter and pick the facet instead.`
    );
  }
  const facet = type ? type.toUpperCase() : undefined;
  const facetOnly = facet !== undefined && FACET_ONLY_TYPES.has(facet);
  // A facet-only type is not asked of the library at all: its answer is measured empty, and an
  // empty answer here would just be a wasted call before the one that works.
  const hits = facetOnly ? [] : await api.searchObject(name, type, 20);
  const exact = hits.filter((h) => upper(h['adtcore:name']) === upper(name));

  if (exact.length) return { ...resolveFacets(exact, intent), foundBy: 'search' };

  // THE SECOND ASK: the same search with the facet the library strips. Only when a facet was
  // given (a bare name has nothing to add), and only through the route that sends it whole.
  if (facet && facet.includes('/') && typeof opts.facetSearch === 'function') {
    const byFacet = (await opts.facetSearch(name, facet)).filter(
      (h) => upper(h['adtcore:name']) === upper(name) && upper(h['adtcore:type']) === facet
    );
    if (byFacet.length) {
      opts.journal?.gap?.({
        code: FOUND_BY_FACET_CODE,
        subject: `${facet} ${upper(name)}`,
        detail:
          (facetOnly
            ? `${facet} is measured empty through the library (${FACET_ONLY_TYPES.get(facet)})`
            : `the library's search answered ${hits.length ? 'only near misses' : 'nothing'} for '${name}' as ${facet}`) +
          '; the quick search with the whole facet answered it',
        impact:
          'the object exists and was read; its description is not available on this path ' +
          '(the facet-filtered reply carries none, measured)',
        fallback: facetOnly ? 'none needed -- this is the measured route for the type' : 'none -- why the stripped search missed it is not measured',
      });
      return { ...resolveFacets(byFacet, intent), foundBy: 'facet' };
    }
  }

  const near = hits.slice(0, 5).map((h) => `${h['adtcore:name']} (${h['adtcore:type']})`);
  const notFound =
    `Object '${name}'${type ? ` of type ${type}` : ''} not found in the system.` +
    (near.length ? ` Closest names: ${near.join(', ')}.` : '');

  const tried = [];
  for (const { type: t, uri } of derivableUris(name, type, intent)) {
    let structure;
    try {
      structure = await api.objectStructure(uri);
    } catch (e) {
      tried.push(`${uri}: ${e?.message ?? e}`);
      continue;
    }
    const meta = structure?.metaData ?? {};
    const hit = {
      'adtcore:name': meta['adtcore:name'] ?? upper(name),
      'adtcore:type': meta['adtcore:type'] ?? t,
      'adtcore:uri': structure?.objectUrl ?? uri,
      'adtcore:description': meta['adtcore:description'] ?? null,
      'adtcore:packageName': null,
    };
    opts.journal?.gap?.({
      code: FOUND_BY_URI_CODE,
      subject: `${hit['adtcore:type']} ${hit['adtcore:name']}`,
      detail:
        `the quick search answered ${hits.length ? 'only near misses' : 'nothing'} for ` +
        `'${name}'; the direct URI ${uri} answered 200` +
        (tried.length ? ` after ${tried.length} that did not` : ''),
      impact:
        'the object exists and was read, but its package is unknown on this path and any ' +
        'tool that relies on the search (adt_search, sweeps that enumerate) will not list it',
      fallback: 'none -- the cause of the invisibility is not measured',
    });
    return {
      hit,
      facets: [hit['adtcore:type']],
      alternatives: [],
      foundBy: 'uri',
      structure,
      searchSaid: notFound,
    };
  }

  throw new Error(
    notFound +
      (tried.length
        ? ` The direct URI${tried.length > 1 ? 's' : ''} did not answer either: ${tried.join('; ')}.`
        : '')
  );
}
