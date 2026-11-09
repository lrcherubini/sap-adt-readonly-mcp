// Name -> URI resolution, offline. One name meaning several things is the norm in
// SAP, not the exception, and this file pins both failures it already produced.
//
// Failure 1: picking the first exact match returned a CDBO metadata blob where the
// caller asked for CDS source -- wrong content under a right-looking name.
// Failure 2 (commit b6c32d2, mine): refusing whenever more than one type matched.
// Measured on the system, every CDS view matches 2-3 types, because DDLS/DF (the DDL
// source), STOB/DO (the generated entity) and CDBO (the data-browser view) are
// facets of ONE object -- so that rule refused every CDS view. The cases below are
// real searchObject replies from the development system.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFacets, resolveObject, groupFacets, derivableUris, DERIVABLE_URI, UNSEARCHABLE_TYPES, SEARCHABLE_TYPES_MEASURED, FACET_ONLY_TYPES, parseObjectReferences } from '../lib/resolve.mjs';

const hit = (name, type, pkg, uri) => ({
  'adtcore:name': name,
  'adtcore:type': type,
  'adtcore:packageName': pkg,
  'adtcore:uri': uri ?? `/sap/bc/adt/ddic/ddl/sources/${name.toLowerCase()}`,
});

const fakeApi = (hits) => ({ searchObject: async () => hits });

// Verbatim from the system: two facets, same package, the STOB URI being the DDL source
// URI plus a fragment.
const I_PLANTVH = [
  hit('I_PLANTVH', 'DDLS/DF', 'ODATA_MM_IM', '/sap/bc/adt/ddic/ddl/sources/i_plantvh'),
  hit(
    'I_PLANTVH',
    'STOB/DO',
    'ODATA_MM_IM',
    '/sap/bc/adt/ddic/ddl/sources/i_plantvh/source/main#name=i_plantvh'
  ),
];

// Verbatim from the system: three facets, same package, one in another ADT collection.
const I_COMPANYCODEVH = [
  hit('I_COMPANYCODEVH', 'CDBO', 'FINS_FIS_FICO', '/sap/bc/adt/databrowser/objects/i_companycodevh'),
  hit('I_COMPANYCODEVH', 'DDLS/DF', 'FINS_FIS_FICO', '/sap/bc/adt/ddic/ddl/sources/i_companycodevh'),
  hit(
    'I_COMPANYCODEVH',
    'STOB/DO',
    'FINS_FIS_FICO',
    '/sap/bc/adt/ddic/ddl/sources/i_companycodevh/source/main#name=i_companycodevh'
  ),
];

test('a single facet resolves to itself', () => {
  const { hit: found, facets, alternatives } = resolveFacets(
    [hit('I_PLANTSTDVH', 'DDLS/DF', 'MM_IM_VDM_MD')],
    'source'
  );
  assert.equal(found['adtcore:name'], 'I_PLANTSTDVH');
  assert.deepEqual(facets, ['DDLS/DF']);
  assert.deepEqual(alternatives, []);
});

test('DDLS/DF + STOB/DO are one object, and source reading picks the DDL source', () => {
  const { hit: found, facets, alternatives, warning } = resolveFacets(I_PLANTVH, 'source');
  assert.equal(found['adtcore:type'], 'DDLS/DF', 'only the DDL source has source text');
  assert.equal(facets.length, 2, 'both facets are reported, not hidden');
  assert.deepEqual(alternatives, [], 'a facet is not an alternative object');
  assert.equal(warning, undefined, 'the normal case must not warn');
});

test('the three facets of a CDS view do not refuse (regression of b6c32d2)', () => {
  assert.equal(groupFacets(I_COMPANYCODEVH).length, 1, 'one logical object');
  const { hit: found, facets, warning } = resolveFacets(I_COMPANYCODEVH, 'source');
  assert.equal(found['adtcore:type'], 'DDLS/DF');
  assert.equal(facets.length, 3);
  assert.equal(warning, undefined);
});

test('an explicit objectType still wins', async () => {
  // objectType is passed through to searchObject; here the system answers with the
  // one facet, which must resolve without ceremony.
  const api = fakeApi([I_COMPANYCODEVH[1]]);
  const { hit: found } = await resolveObject(api, 'I_CompanyCodeVH', 'DDLS/DF', 'source');
  assert.equal(found['adtcore:type'], 'DDLS/DF');
});

test('genuinely distinct objects answer with the best and say so', () => {
  const clash = [
    hit('ZFOO', 'CLAS/OC', 'ZDEMO_UTILS', '/sap/bc/adt/oo/classes/zfoo'),
    hit('ZFOO', 'TABL/DT', 'ZDEMO_SD', '/sap/bc/adt/ddic/tables/zfoo'),
  ];
  const { hit: found, alternatives, warning } = resolveFacets(clash, 'source');
  assert.equal(found['adtcore:type'], 'CLAS/OC', 'ranked ahead of TABL/DT for source');
  assert.equal(alternatives.length, 1);
  assert.match(warning, /also names 1 other object/);
  assert.match(warning, /TABL\/DT in ZDEMO_SD/, 'the alternative is named, not hidden');
});

