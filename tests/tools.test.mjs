// The five original handlers, closed with a doubled api.
//
// Every one of them was undiscovered until now: `buildTools` was imported by no test,
// so the mapping, the caps and the refusals were only ever exercised against the real
// DEV. What is asserted here is both halves of each handler -- the answer AND the ADT
// calls it made, because half of this server's design is *not* calling the system.
//
// The ADTClient statics (`mainInclude`, `classIncludes`) are NOT stubbed. They are pure
// functions over the object structure, so the double returns structures in the measured
// ADT shape and the real statics run over them -- which is the only way this test can
// catch a change in that glue.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTools, argumentErrors } from '../tools/index.mjs';
import { resetBudget } from '../lib/audit.mjs';
import { installAtcVariants, ATC_VARIANTS as ATC_VARIANTS_LIVE } from '../lib/atc.mjs';
import { loadSystemVariant } from '../tools/atc.mjs';
import { CUSTOMIZING_TABLES as CUSTOMIZING_TABLES_LIVE } from '../lib/data-preview.mjs';
import { openJournal } from '../lib/journal.mjs';
import { RUN_REPLY as ATC_RUN_REPLY, WORKLIST as ATC_WORKLIST, CUSTOMIZING as ATC_CUSTOMIZING } from './atc.test.mjs';

/** cfg with the audit sink diverted away from disk (see lib/audit.mjs). */
/** Journal lines the handler wrapper produces, per test. */
const journalLines = [];

function cfgWith(log) {
  return {
    host: 'dev.example',
    client: '001',
    budget: { reads: 1000 },
    auditSink: (line) => log.push(JSON.parse(line)),
    // The journal writes through a sink here, never to disk: the tests must not depend
    // on (or pollute) logs/ in the repository.
    journalSink: (stream, record) => journalLines.push({ stream, ...record }),
  };
}

const hit = (name, type, pkg, uri) => ({
  'adtcore:name': name,
  'adtcore:type': type,
  'adtcore:packageName': pkg,
  'adtcore:description': `${name} description`,
  'adtcore:uri': uri,
});

/** A CDS view as ADT returns it: DDL source + generated entity, one logical object. */
const CDS_HITS = [
  hit('ZI_TEST', 'DDLS/DF', 'ZSD_TEST', '/sap/bc/adt/ddic/ddl/sources/zi_test'),
  hit(
    'ZI_TEST',
    'STOB/DO',
    'ZSD_TEST',
    '/sap/bc/adt/ddic/ddl/sources/zi_test/source/main#name=zi_test'
  ),
];

const CDS_STRUCTURE = {
  objectUrl: '/sap/bc/adt/ddic/ddl/sources/zi_test',
  metaData: {
    'adtcore:type': 'DDLS/DF',
    'adtcore:name': 'ZI_TEST',
    'abapsource:sourceUri': 'source/main',
  },
  links: [],
};

const CLASS_HITS = [hit('ZCL_T', 'CLAS/OC', 'ZSD_TEST', '/sap/bc/adt/oo/classes/zcl_t')];

const CLASS_STRUCTURE = {
  objectUrl: '/sap/bc/adt/oo/classes/zcl_t',
  metaData: {
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'ZCL_T',
    // What isClassStructure() keys on. Without it the statics take the CDS branch.
    'class:visibility': 'public',
  },
  includes: [
    { 'class:includeType': 'main', links: [{ href: 'source/main', type: 'text/plain' }] },
    {
      'class:includeType': 'testclasses',
      links: [{ href: 'includes/testclasses', type: 'text/plain' }],
    },
  ],
  links: [],
};

/** Counting double: every ADT method the five handlers can reach. */
function fakeApi(over = {}) {
  const calls = [];
  const spy = (name, fn) => async (...args) => {
    calls.push({ name, args });
    if (typeof over[name] === 'function') return over[name](...args);
    if (name in over) return over[name];
    return fn(...args);
  };
  return {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    searchObject: spy('searchObject', () => CDS_HITS),
    objectStructure: spy('objectStructure', () => CDS_STRUCTURE),
    getObjectSource: spy('getObjectSource', () => 'define view entity ZI_TEST as select from t001 {}'),
    objectStructureElements: spy('objectStructureElements', () => []),
    ddicElement: spy('ddicElement', () => ({ name: 'ZI_TEST', children: [] })),
    usageReferences: spy('usageReferences', () => []),
    usageReferenceSnippets: spy('usageReferenceSnippets', () => []),
    nodeContents: spy('nodeContents', () => ({ nodes: [] })),
    objectEnhancements: spy('objectEnhancements', () => ({ implementations: [] })),
    getDataElementProperties: spy('getDataElementProperties', () => { throw new Error('getDataElementProperties not doubled'); }),
    getDomainProperties: spy('getDomainProperties', () => { throw new Error('getDomainProperties not doubled'); }),
  };
}

function toolsWith(api, log = []) {
  // `sources` is injected so the value-help tool never reaches disk from here.
  return buildTools(cfgWith(log), { api, sources: { catalog: null, mirror: null, precedent: null } });
}

const byName = (tools, name) => tools.find((t) => t.definition.name === name);
const textOf = (res) => res.content[0].text;
const jsonOf = (res) => JSON.parse(textOf(res));

beforeEach(() => {
  resetBudget();
  journalLines.length = 0;
});

// --- registration ------------------------------------------------------------

test('nineteen tools are registered, each with a name and an input schema', () => {
  const tools = toolsWith(fakeApi());
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [
      'adt_search',
      'adt_read_source',
      'adt_object_info',
      'adt_where_used',
      'adt_package_tree',
      'adt_value_help',
      'adt_clean_core_scan',
      'adt_contract_check',
      'adt_annotation_scan',
      'adt_annotation_chain',
      'adt_transport',
      'adt_customizing',
      'adt_runtime_errors',
      'adt_atc_run',
      'adt_launchpad',
      'adt_syntax_check',
      'adt_package_health',
      'adt_find_definition',
      'adt_used_objects',
    ]
  );
  for (const t of tools) {
    assert.equal(typeof t.handler, 'function', `${t.definition.name} has a handler`);
    assert.equal(t.definition.inputSchema.type, 'object');
  }
});

// The model reads every description in every session, so the text is a token budget. A cap per
// tool, not a total, so a new tool brings its own room. The lists an installation extends (its
// customizing tables, its ATC variants) are left out of the count. Lower these caps when the
// text shrinks; never raise them to fit a sentence that belongs in docs/ instead.
const TOOL_TEXT_CAP = 600;
const PARAM_TEXT_CAP = 120;

test('tool and parameter descriptions stay inside their caps', () => {
  const lists = [
    [...CUSTOMIZING_TABLES_LIVE.keys()].join(', '),
    [...ATC_VARIANTS_LIVE].map(([name, why]) => `${name} (${why})`).join('; '),
  ];
  const params = [];
  const walk = (schema, where) => {
    if (!schema || typeof schema !== 'object') return;
    if (typeof schema.description === 'string') params.push([where, schema.description.length]);
    for (const [k, v] of Object.entries(schema.properties ?? {})) walk(v, `${where}.${k}`);
    if (schema.items) walk(schema.items, `${where}[]`);
  };
  for (const { definition: d } of toolsWith(fakeApi())) {
    const own = lists.reduce((text, list) => text.replace(list, ''), d.description);
    assert.ok(own.length <= TOOL_TEXT_CAP, `${d.name}: ${own.length} > ${TOOL_TEXT_CAP} characters`);
    for (const [k, v] of Object.entries(d.inputSchema.properties ?? {})) walk(v, `${d.name}.${k}`);
  }
  for (const [where, n] of params) assert.ok(n <= PARAM_TEXT_CAP, `${where}: ${n} > ${PARAM_TEXT_CAP}`);
});

// --- adt_search --------------------------------------------------------------

test('adt_search maps the ADT fields and records the hit count', async () => {
  const log = [];
  const api = fakeApi();
  const res = await byName(toolsWith(api, log), 'adt_search').handler({ query: 'ZI_TEST' });

  const out = jsonOf(res);
  assert.deepEqual(out.hits[0], {
    name: 'ZI_TEST',
    type: 'DDLS/DF',
    package: 'ZSD_TEST',
    description: 'ZI_TEST description',
    uri: '/sap/bc/adt/ddic/ddl/sources/zi_test',
  });
  assert.equal(out.count, 2);
  assert.equal(out.limit, 50);
  assert.equal(out.truncated, false, 'two hits under a cap of fifty: nothing was cut');
  assert.deepEqual(log.at(-1).tool, 'adt_search');
  assert.equal(log.at(-1).target, 'ZI_TEST');
  assert.equal(log.at(-1).resultSize, 2);
});

test('a result that hits the cap says it may be truncated', async () => {
  // The quick search has no paging and no total: 200 hits for a cap of 200 reads exactly
  // like "there are 200". Measured: ENHO/XHH answered 182 of 200, 18 of headroom.
  const many = Array.from({ length: 7 }, (_, i) => hit(`Z${i}`, 'CLAS/OC', 'ZP', `/c/z${i}`));
  const api = fakeApi({ searchObject: () => many });
  const before = journalLines.filter((l) => l.code === 'SEARCH_AT_CAP').length;
  const out = jsonOf(await byName(toolsWith(api), 'adt_search').handler({ query: 'Z*', max: 7 }));
  assert.equal(out.count, 7);
  assert.equal(out.truncated, 'possible');
  const gaps = journalLines.filter((l) => l.stream === 'gaps' && l.code === 'SEARCH_AT_CAP');
  assert.equal(gaps.length - before, 1, 'one gap for the one answer at the cap');
  assert.match(gaps.at(-1).detail, /7 hits for a limit of 7/);
  // Under the cap, no gap: six of seven is a complete answer.
  const under = jsonOf(await byName(toolsWith(api), 'adt_search').handler({ query: 'Z*', max: 8 }));
  assert.equal(under.truncated, false);
  assert.equal(journalLines.filter((l) => l.code === 'SEARCH_AT_CAP').length - before, 1);
});

test('adt_search says that an empty answer is not proof of absence (RV64A953, 2026-09-12)', async () => {
  // The index does not know every object that exists: a generated include with a normal
  // TADIR entry answered 0 hits by exact name while its URI read. So the empty list carries
  // the rule, and a non-empty one does not.
  const api = fakeApi({ searchObject: () => [] });
  const out = jsonOf(await byName(toolsWith(api), 'adt_search').handler({ query: 'RV64A953' }));
  assert.equal(out.count, 0);
  assert.match(out.note, /empty is not proof of absence/);
  assert.match(out.note, /foundBy: "uri"/);
  const full = jsonOf(await byName(toolsWith(fakeApi()), 'adt_search').handler({ query: 'ZI_TEST' }));
  assert.equal(full.note, undefined);
});

// The measured reply of the quick search asked with the whole facet: no adtcore:description.
const FACET_REPLY =
  '<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
  '<adtcore:objectReference adtcore:uri="/sap/bc/adt/functions/groups/zdemo/fmodules/z_demo_fm" adtcore:type="FUGR/FF" adtcore:name="Z_DEMO_FM" adtcore:packageName="ZDEMO"/>' +
  '</adtcore:objectReferences>';

/** A session whose raw client answers the quickSearch route with `body` and records the URL. */
function sessionWithRaw(api, body, urls = []) {
  return {
    api,
    sources: { catalog: null, mirror: null, precedent: null },
    raw: {
      httpClient: {
        request: async (url) => {
          urls.push(url);
          return { status: 200, body, headers: { 'content-type': 'application/xml' } };
        },
      },
    },
  };
}

test('a function module is found by the whole facet, the answer says so and says it has no description', async () => {
  const log = [];
  const urls = [];
  const api = fakeApi({ searchObject: () => assert.fail('FUGR/FF is measured empty through the library: never asked') });
  const tools = buildTools(cfgWith(log), sessionWithRaw(api, FACET_REPLY, urls));
  const out = jsonOf(await byName(tools, 'adt_search').handler({ query: 'Z_DEMO_FM', objectType: 'FUGR/FF' }));
  assert.equal(api.count('searchObject'), 0);
  assert.deepEqual(urls, [
    '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&maxResults=50&objectType=FUGR%2FFF&query=Z_DEMO_FM',
  ]);
  assert.equal(out.foundBy, 'facet');
  assert.match(out.note, /WHOLE facet/);
  assert.equal(out.count, 1);
  assert.equal(out.hits[0].name, 'Z_DEMO_FM');
  assert.equal(out.hits[0].description, null, 'no description on this path, and not an empty string either');
  assert.equal(journalLines.filter((l) => l.stream === 'gaps').length, 0, 'the measured route files no gap');
  // One audit line for the route, naming the object and the facet, never a description.
  const line = log.find((l) => l.target === 'Z_DEMO_FM (FUGR/FF, whole facet)');
  assert.ok(line, 'the whole-facet call is audited like every other route');
  assert.equal(line.tool, 'adt_search');

  // The resolver takes the same road: adt_object_info on the function module reads it.
  const info = jsonOf(await byName(tools, 'adt_object_info').handler({ objectName: 'Z_DEMO_FM', objectType: 'FUGR/FF' }));
  assert.equal(info.foundBy, 'facet');
  assert.equal(api.count('searchObject'), 0);
});

