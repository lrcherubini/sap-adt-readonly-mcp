// adt_package_health: the Clean Core scan and the syntax check on ONE listing of a package, and
// an answer that never calls clean what it did not read.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPackageHealth, packageHealthTool, MAX_CHECKS } from '../tools/package-health.mjs';
import { resetBudget } from '../lib/audit.mjs';

const WL = '0123456789ABCDEF0123456789ABCDEF';
const RUN_REPLY =
  '<?xml version="1.0" encoding="utf-8"?><atcworklist:worklistRun xmlns:atcworklist="http://www.sap.com/abapxml/atc/worklist">' +
  `<atcworklist:worklistId>${WL}</atcworklist:worklistId><atcworklist:worklistTimestamp>2026-11-10T12:00:00Z</atcworklist:worklistTimestamp>` +
  '<atcworklist:infos><atcinfo:info xmlns:atcinfo="http://www.sap.com/abapxml/atc/info"><atcinfo:type>FINDING_STATS</atcinfo:type><atcinfo:description>0,1,0</atcinfo:description></atcinfo:info></atcworklist:infos></atcworklist:worklistRun>';
const WORKLIST =
  `<?xml version="1.0" encoding="utf-8"?><atcworklist:worklist xmlns:atcworklist="http://www.sap.com/abapxml/atc/worklist" atcworklist:id="${WL}" atcworklist:timestamp="2026-11-10T12:00:00Z" atcworklist:usedObjectSet="99999999999999999999999999999999" atcworklist:objectSetIsComplete="true">` +
  '<atcworklist:objectSets><atcworklist:objectSet atcworklist:name="99999999999999999999999999999999" atcworklist:title="Last Check Run" atcworklist:kind="LAST_RUN"/></atcworklist:objectSets>' +
  '<atcworklist:objects><atcobject:object xmlns:atcobject="http://www.sap.com/abapxml/atc/object" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="/sap/bc/adt/atc/objects/R3TR/PROG/ZDEMO_REPORT" adtcore:type="PROG" adtcore:name="ZDEMO_REPORT" adtcore:packageName="ZDEMO_PKG" atcobject:author="DEVUSER1"><atcobject:findings>' +
  `<atcfinding:finding xmlns:atcfinding="http://www.sap.com/abapxml/atc/finding" adtcore:uri="/sap/bc/adt/atc/worklists/${WL}/findings/1" atcfinding:location="/sap/bc/adt/programs/programs/zdemo_report/source/main#start=3,0" atcfinding:processor="" atcfinding:lastChangedBy="" atcfinding:priority="2" atcfinding:checkId="SELECT" atcfinding:checkTitle="Check SELECT" atcfinding:messageId="0002" atcfinding:messageTitle="SELECT * without WHERE" atcfinding:exemptionApproval="" atcfinding:exemptionKind="" atcfinding:checksum="1" atcfinding:quickfixInfo=""></atcfinding:finding>` +
  '</atcobject:findings></atcobject:object></atcworklist:objects><atcworklist:infos/></atcworklist:worklist>';

const checkrun = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'checkrun', name), 'utf8');