test('an undecidable tie refuses instead of guessing', () => {
  const tie = [
    hit('ZBAR', 'XSLT/VT', 'ZDEMO_PKG', '/sap/bc/adt/xslt/zbar'),
    hit('ZBAR', 'ENHO/XHH', 'ZDEMO_SD', '/sap/bc/adt/enhancements/zbar'),
  ];
  assert.throws(
    () => resolveFacets(tie, 'source'),
    /names 2 unrelated objects.*Pass objectType/s
  );
});

test('a name that does not exist lists the near misses, and the URIs it tried', async () => {
  const api = fakeApi([hit('I_PLANTVH', 'DDLS/DF', 'ODATA_MM_IM')]);
  const tried = [];
  api.objectStructure = async (uri) => {
    tried.push(uri);
    throw new Error('404');
  };
  await assert.rejects(
    () => resolveObject(api, 'I_PlantStdVH', undefined, 'source'),
    /not found.*Closest names.*I_PLANTVH.*direct URIs did not answer either/s
  );
  assert.equal(tried.length, DERIVABLE_URI.size, 'every derivable URI was tried before giving up');
});

test('the derivable URIs follow the intent, and an explicit type narrows to one or none', () => {
  assert.deepEqual(
    derivableUris('rv64a953', undefined, 'source').map((x) => x.type),
    ['CLAS/OC', 'PROG/P', 'FUGR/F', 'PROG/I'],
    'the source preference order, includes last'
  );
  assert.deepEqual(derivableUris('RV64A953', 'PROG/I'), [
    { type: 'PROG/I', uri: '/sap/bc/adt/programs/includes/rv64a953' },
  ]);
  assert.deepEqual(derivableUris('I_PLANTVH', 'DDLS/DF'), [], 'a DDLS URI is not derived: never measured invisible');
  assert.deepEqual(derivableUris('L0KBLFZ1', 'FUGR/I'), [], 'a FUGR/I URI needs the group name');
});

test('an empty search is a question: the derivable URI answers, and the answer says how', async () => {
  const api = fakeApi([]);
  api.objectStructure = async (uri) =>
    /programs\/includes\/rv64a953$/.test(uri)
      ? { objectUrl: uri, metaData: { 'adtcore:name': 'RV64A953', 'adtcore:type': 'PROG/I' } }
      : Promise.reject(new Error('404'));
  const gaps = [];
  const journal = { gap: (g) => gaps.push(g) };
  const r = await resolveObject(api, 'rv64a953', undefined, 'source', { journal });
  assert.equal(r.foundBy, 'uri');
  assert.equal(r.hit['adtcore:type'], 'PROG/I');
  assert.equal(r.hit['adtcore:packageName'], null, 'the package is not on this path, and is not invented');
  assert.ok(r.structure, 'the structure read on the way is handed over');
  assert.match(r.searchSaid, /not found/);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].code, 'FOUND_BY_URI');
  assert.match(gaps[0].detail, /after 3 that did not/);
  // Found by search: the same field says so, so a caller never has to guess.
  const bySearch = await resolveObject(fakeApi([hit('X', 'PROG/P', 'P', '/sap/bc/adt/programs/programs/x')]), 'X');
  assert.equal(bySearch.foundBy, 'search');
});

// `FUGR/I` is not a searchable facet: the ADT quick search answers an EMPTY list for it, and empty
// is indistinguishable from "does not exist". Measured on 2026-09-11 with LV05CFZZ and L0KBLFZ1 --
// both found by the SAME search, as FUGR/I, when no filter is passed. Filtering by an unsupported
// type turns a search that works into a confident false negative.
test('refuses to filter by a type the ADT search does not support', async () => {
  const api = { searchObject: async () => assert.fail('must not even reach the search') };
  await assert.rejects(() => resolveObject(api, 'LV05CFZZ', 'FUGR/I', 'source'), /not a searchable/);
});

test('a function-group include resolves when no type filter is passed', async () => {
  // Verbatim answer of a development system to the unfiltered search.
  const api = fakeApi([
    hit('L0KBLFZ1', 'FUGR/I', 'KBE', '/sap/bc/adt/functions/groups/0kbl/includes/l0kblfz1'),
  ]);
  const { hit: chosen } = await resolveObject(api, 'L0KBLFZ1', undefined, 'source');
  assert.equal(chosen['adtcore:type'], 'FUGR/I');
});

test('the owner of the name wins over the include when both exist', async () => {
  // Include facets enter the preference to RESOLVE, not to win over whoever contains them.
  const api = fakeApi([
    hit('X', 'FUGR/I', 'KBE', '/sap/bc/adt/functions/groups/x/includes/x'),
    hit('X', 'PROG/P', 'OTHER', '/sap/bc/adt/programs/programs/x'),
  ]);
  const { hit: chosen } = await resolveObject(api, 'X', undefined, 'source');
  assert.equal(chosen['adtcore:type'], 'PROG/P');
});

