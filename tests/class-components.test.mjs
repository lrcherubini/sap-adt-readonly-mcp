// One method of a class and the text elements, through adt_read_source, over the shapes measured
// on 2026-11-10 (the outline fixture is a reduced, anonymised copy of a class with 21 methods, an
// interface and a local class).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTools } from '../tools/index.mjs';
import { resetBudget } from '../lib/audit.mjs';
import { parseClassComponents, parsePosition, findMethod, sliceLines } from '../lib/class-components.mjs';

const OUTLINE = fs.readFileSync(new URL('./fixtures/versions/zcl_demo_model.objectstructure.xml', import.meta.url), 'utf8');
const DOC_INACTIVE = fs.readFileSync(new URL('./fixtures/versions/zdemo_report2.object-inactive.xml', import.meta.url), 'utf8');
const DOC_ACTIVE = fs.readFileSync(new URL('./fixtures/versions/zdemo_report2.object-active.xml', import.meta.url), 'utf8');
const URI = '/sap/bc/adt/oo/classes/zcl_demo_model';

const MAIN = [
  'CLASS zcl_demo_model DEFINITION PUBLIC CREATE PUBLIC.', // 1
  '  PUBLIC SECTION.', // 2
  '', // 3
  '    INTERFACES zif_demo_model.', // 4
  '    CLASS-METHODS is_mad', // 5
  '      RETURNING VALUE(result) TYPE abap_bool.', // 6
  '    METHODS constructor.', // 7
  '  PRIVATE SECTION.', // 8
  '    CLASS-DATA mo_pl TYPE REF TO object.', // 9
  'ENDCLASS.', // 10
  '', // 11
  'CLASS zcl_demo_model IMPLEMENTATION.', // 12
  '  METHOD is_mad.', // 13
  '    result = abap_true.', // 14
  '  ENDMETHOD.', // 15
  '', // 16
  '  METHOD constructor.', // 17
  '    CLEAR mo_pl.', // 18
  '  ENDMETHOD.', // 19
  '', // 20
  '  METHOD zif_demo_model~is_scary.', // 21
  '    " scary', // 22
  '    result = abap_false.', // 23
  '  ENDMETHOD.', // 24
  '', // 25
  'ENDCLASS.', // 26
].join('\n');
const IMPLEMENTATIONS = [
  'CLASS lcl_iterator DEFINITION.', // 1
  '  PUBLIC SECTION.', // 2
  '    METHODS constructor.', // 3
  'ENDCLASS.', // 4
  '', // 5
  'CLASS lcl_iterator IMPLEMENTATION.', // 6
  '  METHOD constructor.', // 7
  '    RETURN.', // 8
  '  ENDMETHOD.', // 9
  '', // 10
  'ENDCLASS.', // 11
].join('\n');