test('without a raw client there is no second ask: the facet-only type is refused as not found, never as empty', async () => {
  const api = fakeApi({ searchObject: () => assert.fail('never asked') });
  const tools = toolsWith(api);
  const out = jsonOf(await byName(tools, 'adt_search').handler({ query: 'Z_DEMO_FM', objectType: 'FUGR/FF' }));
  assert.equal(out.count, 0);
  assert.equal(out.foundBy, undefined);
  assert.match(out.note, /NOT evidence of absence/);
  await assert.rejects(
    () => byName(tools, 'adt_object_info').handler({ objectName: 'Z_DEMO_FM', objectType: 'FUGR/FF' }),
    /not found/i
  );
});

test('a facet the library answers is never asked twice, and an empty library answer with a facet is asked once more', async () => {
  const urls = [];
  const api = fakeApi({ searchObject: () => [] });
  const tools = buildTools(cfgWith([]), sessionWithRaw(api, '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>', urls));
  // Empty with a facet: the route is asked; empty again -> zero hits, no foundBy.
  const out = jsonOf(await byName(tools, 'adt_search').handler({ query: 'ZNOPE', objectType: 'PROG/P' }));
  assert.equal(out.count, 0);
  assert.equal(out.foundBy, undefined);
  assert.equal(urls.length, 1);
  // Empty without a facet: nothing to send whole, the route is not asked.
  await byName(tools, 'adt_search').handler({ query: 'ZNOPE' });
  assert.equal(urls.length, 1);
  // A query the route refuses (leading wildcard) is not sent: enumeration stays the library's.
  await byName(tools, 'adt_search').handler({ query: '*NOPE*', objectType: 'PROG/P' });
  assert.equal(urls.length, 1);
});

test('adt_search defaults to 50 results and caps at 200', async () => {
  const api = fakeApi();
  const tools = toolsWith(api);
  await byName(tools, 'adt_search').handler({ query: 'Z*' });
  await byName(tools, 'adt_search').handler({ query: 'Z*', max: 5000 });
  await byName(tools, 'adt_search').handler({ query: 'Z*', max: 7, objectType: 'CLAS/OC' });

  assert.deepEqual(api.calls.map((c) => c.args), [
    ['Z*', undefined, 50],
    ['Z*', undefined, 200],
    ['Z*', 'CLAS/OC', 7],
  ]);
});

// --- adt_read_source ---------------------------------------------------------

test('adt_read_source reads the main include and stamps the provenance header', async () => {
  const api = fakeApi();
  const res = await byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZI_TEST' });
  const text = textOf(res);

  assert.match(text, /^\* ZI_TEST \(DDLS\/DF\) -- package ZSD_TEST\n/);
  assert.match(text, /read live from dev\.example client 001 at \d{4}-/);
  assert.match(text, /define view entity ZI_TEST/);
  // The URI came out of the real ADTClient.mainInclude over the measured shape.
  assert.equal(
    api.calls.find((c) => c.name === 'getObjectSource').args[0],
    '/sap/bc/adt/ddic/ddl/sources/zi_test/source/main'
  );
});

test('adt_read_source names the other facets of the same object instead of refusing', async () => {
  const text = textOf(
    await byName(toolsWith(fakeApi()), 'adt_read_source').handler({ objectName: 'ZI_TEST' })
  );
  assert.match(text, /this name also exists as STOB\/DO -- facets of the same object/);
});

// Shape from the abap-adt-api types: one ENHO carrying source-code plugin elements,
// each with the enhancement-point fullname, the replacing flag and the position in the
// base object. This is the reply an implicit enhancement produces.
const ENHANCEMENTS = {
  implementations: [
    {
      name: 'ZENH_SD_ORDER_CHECK',
      type: 'ENHO/XH',
      version: 'active',
      enhancedObject: { name: 'MV45AFZZ', type: 'PROG/I', uri: '/sap/bc/adt/programs/includes/mv45afzz' },
      elements: [
        {
          id: '1',
          fullname: '\PR:SAPMV45A\FO:USEREXIT_SAVE_DOCUMENT\SE:BEGIN\EI',
          mode: 'any',
          replacing: false,
          source: '  " customer check\n  PERFORM zcheck.',
          position: { uri: '/x#start=120,0', startLine: 120, startColumn: 0 },
        },
      ],
    },
  ],
};

// A data-preview reply in the measured column-major shape, echoing the statement it was sent
// (the same builder as tests/legacy-objects.test.mjs).
const previewReply = (sql, columns) => {
  const col = (name, values) =>
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
    (values.length ? `<dataPreview:dataSet>${values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join('')}</dataPreview:dataSet>` : '<dataPreview:dataSet/>') +
    '</dataPreview:columns>';
  const n = Object.values(columns)[0]?.length ?? 0;
  const esc = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `<dataPreview:totalRows>${n}</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>` +
    `<dataPreview:executedQueryString>${esc} INTO TABLE @DATA(LT_RESULT) UP TO 200 ROWS .</dataPreview:executedQueryString>` +
    '<dataPreview:queryExecutionTime>0.1</dataPreview:queryExecutionTime>' +
    Object.entries(columns).map(([k, v]) => col(k, v)).join('') + '</dataPreview:tableData>';
};

test('each listed enhancement carries the stored state of its switch, read in three statements', async () => {
  const sent = [];
  const rules = [
    [/FROM TADIR/, { OBJ_NAME: ['ZENH_SD_ORDER_CHECK'], DEVCLASS: ['ZDEMO_PKG_OIL'] }],
    [/FROM SFW_PACKAGE/, { SWITCH_ID: ['ZDEMO_SW_OIL'], DEVCLASS: ['ZDEMO_PKG_OIL'] }],
    [/FROM SFW_SWITCH_STATE/, { SWITCH_ID: ['ZDEMO_SW_OIL'], CLIENT: [''], STATE: ['F'] }],
  ];
  const raw = {
    httpClient: {
      request: async (url, c) => {
        const sql = String(c.body).replace(/\s+/g, ' ').trim();
        sent.push(sql);
        const rule = rules.find(([re]) => re.test(sql));
        return { status: 200, body: previewReply(sql, rule[1]), headers: {} };
      },
    },
  };
  const log = [];
  const api = fakeApi({ objectEnhancements: () => ENHANCEMENTS });
  const tools = buildTools(cfgWith(log), { api, raw, sources: { catalog: null, mirror: null, precedent: null } });
  const text = textOf(await byName(tools, 'adt_read_source').handler({ objectName: 'ZI_TEST', enhancements: true }));
  assert.match(text, /ZENH_SD_ORDER_CHECK \(ENHO\/XH, version active\) on MV45AFZZ\n\*   switch: package ZDEMO_PKG_OIL -> switch ZDEMO_SW_OIL: OFF \(SFW_SWITCH_STATE F\)/);
  assert.equal(sent.length, 3, 'one statement per table, for the whole list');
  assert.ok(sent.every((s) => !/USERNAME,|SELECT \*|, USERNAME/.test(s)), 'USERNAME is never selected');
  assert.ok(log.some((l) => /SFW_SWITCH_STATE/.test(l.target)), 'the reads are audited');

  // A failed read says so in the footer: no switch line must never read as "behind no switch".
  const broken = { httpClient: { request: async () => { throw Object.assign(new Error('Internal Server Error'), { status: 500 }); } } };
  const t2 = buildTools(cfgWith([]), { api: fakeApi({ objectEnhancements: () => ENHANCEMENTS }), raw: broken, sources: { catalog: null, mirror: null, precedent: null } });
  const text2 = textOf(await byName(t2, 'adt_read_source').handler({ objectName: 'ZI_TEST', enhancements: true }));
  assert.match(text2, /⚠ switch state not read: .*Internal Server Error/);
});

test('adt_read_source lists the enhancements when asked, and only then', async () => {
  const api = fakeApi({ objectEnhancements: () => ENHANCEMENTS });
  const plain = textOf(await byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZI_TEST' }));
  assert.ok(!/enhancement/i.test(plain), 'not asked for: not fetched, not reported');
  assert.equal(api.count('objectEnhancements'), 0);

  const withEnh = textOf(
    await byName(toolsWith(api), 'adt_read_source').handler({
      objectName: 'ZI_TEST',
      enhancements: true,
    })
  );
  assert.equal(api.count('objectEnhancements'), 1);
  // The source is still the source; the enhancements are a footer under it.
  assert.match(withEnh, /define view entity ZI_TEST/);
  // "bound to", never "active on": the ADT lists implementations whatever their switch says, and
  // `active` is the object version (measured on SAPMV45A, 2026-11-09).
  assert.match(withEnh, /1 enhancement implementation\(s\) bound to ZI_TEST/);
  assert.match(withEnh, /bound is not running/);
  assert.equal(/active on ZI_TEST/.test(withEnh), false);
  assert.match(withEnh, /ZENH_SD_ORDER_CHECK \(ENHO\/XH, version active\) on MV45AFZZ/);
  assert.match(withEnh, /USEREXIT_SAVE_DOCUMENT/);
  assert.match(withEnh, /at line 120/);
  // Not asked for, so the enhancement's own source stays out.
  assert.ok(!/customer check/.test(withEnh));
  assert.equal(api.calls.find((c) => c.name === 'objectEnhancements').args[2], false);
});

test('adt_read_source can include the enhancement source, and says when one REPLACES', async () => {
  const replacing = {
    implementations: [
      {
        ...ENHANCEMENTS.implementations[0],
        elements: [{ ...ENHANCEMENTS.implementations[0].elements[0], replacing: true }],
      },
    ],
  };
  const api = fakeApi({ objectEnhancements: () => replacing });
  const text = textOf(
    await byName(toolsWith(api), 'adt_read_source').handler({
      objectName: 'ZI_TEST',
      enhancementSource: true,
    })
  );
  assert.match(text, /REPLACES the enhancement point/);
  assert.match(text, /customer check/);
  assert.equal(api.calls.find((c) => c.name === 'objectEnhancements').args[2], true);
});

test('"no enhancements" and "I could not ask" are different answers', async () => {
  // The whole point of the capability is finding customer code that no namespace sweep
  // shows. A swallowed failure would read as "this standard object is untouched".
  const none = textOf(
    await byName(toolsWith(fakeApi()), 'adt_read_source').handler({
      objectName: 'ZI_TEST',
      enhancements: true,
    })
  );
  assert.match(none, /0 enhancement implementation\(s\)/);
  assert.match(none, /the system reports no enhancement bound to this object/);

  const failed = textOf(
    await byName(
      toolsWith(
        fakeApi({
          objectEnhancements: () => {
            throw new Error('HTTP 406');
          },
        })
      ),
      'adt_read_source'
    ).handler({ objectName: 'ZI_TEST', enhancements: true })
  );
  assert.match(failed, /enhancements NOT read: Error: HTTP 406/);
  assert.match(failed, /This is not the same as "there are none"/);
  assert.match(failed, /define view entity ZI_TEST/, 'the source itself is still returned');
});

test('adt_read_source follows a class include when one is asked for', async () => {
  const api = fakeApi({ searchObject: () => CLASS_HITS, objectStructure: () => CLASS_STRUCTURE });
  await byName(toolsWith(api), 'adt_read_source').handler({
    objectName: 'ZCL_T',
    include: 'testclasses',
  });
  assert.equal(
    api.calls.find((c) => c.name === 'getObjectSource').args[0],
    '/sap/bc/adt/oo/classes/zcl_t/includes/testclasses'
  );
});

test('adt_read_source refuses an include the class does not have, naming it', async () => {
  const api = fakeApi({ searchObject: () => CLASS_HITS, objectStructure: () => CLASS_STRUCTURE });
  await assert.rejects(
    () =>
      byName(toolsWith(api), 'adt_read_source').handler({
        objectName: 'ZCL_T',
        include: 'macros',
      }),
    /Include 'macros' not available for ZCL_T/
  );
  assert.equal(api.count('getObjectSource'), 0, 'nothing is read after the refusal');
});

test('an object the system does not have fails with a clear message, not a stack trace', async () => {
  // The search misses AND every derivable URI answers 404 -- both halves, because since
  // 2026-09-12 an empty search alone is a question, not a verdict.
  const api = fakeApi({
    searchObject: () => [hit('ZI_TESTX', 'DDLS/DF', 'ZSD_TEST', '/x')],
    objectStructure: () => {
      throw Object.assign(new Error('Resource not found'), { status: 404 });
    },
  });
  await assert.rejects(
    () => byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZI_TEST' }),
    /Object 'ZI_TEST' not found in the system\. Closest names: ZI_TESTX \(DDLS\/DF\)\. The direct URIs did not answer either: .*programs\/includes\/zi_test/
  );
  assert.equal(api.count('objectStructure'), 4, 'the four derivable URIs were each tried once');
});

test('a name the search cannot see is still read when its URI is derivable, and the journal says so', async () => {
  // Measured: RV64A953 -- the quick search answers [], the include URI answers 200.
  const api = fakeApi({
    searchObject: () => [],
    objectStructure: (uri) => {
      if (!/programs\/includes\/rv64a953$/.test(uri)) {
        throw Object.assign(new Error('Resource not found'), { status: 404 });
      }
      return {
        objectUrl: '/sap/bc/adt/programs/includes/rv64a953',
        metaData: { 'adtcore:name': 'RV64A953', 'adtcore:type': 'PROG/I', 'adtcore:description': 'Demo document total' },
        links: [{ href: 'source/main', rel: 'http://www.sap.com/adt/relations/source', type: 'text/plain' }],
      };
    },
    getObjectSource: () => 'FORM frm_kondi_wert_953.',
  });
  const text = textOf(await byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'RV64A953' }));
  assert.match(text, /RV64A953 \(PROG\/I\)/);
  assert.match(text, /FOUND BY URI/);
  assert.match(text, /FORM frm_kondi_wert_953/);
  // Read once on the way in, not again: the resolver hands the structure over.
  assert.equal(api.count('objectStructure'), 4, 'three 404s and the one that answered');
  // The case is not cured in silence: the answer says FOUND BY URI (above). A read that
  // succeeded files no gap row.
  assert.equal(journalLines.filter((l) => l.stream === 'gaps').length, 0);
});