// Measured, fourteen facets, four readings each (unfiltered; through the library;
// raw GET with the full facet; raw GET with the stripped major type). The list of the
// unsearchable is closed by measurement and the list of the searchable keeps it from
// growing by symmetry: `FUGR/F` is the sibling of `FUGR/I` and it filters.
test('a facet measured searchable is never refused, and the two unsearchable ones say why', async () => {
  for (const [facet, name] of SEARCHABLE_TYPES_MEASURED) {
    assert.ok(!UNSEARCHABLE_TYPES.has(facet), `${facet} (${name}) filters through the library`);
    const api = fakeApi([hit(name, facet, 'X', `/sap/bc/adt/x/${name.toLowerCase()}`)]);
    const { hit: chosen } = await resolveObject(api, name, facet, 'metadata');
    assert.equal(chosen['adtcore:type'], facet);
  }
  assert.deepEqual([...UNSEARCHABLE_TYPES], ['FUGR/I']);
  assert.deepEqual([...FACET_ONLY_TYPES.keys()], ['FUGR/FF']);
  const api = { searchObject: async () => assert.fail('never reaches the search') };
  await assert.rejects(() => resolveObject(api, 'LV05CFZZ', 'FUGR/I'), /index does not filter/);
});

// The measured reply of the quick search with the whole facet: no description attribute.
const FACET_REPLY =
  '<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:objectReference adtcore:uri="/sap/bc/adt/functions/groups/zdemo/fmodules/z_demo_fm" adtcore:type="FUGR/FF" adtcore:name="Z_DEMO_FM" adtcore:packageName="ZDEMO"/>' +
  '</adtcore:objectReferences>';

test('a function module is asked with the facet whole, never through the library, and the answer says it has no description', async () => {
  const api = { searchObject: async () => assert.fail('FUGR/FF is measured empty through the library: not asked') };
  const asked = [];
  const gaps = [];
  const facetSearch = async (name, facet) => {
    asked.push([name, facet]);
    return parseObjectReferences(FACET_REPLY);
  };
  const out = await resolveObject(api, 'z_demo_fm', 'FUGR/FF', 'metadata', { facetSearch, journal: { gap: (g) => gaps.push(g) } });
  assert.deepEqual(asked, [['z_demo_fm', 'FUGR/FF']]);
  assert.equal(out.foundBy, 'facet');
  assert.equal(out.hit['adtcore:name'], 'Z_DEMO_FM');
  assert.equal(out.hit['adtcore:uri'], '/sap/bc/adt/functions/groups/zdemo/fmodules/z_demo_fm');
  assert.equal(out.hit['adtcore:description'], null, 'absent, reported as null and never as an empty text');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].code, 'FOUND_BY_FACET');
  assert.match(gaps[0].detail, /measured empty through the library/);
});

test('the second ask happens only after an empty first one, only with a facet, and a miss is still a miss', async () => {
  let calls = 0;
  const facetSearch = async () => { calls++; return []; };
  // A hit through the library: the facet route is never consulted.
  const api = fakeApi([hit('SAPMV45A', 'PROG/P', 'VA', '/sap/bc/adt/programs/programs/sapmv45a')]);
  api.objectStructure = async () => Promise.reject(new Error('404'));
  await resolveObject(api, 'SAPMV45A', 'PROG/P', 'metadata', { facetSearch });
  assert.equal(calls, 0);
  // Empty through the library WITH a facet: asked once more; still empty -> not found.
  const empty = fakeApi([]);
  empty.objectStructure = async () => Promise.reject(new Error('404'));
  await assert.rejects(() => resolveObject(empty, 'ZNOPE', 'PROG/P', 'metadata', { facetSearch }), /not found/i);
  assert.equal(calls, 1);
  // A bare name has no facet to add: no second ask.
  await assert.rejects(() => resolveObject(empty, 'ZNOPE', undefined, 'metadata', { facetSearch }), /not found/i);
  assert.equal(calls, 1);
  // A FACET_ONLY type without the route (no raw session): nothing to ask, refused as not found.
  await assert.rejects(() => resolveObject(empty, 'Z_DEMO_FM', 'FUGR/FF', 'metadata', {}), /not found/i);
});

test('parseObjectReferences reads the measured reply shape, with and without the description', () => {
  const withDesc =
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zdemo" adtcore:type="PROG/P" adtcore:name="ZDEMO" adtcore:packageName="ZD" adtcore:description="A &amp; B &lt;demo&gt;"/></adtcore:objectReferences>';
  assert.deepEqual(parseObjectReferences(withDesc), [
    { 'adtcore:uri': '/sap/bc/adt/programs/programs/zdemo', 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZDEMO', 'adtcore:packageName': 'ZD', 'adtcore:description': 'A & B <demo>' },
  ]);
  assert.equal(parseObjectReferences(FACET_REPLY)[0]['adtcore:description'], null);
  assert.deepEqual(parseObjectReferences('<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>'), []);
  assert.deepEqual(parseObjectReferences(''), []);
});
