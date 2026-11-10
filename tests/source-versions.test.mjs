// adt_read_source with `version` and `compareTo`, end to end over a fake system that answers
// what was measured on 2026-11-10 (fixtures anonymised from that run): the reads it sends, the
// trap of an inactive version that does not exist, and the comparison of two versions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTools } from '../tools/index.mjs';
import { resetBudget } from '../lib/audit.mjs';
import { documentVersion, feedLinkFor, readVersion } from '../lib/source-versions.mjs';
import { VERSIONS_REL } from '../lib/object-versions.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/versions/${name}`, import.meta.url), 'utf8');
const FEED = fixture('zdemo_report.versions.xml');
const V0 = fixture('zdemo_report.00000.abap');
const V2 = fixture('zdemo_report.00002.abap');
const DOC_INACTIVE = fixture('zdemo_report2.object-inactive.xml');
const DOC_ACTIVE = fixture('zdemo_report2.object-active.xml');

const URI = '/sap/bc/adt/programs/programs/zdemo_report';
const SRC = `${URI}/source/main`;
const STAMP = '20261110083724';

function system({ hasInactive = false, inactiveSource = V2 } = {}) {
  const seen = [];
  const replies = new Map([
    [`${URI}/source/main/versions`, FEED],
    [`${URI}/source/main/versions/${STAMP}/00000/content`, V0],
    [`${URI}/source/main/versions/${STAMP}/00002/content`, V2],
    [`${URI}?version=inactive`, hasInactive ? DOC_INACTIVE : DOC_ACTIVE],
    [`${SRC}?version=active`, V0.replace('REPORT zdemo_report.', 'report zdemo_report.')],
    [`${SRC}?version=inactive`, hasInactive ? inactiveSource : V0],
  ]);
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        seen.push({ url, method: opts.method, accept: opts.headers?.Accept });
        if (!replies.has(url)) return { status: 404, body: `no fixture for ${url}`, headers: {} };
        return { status: 200, body: replies.get(url), headers: { 'content-type': 'text/plain' } };
      },
    },
  };
  const structure = {
    objectUrl: URI,
    metaData: { 'adtcore:type': 'PROG/P', 'adtcore:name': 'ZDEMO_REPORT', 'abapsource:sourceUri': 'source/main' },
    links: [{ rel: VERSIONS_REL, href: 'source/main/versions', type: 'application/atom+xml;type=feed' }],
  };
  const api = {
    searchObject: async () => [
      { 'adtcore:name': 'ZDEMO_REPORT', 'adtcore:type': 'PROG/P', 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': URI },
    ],
    objectStructure: async () => structure,
    getObjectSource: async () => assert.fail('a stored version never goes through the client library'),
  };
  const gaps = [];
  const audit = [];
  const cfg = {
    host: 'vhdemohost.example',
    client: '001',
    budget: { reads: 1000 },
    auditSink: (line) => audit.push(JSON.parse(line)),
    journalSink: (stream, record) => gaps.push({ stream, ...record }),
    paths: {},
  };
  resetBudget();
  const tool = buildTools(cfg, { api, raw, sources: { catalog: null, mirror: null, precedent: null } }).find(
    (t) => t.definition.name === 'adt_read_source',
  );
  return { tool, seen, gaps, audit, structure };
}

const text = (res) => res.content[0].text;

test('the root adtcore:version of an object document is what the system says it returned', () => {
  assert.equal(documentVersion(DOC_INACTIVE), 'inactive');
  assert.equal(documentVersion(DOC_ACTIVE), 'active');
  assert.equal(documentVersion('<?xml version="1.0"?><x/>'), null);
});

test('a numbered version is read from the link its feed entry publishes, never built', async () => {
  const { tool, seen, audit } = system();
  const out = text(await tool.handler({ objectName: 'ZDEMO_REPORT', version: '00002' }));
  assert.deepEqual(
    seen.map((r) => [r.method, r.url]),
    [
      ['GET', `${URI}/source/main/versions`],
      ['GET', `${URI}/source/main/versions/${STAMP}/00002/content`],
    ],
  );
  assert.match(out, /\* version: 00002 -- DEVK900171, DEVUSER1, 2026-11-10T08:37:24Z/);
  assert.match(out, /DEFAULT 'str1'/);
  assert.equal(audit.length, 2, 'one audit line per read');
  assert.ok(audit.every((l) => !JSON.stringify(l).includes("DEFAULT 'str1'")), 'the trail carries no source');
});