/** ZDEMO_PKG: one view, two classes, one program, and a class the listing gives no URI. */
function fakeSession({ calls = [], replies = {}, failing = new Set(), nodes = null } = {}) {
  const api = {
    nodeContents: async (_t, pkg) => {
      calls.push(`list ${pkg}`);
      return {
        nodes: nodes ?? (pkg === 'ZDEMO_PKG'
          ? [
              { OBJECT_NAME: 'ZDEMO_I_VIEW', OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zdemo_i_view' },
              { OBJECT_NAME: 'ZCL_DEMO_CLEAN', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_demo_clean' },
              { OBJECT_NAME: 'ZCL_DEMO_BROKEN', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_demo_broken' },
              { OBJECT_NAME: 'ZDEMO_REPORT', OBJECT_TYPE: 'PROG/P', OBJECT_URI: '/sap/bc/adt/programs/programs/zdemo_report' },
              { OBJECT_NAME: 'ZCL_DEMO_NOURI', OBJECT_TYPE: 'CLAS/OC' },
            ]
          : []),
      };
    },
    getObjectSource: async (uri) => {
      calls.push(`read ${uri}`);
      return 'define view entity ZDEMO_I_VIEW as select from MARA { key matnr }';
    },
  };
  const raw = {
    httpClient: {
      request: async (url, req) => {
        if (url.startsWith('/sap/bc/adt/atc/')) {
          calls.push(`atc ${req.method} ${url.split('?')[0]}`);
          if (failing.has('atc')) throw Object.assign(new Error('Service unavailable'), { err: 503 });
          if (url.startsWith('/sap/bc/adt/atc/worklists?')) return { status: 200, body: WL };
          if (url.startsWith('/sap/bc/adt/atc/runs')) {
            calls.push(`atc body ${/adtcore:uri="([^"]+)"/.exec(req.body)?.[1]}`);
            return { status: 200, body: RUN_REPLY };
          }
          if (url.startsWith('/sap/bc/adt/atc/checkvariants')) throw Object.assign(new Error('Not Found'), { err: 404 });
          return { status: 200, body: WORKLIST, headers: {} };
        }
        const uri = /adtcore:uri="([^"]+)"/.exec(req.body ?? '')?.[1];
        calls.push(`check ${uri}`);
        if (failing.has(uri)) throw Object.assign(new Error('Service unavailable'), { err: 503 });
        return { status: 200, body: checkrun(replies[uri] ?? 'clean.xml') };
      },
    },
  };
  return { api, raw };
}

const gaps = [];
const journal = { enabled: true, gap: (g) => gaps.push(g), finding: () => {} };
const cfgFor = (catalog = path.join(import.meta.dirname, 'fixtures', 'clean-core-release.json')) => ({
  budget: { reads: 1000 },
  auditSink: () => {},
  paths: { catalog },
});

beforeEach(() => {
  gaps.length = 0;
  resetBudget();
});

test('one listing feeds both parts; each class and program is checked on its stored active version', async () => {
  const calls = [];
  const session = fakeSession({ calls, replies: { '/sap/bc/adt/oo/classes/zcl_demo_broken': 'error.xml' } });
  const out = await runPackageHealth(cfgFor(), session, { package: 'zdemo_pkg' }, journal);
  assert.equal(calls.filter((c) => c.startsWith('list')).length, 1, 'the package is listed once');
  assert.equal(out.package, 'ZDEMO_PKG');
  assert.equal(out.cleanCore.read, true);
  assert.equal(out.cleanCore.viewsRead, 1);
  assert.ok(out.cleanCore.findings.some((f) => f.name === 'MARA'), 'what the view consumes is classified');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('check')),
    ['check /sap/bc/adt/oo/classes/zcl_demo_broken', 'check /sap/bc/adt/oo/classes/zcl_demo_clean', 'check /sap/bc/adt/programs/programs/zdemo_report']
  );
  assert.equal(out.syntax.candidates, 4);
  assert.equal(out.syntax.checked, 3);
  assert.equal(out.syntax.clean, 2);
  assert.deepEqual(out.syntax.withMessages.map((m) => [m.object, m.byType]), [['CLAS/OC ZCL_DEMO_BROKEN', { E: 1 }]]);
  assert.deepEqual(out.syntax.notChecked, [{ object: 'CLAS/OC ZCL_DEMO_NOURI', package: 'ZDEMO_PKG', reason: 'the package listing gave no URI for it' }]);
  assert.equal(out.syntax.complete, false, 'an object not checked is not clean');
  assert.equal(out.complete, false);
  assert.equal(out.atc.read, false, 'ATC is not run unless asked, and the answer says so');
  assert.match(out.atc.reason, /atc: true/);
  assert.equal(calls.some((c) => c.startsWith('atc')), false);
});

test('a behaviour definition and a metadata extension are checked too; an interface is counted as not covered', async () => {
  const calls = [];
  const nodes = [
    { OBJECT_NAME: 'ZR_DEMO_TRAVEL', OBJECT_TYPE: 'BDEF/BDO', OBJECT_URI: '/sap/bc/adt/bo/behaviordefinitions/zr_demo_travel' },
    { OBJECT_NAME: 'ZC_DEMO_TRAVEL', OBJECT_TYPE: 'DDLX/EX', OBJECT_URI: '/sap/bc/adt/ddic/ddlx/sources/zc_demo_travel' },
    { OBJECT_NAME: 'ZIF_DEMO', OBJECT_TYPE: 'INTF/OI', OBJECT_URI: '/sap/bc/adt/oo/interfaces/zif_demo' },
  ];
  const out = await runPackageHealth(cfgFor(), fakeSession({ calls, nodes }), { package: 'zdemo_pkg' }, journal);
  assert.deepEqual(calls.filter((c) => c.startsWith('check')), ['check /sap/bc/adt/bo/behaviordefinitions/zr_demo_travel', 'check /sap/bc/adt/ddic/ddlx/sources/zc_demo_travel']);
  assert.equal(out.syntax.checked, 2);
  assert.deepEqual(out.notCovered, { 'INTF/OI': 1 }, 'only what no part checks is out of scope');
});

test('the cap on checks is a gap and an incomplete answer, never a smaller clean package', async () => {
  const out = await runPackageHealth(cfgFor(), fakeSession(), { package: 'ZDEMO_PKG', maxChecks: 1 }, journal);
  assert.equal(out.syntax.checked, 1);
  assert.equal(out.syntax.skipped, 3);
  assert.equal(out.syntax.complete, false);
  assert.ok(gaps.some((g) => g.code === 'SCAN_AT_CAP' && /3 of 4/.test(g.detail)));
  await assert.rejects(() => runPackageHealth(cfgFor(), fakeSession(), { package: 'ZDEMO_PKG', maxChecks: MAX_CHECKS + 1 }, journal), /maxChecks must be/);
});

