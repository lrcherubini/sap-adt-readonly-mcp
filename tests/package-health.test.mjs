// adt_package_health: the Clean Core scan and the syntax check on ONE listing of a package, and
// an answer that never calls clean what it did not read.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPackageHealth, packageHealthTool, MAX_CHECKS } from '../tools/package-health.mjs';
import { resetBudget } from '../lib/audit.mjs';

const checkrun = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'checkrun', name), 'utf8');

/** ZDEMO_PKG: one view, two classes, one program, and a class the listing gives no URI. */
function fakeSession({ calls = [], replies = {}, failing = new Set() } = {}) {
  const api = {
    nodeContents: async (_t, pkg) => {
      calls.push(`list ${pkg}`);
      return {
        nodes: pkg === 'ZDEMO_PKG'
          ? [
              { OBJECT_NAME: 'ZDEMO_I_VIEW', OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zdemo_i_view' },
              { OBJECT_NAME: 'ZCL_DEMO_CLEAN', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_demo_clean' },
              { OBJECT_NAME: 'ZCL_DEMO_BROKEN', OBJECT_TYPE: 'CLAS/OC', OBJECT_URI: '/sap/bc/adt/oo/classes/zcl_demo_broken' },
              { OBJECT_NAME: 'ZDEMO_REPORT', OBJECT_TYPE: 'PROG/P', OBJECT_URI: '/sap/bc/adt/programs/programs/zdemo_report' },
              { OBJECT_NAME: 'ZCL_DEMO_NOURI', OBJECT_TYPE: 'CLAS/OC' },
            ]
          : [],
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
  assert.equal(out.atc.read, false, 'ATC is not run, and the answer says so');
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
