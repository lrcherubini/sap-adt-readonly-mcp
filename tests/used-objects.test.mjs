// adt_used_objects: the objects one class uses, each listed, and a release state that is either
// read or named as not read -- never a summary over what was not read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildNetworkRequest, networkPost, parseNetwork, displayNameOf, ObjectRelationsViolation, NETWORK_URL } from '../lib/object-relations.mjs';
import { usedObjectsTool } from '../tools/used-objects.mjs';
import { resetBudget } from '../lib/audit.mjs';

const fixture = (...p) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', ...p), 'utf8');
const NETWORK = fixture('object-relations', 'network.xml');
// No released object was captured: the measured reply with its catalogue flag turned.
const RELEASED = fixture('apirelease', 'mara.xml').replace('isAnyContractReleased="false"', 'isAnyContractReleased="true"');
const NOT_RELEASED = fixture('apirelease', 'zclass-not-released.xml');
const URI = '/sap/bc/adt/oo/classes/zcl_demo_rate_service';

test('the body names one class and nothing else, in the measured form', () => {
  const b = buildNetworkRequest({ uri: URI, type: 'CLAS/OC', name: 'zcl_demo_rate_service' });
  assert.equal(
    b.xml,
    '<?xml version="1.0" encoding="UTF-8"?><oro:request xmlns:adtcore="http://www.sap.com/adt/core" xmlns:oro="http://www.sap.com/adt/objectrelations">' +
      '<oro:reference adtcore:name="ZCL_DEMO_RATE_SERVICE" adtcore:type="CLAS/OC" adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo_rate_service"/></oro:request>'
  );
  for (const bad of [
    { uri: '/sap/bc/adt/programs/programs/zdemo', type: 'PROG/P', name: 'ZDEMO' },
    { uri: '/sap/bc/adt/oo/classes/zcl_x"/><x a="', type: 'CLAS/OC', name: 'ZCL_X' },
    { uri: URI, type: 'CLAS/OC', name: 'ZCL"X' },
    { uri: `${URI}/source/main`, type: 'CLAS/OC', name: 'ZCL_DEMO_RATE_SERVICE' },
  ]) {
    assert.throws(() => buildNetworkRequest(bad), ObjectRelationsViolation, JSON.stringify(bad));
  }
});

test('the POST goes out only with a built body, to the fixed path with the measured headers', async () => {
  const sent = [];
  const raw = { httpClient: { request: async (url, opts) => { sent.push({ url, ...opts }); return { status: 200, body: NETWORK }; } } };
  await assert.rejects(() => networkPost(raw, { xml: '<x/>' }), ObjectRelationsViolation);
  await networkPost(raw, buildNetworkRequest({ uri: URI, type: 'CLAS/OC', name: 'ZCL_DEMO_RATE_SERVICE' }));
  assert.equal(sent[0].url, NETWORK_URL);
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].headers, {
    Accept: 'application/vnd.sap.adt.objectrelations.response.network.v1+xml',
    'Content-Type': 'application/vnd.sap.adt.objectrelations.request.v1+xml',
  });
});

test('the reply: context, relations, every object with package and package path; a function module by its own name', () => {
  const n = parseNetwork(NETWORK);
  assert.equal(n.activeContext, 'ENV');
  assert.deepEqual(n.contexts.map((c) => c.id), ['ENV', 'WUL']);
  assert.equal(n.relations.length, 4);
  assert.equal(n.objects.length, 5);
  const fm = n.objects.find((o) => o.type === 'FUGR/FF');
  assert.deepEqual([fm.name, fm.group, fm.package], ['BAPI_EXCHANGERATE_CREATE', 'BUS1093', 'BCUR']);
  assert.deepEqual(fm.packagePath, ['BCUR', 'ABA_MAIN_FIN', 'ABA_MAIN', 'ABA']);
  assert.deepEqual(n.drift, []);
  assert.equal(displayNameOf('CLAS/OC', ' ZCL_A '), 'ZCL_A');
  assert.deepEqual(parseNetwork(NETWORK.replace('<oro:activeContext>', '<oro:extra/><oro:activeContext>')).drift, [{ node: 'oro:extra' }]);
});