// --- adt_object_info ---------------------------------------------------------

test('adt_object_info returns metadata, elements and the DDIC field tree', async () => {
  const api = fakeApi({ objectStructureElements: () => [{ name: 'X' }] });
  const out = jsonOf(
    await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZI_TEST' })
  );

  assert.equal(out.found['adtcore:name'], 'ZI_TEST');
  assert.deepEqual(out.facets, ['DDLS/DF', 'STOB/DO']);
  assert.equal(out.metadata.objectUrl, undefined, 'objectUrl is dropped from the metadata block');
  assert.equal(out.metadata.metaData['adtcore:name'], 'ZI_TEST');
  assert.deepEqual(out.elements, [{ name: 'X' }]);
  assert.equal(out.ddic.ok, true);
});

test('adt_object_info with fields:false makes no ddicElement call', async () => {
  const api = fakeApi();
  const out = jsonOf(
    await byName(toolsWith(api), 'adt_object_info').handler({
      objectName: 'ZI_TEST',
      fields: false,
    })
  );
  assert.equal(out.ddic, undefined);
  assert.equal(api.count('ddicElement'), 0);
});

test('adt_object_info asks ddicElement by NAME, never by URI', async () => {
  // THE REGRESSION. ddicElement answers on the NAME; called with a URI it returns an empty tree
  // and no error (docs/adt-api-reference.md, 2026-09-09). This call passed the URI until
  // 2026-09-22, so every DDIC object reported ok:true with no fields -- measured empty that day
  // on VBAK, KOMPAZ, AGR_TIMEB and ZC_DEMOITEMRATING. The double hid it, so the double is
  // exactly what has to assert the argument now.
  const api = fakeApi({ ddicElement: () => ({ name: 'ZI_TEST', children: [{ name: 'PLANT' }] }) });
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZI_TEST' }));

  const call = api.calls.find((c) => c.name === 'ddicElement');
  assert.ok(call, 'ddicElement was not called');
  assert.equal(call.args[0], 'ZI_TEST', 'ddicElement must be asked by name');
  assert.equal(/^\/sap\/bc\/adt\//.test(String(call.args[0])), false, 'a URI was passed again');
  assert.equal(out.ddic.askedBy, 'name');
  assert.equal(out.ddic.note, undefined, 'a non-empty answer files nothing');
  assert.equal(journalLines.filter((l) => l.code === 'DDIC_FIELDS_NOT_READ').length, 0);
});

// A data element and a domain: the domain's fixed values, never a "fields not read" gap.
const FIX = [
  { low: 'O', text: 'Ok' },
  { low: 'E', text: 'Error' },
];
const DTEL_API = (over = {}) =>
  fakeApi({
    searchObject: () => [hit('ZDE_STAT', 'DTEL/DE', 'ZTEST', '/sap/bc/adt/ddic/dataelements/zde_stat')],
    objectStructure: () => ({ objectUrl: '/sap/bc/adt/ddic/dataelements/zde_stat', metaData: { 'adtcore:type': 'DTEL/DE', 'adtcore:name': 'ZDE_STAT' } }),
    getDataElementProperties: () => ({ properties: { typeName: 'ZD_STAT', dataType: 'CHAR', dataTypeLength: 1 } }),
    getDomainProperties: () => ({ metaData: { description: 'Status', packageName: 'ZTEST' }, properties: { typeInformation: { datatype: 'CHAR', length: 1, decimals: 0 }, outputInformation: { length: 1, lowercase: false }, valueInformation: { valueTableRef: '', appendExists: false, fixValues: FIX } } }),
    ...over,
  });

test('adt_object_info on a data element answers its domain and the fixed values, and asks no field tree', async () => {
  const api = DTEL_API();
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZDE_STAT' }));
  assert.equal(out.dataElement.domain, 'ZD_STAT');
  assert.equal(out.dataElement.ddicType, 'CHAR');
  assert.equal(out.dataElement.fixValues, 2);
  assert.deepEqual(out.dataElement.fixValueList, FIX);
  assert.equal(api.calls.find((c) => c.name === 'getDomainProperties').args[0], '/sap/bc/adt/ddic/domains/zd_stat');
  assert.equal(api.count('ddicElement'), 0);
  assert.equal(out.ddic, undefined);
  assert.equal(journalLines.filter((l) => l.code === 'DDIC_FIELDS_NOT_READ').length, 0);
});

test('adt_object_info on a domain answers it directly; a domain that does not read is a gap, never "no fixed values"', async () => {
  const doma = DTEL_API({
    searchObject: () => [hit('ZD_STAT', 'DOMA/DD', 'ZTEST', '/sap/bc/adt/ddic/domains/zd_stat')],
    objectStructure: () => ({ objectUrl: '/sap/bc/adt/ddic/domains/zd_stat', metaData: { 'adtcore:type': 'DOMA/DD', 'adtcore:name': 'ZD_STAT' } }),
  });
  const out = jsonOf(await byName(toolsWith(doma), 'adt_object_info').handler({ objectName: 'ZD_STAT' }));
  assert.equal(out.domain.ok, true);
  assert.equal(out.domain.description, 'Status');
  assert.deepEqual(out.domain.fixValueList, FIX);
  assert.equal(doma.count('getDataElementProperties'), 0);

  const broken = DTEL_API({ getDomainProperties: () => { throw new Error('404'); } });
  const b = jsonOf(await byName(toolsWith(broken), 'adt_object_info').handler({ objectName: 'ZDE_STAT' }));
  assert.equal(b.dataElement.fixValues, undefined, 'a failed read is not zero fixed values');
  assert.match(b.dataElement.reason, /ZD_STAT did not resolve/);
  const gap = journalLines.find((l) => l.code === 'DOMAIN_NOT_READ');
  assert.equal(gap?.subject, 'ZDE_STAT');
  assert.match(gap.impact, /NOT "no fixed values"/);
});

test('adt_read_source refuses a data element or a domain and names the call that answers', async () => {
  const api = DTEL_API();
  await assert.rejects(
    () => byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'BTCXPGSTAT', objectType: 'DTEL/DE' }),
    /no source text.*adt_object_info/s
  );
  assert.equal(api.calls.length, 0, 'refused before any request');
  await assert.rejects(() => byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZDE_STAT' }), /no source text/);
  assert.equal(api.count('getObjectSource'), 0);
});

// --- the type contract (lib/type-contract.mjs) ----------------------------------

/** An api whose search answers one object of `type`. */
const apiOfType = (name, type, uri, over = {}) =>
  fakeApi({
    searchObject: () => [hit(name, type, 'ZTEST', uri)],
    objectStructure: () => ({ objectUrl: uri, metaData: { 'adtcore:type': type, 'adtcore:name': name } }),
    ...over,
  });

test('the field list is asked only of a type that has one: a package gets a note, not a false gap', async () => {
  const api = apiOfType('ZDEMO_DEV', 'DEVC/K', '/sap/bc/adt/packages/zdemo_dev', { findObjectPath: () => [] });
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZDEMO_DEV' }));
  assert.equal(api.count('ddicElement'), 0);
  assert.equal(out.ddic, undefined);
  assert.match(out.fieldsNote, /package has no fields/);
  assert.equal(journalLines.filter((l) => l.code === 'DDIC_FIELDS_NOT_READ').length, 0);
});

test('a structure is not asked for a field list: ddicElement answers every TABL/DS empty', async () => {
  // Measured on 7 of 7 structures (docs/adt-api-reference.md, "Type contract"): asking filed a
  // DDIC_FIELDS_NOT_READ on every structure, a medium gap for a property of the type.
  const api = apiOfType('ZDEMO_S_ITEM', 'TABL/DS', '/sap/bc/adt/ddic/structures/zdemo_s_item', { ddicElement: () => ({ children: [] }) });
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZDEMO_S_ITEM' }));
  assert.equal(api.count('ddicElement'), 0);
  assert.equal(out.ddic, undefined);
  assert.match(out.fieldsNote, /every structure.*adt_read_source.*enhancement\/elements/s);
  assert.equal(journalLines.filter((l) => l.code === 'DDIC_FIELDS_NOT_READ').length, 0);
});

test('a BDEF is not answered with the fields of the CDS of the same name', async () => {
  const api = apiOfType('ZR_X', 'BDEF/BDO', '/sap/bc/adt/bo/behaviordefinitions/zr_x', { ddicElement: () => ({ children: [{ name: 'F' }] }) });
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZR_X' }));
  assert.equal(api.count('ddicElement'), 0);
  assert.match(out.fieldsNote, /CDS entity of the same name/);
});

test('a type outside the contract is attempted without a field list, and filed', async () => {
  const api = apiOfType('ZX', 'XSLT/VT', '/sap/bc/adt/xslt/transformations/zx');
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZX' }));
  assert.equal(out.contract, 'unmeasured');
  assert.match(out.fieldsNote, /NOT "no fields"/);
  assert.equal(api.count('ddicElement'), 0);
  const gap = journalLines.find((l) => l.code === 'TYPE_NOT_IN_CONTRACT');
  assert.equal(gap?.subject, 'XSLT/VT');
});

test('adt_read_source refuses a form-based type before any request, and names the call that answers', async () => {
  const api = apiOfType('ZUI_X_O4', 'SRVB/SVB', '/sap/bc/adt/businessservices/bindings/zui_x_o4');
  await assert.rejects(() => byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZUI_X_O4', objectType: 'SRVB/SVB' }), /no source text.*adt_object_info/s);
  assert.equal(api.calls.length, 0);
  const devc = apiOfType('ZDEMO_DEV', 'DEVC/K', '/sap/bc/adt/packages/zdemo_dev');
  await assert.rejects(() => byName(toolsWith(devc), 'adt_read_source').handler({ objectName: 'ZDEMO_DEV' }), /adt_package_tree\(\{ packageName: 'ZDEMO_DEV' \}\)/);
  assert.equal(devc.count('getObjectSource'), 0, 'the package XML is never handed back as source');
});

test('an HTTP failure no code explains is filed per tool x type; a refusal of the server is not', async () => {
  const api = fakeApi({ getObjectSource: () => { throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }); } });
  await assert.rejects(() => byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZI_TEST', objectType: 'DDLS/DF' }), /404/);
  const gap = journalLines.find((l) => l.code === 'UNCLASSIFIED_ADT_ERROR');
  assert.equal(gap?.subject, 'adt_read_source DDLS/DF');
  assert.match(gap.detail, /HTTP 404 on ZI_TEST/);

  journalLines.length = 0;
  await assert.rejects(() => byName(toolsWith(fakeApi()), 'adt_read_source').handler({ objectName: 'BTCXPGSTAT', objectType: 'DTEL/DE' }), /no source text/);
  assert.equal(journalLines.filter((l) => l.code === 'UNCLASSIFIED_ADT_ERROR').length, 0, 'a refusal is an answer, not a failure');
});

test('an empty ddicElement tree is reported, not returned as "no fields"', async () => {
  const api = fakeApi({ ddicElement: () => ({ name: 'ZI_TEST', children: [] }) });
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZI_TEST' }));

  // ok stays true -- the call succeeded -- but the answer must not read as an empty object.
  assert.equal(out.ddic.ok, true);
  assert.match(out.ddic.note, /NOT evidence/);
  const gap = journalLines.find((l) => l.code === 'DDIC_FIELDS_NOT_READ');
  assert.ok(gap, 'an empty tree must file a gap');
  assert.equal(gap.stream, 'gaps');
  assert.match(gap.impact, /not an empty object/);
});

test('adt_object_info reports a DDIC failure instead of swallowing or throwing it', async () => {
  const api = fakeApi({
    objectStructureElements: () => {
      throw new Error('not supported for this type');
    },
    ddicElement: () => {
      throw Object.assign(new Error('HTTP 404'), { name: 'AdtError' });
    },
  });
  const out = jsonOf(
    await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZI_TEST' })
  );
  // An object type without structure elements is normal; a DDIC failure is not, and
  // has to reach the caller as a stated failure -- silence would read as "no fields".
  assert.deepEqual(out.elements, []);
  assert.equal(out.ddic.ok, false);
  assert.match(out.ddic.error, /AdtError: HTTP 404/);
});

