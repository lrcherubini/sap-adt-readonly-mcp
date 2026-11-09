// The guard is the safety property of this server, so it is the one thing with a test
// that runs offline: no SAP system, no credentials.

import { test } from 'node:test';
import { buildSelect, previewPost, SelectViolation } from '../lib/data-preview.mjs';
import { atcPost, buildRunBody, AtcViolation } from '../lib/atc.mjs';

import assert from 'node:assert/strict';
import util from 'node:util';
import { readOnly, deniedMethods, allowedMethods, ReadOnlyViolation } from '../lib/guard.mjs';
import { buildUrl, RouteViolation } from '../lib/adt-get.mjs';

// A stand-in with the same shape as ADTClient: every method resolves if reached.
function fakeClient() {
  const reached = [];
  const method = (name) => (...args) => {
    reached.push(name);
    return Promise.resolve(args);
  };
  return {
    reached,
    // read paths we do expose
    searchObject: method('searchObject'),
    getObjectSource: method('getObjectSource'),
    objectStructure: method('objectStructure'),
    usageReferences: method('usageReferences'),
    nodeContents: method('nodeContents'),
    // write paths that must never be reachable
    lock: method('lock'),
    unLock: method('unLock'),
    setObjectSource: method('setObjectSource'),
    createObject: method('createObject'),
    deleteObject: method('deleteObject'),
    activate: method('activate'),
    createTransport: method('createTransport'),
    gitPullRepo: method('gitPullRepo'),
    pushRepo: method('pushRepo'),
    unitTestRun: method('unitTestRun'),
    createAtcRun: method('createAtcRun'),
    runQuery: method('runQuery'),
    tableContents: method('tableContents'),
    stateful: 'stateless',
  };
}

test('read methods still work through the proxy', async () => {
  const raw = fakeClient();
  const api = readOnly(raw);
  await api.searchObject('ZCL_SD*');
  await api.getObjectSource('/sap/bc/adt/oo/classes/x/source/main');
  await api.objectStructure('/sap/bc/adt/oo/classes/x');
  await api.usageReferences('/sap/bc/adt/oo/classes/x');
  await api.nodeContents('DEVC/K', 'ZDEMO_SD');
  assert.deepEqual(raw.reached, [
    'searchObject',
    'getObjectSource',
    'objectStructure',
    'usageReferences',
    'nodeContents',
  ]);
});

test('lock is blocked -- without a lock, ADT cannot write', () => {
  const raw = fakeClient();
  const api = readOnly(raw);
  assert.throws(() => api.lock('/sap/bc/adt/oo/classes/x'), ReadOnlyViolation);
  assert.equal(raw.reached.length, 0);
});

test('every write path is blocked before a request is issued', () => {
  const raw = fakeClient();
  const api = readOnly(raw);
  const mustFail = [
    'lock',
    'unLock',
    'setObjectSource',
    'createObject',
    'deleteObject',
    'activate',
    'createTransport',
    'gitPullRepo',
    'pushRepo',
    'unitTestRun',
    'createAtcRun',
    'runQuery',
    'tableContents',
  ];
  for (const name of mustFail) {
    assert.throws(() => api[name](), ReadOnlyViolation, `${name} should be blocked`);
  }
  assert.equal(raw.reached.length, 0, 'no blocked method may reach the client');
});

test('turning the session stateful is refused', () => {
  const api = readOnly(fakeClient());
  assert.throws(() => {
    api.stateful = 'stateful';
  }, ReadOnlyViolation);
});

test('the denied list is not accidentally empty', () => {
  assert.ok(deniedMethods().length > 40);
  assert.ok(deniedMethods().includes('lock'));
});

// --- regression: the four escape hatches that made the original denylist pointless ---
// Each of these hands back an object the proxy does NOT wrap, so blocking `lock` while
// leaving them reachable protected nothing.

test('escape hatches are blocked', () => {
  const raw = fakeClient();
  // Getters that would return an unguarded object or the plaintext password.
  Object.defineProperties(raw, {
    httpClient: { get: () => ({ request: () => 'arbitrary HTTP verb on /sap/bc/adt' }), configurable: true },
    statelessClone: { get: () => fakeClient(), configurable: true },
    password: { get: () => 'the-real-sap-password', configurable: true },
  });
  raw.createHttp = () => ({ request: () => 'another unguarded client' });
  const api = readOnly(raw);
  for (const prop of ['httpClient', 'statelessClone', 'createHttp', 'password']) {
    assert.throws(() => api[prop], ReadOnlyViolation, `${prop} must not be reachable`);
  }
});

test('fails closed: a method the library adds later is unreachable by default', () => {
  const raw = fakeClient();
  raw.someNewMethodAddedInAFutureRelease = () => 'reached';
  const api = readOnly(raw);
  assert.throws(() => api.someNewMethodAddedInAFutureRelease(), ReadOnlyViolation);
});

