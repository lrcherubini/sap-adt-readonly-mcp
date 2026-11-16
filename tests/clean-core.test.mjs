// The Clean Core level table, and the two entries of it that are counter-intuitive.
//
// tests/fixtures/clean-core-{release,classifications}.json hold 9 rows COPIED VERBATIM
// out of SAP's catalogue files, one per case that decides something:
//
//   MARA                  TABL, notToBeReleased, five successors -> C
//   I_PRODUCT             released                               -> A
//   I_ADDRESS_2           released -- settles a comment in zp_demoemployeebp.ddls
//   C_BILLGDOC...BSCDEX   deprecated                             -> A, not B
//   ABP_BEHV_DRAFT_...    notToBeReleasedStable                  -> C
//   ES_SRF_RPG_ACTIVITY   BADI_DEF whose objectKey differs from tadirObjName
//   J1BS / J_1BREAD_...   FUNC addressable ONLY by objectKey     -> B
//   I_BANKACCOUNT         classicAPI with a released successor   -> B
//   /AIF/CL_TRANSFORM_DATA noAPI                                 -> D
//
// The levels asserted here were cross-checked against an independent reading of the same
// upstream catalogue, which agreed on all nine. A disagreement is a bug on one of the two sides, never a rounding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCatalog } from '../lib/catalog.mjs';
import {
  classify,
  classifyName,
  findingFor,
  isCustomName,
  levelRank,
  LEVEL_BY_STATE,
} from '../lib/clean-core.mjs';
import { codeInfo } from '../lib/journal-codes.mjs';

const catalog = loadCatalog(
  path.join(import.meta.dirname, 'fixtures', 'clean-core-release.json'),
  { classifications: path.join(import.meta.dirname, 'fixtures', 'clean-core-classifications.json') }
);

test('released is A and deprecated is ALSO A', () => {
  // `deprecated` used to be mapped B here; that overstated debt. It is still released, and the
  // ATC reports Info (SAP Note 3638292).
  assert.equal(classifyName('I_PRODUCT', catalog).level, 'A');
  const dep = classifyName('C_BILLGDOCITMPRCGELMNTBSCDEX', catalog);
  assert.equal(dep.level, 'A');
  assert.equal(dep.state, 'deprecated');
  assert.match(dep.why, /still released/);
});

test('absent from BOTH catalogues is C, not D', () => {
  // The other half of the correction. D carries a heavier obligation (Exception Form
  // before coding, remediation in 6 months) than C (architect approval, 12 months), so
  // guessing the harsher level is not the cautious choice -- it is a different wrong one.
  const r = classifyName('VBBE', catalog);
  assert.equal(r.level, 'C');
  assert.equal(r.state, 'ABSENT');
  assert.equal(r.inCatalog, false);
  assert.match(r.why, /NOT D/);
});

test('the remaining states map as the corporate table says', () => {
  assert.equal(classifyName('MARA', catalog).level, 'C');
  assert.equal(classifyName('ABP_BEHV_DRAFT_USER_ACCESS', catalog).level, 'C');
  assert.equal(classifyName('I_BANKACCOUNT', catalog).level, 'B');
  assert.equal(classifyName('/AIF/CL_TRANSFORM_DATA', catalog).level, 'D');
  assert.equal(LEVEL_BY_STATE.get('internalAPI').level, 'C');
});

test('a function module is found under objectKey, not under its function group', () => {
  // 6,454 rows of the two catalogues are addressable ONLY this way. Indexing on
  // tadirObjName alone answered "absent from both" for a classicAPI sitting right there,
  // which is the inference-from-absence the whole catalogue module exists to refuse.
  const r = classifyName('J_1BREAD_BRANCH_DATA', catalog);
  assert.equal(r.level, 'B');
  assert.equal(r.objectType, 'FUNC');
  assert.equal(classifyName('SRF_RPG_ACT_ON_CREATE', catalog).objectType, 'BADI_DEF');
});

test('the catalogue names the successor, so a rejection says what to use', () => {
  assert.deepEqual(classifyName('I_BANKACCOUNT', catalog).successors, ['I_BANKACCOUNTBASICDATA']);
  assert.equal(classifyName('MARA', catalog).successors.length, 5);
  assert.deepEqual(classifyName('I_PRODUCT', catalog).successors, []);
});

test('a Z object is not levelled: the level is about what it consumes', () => {
  const r = classifyName('ZI_Demo', catalog);
  assert.equal(r.custom, true);
  assert.equal(r.level, null);
  assert.equal(isCustomName('/SCWM/ORDIM_C'), false, 'a namespace is SAP or a partner, not ours');
  assert.equal(isCustomName('yi_x'), true);
});