// --- adt_where_used ----------------------------------------------------------

test('where-used on an SAP standard object is refused before any ADT call', async () => {
  const api = fakeApi();
  await assert.rejects(
    () => byName(toolsWith(api), 'adt_where_used').handler({ objectName: 'I_PlantStdVH' }),
    /most expensive call this server can make against the SAP system/
  );
  assert.equal(api.calls.length, 0, 'the refusal costs the system nothing');
});

test('allowStandard lifts the refusal; a Z or namespaced object never needed it', async () => {
  for (const [name, params] of [
    ['I_PlantStdVH', { objectName: 'I_PlantStdVH', allowStandard: true }],
    ['ZI_TEST', { objectName: 'ZI_TEST' }],
    ['/STY/THING', { objectName: '/STY/THING' }],
  ]) {
    const api = fakeApi({
      searchObject: () => [hit(name, 'DDLS/DF', 'P', `/sap/bc/adt/ddic/ddl/sources/x`)],
    });
    const out = jsonOf(await byName(toolsWith(api), 'adt_where_used').handler(params));
    assert.equal(out.object, name);
    assert.equal(api.count('usageReferences'), 1);
  }
});

test('adt_where_used maps the rows and asks for snippets only when told to', async () => {
  const refs = [
    {
      'adtcore:name': 'C_CALLER',
      'adtcore:type': 'DDLS/DF',
      'adtcore:responsible': 'SAP',
      packageRef: { 'adtcore:name': 'SOME_PKG' },
      usageInformation: 'gradeDirect includeProductive',
      uri: '/uri/1',
    },
  ];
  const api = fakeApi({ usageReferences: () => refs });
  const out = jsonOf(
    await byName(toolsWith(api), 'adt_where_used').handler({ objectName: 'ZI_TEST' })
  );
  assert.deepEqual(out.rows, [
    {
      name: 'C_CALLER',
      type: 'DDLS/DF',
      package: 'SOME_PKG',
      responsible: 'SAP',
      usage: 'gradeDirect includeProductive',
      uri: '/uri/1',
    },
  ]);
  assert.equal(out.callers, 1);
  assert.deepEqual(out.snippets, []);
  assert.equal(api.count('usageReferenceSnippets'), 0, 'snippets are opt-in');

  const api2 = fakeApi({
    usageReferences: () => refs,
    usageReferenceSnippets: () => [
      // The measured shape: the snippet object carries its identifier, not a URI.
      { objectIdentifier: 'ABAPFullName;ZI_TEST', snippets: [{ uri: '/uri/1#l=3', content: 'from ZI_TEST' }] },
    ],
  });
  const out2 = jsonOf(
    await byName(toolsWith(api2), 'adt_where_used').handler({
      objectName: 'ZI_TEST',
      snippets: true,
    })
  );
  assert.deepEqual(out2.snippets, [
    { at: '/uri/1#l=3', content: 'from ZI_TEST' },
  ]);
});

// --- adt_package_tree --------------------------------------------------------

const pkgNodes = {
  ZSD_TEST: [
    // The type folders the ADT tree draws, exactly as measured on ZDEMO_ERP_INT: an
    // OBJECT_TYPE and no name at all.
    { OBJECT_NAME: '', OBJECT_TYPE: 'DEVC/DF', DESCRIPTION: '' },
    { OBJECT_NAME: '', OBJECT_TYPE: 'DEVC/Q1S', DESCRIPTION: '' },
    { OBJECT_NAME: 'ZI_TEST', OBJECT_TYPE: 'DDLS/DF', DESCRIPTION: 'a view' },
    { OBJECT_NAME: 'ZCL_T', OBJECT_TYPE: 'CLAS/OC', DESCRIPTION: 'a class' },
    { OBJECT_NAME: 'ZSD_TEST_SUB', OBJECT_TYPE: 'DEVC/K', DESCRIPTION: 'a subpackage' },
  ],
  ZSD_TEST_SUB: [
    { OBJECT_NAME: 'ZCL_U', OBJECT_TYPE: 'CLAS/OC', DESCRIPTION: 'another class' },
    // Points back at its parent: a cycle the walk has to survive.
    { OBJECT_NAME: 'ZSD_TEST', OBJECT_TYPE: 'DEVC/K', DESCRIPTION: 'the parent again' },
  ],
};

test('adt_package_tree counts by type, uppercases the name and recurses one level by default', async () => {
  const log = [];
  const api = fakeApi({ nodeContents: (_type, pkg) => ({ nodes: pkgNodes[pkg] ?? [] }) });
  const out = jsonOf(
    await byName(toolsWith(api, log), 'adt_package_tree').handler({ packageName: 'zsd_test' })
  );

  assert.equal(out.package, 'ZSD_TEST');
  // 3 objects, not 5: the two nameless nodes are the tree's type folders, counted
  // separately so the number still reconciles with what the ADT tree shows.
  assert.equal(out.total, 3);
  assert.equal(out.treeFolders, 2);
  assert.deepEqual(out.byType, { 'DDLS/DF': 1, 'CLAS/OC': 1, 'DEVC/K': 1 });
  assert.ok(out.objects.every((o) => o.name), 'a nameless node is never an object');
  // depth 1 means the sub-package is listed as an object but NOT walked into: the
  // recursion budget is spent on the package that was asked for.
  assert.deepEqual(out.subPackages, []);
  assert.ok(out.objects.some((o) => o.name === 'ZSD_TEST_SUB' && o.type === 'DEVC/K'));
  assert.equal(api.count('nodeContents'), 1, 'one package read at depth 1');
  assert.equal(log.at(-1).tool, 'adt_package_tree');
  assert.equal(log.at(-1).resultSize, 3);
});

test('a package cycle is walked once, not forever', async () => {
  const api = fakeApi({ nodeContents: (_type, pkg) => ({ nodes: pkgNodes[pkg] ?? [] }) });
  const out = jsonOf(
    await byName(toolsWith(api), 'adt_package_tree').handler({
      packageName: 'ZSD_TEST',
      depth: 3,
    })
  );
  // ZSD_TEST_SUB lists ZSD_TEST again; `seen` stops the second visit.
  assert.deepEqual(out.subPackages[0].subPackages, []);
  assert.equal(api.count('nodeContents'), 2);
});

test('adt_package_tree caps the recursion depth at 3', async () => {
  // A chain deeper than the cap: P0 -> P1 -> ... -> P5.
  const api = fakeApi({
    nodeContents: (_type, pkg) => {
      const n = Number(pkg.slice(1));
      return { nodes: [{ OBJECT_NAME: `P${n + 1}`, OBJECT_TYPE: 'DEVC/K', DESCRIPTION: '' }] };
    },
  });
  await byName(toolsWith(api), 'adt_package_tree').handler({ packageName: 'P0', depth: 99 });
  assert.equal(api.count('nodeContents'), 3, 'levels 1..3 are read, level 4 is not');
});

// --- adt_read_source: batch (B.2) and ENHO (B.3) ------------------------------

const ENHO_REL = 'http://www.sap.com/adt/relations/enhancementOptionsOfEnhancedObject';
const enhoHit = (name, type, uri) => ({
  'adtcore:name': name, 'adtcore:type': type, 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': uri,
});

test('adt_read_source reads a batch, keeps going past a failed name, and counts both', async () => {
  const log = [];
  // ZNOPE: the search misses AND its four derivable URIs answer 404 (the resolver tries them).
  const api = fakeApi({
    searchObject: (q) => (q.startsWith('ZNOPE') ? [] : CDS_HITS.map((h) => ({ ...h, 'adtcore:name': q }))),
    objectStructure: (uri) => {
      if (/znope/.test(uri)) throw Object.assign(new Error('Resource not found'), { status: 404 });
      return CDS_STRUCTURE;
    },
  });
  const out = jsonOf(
    await byName(toolsWith(api, log), 'adt_read_source').handler({ objectNames: ['ZI_TEST', 'ZNOPE', 'ZI_TEST'] })
  );
  assert.equal(out.count, 3);
  assert.equal(out.read, 2);
  // ZNOPE resolves to nothing on every route: an answer, counted apart from a failure, no gap.
  assert.equal(out.notFound, 1);
  assert.equal(out.failed, 0);
  assert.equal(out.items[0].name, 'ZI_TEST');
  assert.match(out.items[0].source, /define view entity/);
  assert.equal(out.items[0].type, 'DDLS/DF');
  assert.equal(out.items[1].notFound, true);
  assert.match(out.items[1].error, /not found in the system/, 'the text table-meta and report read is kept');
  assert.match(out.items[1].note, /index does not know every object/);
  assert.equal(out.items[1].source, undefined);
  assert.equal(out.items[2].read, undefined);
  assert.equal(journalLines.filter((l) => l.code === 'BATCH_ITEM_NOT_READ').length, 0);
  assert.equal(log.filter((l) => l.tool === 'adt_read_source').length, 2);
});

test('a batch item whose read FAILED is a gap, never a notFound', async () => {
  // ZBROKEN: the search misses and a derivable URI answers 500 -- a failed read, not an absence.
  const api = fakeApi({
    searchObject: () => [],
    objectStructure: () => {
      throw Object.assign(new Error('Internal Server Error'), { status: 500 });
    },
  });
  const out = jsonOf(await byName(toolsWith(api), 'adt_read_source').handler({ objectNames: ['ZBROKEN'] }));
  assert.equal(out.notFound, 0);
  assert.equal(out.failed, 1);
  assert.equal(out.items[0].notFound, undefined);
  const gap = journalLines.find((l) => l.code === 'BATCH_ITEM_NOT_READ');
  assert.equal(gap?.subject, 'ZBROKEN');
});

test('adt_read_source refuses objectName together with objectNames, an empty batch and one over the cap', async () => {
  const tool = byName(toolsWith(fakeApi()), 'adt_read_source');
  await assert.rejects(() => tool.handler({ objectName: 'A', objectNames: ['B'] }), /never both/);
  await assert.rejects(() => tool.handler({ objectNames: [] }), /empty/);
  await assert.rejects(
    () => tool.handler({ objectNames: Array.from({ length: 26 }, (_, i) => `Z${i}`) }),
    /at most 25 item\(s\), got 26/
  );
  await assert.rejects(() => tool.handler({}), /objectName/);
});

test('adt_read_source on an ENHO reads nothing and names the enhanced object and the call to make', async () => {
  const log = [];
  const api = fakeApi({
    searchObject: () => [enhoHit('ZENH_HOOK', 'ENHO/XHH', '/sap/bc/adt/enhancements/enhoxhh/zenh_hook')],
    objectStructure: () => ({
      objectUrl: '/sap/bc/adt/enhancements/enhoxhh/zenh_hook',
      metaData: { 'adtcore:type': 'ENHO/XHH', 'adtcore:name': 'ZENH_HOOK' },
      links: [{ rel: ENHO_REL, href: '/sap/bc/adt/programs/programs/sapfv45l/enhancements/options?x=1' }],
    }),
  });
  const text = textOf(await byName(toolsWith(api, log), 'adt_read_source').handler({ objectName: 'ZENH_HOOK' }));
  assert.match(text, /WARNING: an enhancement implementation has no source of its own/);
  assert.match(text, /enhanced object: PROG SAPFV45L \(\/sap\/bc\/adt\/programs\/programs\/sapfv45l\)/);
  assert.match(text, /adt_read_source\(\{ objectName: 'SAPFV45L', enhancements: true, enhancementSource: true \}\)/);
  assert.equal(api.count('getObjectSource'), 0, 'nothing is read from the ENHO itself');
  const gap = journalLines.find((l) => l.code === 'ENHO_SOURCE_IS_ELSEWHERE');
  assert.equal(gap?.subject, 'ZENH_HOOK');
  assert.match(gap.detail, /enhances PROG SAPFV45L/);
  assert.equal(log.at(-1).resultSize, 0);
});

test('adt_read_source on a BAdI implementation (no enhanced object) says so, in a batch too', async () => {
  const api = fakeApi({
    searchObject: () => [enhoHit('ZBADI_IMPL', 'ENHO/XHB', '/sap/bc/adt/enhancements/enhoxhb/zbadi_impl')],
    objectStructure: () => ({ objectUrl: '/sap/bc/adt/enhancements/enhoxhb/zbadi_impl', metaData: {}, links: [] }),
  });
  const out = jsonOf(await byName(toolsWith(api), 'adt_read_source').handler({ objectNames: ['ZBADI_IMPL'] }));
  assert.equal(out.read, 1);
  assert.equal(out.items[0].enhancedObject, null);
  assert.match(out.items[0].source, /none published \(a BAdI implementation implements a spot\)/);
  assert.match(out.items[0].warning, /no source of its own/);
});

