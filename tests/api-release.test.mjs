// The API release state per object (MEASURED 2026-11-10; fixtures from that run, the Z class
// anonymised, logon-language titles translated): the parser, the route, and adt_object_info.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseApiRelease, API_RELEASE_OBJECT } from '../lib/api-release.mjs';
import { buildUrl, RouteViolation } from '../lib/adt-get.mjs';
import { buildTools } from '../tools/index.mjs';
import { resetBudget } from '../lib/audit.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/apirelease/${name}`, import.meta.url), 'utf8');

test('a table not to be released names its released successors, per contract', () => {
  const r = parseApiRelease(fixture('mara.xml'));
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.object, { name: 'MARA', type: 'TABL/DT', uri: '/sap/bc/adt/ddic/tables/mara' });
  const c1 = r.contracts.find((c) => c.contract === 'C1');
  assert.equal(c1.state, 'NOT_TO_BE_RELEASED', 'the contract state, not a transition offered after it');
  assert.equal(c1.useInCloudDevelopment, true);
  assert.ok(c1.successors.some((s) => s.name === 'I_PRODUCT' && s.type === 'DDLS/DF'));
  assert.equal(r.contracts.find((c) => c.contract === 'C0').state, 'NOT_RELEASED');
});

test('a Z class answers its contracts not released; an object with no contract answers none', () => {
  const z = parseApiRelease(fixture('zclass-not-released.xml'));
  assert.deepEqual(z.contracts.map((c) => [c.contract, c.state]), [['C1', 'NOT_RELEASED'], ['C4', 'NOT_RELEASED']]);
  assert.equal(z.anyReleased, false);
  const none = parseApiRelease(fixture('bapi-no-contract.xml'));
  assert.deepEqual(none.contracts, []);
  assert.equal(none.anyReleased, false);
  assert.deepEqual(parseApiRelease('<x/>').drift.map((d) => d.node), ['ars:apiRelease']);
});

test('the route takes one object URI of a measured family, encoded once as one segment', () => {
  assert.equal(
    buildUrl('apiRelease', { uri: '/sap/bc/adt/ddic/tables/mara' }),
    '/sap/bc/adt/apireleases/%2Fsap%2Fbc%2Fadt%2Fddic%2Ftables%2Fmara',
  );
  assert.match(buildUrl('apiRelease', { uri: '/sap/bc/adt/oo/classes/%2fns%2fcl_x' }), /%252fns%252fcl_x$/);
  for (const bad of ['/sap/bc/adt/cts/transports', '/sap/bc/adt/ddic/tables/../x', '/sap/bc/adt/ddic/tables/MARA', '/sap/bc/adt/ddic/tables/mara?x=1']) {
    assert.throws(() => buildUrl('apiRelease', { uri: bad }), RouteViolation, bad);
  }
  assert.ok(API_RELEASE_OBJECT.test('/sap/bc/adt/functions/groups/sapl2032/fmodules/bapi_material_getlist'));
});

function infoTool({ reply = fixture('mara.xml'), fail = false, uri = '/sap/bc/adt/ddic/tables/mara', type = 'TABL/DT', name = 'MARA' } = {}) {
  const seen = [];
  const gaps = [];
  const api = {
    searchObject: async () => [{ 'adtcore:name': name, 'adtcore:type': type, 'adtcore:packageName': 'MG', 'adtcore:uri': uri }],
    objectStructure: async () => ({ objectUrl: uri, metaData: { 'adtcore:type': type, 'adtcore:name': name, 'adtcore:abapLanguageVersion': 'standard' }, links: [] }),
    objectStructureElements: async () => [],
    ddicElement: async () => ({ name, children: [] }),
  };
  const raw = {
    httpClient: {
      request: async (url) => {
        seen.push(url);
        if (fail) throw Object.assign(new Error('Service unavailable'), { err: 503 });
        return { status: 200, body: reply, headers: {} };
      },
    },
  };
  const cfg = { host: 'vhdemohost.example', client: '001', budget: { reads: 100 }, auditSink: () => {}, journalSink: (s, r) => gaps.push(r), paths: {} };
  resetBudget();
  const tool = buildTools(cfg, { api, raw, sources: { catalog: null, mirror: null, precedent: null } }).find((t) => t.definition.name === 'adt_object_info');
  return { tool, seen, gaps };
}

test('adt_object_info answers the release state and the ABAP language version', async () => {
  const h = infoTool();
  const out = JSON.parse((await h.tool.handler({ objectName: 'MARA', fields: false })).content[0].text);
  assert.ok(h.seen.includes('/sap/bc/adt/apireleases/%2Fsap%2Fbc%2Fadt%2Fddic%2Ftables%2Fmara'));
  assert.equal(out.abapLanguageVersion, 'standard');
  assert.equal(out.apiRelease.read, true);
  assert.equal(out.apiRelease.contracts.find((c) => c.contract === 'C1').state, 'NOT_TO_BE_RELEASED');
});

test('a release state not read is said and filed, never answered as not released', async () => {
  const h = infoTool({ fail: true });
  const out = JSON.parse((await h.tool.handler({ objectName: 'MARA', fields: false })).content[0].text);
  assert.equal(out.apiRelease.read, false);
  assert.equal(out.apiRelease.contracts, undefined);
  assert.ok(h.gaps.some((g) => g.code === 'API_RELEASE_NOT_READ'));
  const program = infoTool({ uri: '/sap/bc/adt/programs/programs/zdemo_report', type: 'PROG/P', name: 'ZDEMO_REPORT' });
  const p = JSON.parse((await program.tool.handler({ objectName: 'ZDEMO_REPORT', fields: false })).content[0].text);
  assert.equal(p.apiRelease, undefined, 'a family not measured is not asked');
  assert.ok(!program.seen.some((u) => u.includes('apireleases')));
});