test('inactive is asked of the object document first; without one, nothing is passed off as it', async () => {
  const none = system({ hasInactive: false });
  const out = text(await none.tool.handler({ objectName: 'ZDEMO_REPORT', version: 'inactive' }));
  assert.deepEqual(none.seen.map((r) => r.url), [`${URI}?version=inactive`], 'the source is not read');
  assert.match(out, /NO INACTIVE VERSION/);
  assert.doesNotMatch(out, /REPORT zdemo_report/);

  const some = system({ hasInactive: true });
  const read = text(await some.tool.handler({ objectName: 'ZDEMO_REPORT', version: 'inactive' }));
  assert.deepEqual(some.seen.map((r) => [r.url, r.accept]), [
    [`${URI}?version=inactive`, '*/*'],
    [`${SRC}?version=inactive`, 'text/plain'],
  ]);
  assert.match(read, /\* version: inactive \(stored\)/);
});

test('compareTo answers a unified diff, and active facing a number is read as 00000', async () => {
  const { tool, seen } = system();
  const res = await tool.handler({ objectName: 'ZDEMO_REPORT', compareTo: '00002' });
  const out = JSON.parse(text(res));
  assert.ok(!seen.some((r) => r.url.startsWith(`${SRC}?`)), 'source/main is not one side of a version diff');
  assert.deepEqual([out.from.version, out.to.version], ['00002', '00000']);
  assert.deepEqual([out.added, out.removed, out.complete, out.identical], [1, 1, true, false]);
  assert.match(out.diff, /-PARAMETERS p_str TYPE string DEFAULT 'str1'\.\n\+PARAMETERS p_str TYPE string DEFAULT 'str2'\./);
  assert.match(out.notes[0], /'active' read as 00000/);
  assert.equal(out.from.entry.transport, 'DEVK900171');
});

test('comparing inactive with active says there is nothing to compare when no inactive exists', async () => {
  const { tool } = system({ hasInactive: false });
  const out = JSON.parse(text(await tool.handler({ objectName: 'ZDEMO_REPORT', version: 'inactive', compareTo: 'active' })));
  assert.equal(out.diff, null);
  assert.equal(out.complete, false);
  assert.equal(out.from.exists, true);
  assert.equal(out.to.exists, false);
  assert.match(out.notes.join(' '), /no inactive version/);
});

test('a number the feed does not list is refused with the numbers it does list, and filed', async () => {
  const { tool, gaps, seen } = system();
  await assert.rejects(() => tool.handler({ objectName: 'ZDEMO_REPORT', version: '00009' }), /lists 00000, 00002, 00001/);
  assert.equal(seen.length, 1, 'only the feed was read');
  assert.ok(gaps.some((g) => g.code === 'VERSION_NOT_READ'));
});

test('version and compareTo are refused outside one class or program, and with batches or enhancements', async () => {
  const { tool } = system();
  await assert.rejects(() => tool.handler({ objectNames: ['ZDEMO_REPORT'], version: 'active' }), /pass objectName/);
  await assert.rejects(() => tool.handler({ objectName: 'ZDEMO_REPORT', version: 'active', enhancements: true }), /without version/);
  const { tool: same, gaps } = system();
  await assert.rejects(() => same.handler({ objectName: 'ZDEMO_REPORT', version: '00002', compareTo: '00002' }), /nothing to compare/);
  assert.equal(gaps.filter((g) => g.code).length, 0, "the caller's mistake is not a gap");
  const ddls = {
    searchObject: async () => [
      { 'adtcore:name': 'ZDEMO_I', 'adtcore:type': 'DDLS/DF', 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': '/sap/bc/adt/ddic/ddl/sources/zdemo_i' },
    ],
    objectStructure: async () => ({ objectUrl: '/sap/bc/adt/ddic/ddl/sources/zdemo_i', metaData: { 'adtcore:type': 'DDLS/DF' }, links: [] }),
  };
  const cfg = { host: 'vhdemohost.example', client: '001', budget: { reads: 1000 }, auditSink: () => {}, journalSink: () => {}, paths: {} };
  const t = buildTools(cfg, { api: ddls, raw: { httpClient: { request: async () => assert.fail('no read') } } }).find(
    (x) => x.definition.name === 'adt_read_source',
  );
  await assert.rejects(() => t.handler({ objectName: 'ZDEMO_I', version: 'inactive' }), /classes and programs only/);
});

test('a class include picks its own feed; no feed for it is a refusal, never an empty answer', async () => {
  const structure = {
    objectUrl: '/sap/bc/adt/oo/classes/zcl_demo_probe',
    includes: [
      { 'class:includeType': 'main', links: [{ rel: VERSIONS_REL, href: 'includes/main/versions' }] },
      { 'class:includeType': 'testclasses', links: [{ rel: VERSIONS_REL, href: 'includes/testclasses/versions' }] },
    ],
    links: [],
  };
  assert.equal(feedLinkFor(structure, 'testclasses').href, 'includes/testclasses/versions');
  assert.equal(feedLinkFor(structure, undefined).href, 'includes/main/versions');
  await assert.rejects(
    () => readVersion({ read: async () => assert.fail('no read'), structure: { links: [] }, version: '00001' }),
    (e) => e.code === 'NO_VERSION_FEED',
  );
});