test('adt_object_info on an ENHO answers enhancedObject, decoded like the sweep does', async () => {
  const api = fakeApi({
    searchObject: () => [enhoHit('ZENH_NS', 'ENHO/XHH', '/sap/bc/adt/enhancements/enhoxhh/zenh_ns')],
    objectStructure: () => ({
      objectUrl: '/sap/bc/adt/enhancements/enhoxhh/zenh_ns',
      metaData: { 'adtcore:type': 'ENHO/XHH' },
      links: [{ rel: ENHO_REL, href: '/sap/bc/adt/functions/groups/%2fscwm%2fto_whr/enhancements/options' }],
    }),
  });
  const out = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZENH_NS', fields: false }));
  assert.deepEqual(out.enhancedObject, {
    uri: '/sap/bc/adt/functions/groups/%2fscwm%2fto_whr',
    kind: 'FUGR',
    name: '/SCWM/TO_WHR',
  });
  // Not an ENHO: the key is absent, not null.
  const plain = jsonOf(await byName(toolsWith(fakeApi()), 'adt_object_info').handler({ objectName: 'ZI_TEST', fields: false }));
  assert.equal('enhancedObject' in plain, false);
});

// --- adt_package_tree: compact (B.1) ------------------------------------------

test('adt_package_tree compact drops the object list, keeps the counts and raises the cap to 5', async () => {
  const api = fakeApi({
    nodeContents: (_type, pkg) => {
      if (pkg === 'ZSD_TEST' || pkg === 'ZSD_TEST_SUB') return { nodes: pkgNodes[pkg] };
      const n = Number(pkg.slice(1));
      return { nodes: [{ OBJECT_NAME: `P${n + 1}`, OBJECT_TYPE: 'DEVC/K', DESCRIPTION: '' }] };
    },
  });
  const log = [];
  const out = jsonOf(
    await byName(toolsWith(api, log), 'adt_package_tree').handler({ packageName: 'zsd_test', depth: 2, compact: true })
  );
  assert.equal(out.compact, true);
  assert.equal(out.depthCap, 5);
  assert.equal(out.total, 3);
  assert.deepEqual(out.byType, { 'DDLS/DF': 1, 'CLAS/OC': 1, 'DEVC/K': 1 });
  assert.equal('objects' in out, false, 'compact carries no object list');
  assert.equal(out.subPackages[0].package, 'ZSD_TEST_SUB');
  assert.equal('objects' in out.subPackages[0], false);
  assert.equal(log.at(-1).target, 'zsd_test#compact');

  // The cap: P0 -> ... -> P5 reads five levels compact, three otherwise.
  await byName(toolsWith(api), 'adt_package_tree').handler({ packageName: 'P0', depth: 99, compact: true });
  assert.equal(api.count('nodeContents'), 2 + 5, 'levels 1..5 are read compact');
  await byName(toolsWith(api), 'adt_package_tree').handler({ packageName: 'P0', depth: 99 });
  assert.equal(api.count('nodeContents'), 2 + 5 + 3, 'levels 1..3 otherwise');
});

test('adt_package_tree compact with describe carries the sub-package description on the node', async () => {
  const api = fakeApi({
    nodeContents: (_type, pkg) => ({ nodes: pkgNodes[pkg] ?? [] }),
    searchObject: (q) => [{ 'adtcore:name': q, 'adtcore:type': 'DEVC/K', 'adtcore:description': `text of ${q}` }],
  });
  const out = jsonOf(
    await byName(toolsWith(api), 'adt_package_tree').handler({
      packageName: 'ZSD_TEST', depth: 2, compact: true, describe: true,
    })
  );
  assert.equal(out.subPackages[0].description, 'text of ZSD_TEST_SUB');
});

// --- adt_customizing (the first POST) -----------------------------------------

const PREVIEW_COL = (name, type, values) =>
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="${type}" dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/><dataPreview:dataSet>${values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join('')}</dataPreview:dataSet></dataPreview:columns>`;
const PREVIEW_BODY =
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><dataPreview:totalRows>9400</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView><dataPreview:executedQueryString>SELECT KALSM, KOFRM FROM T683S WHERE KOFRM = \'0000953\'   INTO     TABLE @DATA(LT_RESULT)   UP TO 5  ROWS   .</dataPreview:executedQueryString><dataPreview:queryExecutionTime>0.1</dataPreview:queryExecutionTime>' +
  PREVIEW_COL('KALSM', 'C', ['ZDEMO1', 'ZDEMO2']) +
  PREVIEW_COL('KOFRM', 'N', ['0000953', '0000953']) +
  '</dataPreview:tableData>';

function sessionWithPost(api, body, sent = [], status = 200) {
  return {
    api,
    sources: { catalog: null, mirror: null, precedent: null },
    raw: {
      httpClient: {
        request: async (url, cfg) => {
          sent.push({ url, ...cfg });
          if (status >= 400) throw Object.assign(new Error('server said no'), { err: status });
          return { status, body, headers: { 'content-type': 'application/vnd.sap.adt.datapreview.table.v1+xml' } };
        },
      },
    },
  };
}

test('adt_customizing reads an allow-listed table by POST and audits the table, never a row', async () => {
  const log = [];
  const sent = [];
  const tools = buildTools(cfgWith(log), sessionWithPost(fakeApi(), PREVIEW_BODY, sent));
  const out = jsonOf(
    await byName(tools, 'adt_customizing').handler({
      table: 't683s',
      fields: ['KALSM', 'KOFRM'],
      where: [{ field: 'KOFRM', value: '0000953' }],
      rows: 5,
    })
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, '/sap/bc/adt/datapreview/freestyle?rowNumber=5');
  assert.equal(sent[0].body, "SELECT KALSM, KOFRM FROM T683S WHERE KOFRM = '0000953'");
  assert.equal(out.table, 'T683S');
  assert.equal(out.count, 2);
  assert.equal(out.totalRows, 9400);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.rows[1], { KALSM: 'ZDEMO2', KOFRM: '0000953' });
  assert.equal(out.drift, undefined);
  const audit = log.at(-1);
  assert.equal(audit.tool, 'adt_customizing');
  assert.equal(audit.target, 'T683S rows<=5');
  assert.ok(!JSON.stringify(audit).includes('ZDEMO1'), 'no row value reaches the audit line');
});

test('adt_customizing refuses a table outside the list before any request, and needs a raw client', async () => {
  const sent = [];
  const tools = buildTools(cfgWith([]), sessionWithPost(fakeApi(), PREVIEW_BODY, sent));
  await assert.rejects(() => byName(tools, 'adt_customizing').handler({ table: 'VBAK' }), /not in the customizing allow-list/);
  await assert.rejects(() => byName(tools, 'adt_customizing').handler({ table: 'T683S', rows: 999 }), /1 to 200/);
  assert.equal(sent.length, 0);
  await assert.rejects(() => byName(toolsWith(fakeApi()), 'adt_customizing').handler({ table: 'T683S' }), /no raw client/);
  assert.equal(journalLines.filter((l) => l.code === 'TABLE_NOT_READ').length, 0, 'a refusal is not a failed read');
});

test('adt_customizing files TABLE_NOT_READ when the server fails, and SHAPE_DRIFT when the shape aged', async () => {
  const tools = buildTools(cfgWith([]), sessionWithPost(fakeApi(), '', [], 500));
  await assert.rejects(() => byName(tools, 'adt_customizing').handler({ table: 'TVCPA' }), /500/);
  const gap = journalLines.find((l) => l.code === 'TABLE_NOT_READ');
  assert.equal(gap?.subject, 'TVCPA');
  assert.match(gap.impact, /NOT an empty table/);

  const aged = PREVIEW_BODY.replace('</dataPreview:tableData>', '<dataPreview:extra/></dataPreview:tableData>');
  const asked = { table: 'T683S', fields: ['KALSM', 'KOFRM'], where: [{ field: 'KOFRM', value: '0000953' }], rows: 5 };
  const out = jsonOf(await byName(buildTools(cfgWith([]), sessionWithPost(fakeApi(), aged)), 'adt_customizing').handler(asked));
  assert.equal(out.count, 2, 'the rows stand');
  assert.ok(out.drift.some((d) => d.node === 'extra'));
  assert.ok(journalLines.some((l) => l.code === 'SHAPE_DRIFT' && /T683S/.test(l.subject)));
});

test('adt_customizing refuses rows the server selected with another statement, and sends a long one on several lines', async () => {
  // The echo answers a different WHERE than the one asked: measured as a silent truncation.
  const tools = buildTools(cfgWith([]), sessionWithPost(fakeApi(), PREVIEW_BODY));
  await assert.rejects(
    () => byName(tools, 'adt_customizing').handler({ table: 'T683S', fields: ['KALSM', 'KOFRM'], where: [{ field: 'KOFRM', value: '0000953' }, { field: 'KVEWE', value: 'X' }], rows: 5 }),
    (e) => e.name === 'QueryAltered'
  );
  const gap = journalLines.findLast((l) => l.code === 'TABLE_NOT_READ');
  assert.equal(gap?.subject, 'T683S');
  assert.match(gap.impact, /different question/);

  // 30 routines: 343 characters, out on two lines; the server's echo joins them with one blank.
  const sent = [];
  const long = Array.from({ length: 30 }, (_, i) => String(901 + i).padStart(7, '0'));
  const oneLine = `SELECT * FROM T683S WHERE KOFRM IN (${long.map((v) => `'${v}'`).join(', ')})`;
  const echoed = PREVIEW_BODY.replace(/<dataPreview:executedQueryString>[^<]*/, `<dataPreview:executedQueryString>${oneLine.replace(/'/g, '&apos;')}   INTO     TABLE @DATA(LT_RESULT)   UP TO 50  ROWS   .`);
  const out = jsonOf(await byName(buildTools(cfgWith([]), sessionWithPost(fakeApi(), echoed, sent)), 'adt_customizing').handler({ table: 'T683S', where: [{ field: 'KOFRM', op: 'IN', value: long }] }));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('\n') && sent[0].body.split('\n').every((l) => l.length <= 255));
  assert.equal(out.count, 2);
});

// --- adt_atc_run (the second POST, 2026-09-14) ----------------------------------

const ATC_ID = '0123456789ABCDEF0123456789ABCDEF';

/** The check variant read after a run: an SAP variant measured 2026-11-09 (8 checks). */
const CHECK_VARIANT = () => fs.readFileSync(new URL('./fixtures/atc-checkvariant-measured.xml', import.meta.url), 'utf8');

/** A session whose raw client plays the ATC calls: worklist POST, run POST, worklist GET, variant GET. */
function sessionForAtc(api, sent = [], fail = {}) {
  return {
    api,
    sources: { catalog: null, mirror: null, precedent: null },
    raw: {
      httpClient: {
        request: async (url, cfg = {}) => {
          sent.push({ url, ...cfg });
          const step = cfg.method === 'POST' ? (url.includes('/worklists?') ? 'worklist' : 'run') : url.includes('/atc/checkvariants/') ? 'variant' : 'read';
          if (fail[step]) throw Object.assign(new Error('server said no'), { err: fail[step] });
          if (step === 'worklist') return { status: 200, body: ATC_ID, headers: { 'content-type': 'text/plain' } };
          if (step === 'run') return { status: 200, body: ATC_RUN_REPLY, headers: { 'content-type': 'application/xml' } };
          if (step === 'variant') return { status: 200, body: CHECK_VARIANT(), headers: { 'content-type': 'application/vnd.sap.adt.chkvv4+xml' } };
          return { status: 200, body: ATC_WORKLIST(fail.aged ? ' atcfinding:severity="9"' : ''), headers: { 'content-type': 'application/atc.worklist.v1+xml' } };
        },
      },
    },
  };
}

test('adt_atc_run sends the two POSTs and the GET, answers the findings, and audits ids and counts -- never a finding', async () => {
  // The governance variant is an installation's: installed here the way the store installs it.
  installAtcVariants([{ name: 'ZDEMO_CLEAN_CORE', why: 'the system check variant of a demo installation' }], 'ZDEMO_CLEAN_CORE');
  try {
  const log = [];
  const sent = [];
  const api = fakeApi({ searchObject: () => CLASS_HITS });
  const out = jsonOf(await byName(buildTools(cfgWith(log), sessionForAtc(api, sent)), 'adt_atc_run').handler({ objectName: 'zcl_t', maxFindings: 10 }));
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((c) => c.method ?? 'GET'), ['POST', 'POST', 'GET', 'GET']);
  assert.equal(sent[0].url, '/sap/bc/adt/atc/worklists?checkVariant=ZDEMO_CLEAN_CORE');
  assert.equal(sent[1].url, `/sap/bc/adt/atc/runs?worklistId=${ATC_ID}`);
  assert.match(sent[1].body, /maximumVerdicts="10"/);
  assert.match(sent[1].body, /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_t"/);
  assert.equal(sent[2].url, `/sap/bc/adt/atc/worklists/${ATC_ID}`);
  assert.equal(sent[2].headers.Accept, 'application/atc.worklist.v1+xml');
  // The variant that ran, read once after the run (a CHKV variant: its checks and parameters).
  assert.equal(sent[3].url, '/sap/bc/adt/atc/checkvariants/zdemo_clean_core');
  assert.equal(sent[3].headers.Accept, 'application/vnd.sap.adt.chkvv4+xml');
  assert.equal(out.variantKind, 'CHKV');
  assert.equal(out.variantChecks.length, 8);
  assert.deepEqual(out.variantChecks[1].parameters, [{ name: 'ABAPLanguageVersion', value: '1' }]);
  assert.equal(out.variant, 'ZDEMO_CLEAN_CORE');
  assert.equal(out.worklistId, ATC_ID);
  assert.equal(out.object.name, 'ZCL_T');
  assert.equal(out.count, 2);
  assert.deepEqual(out.byPriority, { 1: 1, 2: 1, 3: 0 });
  assert.deepEqual(out.runStats, { 1: 1, 2: 1, 3: 0 });
  assert.equal(out.findings[0].checkId, 'NOAPI');
  assert.equal(out.findings[0].location.line, 12);
  assert.equal(out.truncated, false);
  assert.equal(out.drift, undefined);
  const mine = log.filter((l) => l.tool === 'adt_atc_run');
  assert.equal(mine.length, 4);
  assert.equal(mine[0].target, 'ZDEMO_CLEAN_CORE CLAS/OC ZCL_T#worklist');
  assert.equal(mine[1].target, `${ATC_ID}#run`);
  assert.equal(mine[2].target, `${ATC_ID}#worklist`);
  assert.equal(mine[3].target, 'ZDEMO_CLEAN_CORE#variant');
  const auditText = JSON.stringify(mine);
  assert.ok(!auditText.includes('NOAPI') && !auditText.includes('non-released'), 'no finding reaches the audit line');
  assert.equal(journalLines.filter((l) => /^ATC_/.test(l.code)).length, 0);
  } finally {
    installAtcVariants([]);
  }
});