test('a failed check names the object and files SYNTAX_NOT_CHECKED; the other checks still run', async () => {
  const failing = new Set(['/sap/bc/adt/oo/classes/zcl_demo_clean']);
  const out = await runPackageHealth(cfgFor(), fakeSession({ failing }), { package: 'ZDEMO_PKG' }, journal);
  assert.equal(out.syntax.checked, 2);
  assert.ok(out.syntax.notChecked.some((n) => n.object === 'CLAS/OC ZCL_DEMO_CLEAN' && /Service unavailable/.test(n.reason)));
  assert.ok(gaps.some((g) => g.code === 'SYNTAX_NOT_CHECKED' && g.subject === 'CLAS/OC ZCL_DEMO_CLEAN'));
});

test('without the catalogue the Clean Core part says it did not run, and the syntax part still runs', async () => {
  const out = await runPackageHealth(cfgFor(null), fakeSession(), { package: 'ZDEMO_PKG' }, journal);
  assert.equal(out.cleanCore.read, false);
  assert.match(out.cleanCore.reason, /sync:catalog/);
  assert.equal(out.syntax.checked, 3);
  assert.equal(out.complete, false);
});

test('a cancelled call stops between checks and counts the rest as skipped', async () => {
  const ctl = new AbortController();
  const session = fakeSession();
  const request = session.raw.httpClient.request;
  session.raw.httpClient.request = async (...a) => {
    ctl.abort(); // the client cancels while the first check is in flight
    return request(...a);
  };
  const out = await runPackageHealth(cfgFor(), session, { package: 'ZDEMO_PKG' }, journal, { signal: ctl.signal });
  assert.equal(out.syntax.checked, 1);
  assert.equal(out.syntax.cancelled, true);
  assert.equal(out.syntax.skipped, 3);
  assert.equal(out.complete, false);
});

test('the tool refuses without a package or a raw client, and answers JSON', async () => {
  const tool = packageHealthTool(cfgFor(), fakeSession(), journal);
  await assert.rejects(() => tool.handler({}), /needs a package/);
  await assert.rejects(() => packageHealthTool(cfgFor(), { api: {} }, journal).handler({ package: 'ZDEMO_PKG' }), /no raw client/);
  const res = await tool.handler({ package: 'ZDEMO_PKG' });
  assert.equal(JSON.parse(res.content[0].text).package, 'ZDEMO_PKG');
});

test('atc: true runs the default variant once over the whole package and summarises its findings', async () => {
  const calls = [];
  const out = await runPackageHealth(cfgFor(), fakeSession({ calls }), { package: 'ZDEMO_PKG', atc: true }, journal);
  assert.ok(calls.includes('atc body /sap/bc/adt/repository/informationsystem/virtualfolders?selection=package%3aZDEMO_PKG'));
  assert.equal(calls.filter((c) => c === 'atc POST /sap/bc/adt/atc/runs').length, 1, 'one run, not one per object');
  assert.equal(out.atc.read, true);
  assert.equal(out.atc.complete, true);
  assert.equal(out.atc.worklistId, WL);
  assert.equal(out.atc.count, 1);
  assert.equal(out.atc.findings[0].checkId, 'SELECT');
  assert.equal(out.atc.objectsChecked, 1);

  // A worklist that names no object is a run over nothing: never a clean package.
  const empty = WORKLIST.replace(/<atcworklist:objects>[\s\S]*<\/atcworklist:objects>/, '<atcworklist:objects/>');
  const session = fakeSession();
  const request = session.raw.httpClient.request;
  session.raw.httpClient.request = async (url, req) => (req.method === 'GET' && url.startsWith('/sap/bc/adt/atc/worklists/') ? { status: 200, body: empty, headers: {} } : request(url, req));
  const none = await runPackageHealth(cfgFor(), session, { package: 'ZDEMO_PKG', atc: true }, journal);
  assert.equal(none.atc.objectsChecked, 0);
  assert.equal(none.atc.complete, false);
  assert.match(none.atc.reason, /checked nothing/);
  assert.equal(none.complete, false);
});

test('a failed ATC run is read: false and a gap, never a clean package', async () => {
  const out = await runPackageHealth(cfgFor(), fakeSession({ failing: new Set(['atc']) }), { package: 'ZDEMO_PKG', atc: true }, journal);
  assert.equal(out.atc.read, false);
  assert.match(out.atc.reason, /503/);
  assert.equal(out.complete, false);
  assert.ok(gaps.some((g) => g.code === 'ATC_NOT_RUN' && g.subject === 'DEVC/K ZDEMO_PKG'));
  const ns = await runPackageHealth(cfgFor(), { ...fakeSession(), api: { nodeContents: async () => ({ nodes: [] }) } }, { package: 'ZDEMO#PKG', atc: true }, journal);
  assert.equal(ns.atc.read, false);
  assert.match(ns.atc.reason, /not a package name/);
});
