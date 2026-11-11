// The package scans under the completeness contract (lib/completeness.mjs): every limit of the
// package listing, of the reads and of the reported lists is a structured entry with a next page
// or a filter, and two pages put together are the whole list -- nothing repeated, nothing lost.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listPackage, packageSources, packageIncomplete } from '../lib/package-sources.mjs';
import { contractErrors } from '../lib/completeness.mjs';
import { indexSources, emptyIndex, reaching } from '../lib/annotation-index.mjs';
import { runCleanCoreScan } from '../tools/clean-core-scan.mjs';
import { runAnnotationScan, resetAnnotationIndexCache } from '../tools/annotation-scan.mjs';
import { runPackageHealth } from '../tools/package-health.mjs';
import { resetBudget } from '../lib/audit.mjs';

const cfg = () => ({
  budget: { reads: 10000 },
  auditSink: () => {},
  paths: { catalog: path.join(import.meta.dirname, 'fixtures', 'clean-core-release.json') },
});

beforeEach(() => {
  resetBudget();
  resetAnnotationIndexCache();
});

/** A tree from `{package: [rows]}`; a row of type DEVC/K is a sub-package. */
function treeApi(tree, sources = {}) {
  return {
    nodeContents: async (_t, pkg) => ({ nodes: tree[pkg] ?? [] }),
    getObjectSource: async (uri) => {
      if (!(uri in sources)) throw Object.assign(new Error(`404 ${uri}`), { status: 404 });
      return sources[uri];
    },
  };
}
const sub = (name) => ({ OBJECT_NAME: name, OBJECT_TYPE: 'DEVC/K' });
const ddls = (name) => ({ OBJECT_NAME: name, OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: `/sap/bc/adt/ddic/ddl/sources/${name.toLowerCase()}` });
const srcOf = (name) => `/sap/bc/adt/ddic/ddl/sources/${name.toLowerCase()}/source/main`;

test('a sub-package below the depth limit is named, and the listing is not complete', async () => {
  const tree = { ZDEMO_1: [sub('ZDEMO_2')], ZDEMO_2: [sub('ZDEMO_3')], ZDEMO_3: [sub('ZDEMO_4')], ZDEMO_4: [sub('ZDEMO_5')], ZDEMO_5: [ddls('ZDEMO_I_DEEP')] };
  const listing = await listPackage(treeApi(tree), 'ZDEMO_1');
  assert.deepEqual(listing.packages, ['ZDEMO_1', 'ZDEMO_2', 'ZDEMO_3', 'ZDEMO_4']);
  assert.deepEqual(listing.limits.depth, ['ZDEMO_5']);
  assert.deepEqual(packageIncomplete({ ...listing, notRead: [], skipped: [] }), [{ list: 'packages', code: 'DEPTH_LIMIT', count: 1, packages: ['ZDEMO_5'] }]);
});

test('the package cap and a cancel name the packages they kept out', async () => {
  const many = Array.from({ length: 205 }, (_, i) => `ZDEMO_S${String(i).padStart(3, '0')}`);
  const listing = await listPackage(treeApi({ ZDEMO_ROOT: many.map(sub) }), 'ZDEMO_ROOT');
  assert.equal(listing.packages.length, 200);
  assert.equal(listing.limits.packages.length, 6, 'the root counts: 199 subs listed, 6 kept out');
  const [entry] = packageIncomplete({ ...listing, notRead: [], skipped: [] });
  assert.equal(entry.code, 'CAP_REACHED');
  assert.deepEqual(entry.narrowBy, ['package']);

  const ctl = new AbortController();
  const api = treeApi({ ZDEMO_ROOT: [sub('ZDEMO_A'), sub('ZDEMO_B')] });
  const list = api.nodeContents;
  api.nodeContents = async (t, p) => {
    if (p === 'ZDEMO_A') ctl.abort();
    return list(t, p);
  };
  const cut = await listPackage(api, 'ZDEMO_ROOT', { signal: ctl.signal });
  assert.deepEqual(cut.limits.cancelled, ['ZDEMO_B']);
});

test('two pages of package sources are every source once, in name order', async () => {
  const names = ['ZDEMO_I_A', 'ZDEMO_I_B', 'ZDEMO_I_C', 'ZDEMO_I_D', 'ZDEMO_I_E'];
  const api = treeApi({ ZDEMO_PKG: names.map(ddls) }, Object.fromEntries(names.map((n) => [srcOf(n), `define view entity ${n} as select from t000 { key mandt }`])));
  const one = await packageSources(api, 'ZDEMO_PKG', { types: ['DDLS/DF'], max: 3 });
  assert.deepEqual(one.next, { offset: 3 });
  const [cap] = packageIncomplete(one);
  assert.deepEqual(cap, { list: 'objects', code: 'CAP_REACHED', returned: 3, total: 5, next: { offset: 3 } });
  const two = await packageSources(api, 'ZDEMO_PKG', { types: ['DDLS/DF'], max: 3, offset: one.next.offset });
  assert.equal(two.next, null);
  assert.deepEqual([...one.read, ...two.read].map((o) => o.name), names);
});