test('adt_atc_run: an SCI variant (404) is said, not filed; any other failure is filed and the findings stand', async () => {
  const api = fakeApi({ searchObject: () => CLASS_HITS });
  const sci = jsonOf(await byName(buildTools(cfgWith([]), sessionForAtc(api, [], { variant: 404 })), 'adt_atc_run').handler({ objectName: 'zcl_t' }));
  assert.equal(sci.variantKind, 'SCI');
  assert.match(sci.variantNote, /transaction SCI/);
  assert.equal(sci.count, 2, 'the findings of the run stand');
  assert.equal(journalLines.filter((l) => l.code === 'ATC_VARIANT_NOT_READ').length, 0, 'documented behaviour, not a gap');

  const broken = jsonOf(await byName(buildTools(cfgWith([]), sessionForAtc(api, [], { variant: 500 })), 'adt_atc_run').handler({ objectName: 'zcl_t' }));
  assert.equal(broken.variantKind, undefined);
  assert.match(broken.variantNote, /check list not read/);
  assert.equal(broken.count, 2);
  assert.equal(journalLines.filter((l) => l.code === 'ATC_VARIANT_NOT_READ').length, 1);
});

test('loadSystemVariant reads atc/customizing once at start: the variant joins the tool schema and is its default', async () => {
  try {
    installAtcVariants([]);
    const sent = [];
    const log = [];
    const session = {
      api: fakeApi({ searchObject: () => CLASS_HITS }),
      raw: { httpClient: { request: async (url, c = {}) => (sent.push({ url, ...c }), { status: 200, body: ATC_CUSTOMIZING(), headers: { 'content-type': 'application/vnd.sap.atc.customizing-v1+xml' } }) } },
    };
    const r = await loadSystemVariant(cfgWith(log), session, null);
    assert.deepEqual(r, { read: true, installed: 'ZDEMO_SYSTEM_CC', defaultVariant: 'ZDEMO_SYSTEM_CC', explicitDefault: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/sap/bc/adt/atc/customizing');
    assert.equal(sent[0].method, 'GET');
    assert.equal(log.at(-1).target, 'atc/customizing#systemCheckVariant', 'one audit line');
    const def = byName(buildTools(cfgWith([]), sessionForAtc(session.api)), 'adt_atc_run').definition;
    assert.ok(def.inputSchema.properties.variant.enum.includes('ZDEMO_SYSTEM_CC'));
    assert.match(def.description, /Default ZDEMO_SYSTEM_CC/);
    assert.match(def.description, /ZDEMO_SYSTEM_CC \(the system check variant/);
  } finally {
    installAtcVariants([]);
  }
});

test('loadSystemVariant that cannot read starts with DEFAULT and the store only, and files ATC_SYSTEM_VARIANT_NOT_READ', async () => {
  try {
    installAtcVariants([]);
    journalLines.length = 0;
    const cfg = cfgWith([]);
    const journal = openJournal(cfg);
    const failing = { raw: { httpClient: { request: async () => { throw Object.assign(new Error('server said no'), { err: 500 }); } } } };
    let r = await loadSystemVariant(cfg, failing, journal);
    assert.equal(r.read, false);
    assert.equal(r.installed, null);
    assert.equal(r.defaultVariant, 'DEFAULT');
    assert.deepEqual([...ATC_VARIANTS_LIVE.keys()], ['DEFAULT']);
    let gap = journalLines.find((l) => l.code === 'ATC_SYSTEM_VARIANT_NOT_READ');
    assert.match(gap.detail, /HTTP 500/);
    assert.match(gap.impact, /DEFAULT and the store's variants only/);

    journalLines.length = 0;
    const odd = { raw: { httpClient: { request: async () => ({ status: 200, body: ATC_CUSTOMIZING('BAD&amp;NAME'), headers: {} }) } } };
    r = await loadSystemVariant(cfg, odd, journal);
    assert.equal(r.read, false);
    gap = journalLines.find((l) => l.code === 'ATC_SYSTEM_VARIANT_NOT_READ');
    assert.match(gap.detail, /not a check variant name/);

    journalLines.length = 0;
    r = await loadSystemVariant(cfg, {}, journal);
    assert.match(r.detail, /no raw client/);
    assert.ok(journalLines.some((l) => l.code === 'ATC_SYSTEM_VARIANT_NOT_READ'));
  } finally {
    installAtcVariants([]);
  }
});

test('adt_atc_run caps the findings it lists itself, most severe first, because the server ignores maximumVerdicts', async () => {
  // Measured 2026-11-09: maximumVerdicts=5 still answered every finding. The worklist fixture
  // holds a priority-1 and a priority-2 finding; the run stats say 2 in total.
  const tool = byName(buildTools(cfgWith([]), sessionForAtc(fakeApi({ searchObject: () => CLASS_HITS }))), 'adt_atc_run');
  const one = jsonOf(await tool.handler({ objectName: 'ZCL_T', variant: 'DEFAULT', maxFindings: 1 }));
  assert.equal(one.count, 2, 'count is what the worklist holds');
  assert.equal(one.shown, 1);
  assert.equal(one.findings.length, 1);
  assert.equal(one.findings[0].priority, 1, 'the most severe finding survives the cap');
  assert.deepEqual(one.byPriority, { 1: 1, 2: 1, 3: 0 }, 'the counts cover every finding, listed or not');
  assert.equal(one.truncated, true);
  const all = jsonOf(await tool.handler({ objectName: 'ZCL_T', variant: 'DEFAULT', maxFindings: 2 }));
  assert.equal(all.shown, 2);
  assert.equal(all.truncated, false, 'exactly at the cap is complete, not "possible"');
});

test('adt_atc_run refuses a variant outside the set, a bad count and an ENHO/XH before any request, and needs a raw client', async () => {
  const sent = [];
  const tools = buildTools(cfgWith([]), sessionForAtc(fakeApi({ searchObject: () => CLASS_HITS }), sent));
  await assert.rejects(() => byName(tools, 'adt_atc_run').handler({ objectName: 'ZCL_T', variant: 'ZZZ_NOPE_17' }), /must be one of DEFAULT/);
  await assert.rejects(() => byName(tools, 'adt_atc_run').handler({ objectName: 'ZCL_T', variants: ['DEFAULT', 'ZZZ_NOPE_17'] }), /must be one of DEFAULT/);
  await assert.rejects(() => byName(tools, 'adt_atc_run').handler({ objectName: 'ZCL_T', variant: 'DEFAULT', variants: ['DEFAULT'] }), /not both/);
  await assert.rejects(() => byName(tools, 'adt_atc_run').handler({ objectName: 'ZCL_T', variants: [] }), /at least 1 item/);
  await assert.rejects(() => byName(tools, 'adt_atc_run').handler({ objectName: 'ZCL_T', maxFindings: 500 }), /1 to 100/);
  await assert.rejects(() => byName(tools, 'adt_atc_run').handler({ objectName: '' }), /needs an objectName/);
  const xh = fakeApi({ searchObject: () => [hit('ZCL_ENH_DEMO', 'ENHO/XH', 'ZDEMO', '/sap/bc/adt/enhancements/enhoxh/zcl_enh_demo')] });
  await assert.rejects(() => byName(buildTools(cfgWith([]), sessionForAtc(xh, sent)), 'adt_atc_run').handler({ objectName: 'ZCL_ENH_DEMO' }), /class\/interface enhancement/);
  assert.equal(sent.length, 0, 'nothing left the client');
  await assert.rejects(() => byName(toolsWith(fakeApi({ searchObject: () => CLASS_HITS })), 'adt_atc_run').handler({ objectName: 'ZCL_T' }), /no raw client/);
  assert.equal(journalLines.filter((l) => /^ATC_/.test(l.code)).length, 0, 'a refusal is not a failed run');
});

test('adt_atc_run runs up to three variants on the same object, one worklist each, findings kept apart', async () => {
  installAtcVariants(
    [
      { name: 'ZDEMO_CLEAN_CORE', why: 'Clean Core governance' },
      { name: 'ZDEMO_DEV_PRACTICE', why: 'development practices' },
    ],
    'ZDEMO_CLEAN_CORE'
  );
  try {
    const sent = [];
    const tools = buildTools(cfgWith([]), sessionForAtc(fakeApi({ searchObject: () => CLASS_HITS }), sent));
    const tool = byName(tools, 'adt_atc_run');
    assert.deepEqual(tool.definition.inputSchema.properties.variants.items.enum, ['DEFAULT', 'ZDEMO_CLEAN_CORE', 'ZDEMO_DEV_PRACTICE']);
    assert.match(tool.definition.description, /ZDEMO_DEV_PRACTICE \(development practices\)/, 'each variant is announced with its purpose');
    const progress = [];
    const out = jsonOf(await tool.handler(
      { objectName: 'ZCL_T', variants: ['ZDEMO_CLEAN_CORE', 'ZDEMO_DEV_PRACTICE', 'ZDEMO_CLEAN_CORE'] },
      { _meta: { progressToken: 'p' }, sendNotification: async (n) => progress.push(n.params.progress) }
    ));
    assert.deepEqual(out.variants, ['ZDEMO_CLEAN_CORE', 'ZDEMO_DEV_PRACTICE'], 'a repeated variant runs once');
    assert.equal(sent.length, 8, 'three calls per variant, plus the read of each variant');
    assert.equal(sent.filter((c) => /checkVariant=ZDEMO_DEV_PRACTICE/.test(c.url)).length, 1);
    assert.deepEqual(out.runs.map((r) => r.variant), ['ZDEMO_CLEAN_CORE', 'ZDEMO_DEV_PRACTICE']);
    assert.equal(out.summary.length, 2);
    assert.equal(out.object.name, 'ZCL_T', 'the object is resolved once and named once');
    assert.deepEqual(progress, [0, 1, 2]);
    await assert.rejects(
      () => tool.handler({ objectName: 'ZCL_T', variants: ['DEFAULT', 'ZDEMO_CLEAN_CORE', 'ZDEMO_DEV_PRACTICE', 'DEFAULT'] }),
      /at most 3 item/
    );
  } finally {
    installAtcVariants([], undefined);
  }
});

test('adt_atc_run with several variants reports the one that failed as not run, and still answers the others', async () => {
  installAtcVariants([{ name: 'ZDEMO_CLEAN_CORE', why: 'Clean Core governance' }], 'ZDEMO_CLEAN_CORE');
  try {
    const sent = [];
    const session = sessionForAtc(fakeApi({ searchObject: () => CLASS_HITS }), sent);
    const inner = session.raw.httpClient.request;
    session.raw.httpClient.request = async (url, cfg) => {
      if (/checkVariant=DEFAULT/.test(url)) throw Object.assign(new Error('server said no'), { err: 500 });
      return inner(url, cfg);
    };
    const out = jsonOf(await byName(buildTools(cfgWith([]), session), 'adt_atc_run').handler({ objectName: 'ZCL_T', variants: ['DEFAULT', 'ZDEMO_CLEAN_CORE'] }));
    assert.deepEqual(out.runs.map((r) => r.variant), ['ZDEMO_CLEAN_CORE']);
    assert.equal(out.notRun[0].variant, 'DEFAULT');
    assert.match(out.note, /NO verdict/);
    assert.ok(journalLines.some((l) => l.code === 'ATC_NOT_RUN'));
  } finally {
    installAtcVariants([], undefined);
  }
});

test('adt_atc_run files ATC_NOT_RUN when a POST fails, ATC_RESULT_NOT_READ when the read fails, SHAPE_DRIFT when the shape aged', async () => {
  const api = () => fakeApi({ searchObject: () => CLASS_HITS });
  await assert.rejects(() => byName(buildTools(cfgWith([]), sessionForAtc(api(), [], { worklist: 500 })), 'adt_atc_run').handler({ objectName: 'ZCL_T' }), /ATC worklist/);
  let gap = journalLines.find((l) => l.code === 'ATC_NOT_RUN');
  assert.equal(gap?.subject, 'CLAS/OC ZCL_T');
  assert.match(gap.impact, /NOT a clean object/);

  journalLines.length = 0;
  await assert.rejects(() => byName(buildTools(cfgWith([]), sessionForAtc(api(), [], { run: 500 })), 'adt_atc_run').handler({ objectName: 'ZCL_T' }), /ATC run/);
  gap = journalLines.find((l) => l.code === 'ATC_NOT_RUN');
  assert.match(gap.detail, new RegExp(ATC_ID));

  journalLines.length = 0;
  await assert.rejects(() => byName(buildTools(cfgWith([]), sessionForAtc(api(), [], { read: 500 })), 'adt_atc_run').handler({ objectName: 'ZCL_T' }));
  gap = journalLines.find((l) => l.code === 'ATC_RESULT_NOT_READ');
  assert.equal(gap?.subject, 'CLAS/OC ZCL_T');
  assert.match(gap.impact, /FINDING_STATS 1,1,0/);
  assert.match(gap.impact, /NOT zero findings/);

  journalLines.length = 0;
  const out = jsonOf(await byName(buildTools(cfgWith([]), sessionForAtc(api(), [], { aged: true })), 'adt_atc_run').handler({ objectName: 'ZCL_T', variant: 'DEFAULT', includeExempted: true }));
  assert.equal(out.count, 2, 'the findings stand');
  assert.ok(out.drift.some((d) => d.node === 'finding/@atcfinding:severity'));
  assert.ok(journalLines.some((l) => l.code === 'SHAPE_DRIFT' && l.subject === `ATC worklist ${ATC_ID}`));
});

// --- the journal wrapper -----------------------------------------------------

test('every invocation leaves one journal line, with what it cost', async () => {
  const api = fakeApi();
  await byName(toolsWith(api), 'adt_search').handler({ query: 'ZI_TEST*' });
  const calls = journalLines.filter((l) => l.stream === 'calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'adt_search');
  assert.equal(calls[0].ok, true);
  // adt_search makes one ADT call, and the count comes from the audit budget counter,
  // not from anything the wrapper assumes.
  assert.equal(calls[0].adtCalls, 1);
  assert.equal(typeof calls[0].ms, 'number');
  assert.equal(calls[0].args.query, 'ZI_TEST*');
});

test('a failing tool is journalled as a failure, with the message and not the stack', async () => {
  const api = fakeApi({
    searchObject: () => {
      throw new Error('ADT said no');
    },
  });
  await assert.rejects(() => byName(toolsWith(api), 'adt_search').handler({ query: 'X' }));
  const calls = journalLines.filter((l) => l.stream === 'calls');
  assert.equal(calls[0].ok, false);
  assert.equal(calls[0].outcome, 'ADT said no');
  assert.equal(calls[0].stack, undefined);
});

test('the journal never breaks an answer when its sink throws', async () => {
  const log = [];
  const cfg = cfgWith(log);
  cfg.journalSink = () => {
    throw new Error('disk full');
  };
  const tools = buildTools(cfg, {
    api: fakeApi(),
    sources: { catalog: null, mirror: null, precedent: null },
  });
  const out = jsonOf(await byName(tools, 'adt_search').handler({ query: 'ZI_TEST*' }));
  assert.equal(out.count, 2, 'the answer is unaffected by the logging failure');
});

// Measured on a package with ten sub-packages: the tree resource sends eleven
// nodes -- the "Subpacotes" folder plus ten packages -- and the DESCRIPTION on each row
// belongs to the NEXT one (the folder carries the first package's text, the last package
// is empty). The library's parser is one object per XML element, and the resource is
// POST-only, so the shift is the server's and cannot be re-read raw. The text is therefore
// never presented as the description of its row.
const SHIFTED = [
  { OBJECT_NAME: '', OBJECT_TYPE: 'DEVC/K', NODE_ID: 2, DESCRIPTION: 'Module A' },
  { OBJECT_NAME: 'ZA', OBJECT_TYPE: 'DEVC/K', NODE_ID: '', DESCRIPTION: 'Module B' },
  { OBJECT_NAME: 'ZB', OBJECT_TYPE: 'DEVC/K', NODE_ID: '', DESCRIPTION: 'Module C' },
  { OBJECT_NAME: 'ZC', OBJECT_TYPE: 'DEVC/K', NODE_ID: '', DESCRIPTION: '' },
];
const SEARCH_DESC = { ZA: 'Module A', ZB: 'Module B', ZC: 'Module C' };

test('the description belongs to the package it is printed next to', async () => {
  const api = fakeApi({
    nodeContents: () => ({ nodes: SHIFTED }),
    searchObject: (name, type) => [
      { 'adtcore:name': name, 'adtcore:type': type, 'adtcore:description': SEARCH_DESC[name], 'adtcore:uri': `/sap/bc/adt/packages/${name.toLowerCase()}` },
    ],
  });
  const tool = byName(toolsWith(api), 'adt_package_tree');

  // Without `describe`: the tree's text is carried as what it is, and never as `description`.
  const plain = jsonOf(await tool.handler({ packageName: 'ZROOT' }));
  assert.equal(plain.total, 3);
  assert.ok(plain.objects.every((o) => !('description' in o)), 'no row claims a description it does not have');
  assert.deepEqual(plain.objects.map((o) => o.treeDescription), ['Module B', 'Module C', '']);
  assert.match(plain.descriptions, /belongs to the NEXT row/);
  assert.equal(api.count('searchObject'), 0);

  // With `describe`: one search per sub-package, and the description is the package's own.
  const described = jsonOf(await tool.handler({ packageName: 'ZROOT', describe: true }));
  assert.deepEqual(
    described.objects.map((o) => [o.name, o.description]),
    [['ZA', 'Module A'], ['ZB', 'Module B'], ['ZC', 'Module C']]
  );
  assert.equal(api.count('searchObject'), 3);
  assert.match(described.descriptions, /from the search/);

  // With a raw client: ONE virtual-folders POST answers every description and the counts below.
  const sent = [];
  const folders = [
    '<vfs:virtualFoldersResult objectCount="9" xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders">',
    '<vfs:virtualFolder counter="0" text="directly assigned objects" name="..ZROOT" facet="PACKAGE"/>',
    '<vfs:virtualFolder counter="4" text="Module A" name="ZA" uri="/sap/bc/adt/packages/za" facet="PACKAGE"/>',
    '<vfs:virtualFolder counter="3" text="Module B" name="ZB" uri="/sap/bc/adt/packages/zb" facet="PACKAGE"/>',
    '<vfs:virtualFolder counter="2" text="Module C" name="ZC" uri="/sap/bc/adt/packages/zc" facet="PACKAGE"/>',
    '</vfs:virtualFoldersResult>',
  ].join('');
  const api2 = fakeApi({ nodeContents: (t, name) => ({ nodes: name === 'ZROOT' ? SHIFTED : [] }), searchObject: () => [] });
  const raw = { httpClient: { request: async (url, c = {}) => (sent.push({ url, ...c }), { status: 200, body: folders, headers: {} }) } };
  const viaFolders = jsonOf(await byName(buildTools(cfgWith([]), { api: api2, sources: { catalog: null, mirror: null, precedent: null }, raw }), 'adt_package_tree').handler({ packageName: 'ZROOT', describe: true, depth: 1 }));
  assert.deepEqual(
    viaFolders.objects.map((o) => [o.name, o.description, o.objectsBelow]),
    [['ZA', 'Module A', 4], ['ZB', 'Module B', 3], ['ZC', 'Module C', 2]]
  );
  assert.equal(sent.filter((r) => r.method === 'POST').length, 1, 'one POST for the package, not one search per sub-package');
  assert.equal(api2.count('searchObject'), 0);

  // The POST failing costs calls, never the answer: the search is asked and the gap is filed.
  const failing = { httpClient: { request: async () => { throw Object.assign(new Error('nope'), { err: 500 }); } } };
  const viaSearch = jsonOf(await byName(buildTools(cfgWith([]), { api, sources: { catalog: null, mirror: null, precedent: null }, raw: failing }), 'adt_package_tree').handler({ packageName: 'ZROOT', describe: true }));
  assert.deepEqual(viaSearch.objects.map((o) => o.description), ['Module A', 'Module B', 'Module C']);
  assert.ok(viaSearch.objects.every((o) => o.objectsBelow === undefined));
  assert.equal(journalLines.filter((l) => l.code === 'PACKAGE_FOLDERS_NOT_READ').length, 1);
});

// Measured and 2026-09-14, 3 of 3 class enhancements on the system, with every
// Accept: the structure resource dumps the server (ST22: CL_ENH_ADT_ENHO_OBJ_PERSIST->
// GET_DATA_FROM_TOOL, CX_SY_REF_IS_INITIAL). So it is NEVER asked for an ENHO/XH: the tools
// read objectproperties (measurement, step 1c) or nothing, and say where the code really is.
const CLASENH_PROPS = fs.readFileSync(new URL('./fixtures/object-properties-measured.xml', import.meta.url), 'utf8');
const clasenhApi = () =>
  fakeApi({
    searchObject: () => [
      { 'adtcore:name': 'ZDEMO_CLASENH', 'adtcore:type': 'ENHO/XH', 'adtcore:packageName': 'ZDEMO_PKG', 'adtcore:uri': '/sap/bc/adt/enhancements/enhoxh/zdemo_clasenh' },
    ],
    objectStructure: () => {
      throw new Error('the test asked the structure of an ENHO/XH: on the system this dumps the server');
    },
  });

test('adt_object_info on a class enhancement never asks the structure: objectproperties with the one Accept, package chain and owner in the answer, CLASENH_NOT_IN_ADT filed, owner kept out of audit and journal', async () => {
  const log = [];
  const api = clasenhApi();
  const seen = [];
  const session = {
    api,
    sources: { catalog: null, mirror: null, precedent: null },
    raw: { httpClient: { request: async (url, c) => { seen.push({ url, ...c }); return { status: 200, body: CLASENH_PROPS, headers: { 'content-type': 'application/vnd.sap.adt.repository.objproperties.result.v1+xml' } }; } } },
  };
  const out = jsonOf(await byName(buildTools(cfgWith(log), session), 'adt_object_info').handler({ objectName: 'ZDEMO_CLASENH' }));
  assert.equal(api.count('objectStructure'), 0, 'the resource that dumps is never asked');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=%2Fsap%2Fbc%2Fadt%2Fenhancements%2Fenhoxh%2Fzdemo_clasenh');
  assert.deepEqual(seen[0].headers, { Accept: 'application/vnd.sap.adt.repository.objproperties.result.v1+xml' });
  assert.equal(out.clasenh, true);
  assert.deepEqual(out.packagePath, ['YDEMO_ROOT', 'YDEMO_BASIS', 'ZDEMO_PKG']);
  assert.equal(out.parentPackage, 'YDEMO_BASIS');
  assert.equal(out.properties.owner, 'DEMOUSER');
  assert.equal(out.properties.created, '20190620');
  assert.equal(out.properties.apiState, 'NOT_RELEASED');
  assert.equal(out.enhancedObject, null);
  assert.deepEqual(out.elements, []);
  assert.match(out.rule, /structure was NOT read/);
  assert.match(out.rule, /enho\.em_<method>\.abap/);
  const g = journalLines.find((l) => l.code === 'CLASENH_NOT_IN_ADT');
  assert.equal(g.subject, 'ZDEMO_CLASENH');
  assert.ok(!journalLines.some((l) => l.code === 'ENHANCEMENTS_NOT_READ'), 'not a failed read: nothing failed');
  assert.ok(log.some((l) => l.target === 'ZDEMO_CLASENH#properties'), 'the properties read is audited on its own line');
  assert.ok(!JSON.stringify(log).includes('DEMOUSER'), 'the owner never reaches the audit');
  assert.ok(!JSON.stringify(journalLines).includes('DEMOUSER'), 'nor the journal');

  // No raw client: refused plainly, still without touching the structure.
  await assert.rejects(
    () => byName(toolsWith(clasenhApi()), 'adt_object_info').handler({ objectName: 'ZDEMO_CLASENH' }),
    /not read on purpose .* no raw client/
  );
});

test('adt_read_source on a class enhancement answers empty with the place the code is, never asking the structure', async () => {
  const api = clasenhApi();
  const res = textOf(await byName(toolsWith(api), 'adt_read_source').handler({ objectName: 'ZDEMO_CLASENH' }));
  assert.equal(api.count('objectStructure'), 0);
  assert.match(res, /WARNING: a class enhancement \(CLASENH\) or function-module interface enhancement \(FUGRENH\)/);
  assert.match(res, /enho\.em_<method>\.abap/);
  assert.equal(journalLines.find((l) => l.code === 'CLASENH_NOT_IN_ADT').subject, 'ZDEMO_CLASENH');
  // In a batch the item stands, with the same warning, and no other item pays for it.
  const out = jsonOf(await byName(toolsWith(clasenhApi()), 'adt_read_source').handler({ objectNames: ['ZDEMO_CLASENH'] }));
  assert.equal(out.read, 1);
  assert.match(out.items[0].warning, /no source through the ADT/);
});

// --- adt_object_info: a package's ancestry, a BAdI implementation's spot (measurement, steps 8 and 10)

test('adt_object_info on a package answers packagePath root-first and parentPackage from findObjectPath; a failure is not a root', async () => {
  const log = [];
  const pkg = hit('ZFI_DEMO', 'DEVC/K', 'YDEMO_FI', '/sap/bc/adt/packages/zfi_demo');
  const path = [
    { 'adtcore:uri': '/sap/bc/adt/packages/ydemo_root', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'YDEMO_ROOT', 'projectexplorer:category': 'packages' },
    { 'adtcore:uri': '/sap/bc/adt/packages/ydemo_fi', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'YDEMO_FI', 'adtcore:parentUri': '/sap/bc/adt/packages/ydemo_root', 'projectexplorer:category': 'packages' },
    { 'adtcore:uri': '/sap/bc/adt/packages/zfi_demo', 'adtcore:type': 'DEVC/K', 'adtcore:name': 'ZFI_DEMO', 'adtcore:parentUri': '/sap/bc/adt/packages/ydemo_fi', 'projectexplorer:category': 'packages' },
  ];
  const api = fakeApi({ searchObject: () => [pkg], objectStructure: () => ({ objectUrl: pkg['adtcore:uri'], metaData: {}, links: [] }), findObjectPath: () => path });
  api.findObjectPath = api.findObjectPath ?? (async () => path);
  const out = jsonOf(await byName(toolsWith(api, log), 'adt_object_info').handler({ objectName: 'ZFI_DEMO', objectType: 'DEVC/K', fields: false }));
  assert.deepEqual(out.packagePath.map((s) => s.name), ['YDEMO_ROOT', 'YDEMO_FI', 'ZFI_DEMO']);
  assert.equal(out.parentPackage, 'YDEMO_FI');
  assert.equal(out.packagePathNote, undefined);
  assert.ok(log.some((l) => l.tool === 'adt_object_info' && l.target === 'ZFI_DEMO#path'), 'the path call is audited on its own line');

  // The root: in the path, first, parent null. Not in the path at all: parent undefined and said so.
  const root = hit('YDEMO_ROOT', 'DEVC/K', '', '/sap/bc/adt/packages/ydemo_root');
  const api2 = fakeApi({ searchObject: () => [root], objectStructure: () => ({ objectUrl: root['adtcore:uri'], metaData: {}, links: [] }) });
  api2.findObjectPath = async () => [path[0]];
  const r = jsonOf(await byName(toolsWith(api2), 'adt_object_info').handler({ objectName: 'YDEMO_ROOT', objectType: 'DEVC/K', fields: false }));
  assert.equal(r.parentPackage, null);
  api2.findObjectPath = async () => { throw new Error('boom'); };
  const f = jsonOf(await byName(toolsWith(api2), 'adt_object_info').handler({ objectName: 'YDEMO_ROOT', objectType: 'DEVC/K', fields: false }));
  assert.equal(f.packagePath, undefined);
  assert.match(f.packagePathNote, /NOT a root package/);

  // Not a package: no path call at all.
  const api3 = fakeApi();
  api3.findObjectPath = async () => assert.fail('a view has no package path to ask');
  const v = jsonOf(await byName(toolsWith(api3), 'adt_object_info').handler({ objectName: 'ZI_TEST', fields: false }));
  assert.equal(v.packagePath, undefined);
});

test('adt_object_info on an ENHO/XHB reads its body once at its own URI and answers the spot; without a raw client it says so', async () => {
  const fs = await import('node:fs');
  const xml = fs.readFileSync(new URL('./fixtures/enhoxhb-measured.xml', import.meta.url), 'utf8');
  const xhb = hit('ZDEMO_BADI_IMPL', 'ENHO/XHB', 'ZDEMO', '/sap/bc/adt/enhancements/enhoxhb/zdemo_badi_impl');
  const structure = { objectUrl: xhb['adtcore:uri'], metaData: {}, links: [{ rel: 'http://www.sap.com/adt/relations/versions', href: 'versions' }] };
  const log = [];
  const urls = [];
  const api = fakeApi({ searchObject: () => [xhb], objectStructure: () => structure });
  const tools = buildTools(cfgWith(log), sessionWithRaw(api, xml, urls));
  const out = jsonOf(await byName(tools, 'adt_object_info').handler({ objectName: 'ZDEMO_BADI_IMPL', objectType: 'ENHO/XHB', fields: false }));
  assert.deepEqual(urls, [xhb['adtcore:uri']]);
  assert.equal(out.enhancedObject, null, 'a BAdI implementation publishes no enhanced object -- measured, not a miss');
  assert.equal(out.badi.implementations[0].spot.name, '/XNFE/ES_INVOICE_ENHANCE');
  assert.equal(out.badi.implementations[0].implementingClass.name, 'ZCL_DEMO_BADI_IMPL');
  assert.equal(out.badiNote, undefined);
  assert.ok(log.some((l) => l.target === 'ZDEMO_BADI_IMPL#badi'), 'the body read is audited on its own line');
  assert.ok(!journalLines.some((l) => l.code === 'SHAPE_DRIFT'));

  // The rest of the answer stands when the body cannot be read, and the gap says it is not an orphan.
  const failing = { api, sources: { catalog: null, mirror: null, precedent: null }, raw: { httpClient: { request: async () => { throw Object.assign(new Error('nope'), { err: 500 }); } } } };
  const f = jsonOf(await byName(buildTools(cfgWith([]), failing), 'adt_object_info').handler({ objectName: 'ZDEMO_BADI_IMPL', objectType: 'ENHO/XHB', fields: false }));
  assert.equal(f.badi, undefined);
  assert.match(f.badiNote, /badi not read/);
  assert.equal(f.found['adtcore:name'], 'ZDEMO_BADI_IMPL');
  const g = journalLines.find((l) => l.code === 'ENHANCEMENTS_NOT_READ');
  assert.ok(g);
  assert.match(g.impact, /NOT evidence of an orphan/);

  // No raw client: no body, said plainly.
  const n = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZDEMO_BADI_IMPL', objectType: 'ENHO/XHB', fields: false }));
  assert.match(n.badiNote, /no raw client/);
});

test('adt_object_info on a SRVB reads the binding and the detail of each version; without a raw client it says so', async () => {
  const fs = await import('node:fs');
  const fx = (n) => fs.readFileSync(new URL(`./fixtures/service-binding/${n}`, import.meta.url), 'utf8');
  const srvb = hit('ZDEMO_UI_FLIGHT_O2', 'SRVB/SVB', 'ZDEMO', '/sap/bc/adt/businessservices/bindings/zdemo_ui_flight_o2');
  const structure = { objectUrl: srvb['adtcore:uri'], metaData: {}, links: [] };
  const api = fakeApi({ searchObject: () => [srvb], objectStructure: () => structure });
  const urls = [];
  const session = {
    api,
    sources: { catalog: null, mirror: null, precedent: null },
    raw: {
      httpClient: {
        request: async (url, c = {}) => {
          urls.push({ url, method: c.method });
          const body = /serviceversion=0001/.test(url) ? fx('detail-v2-0001-unpublished.xml')
            : /serviceversion=0002/.test(url) ? fx('detail-v2-0002-published.xml')
            : fx('binding-v2-two-versions.xml');
          return { status: 200, body, headers: {} };
        },
      },
    },
  };
  const log = [];
  const out = jsonOf(await byName(buildTools(cfgWith(log), session), 'adt_object_info').handler({ objectName: 'ZDEMO_UI_FLIGHT_O2', objectType: 'SRVB/SVB', fields: false }));
  assert.deepEqual(urls.map((u) => u.method), ['GET', 'GET', 'GET']);
  assert.equal(out.binding.type, 'ODATA');
  assert.deepEqual(out.binding.versions.map((v) => [v.version, v.published]), [['0001', false], ['0002', true]]);
  assert.equal(out.bindingNote, undefined);
  assert.ok(log.some((l) => l.target === 'ZDEMO_UI_FLIGHT_O2#0002'), 'each detail read is audited on its own line');

  const n = jsonOf(await byName(toolsWith(api), 'adt_object_info').handler({ objectName: 'ZDEMO_UI_FLIGHT_O2', objectType: 'SRVB/SVB', fields: false }));
  assert.equal(n.binding, undefined);
  assert.match(n.bindingNote, /no raw client/);
});

test('adt_search on APLO also answers the legacy objects created in SLG0; other types answer none', async () => {
  const preview = (sql, cols) =>
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `<dataPreview:totalRows>${Object.values(cols)[0].length}</dataPreview:totalRows>` +
    `<dataPreview:executedQueryString>${sql.replace(/'/g, '&apos;')} INTO TABLE @DATA(LT_RESULT) UP TO 200 ROWS .</dataPreview:executedQueryString>` +
    Object.entries(cols).map(([k, v]) => `<dataPreview:columns><dataPreview:metadata dataPreview:name="${k}" dataPreview:type="C" dataPreview:description="${k}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
      (v.length ? `<dataPreview:dataSet>${v.map((x) => `<dataPreview:data>${x}</dataPreview:data>`).join('')}</dataPreview:dataSet>` : '<dataPreview:dataSet/>') + '</dataPreview:columns>').join('') +
    '</dataPreview:tableData>';
  const raw = {
    httpClient: {
      request: async (url, c = {}) => {
        const sql = String(c.body ?? '').replace(/\s+/g, ' ').trim();
        if (/FROM BALOBJ WHERE/.test(sql)) return { status: 200, body: preview(sql, { OBJECT: ['ZDEMO_SLG0', 'ZDEMO_APLO'] }), headers: {} };
        if (/FROM TADIR/.test(sql)) return { status: 200, body: preview(sql, { OBJ_NAME: ['ZDEMO_APLO'] }), headers: {} };
        if (/FROM BALOBJT/.test(sql)) return { status: 200, body: preview(sql, { SPRAS: ['E'], OBJECT: ['ZDEMO_SLG0'], OBJTXT: ['Demo log'] }), headers: {} };
        throw Object.assign(new Error('unexpected'), { err: 500 });
      },
    },
  };
  const aplo = { 'adtcore:name': 'ZDEMO_APLO', 'adtcore:type': 'APLO/TYP', 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': '/sap/bc/adt/applicationlog/objects/zdemo_aplo' };
  const api = fakeApi({ searchObject: () => [aplo] });
  const session = { api, sources: { catalog: null, mirror: null, precedent: null }, raw };
  const out = jsonOf(await byName(buildTools(cfgWith([]), session), 'adt_search').handler({ query: 'Z*', objectType: 'APLO' }));
  assert.equal(out.hits.length, 1, 'the ADT hits are unchanged');
  assert.equal(out.legacy.kind, 'SLG0');
  assert.deepEqual(out.legacy.objects, [{ name: 'ZDEMO_SLG0', description: 'Demo log' }]);
  assert.equal(out.legacy.complete, true);
  assert.match(out.legacy.guidance, /SLG0/);

  const cls = jsonOf(await byName(buildTools(cfgWith([]), session), 'adt_search').handler({ query: 'Z*', objectType: 'CLAS/OC' }));
  assert.equal(cls.legacy, undefined);

  const noRaw = jsonOf(await byName(toolsWith(api), 'adt_search').handler({ query: 'Z*', objectType: 'CHKV' }));
  assert.equal(noRaw.legacy.complete, false);
  assert.match(noRaw.legacy.note, /no raw client/);
});

// --- argument validation (tools/index.mjs argumentErrors) ---------------------

test('a missing required argument is refused before the handler, naming what arrived', async () => {
  const log = [];
  await assert.rejects(
    () => byName(toolsWith(fakeApi(), log), 'adt_package_tree').handler({ package: 'ZSD_TEST' }),
    /adt_package_tree: missing required argument 'packageName' \(received: package\)/
  );
  assert.equal(log.length, 0);
});

test('an array argument sent as a string is refused, not read as a name', async () => {
  await assert.rejects(
    () => byName(toolsWith(fakeApi()), 'adt_read_source').handler({ objectNames: '["ZCL_A","ZCL_B"]' }),
    /argument 'objectNames' must be array, got string/
  );
});

test('an argument another tool takes is a missing required one here, not a search for undefined', async () => {
  // adt_object_info has no objectNames: the 2026-09-24 call answered "Object 'undefined' not found".
  await assert.rejects(
    () => byName(toolsWith(fakeApi()), 'adt_object_info').handler({ objectNames: ['ZCL_A'] }),
    /missing required argument 'objectName' \(received: objectNames\)/
  );
});

test('argumentErrors passes a well-formed call and an empty string to the handler', () => {
  const schema = { required: ['objectName'], properties: { objectName: { type: 'string' }, objectNames: { type: 'array' } } };
  assert.deepEqual(argumentErrors(schema, { objectName: 'ZCL_A' }), []);
  assert.deepEqual(argumentErrors(schema, { objectName: '' }), []);
  assert.deepEqual(argumentErrors(schema, undefined), ["missing required argument 'objectName' (received: nothing)"]);
});