test('classify deduplicates case-insensitively and counts by level', () => {
  const out = classify(['MARA', 'mara', 'I_PRODUCT', 'VBBE', 'ZI_X'], catalog);
  assert.deepEqual(out.counts, { A: 1, B: 0, C: 2, D: 0, custom: 1 });
  assert.equal(out.results.length, 3, 'custom names are dropped unless asked for');
  assert.equal(out.results[0].level, 'C', 'worst level first');
  assert.deepEqual(out.unmapped, []);
});

test('minLevel keeps only what is at or worse than the threshold', () => {
  const out = classify(['MARA', 'I_PRODUCT', 'I_BANKACCOUNT'], catalog, { minLevel: 'C' });
  assert.deepEqual(
    out.results.map((r) => r.name),
    ['MARA']
  );
  assert.equal(out.counts.A, 1, 'the counts still describe everything that was classified');
  assert.equal(levelRank('D') > levelRank('A'), true);
});

test('classify accepts dataSourcesFrom hits, not only strings', () => {
  const out = classify([{ name: 'MARA', kind: 'from' }, { name: 'I_PRODUCT' }], catalog);
  assert.deepEqual(out.counts, { A: 1, B: 0, C: 1, D: 0, custom: 0 });
});

test('an unmapped catalogue state is reported as unmapped, not silently absorbed', () => {
  const fake = { lookup: () => ({ state: 'somethingNew', objectType: 'CDS_STOB' }) };
  const r = classifyName('X', fake);
  assert.equal(r.level, 'C');
  assert.match(r.why, /not in this module's mapping/);
  assert.deepEqual(classify(['X'], fake).unmapped, ['somethingNew']);
});

test('a finding is emitted for every non-A level, and never for a Z object', () => {
  const c = findingFor(classifyName('MARA', catalog), { repo: 'zdemo_sd', file: 'f.asddls', line: 4 });
  assert.equal(c.code, 'CC_LEVEL_C');
  assert.equal(c.severity, codeInfo('CC_LEVEL_C').severity);
  assert.equal(c.file, 'f.asddls');
  assert.equal(c.context.objectType, 'TABL');
  assert.match(c.fix, /I_PRODUCT/);
  assert.equal(findingFor(classifyName('I_BANKACCOUNT', catalog)).code, 'CC_LEVEL_B');
  assert.equal(findingFor(classifyName('/AIF/CL_TRANSFORM_DATA', catalog)).code, 'CC_LEVEL_D');
  assert.equal(findingFor(classifyName('ZI_X', catalog)), null);
});

test('deprecated produces a migration note, not a level finding', () => {
  const f = findingFor(classifyName('C_BILLGDOCITMPRCGELMNTBSCDEX', catalog));
  assert.equal(f.code, 'CC_DEPRECATED');
  assert.equal(f.severity, 'low');
  assert.equal(f.context.level, 'A');
});

test('a released object produces nothing at all', () => {
  assert.equal(findingFor(classifyName('I_PRODUCT', catalog)), null);
  assert.equal(findingFor(null), null);
});

// --- the scan, end to end: sources from a fake ADT client -------------------------

import { runCleanCoreScan } from '../tools/clean-core-scan.mjs';
import { openJournal } from '../lib/journal.mjs';

/** A package ZTEST holding one view with the shapes that decide the report, and one empty source. */
function fakeApi({ calls = [] } = {}) {
  const sources = {
    '/sap/bc/adt/ddic/ddl/sources/zi_a/source/main': [
      'define view entity ZI_A',
      '  as select from MARA',
      '  inner join I_PRODUCT on 1 = 1',
      '  association [0..1] to VBBE as _R on 1 = 1',
      '{ key matnr }',
    ].join('\n'),
    '/sap/bc/adt/ddic/ddl/sources/zi_empty/source/main': '',
  };
  return {
    calls,
    nodeContents: async (_t, pkg) => {
      calls.push(`list ${pkg}`);
      return {
        nodes: pkg === 'ZTEST'
          ? [
              { OBJECT_NAME: 'ZI_A', OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zi_a' },
              { OBJECT_NAME: 'ZI_EMPTY', OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zi_empty' },
              { OBJECT_NAME: 'ZCL_NOT_CDS', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_not_cds' },
              { OBJECT_NAME: '', OBJECT_TYPE: 'DEVC/Q1S' },
            ]
          : [],
      };
    },
    getObjectSource: async (uri) => {
      calls.push(`read ${uri}`);
      if (!(uri in sources)) throw new Error(`404 ${uri}`);
      return sources[uri];
    },
  };
}

function cfgFor(sink) {
  return {
    budget: { reads: 100 },
    auditSink: () => {},
    journalSink: sink,
    paths: { catalog: path.join(import.meta.dirname, 'fixtures', 'clean-core-release.json') },
  };
}

test('the scan reads the package from the system and reports the non-A names with citations and successors', async () => {
  // The fixture catalogue's sibling classifications file is not next to it under this
  // path, so I_BANKACCOUNT is out of scope here -- that is asserted above, on the
  // classifier, where it belongs.
  const api = fakeApi();
  const out = await runCleanCoreScan(cfgFor(), api, { package: 'ztest' });
  assert.equal(out.scope.package, 'ZTEST');
  assert.equal(out.scope.objects, 2, 'only the DDLS: a class and a type folder are not CDS sources');
  assert.equal(out.scope.read, 1);
  assert.equal(out.scope.references, 3);
  assert.equal(out.scope.complete, false, 'the empty source is not a clean view');
  assert.deepEqual(out.scope.notRead, [{ object: 'DDLS/DF ZI_EMPTY', reason: 'the system answered an empty source' }]);
  const byName = Object.fromEntries(out.findings.map((f) => [f.name, f]));
  assert.equal(byName.I_PRODUCT, undefined, 'a released name is not a finding');
  assert.equal(byName.MARA.level, 'C');
  assert.equal(byName.MARA.state, 'notToBeReleased');
  assert.ok(byName.MARA.useInstead.includes('I_PRODUCT'));
  assert.match(byName.MARA.at[0], /ZTEST\/zi_a\.ddls:2 \(from, in ZI_A\)/);
  assert.equal(byName.VBBE.level, 'C');
  assert.equal(byName.VBBE.inCatalog, false, 'absent from both is a stated answer');
  assert.deepEqual(byName.VBBE.useInstead, []);
  assert.equal(out.reminder, undefined, "the fixed reading of the answer is the tool's description and docs/tools.md, not a field of every answer");
});

test('the scan writes findings to the journal on the scanned package, and the unread source as a gap', async () => {
  const lines = [];
  const cfg = cfgFor((stream, record) => lines.push({ stream, ...record }));
  await runCleanCoreScan(cfg, fakeApi(), { package: 'ZTEST' }, openJournal(cfg));
  const findings = lines.filter((l) => l.stream === 'findings');
  assert.deepEqual(findings.map((f) => f.code).sort(), ['CC_LEVEL_C', 'CC_LEVEL_C']);
  assert.equal(findings.every((f) => f.fingerprint?.length === 12), true);
  assert.equal(findings.every((f) => f.repo === 'ZTEST'), true);
  const gaps = lines.filter((l) => l.stream === 'gaps').map((g) => g.code);
  assert.ok(gaps.includes('SOURCE_NOT_READ'));
});

test('the same scan run twice produces the same fingerprints', async () => {
  // This is what makes logs/findings a backlog: a repeated defect accumulates
  // occurrences under one identity instead of appearing as a new one every run.
  const run = async () => {
    const lines = [];
    const cfg = cfgFor((stream, record) => lines.push({ stream, ...record }));
    await runCleanCoreScan(cfg, fakeApi(), { package: 'ZTEST' }, openJournal(cfg));
    return lines.filter((l) => l.stream === 'findings').map((f) => f.fingerprint);
  };
  assert.deepEqual(await run(), await run());
});

test('minLevel D silences the C findings without changing the counts', async () => {
  const out = await runCleanCoreScan(cfgFor(), fakeApi(), { package: 'ZTEST', minLevel: 'D' });
  assert.deepEqual(out.findings, []);
  assert.equal(out.levels.C, 2, 'the scan still says what it found');
  assert.equal(out.levels.A, 1);
});

test('an entity filter reads one source, not the package', async () => {
  const calls = [];
  const out = await runCleanCoreScan(cfgFor(), fakeApi({ calls }), { package: 'ZTEST', entity: 'zi_a' });
  assert.equal(calls.filter((c) => c.startsWith('read')).length, 1);
  assert.equal(out.scope.complete, true);
  assert.equal(out.scope.entityFilter, 'zi_a');
});

test('without a catalogue the scan refuses and files CATALOG_MISSING -- never "everything released"', async () => {
  const lines = [];
  const cfg = { ...cfgFor((stream, record) => lines.push({ stream, ...record })), paths: { catalog: null }, catalogRelease: null };
  await assert.rejects(() => runCleanCoreScan(cfg, fakeApi(), { package: 'ZTEST' }, openJournal(cfg)), /npm run sync:catalog/);
  assert.ok(lines.some((l) => l.code === 'CATALOG_MISSING'));
});