function system({ hasInactive = false, text = {}, failText = false } = {}) {
  const seen = [];
  const replies = new Map([
    [`${URI}/objectstructure?version=active&withShortDescriptions=true`, OUTLINE],
    [`${URI}/objectstructure?version=inactive&withShortDescriptions=true`, OUTLINE],
    [`${URI}/source/main?version=active`, MAIN],
    [`${URI}/source/main?version=inactive`, MAIN],
    [`${URI}/includes/implementations?version=active`, IMPLEMENTATIONS],
    [`${URI}?version=inactive`, hasInactive ? DOC_INACTIVE : DOC_ACTIVE],
    ['/sap/bc/adt/textelements/classes/zcl_demo_model/source/symbols', text.symbols ?? '@MaxLength:15\n001=demo\n'],
    ['/sap/bc/adt/textelements/classes/zcl_demo_model/source/selections', text.selections ?? ''],
    ['/sap/bc/adt/textelements/classes/zcl_demo_model/source/headings', 'listHeader=\n\ncolumnHeader_1=\n'],
  ]);
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        seen.push({ url, accept: opts.headers?.Accept });
        if (failText && url.includes('/textelements/')) throw Object.assign(new Error('Not Found'), { err: 404 });
        if (!replies.has(url)) return { status: 404, body: `no fixture for ${url}`, headers: {} };
        return { status: 200, body: replies.get(url), headers: {} };
      },
    },
  };
  const structure = {
    objectUrl: URI,
    metaData: { 'adtcore:type': 'CLAS/OC', 'adtcore:name': 'ZCL_DEMO_MODEL', 'class:visibility': 'public' },
    includes: [{ 'class:includeType': 'main', links: [{ href: 'source/main', type: 'text/plain' }] }],
    links: [],
  };
  const api = {
    searchObject: async () => [{ 'adtcore:name': 'ZCL_DEMO_MODEL', 'adtcore:type': 'CLAS/OC', 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': URI }],
    objectStructure: async () => structure,
    objectEnhancements: async () => ({ implementations: [] }),
    getObjectSource: async () => MAIN,
  };
  const gaps = [];
  const cfg = {
    host: 'vhdemohost.example',
    client: '001',
    budget: { reads: 1000 },
    auditSink: () => {},
    journalSink: (stream, record) => gaps.push({ stream, ...record }),
    paths: {},
  };
  resetBudget();
  const tool = buildTools(cfg, { api, raw, sources: { catalog: null, mirror: null, precedent: null } }).find(
    (t) => t.definition.name === 'adt_read_source',
  );
  return { tool, seen, gaps: () => gaps.filter((g) => g.code) };
}
const text = (res) => res.content[0].text;

test('the outline parses into components with their positions, in document order', () => {
  const all = parseClassComponents(OUTLINE);
  assert.deepEqual(
    all.map((c) => [c.type, c.name, c.parent]),
    [
      ['CLAS/OC', 'ZCL_DEMO_MODEL', null],
      ['CLAS/OR', 'ZIF_DEMO_MODEL', 'ZCL_DEMO_MODEL'],
      ['CLAS/OM', 'IS_MAD', 'ZCL_DEMO_MODEL'],
      ['CLAS/OM', 'CONSTRUCTOR', 'ZCL_DEMO_MODEL'],
      ['CLAS/OM', 'ZIF_DEMO_MODEL~IS_SCARY', 'ZCL_DEMO_MODEL'],
      ['CLAS/OA', 'MO_PL', 'ZCL_DEMO_MODEL'],
      ['CLAS/OCX', 'ZCL_DEMO_MODEL', 'ZCL_DEMO_MODEL'],
      ['CLAS/OCL', 'LCL_ITERATOR', 'ZCL_DEMO_MODEL'],
      ['CLAS/OLD', 'CONSTRUCTOR', 'LCL_ITERATOR'],
    ],
  );
  const isMad = all.find((c) => c.name === 'IS_MAD');
  assert.deepEqual(isMad.positions.implementationBlock, { include: 'source/main', start: { line: 13, column: 2 }, end: { line: 15, column: 11 } });
  assert.deepEqual(all.find((c) => c.type === 'CLAS/OCX').positions.definitionIdentifier, { href: '/sap/bc/adt/textelements/classes/zcl_demo_model' });
  assert.equal(parsePosition('./includes/other#start=1,0;end=2,0'), null, 'only the measured includes');
  assert.equal(sliceLines('a\nb', 2, 3), null);
});

test('a bare name prefers the global method; LOCAL->NAME picks the local one; an unknown name lists them', () => {
  const all = parseClassComponents(OUTLINE);
  assert.equal(findMethod(all, 'constructor').method.type, 'CLAS/OM');
  assert.equal(findMethod(all, 'lcl_iterator->constructor').method.type, 'CLAS/OLD');
  assert.equal(findMethod(all, 'zif_demo_model~is_scary').method.name, 'ZIF_DEMO_MODEL~IS_SCARY');
  const none = findMethod(all, 'nope');
  assert.equal(none.method, null);
  assert.deepEqual(none.known, ['IS_MAD', 'CONSTRUCTOR', 'ZIF_DEMO_MODEL~IS_SCARY', 'LCL_ITERATOR->CONSTRUCTOR']);
});

test('method slices METHOD..ENDMETHOD from the include, outline and source in the same version', async () => {
  const { tool, seen } = system();
  const out = text(await tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'ZIF_DEMO_MODEL~IS_SCARY' }));
  assert.deepEqual(seen.map((s) => s.url), [
    `${URI}/objectstructure?version=active&withShortDescriptions=true`,
    `${URI}/source/main?version=active`,
  ]);
  assert.match(out, /\* method: ZIF_DEMO_MODEL~IS_SCARY \(public, instance\) -- Is it scary\?/);
  assert.match(out, /implementation: source\/main lines 21-24, version active/);
  assert.match(out, /  METHOD zif_demo_model~is_scary\.\n    " scary\n    result = abap_false\.\n  ENDMETHOD\.$/);
  assert.doesNotMatch(out, /is_mad/);

  const local = text(await system().tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'LCL_ITERATOR->CONSTRUCTOR' }));
  assert.match(local, /includes\/implementations lines 7-9/);
  assert.match(local, /RETURN\./);
});

test('method in the inactive version is asked only when one exists', async () => {
  const none = system({ hasInactive: false });
  await assert.rejects(() => none.tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'IS_MAD', version: 'inactive' }), /no inactive version/);
  assert.deepEqual(none.seen.map((s) => s.url), [`${URI}?version=inactive`]);
  const some = system({ hasInactive: true });
  const out = text(await some.tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'IS_MAD', version: 'inactive' }));
  assert.match(out, /version inactive/);
  assert.ok(some.seen.some((s) => s.url.endsWith('objectstructure?version=inactive&withShortDescriptions=true')));
});

test('method is refused with what does not fit it, and names the methods when it finds none', async () => {
  const { tool, seen } = system();
  await assert.rejects(() => tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'IS_MAD', version: '00001' }), /history number/);
  await assert.rejects(() => tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'IS_MAD', compareTo: 'active' }), /no compareTo/);
  await assert.rejects(() => tool.handler({ objectName: 'ZCL_DEMO_MODEL', method: 'NOPE' }), /Its methods: IS_MAD, CONSTRUCTOR/);
  assert.equal(seen.filter((s) => s.url.includes('/source/')).length, 0, 'nothing sliced');
});

test('textElements adds the three categories; an empty one says none; a failed one says not read and is filed', async () => {
  const { tool, seen } = system();
  const out = text(await tool.handler({ objectName: 'ZCL_DEMO_MODEL', textElements: true }));
  assert.match(out, /===== text elements of ZCL_DEMO_MODEL =====\n\* --- symbols ---\n@MaxLength:15\n001=demo\n\* --- selections ---\n\* \(none\)/);
  assert.deepEqual(
    seen.filter((s) => s.url.includes('textelements')).map((s) => s.accept),
    ['symbols', 'selections', 'headings'].map((c) => `application/vnd.sap.adt.textelements.${c}.v1`),
  );
  const failing = system({ failText: true });
  const bad = text(await failing.tool.handler({ objectName: 'ZCL_DEMO_MODEL', textElements: true }));
  assert.match(bad, /symbols: NOT read .* not the same as "none"/);
  assert.equal(failing.gaps().filter((g) => g.code === 'TEXT_ELEMENTS_NOT_READ').length, 3);
  await assert.rejects(() => tool.handler({ objectName: 'ZCL_DEMO_MODEL', textElements: true, version: 'active' }), /without version/);
});