test('two DDLX of one entity that write the same key are both rows: neither hides the other', () => {
  const index = indexSources(
    [
      { file: 'ZDEMO/zdemo_c_item.ddls', repo: 'ZDEMO', layer: 'ddls', text: 'define view entity ZDEMO_C_Item as select from t000 { key mandt as Plant }' },
      { file: 'ZDEMO/zdemo_c_item_a.ddlx', repo: 'ZDEMO', layer: 'ddlx', text: 'annotate entity ZDEMO_C_Item with {\n  @UI.lineItem: [{ position: 10 }]\n  Plant;\n}' },
      { file: 'ZDEMO/zdemo_c_item_b.ddlx', repo: 'ZDEMO', layer: 'ddlx', text: 'annotate entity ZDEMO_C_Item with {\n  @UI.lineItem: [{ position: 20 }]\n  Plant;\n}' },
    ],
    emptyIndex()
  );
  const rows = reaching(index, 'ZDEMO_C_ITEM', 'Plant').filter((r) => r.layer === 'ddlx');
  assert.deepEqual(rows.map((r) => r.file).sort(), ['ZDEMO/zdemo_c_item_a.ddlx', 'ZDEMO/zdemo_c_item_b.ddlx']);
});

/** A package of views that each read the same three standard names, for the reported lists. */
function scanPackage() {
  const names = ['ZDEMO_I_A', 'ZDEMO_I_B'];
  const text = (n) => `define view entity ${n}\n  as select from MARA\n  association [0..1] to VBBE as _R on 1 = 1\n  association [0..1] to ZDEMO_UNKNOWN_STD as _U on 1 = 1\n{ key matnr as Plant }`;
  return treeApi({ ZDEMO_PKG: names.map(ddls) }, Object.fromEntries(names.map((n) => [srcOf(n), text(n)])));
}

test('adt_clean_core_scan answers the contract, and two pages of findings are every finding once', async () => {
  const all = await runCleanCoreScan(cfg(), scanPackage(), { package: 'ZDEMO_PKG' });
  assert.deepEqual(contractErrors(all), []);
  assert.equal(typeof all.complete, 'boolean');
  assert.equal(all.absent.count, all.absent.names.length);
  assert.ok(Array.isArray(all.unmapped));
  const total = all.findingsPage.total;
  assert.ok(total >= 2, 'the fixture yields several findings');
  const one = await runCleanCoreScan(cfg(), scanPackage(), { package: 'ZDEMO_PKG', max: 1 });
  assert.deepEqual(contractErrors(one), []);
  assert.equal(one.complete, false);
  const cap = one.incomplete.find((i) => i.list === 'findings');
  assert.equal(cap.code, 'CAP_REACHED');
  const rest = await runCleanCoreScan(cfg(), scanPackage(), { package: 'ZDEMO_PKG', max: 1000, findingsOffset: cap.next.findingsOffset });
  assert.deepEqual([...one.findings, ...rest.findings].map((f) => f.name), all.findings.map((f) => f.name));
});

test('adt_annotation_scan answers the contract, and rowsOffset pages the lookup rows', async () => {
  const api = scanPackage();
  const all = await runAnnotationScan(cfg(), api, { package: 'ZDEMO_PKG', element: 'Plant', upstream: 0 });
  assert.deepEqual(contractErrors(all), []);
  const detect = await runAnnotationScan(cfg(), api, { package: 'ZDEMO_PKG', upstream: 0 });
  assert.deepEqual(contractErrors(detect), []);
  assert.equal(detect.scope.cached, true);
  // upstream: 0 leaves the consumed names unfollowed: a budget, said as one.
  assert.ok(detect.incomplete.some((i) => i.list === 'upstream' && i.code === 'BUDGET_REACHED'));
});

test('adt_package_health answers the contract, pages the checks, and counts what no part checks', async () => {
  const objects = [
    ddls('ZDEMO_I_VIEW'),
    { OBJECT_NAME: 'ZCL_DEMO_A', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_demo_a' },
    { OBJECT_NAME: 'ZCL_DEMO_B', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_demo_b' },
    { OBJECT_NAME: 'ZIF_DEMO', OBJECT_TYPE: 'INTF/OI', OBJECT_URI: '/sap/bc/adt/oo/interfaces/zif_demo' },
  ];
  const api = treeApi({ ZDEMO_PKG: objects }, { [srcOf('ZDEMO_I_VIEW')]: 'define view entity ZDEMO_I_VIEW as select from MARA { key matnr }' });
  const checked = [];
  const clean = '<?xml version="1.0" encoding="utf-8"?><chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="x" chkrun:status="processed" chkrun:statusText="ok"><chkrun:checkMessageList/></chkrun:checkReport></chkrun:checkRunReports>';
  const raw = {
    httpClient: {
      request: async (_url, req) => {
        checked.push(/adtcore:uri="([^"]+)"/.exec(req.body ?? '')?.[1]);
        return { status: 200, body: clean };
      },
    },
  };
  const session = { api, raw };
  const one = await runPackageHealth(cfg(), session, { package: 'ZDEMO_PKG', maxChecks: 1 }, null);
  assert.deepEqual(contractErrors(one), []);
  assert.deepEqual(one.notCovered, { 'INTF/OI': 1 });
  assert.ok(one.incomplete.some((i) => i.code === 'OUT_OF_SCOPE' && i.count === 1));
  assert.deepEqual(one.atc.asked, false);
  assert.ok(!one.incomplete.some((i) => i.list === 'atc'), 'not asked is not incompleteness');
  const cap = one.incomplete.find((i) => i.list === 'syntax' && i.code === 'CAP_REACHED');
  assert.deepEqual(cap.next, { checksOffset: 1 });
  await runPackageHealth(cfg(), session, { package: 'ZDEMO_PKG', maxChecks: 1, checksOffset: cap.next.checksOffset }, null);
  assert.deepEqual(checked, ['/sap/bc/adt/oo/classes/zcl_demo_a', '/sap/bc/adt/oo/classes/zcl_demo_b'], 'two pages, each class once');
});