test('allowlist is the security property, and it is small', () => {
  // 22: 15 originally, 18 with the DDIC metadata reads, 21 once measurement showed
  // ddicElement returns no domain (so the data element and domain reads are needed)
  // and that /sap/bc/adt/discovery is the only documented source of this system's
  // REST parameters, and 22 with objectEnhancements -- the read that makes customer
  // code inside standard objects visible at all. The cap is deliberately close to the real number: growing the
  // allowlist should require editing this line and saying why, not slipping under a
  // generous bound.
  assert.equal(allowedMethods().length, 22, 'changing the allowlist size is a decision');
  assert.ok(allowedMethods().length < 25, 'it must stay small enough to audit by eye');
  assert.ok(!allowedMethods().includes('lock'));
});

test("the transport reads do not enter the allowlist: the client's list method is defective here", () => {
  // Measured on the development system. `userTransports` fails three independent ways, each
  // of which alone yields an EMPTY LIST AND NO ERROR: no Accept (200 + empty root rather
  // than the 406 a wrong Accept earns), an always-sent `?user=&targets=` (any query
  // string empties this collection, silently), and a parser that navigates
  // tm:root > tm:workbench > tm:target, an element the reply does not contain.
  // `transportDetails` reads only the direct tm:abap_object children and drops
  // tm:all_objects. Both are served by the named GET routes instead, so the allowlist
  // does not grow -- admitting the methods would import their defects.
  for (const m of ['userTransports', 'transportDetails']) {
    assert.ok(!allowedMethods().includes(m), `${m} must stay out of the allowlist`);
  }
});

test('every transport write stays blocked', () => {
  const raw = fakeClient();
  const api = readOnly(raw);
  for (const m of [
    'createTransport',
    'transportDelete',
    'transportRelease',
    'transportSetOwner',
    'transportAddUser',
    'setTransportsConfig',
    'createTransportsConfig',
  ]) {
    assert.ok(deniedMethods().includes(m), `${m} is named in DENIED`);
    assert.throws(() => api[m], ReadOnlyViolation, `${m} must not be reachable`);
  }
  assert.equal(raw.reached.length, 0, 'nothing was called on the way to being refused');
});

// The DDIC metadata reads. They are here because a projection field inherits its type
// without restating it, so the data element behind it is not derivable from source.
test('DDIC metadata reads are reachable, their write neighbours are not', () => {
  const raw = fakeClient();
  for (const m of [
    'ddicElement',
    'annotationDefinitions',
    'ddicRepositoryAccess',
    'getDataElementProperties',
    'getDomainProperties',
    'adtDiscovery',
  ]) {
    raw[m] = () => `${m} reached`;
  }
  raw.setDataElementProperties = () => 'MUST NOT HAPPEN';
  raw.setDomainProperties = () => 'MUST NOT HAPPEN';
  const api = readOnly(raw);

  assert.equal(api.ddicElement('/sap/bc/adt/ddic/ddl/sources/i_plantstdvh'), 'ddicElement reached');
  assert.equal(api.annotationDefinitions(), 'annotationDefinitions reached');
  assert.equal(api.ddicRepositoryAccess('/x'), 'ddicRepositoryAccess reached');
  // The domain, which ddicElement does not return, comes from these two.
  assert.equal(
    api.getDataElementProperties('/sap/bc/adt/ddic/dataelements/werks_d'),
    'getDataElementProperties reached'
  );
  assert.equal(
    api.getDomainProperties('/sap/bc/adt/ddic/domains/werks'),
    'getDomainProperties reached'
  );
  assert.equal(api.adtDiscovery(), 'adtDiscovery reached');

  for (const m of ['setDataElementProperties', 'setDomainProperties']) {
    assert.throws(() => api[m](), ReadOnlyViolation, `${m} must stay blocked`);
  }
  // Reads that exist in the library but no tool needs stay unreachable: less surface.
  assert.throws(() => api.runQuery(), ReadOnlyViolation);
  assert.throws(() => api.tableContents(), ReadOnlyViolation);
});

// The enhancement read. Its own section because the argument for it is not "it is a
// GET" -- several blocked methods are GETs too -- but that it answers a question with
// no other source: which customer code runs inside a standard object.
test('objectEnhancements is reachable, and the enhancement WRITES are not', () => {
  const raw = fakeClient();
  raw.objectEnhancements = () => 'objectEnhancements reached';
  // The library's write-side neighbours in the same area must stay unreachable, and
  // the allowlist gives that for free: they were never added.
  for (const m of ['createObject', 'setObjectSource', 'activate', 'lock']) {
    raw[m] = () => 'MUST NOT HAPPEN';
  }
  const api = readOnly(raw);
  assert.equal(
    api.objectEnhancements('/sap/bc/adt/programs/includes/mv45afzz/source/main'),
    'objectEnhancements reached'
  );
  for (const m of ['createObject', 'setObjectSource', 'activate', 'lock']) {
    assert.throws(() => api[m](), ReadOnlyViolation, `${m} must stay blocked`);
  }
});

test('the proxy survives normal JS handling (await, inspect, delete)', async () => {
  const api = readOnly(fakeClient());
  await Promise.resolve(api); // touches `then`; must not throw
  assert.doesNotThrow(() => util.inspect(api));
  assert.throws(() => { delete api.searchObject; }, ReadOnlyViolation);
});