function harness({ network = NETWORK, release = {}, failNetwork = false } = {}) {
  const seen = [];
  const gaps = [];
  const api = {
    searchObject: async () => [{ 'adtcore:name': 'ZCL_DEMO_RATE_SERVICE', 'adtcore:type': 'CLAS/OC', 'adtcore:packageName': 'ZDEMO_PKG', 'adtcore:uri': URI }],
  };
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        seen.push({ url, method: opts.method });
        if (opts.method === 'POST') {
          if (failNetwork) throw Object.assign(new Error('Service unavailable'), { err: 503 });
          return { status: 200, body: network };
        }
        const target = decodeURIComponent(url.replace('/sap/bc/adt/apireleases/', ''));
        const r = release[target] ?? RELEASED;
        if (r instanceof Error) throw r;
        return { status: 200, body: r, headers: {} };
      },
    },
  };
  const cfg = { budget: { reads: 100 }, auditSink: () => {}, journalSink: () => {} };
  resetBudget();
  return { tool: usedObjectsTool(cfg, { api, raw }, { enabled: true, gap: (g) => gaps.push(g) }), seen, gaps };
}

const json = (res) => JSON.parse(res.content[0].text);

test('every used object is listed; the release state is read for the measured families and named otherwise', async () => {
  const h = harness({ release: { '/sap/bc/adt/oo/classes/zcx_demo_error': NOT_RELEASED } });
  const out = json(await h.tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE' }));
  assert.equal(out.count, 4, 'the class itself is not one of its used objects');
  assert.deepEqual(out.used.map((u) => u.name), ['BAPI_EXCHANGERATE_CREATE', 'IF_OO_ADT_CLASSRUN', 'BAPI1093_0', 'ZCX_DEMO_ERROR']);
  assert.deepEqual(out.used.map((u) => u.crossesPackage), [true, true, true, false]);
  assert.equal(out.releaseState.read, 3);
  assert.equal(out.releaseState.released, 2);
  assert.equal(out.releaseState.notReleased, 1);
  assert.deepEqual(out.releaseState.notRead.map((n) => n.object), ['TABL/DS BAPI1093_0'], 'a structure is a family not measured');
  assert.equal(out.complete, false, 'an object without a verdict makes the answer incomplete');
  assert.equal(h.seen.filter((s) => s.method === 'GET').length, 3);
});

test('the cap is a gap and names each object past it; zero reads lists everything with no verdict', async () => {
  const h = harness();
  const out = json(await h.tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE', maxReleaseReads: 1 }));
  assert.equal(out.releaseState.read, 1);
  assert.equal(out.releaseState.notRead.filter((n) => /past maxReleaseReads/.test(n.reason)).length, 2);
  assert.ok(h.gaps.some((g) => g.code === 'SCAN_AT_CAP'));
  const none = json(await harness().tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE', maxReleaseReads: 0 }));
  assert.equal(none.count, 4);
  assert.equal(none.releaseState.read, 0);
  assert.equal(none.releaseState.released, 0);
  assert.equal(none.complete, false);
  await assert.rejects(() => harness().tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE', maxReleaseReads: 26 }), ObjectRelationsViolation);
});

test('a failed release read is no verdict; a failed POST or another context is "unknown", never "uses nothing"', async () => {
  const h = harness({ release: { '/sap/bc/adt/oo/interfaces/if_oo_adt_classrun': Object.assign(new Error('boom'), { err: 500 }) } });
  const out = json(await h.tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE' }));
  assert.equal(out.used.find((u) => u.name === 'IF_OO_ADT_CLASSRUN').apiRelease.read, false);
  assert.ok(h.gaps.some((g) => g.code === 'API_RELEASE_NOT_READ'));

  const failing = harness({ failNetwork: true });
  await assert.rejects(() => failing.tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE' }), /503/);
  assert.ok(failing.gaps.some((g) => g.code === 'USED_OBJECTS_NOT_READ'));

  const other = harness({ network: NETWORK.replace('<oro:activeContext>ENV<', '<oro:activeContext>WUL<') });
  const answer = json(await other.tool.handler({ objectName: 'ZCL_DEMO_RATE_SERVICE' }));
  assert.equal(answer.read, false);
  assert.equal(answer.used, undefined);
  assert.ok(other.gaps.some((g) => g.code === 'USED_OBJECTS_NOT_READ'));

  await assert.rejects(() => harness().tool.handler({ objectName: 'ZDEMO_I_VIEW', objectType: 'DDLS/DF' }), /adt_clean_core_scan/);
});
