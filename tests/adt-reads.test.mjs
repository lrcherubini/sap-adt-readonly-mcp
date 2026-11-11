// lib/adt-reads.mjs: the guard's members written over the closed seams, in the library's shapes,
// and the one object that mixes them with what the library still serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownReads, mixedApi, splitSourceUri, OWN_READS } from '../lib/adt-reads.mjs';
import { readOnly, allowedMethods, ReadOnlyViolation } from '../lib/guard.mjs';

function fakeRaw(answer = () => ({ status: 200, body: 'REPORT zdemo.', headers: { 'content-type': 'text/plain' } })) {
  const calls = [];
  return {
    calls,
    httpClient: {
      request: async (url, opts) => {
        calls.push({ url, ...opts });
        return answer(url, opts);
      },
    },
  };
}

test('getObjectSource reads the source URI it is given, with the Accept the library sent, and answers the text', async () => {
  const raw = fakeRaw();
  const reads = ownReads(raw);
  for (const uri of [
    '/sap/bc/adt/programs/programs/zdemo_report/source/main',
    '/sap/bc/adt/oo/classes/zcl_demo/includes/definitions',
    '/sap/bc/adt/oo/classes/%2fdemo%2fcl_x/source/main',
    '/sap/bc/adt/functions/groups/zdemo_fg/fmodules/zdemo_fm/source/main',
    '/sap/bc/adt/ddic/srvd/sources/zdemo_ui/source/main',
  ]) {
    assert.equal(await reads.getObjectSource(uri), 'REPORT zdemo.');
    assert.equal(raw.calls.at(-1).url, uri);
    assert.equal(raw.calls.at(-1).method, 'GET');
    assert.deepEqual(raw.calls.at(-1).headers, { Accept: '*/*' });
  }
});

test('getObjectSource refuses what is not a source URI before anything is sent', async () => {
  const raw = fakeRaw();
  const reads = ownReads(raw);
  for (const bad of [
    '/sap/bc/adt/oo/classes/zcl_demo',
    '/sap/bc/adt/oo/classes/zcl_demo/source/main?version=inactive',
    '/sap/bc/adt/oo/classes/zcl_demo/../x/source/main',
    '/sap/opu/odata/sap/x/source/main',
    '/sap/bc/adt/oo/classes/zcl_demo/includes/locals_imp_x/../../y',
  ]) {
    await assert.rejects(() => reads.getObjectSource(bad), (e) => e.name === 'RouteViolation', bad);
  }
  assert.equal(raw.calls.length, 0);
  assert.equal(splitSourceUri('/x'), null);
});

test('a refused read keeps its status for the callers and the dump lookup', async () => {
  const raw = fakeRaw(() => {
    throw Object.assign(new Error('HTTP 404'), { err: 404, status: 404 });
  });
  const e = await ownReads(raw).getObjectSource('/sap/bc/adt/programs/programs/zdemo/source/main').catch((x) => x);
  assert.equal(e.status, 404);
});

test('the mixed api: own members from here, every other allowlisted one from the library, the guard on top', async () => {
  const library = { objectStructure: function () { return this === library ? 'library' : 'unbound'; }, getObjectSource: () => 'library source' };
  Object.defineProperty(library, 'username', { get: () => 'DEVUSER1' });
  const api = readOnly(mixedApi(library, { getObjectSource: async () => 'own source' }));
  assert.equal(await api.getObjectSource('/x'), 'own source', 'a migrated member never reaches the library');
  assert.equal(api.objectStructure(), 'library', 'a library member stays bound to the library');
  assert.equal(api.username, 'DEVUSER1');
  assert.throws(() => api.lock, ReadOnlyViolation);
  assert.throws(() => api.httpClient, ReadOnlyViolation);
  assert.deepEqual(Object.keys(mixedApi(library, {})).sort(), allowedMethods());
  assert.deepEqual([...OWN_READS], ['getObjectSource', 'objectStructure', 'searchObject']);
});

test('searchObject asks the quick search with the major type, as the library did, and keeps every hit field', async () => {
  const body =
    '<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo" adtcore:type="CLAS/OC" adtcore:name="ZCL_DEMO" adtcore:packageName="ZDEMO_PKG" adtcore:description="Demo &amp; test"/>' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zdemo" adtcore:type="PROG/P" adtcore:name="ZDEMO (Old style)"/>' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/x/0001" adtcore:type="X" adtcore:name="0001" adtcore:description="42"/>' +
    '</adtcore:objectReferences>';
  const raw = fakeRaw(() => ({ status: 200, body, headers: { 'content-type': 'application/xml' } }));
  const hits = await ownReads(raw).searchObject('ZCL_DEMO*', 'CLAS/OC', 5);
  assert.equal(raw.calls[0].url, '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&maxResults=5&objectType=CLAS&query=ZCL_DEMO*');
  assert.deepEqual(raw.calls[0].headers, { Accept: 'application/*' });
  assert.deepEqual(hits[0], {
    'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_demo',
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'ZCL_DEMO',
    'adtcore:packageName': 'ZDEMO_PKG',
    'adtcore:description': 'Demo & test',
  });
  assert.deepEqual([hits[1]['adtcore:name'], hits[1]['adtcore:description']], ['ZDEMO', 'Old style'], 'the old NAME (description) form');
  assert.deepEqual([hits[2]['adtcore:name'], hits[2]['adtcore:description']], ['0001', '42'], 'digits stay strings');
  await ownReads(raw).searchObject('*sales*');
  assert.equal(raw.calls[1].url, '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&maxResults=100&query=*sales*');
  for (const bad of [['two words'], ['x', 'CLAS/OC', 0], ['', 'CLAS/OC'], ['x'.repeat(101)]]) {
    await assert.rejects(() => ownReads(raw).searchObject(...bad), (e) => e.name === 'RouteViolation', JSON.stringify(bad));
  }
});