test('the two POSTs are the data preview and the ATC run; a table outside the list never reaches a socket', async () => {
  // docs/security.md, 2026-09-12: the reversal admits ONE POST for a closed list of
  // customizing tables; 2026-09-14 adds the ATC run (next test). The guard does not move
  // (runQuery/tableContents stay denied); the fence is lib/data-preview.mjs, and it has
  // to refuse BEFORE the request exists.
  const api = readOnly({ runQuery: async () => [], tableContents: async () => [] });
  assert.throws(() => api.runQuery, ReadOnlyViolation);
  assert.throws(() => api.tableContents, ReadOnlyViolation);

  const sent = [];
  const raw = { httpClient: { request: async (url, cfg) => { sent.push({ url, ...cfg }); return { status: 200, body: '<x/>', headers: {} }; } } };
  assert.throws(() => buildSelect({ table: 'VBAK' }), SelectViolation);
  assert.throws(() => buildSelect({ table: 'T683S; DROP' }), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'SELECT * FROM VBAK', 5), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'DELETE FROM T683S', 5), SelectViolation);
  assert.equal(sent.length, 0, 'nothing left the client');

  const { sql, rows } = buildSelect({ table: 't683s', rows: 5 });
  await previewPost(raw, sql, rows);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, '/sap/bc/adt/datapreview/freestyle?rowNumber=5');
  assert.equal(sent[0].body, 'SELECT * FROM T683S');
});

test('the ATC run is the second POST: a variant outside the set or a bad URI never reaches a socket', async () => {
  // docs/security.md, 2026-09-14: the server hands a worklist id to ANY variant name
  // (measured), so the closed set in lib/atc.mjs is the only fence. The library methods
  // stay denied; the POST goes through the raw transport with fixed paths.
  const api = readOnly({ createAtcRun: async () => ({}), atcCheckVariant: async () => '', atcWorklists: async () => ({}) });
  assert.throws(() => api.createAtcRun, ReadOnlyViolation);
  assert.throws(() => api.atcCheckVariant, ReadOnlyViolation);
  assert.throws(() => api.atcWorklists, ReadOnlyViolation);

  const sent = [];
  const raw = { httpClient: { request: async (url, cfg) => { sent.push({ url, ...cfg }); return { status: 200, body: '0123456789ABCDEF0123456789ABCDEF', headers: {} }; } } };
  await assert.rejects(() => atcPost(raw, 'worklist', { variant: 'ZZZ_NOPE_17' }), AtcViolation);
  await assert.rejects(() => atcPost(raw, 'worklist', { variant: 'DEFAULT?x=1' }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/oo/classes/zcl_t?version=inactive' }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/../logout' }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: 'https://elsewhere/sap/bc/adt/oo/classes/zcl_t' }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/oo/classes/zcl_t', maxVerdicts: 101 }), AtcViolation);
  await assert.rejects(() => atcPost(raw, 'run', { worklistId: 'not-hex', body: buildRunBody({ uri: '/sap/bc/adt/oo/classes/zcl_t' }) }), AtcViolation);
  await assert.rejects(() => atcPost(raw, 'run', { worklistId: '0123456789ABCDEF0123456789ABCDEF', body: { xml: '<atc:run/>', uri: '/sap/bc/adt/oo/classes/zcl_t' } }), AtcViolation);
  await assert.rejects(() => atcPost(raw, 'exemption', {}), AtcViolation);
  assert.equal(sent.length, 0, 'nothing left the client');

  const created = await atcPost(raw, 'worklist', { variant: 'default' });
  assert.equal(created.body, '0123456789ABCDEF0123456789ABCDEF');
  const body = buildRunBody({ uri: '/sap/bc/adt/oo/classes/zcl_t', maxVerdicts: 10 });
  await atcPost(raw, 'run', { worklistId: created.body, body });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, '/sap/bc/adt/atc/worklists?checkVariant=DEFAULT');
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].url, '/sap/bc/adt/atc/runs?worklistId=0123456789ABCDEF0123456789ABCDEF');
  assert.match(sent[1].body, /maximumVerdicts="10"/);
  assert.match(sent[1].body, /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_t"/);
});

test('the named GET route did not widen the guard', () => {
  // lib/adt-get.mjs reaches raw HTTP for one measured collection. The threshold that
  // makes that acceptable is that it is a ROUTE and not a client, so it has to be
  // provable from here as well as from tests/adt-get.test.mjs: the guard still refuses
  // every way of obtaining an unguarded request(), and the route still refuses every
  // way of expressing a verb.
  const api = readOnly({ httpClient: { request: async () => ({}) }, statelessClone: {} });
  assert.throws(() => api.httpClient, ReadOnlyViolation);
  assert.throws(() => api.statelessClone, ReadOnlyViolation);
  assert.ok(!allowedMethods().includes('httpClient'));

  assert.throws(() => buildUrl('/sap/bc/adt/repository/nodestructure', {}), RouteViolation);
  assert.throws(() => buildUrl('annotationChain', { entity: 'ZC_X', method: 'POST' }), RouteViolation);
  assert.throws(() => buildUrl('annotationChain', { entity: 'ZC_X', body: '<x/>' }), RouteViolation);
});
