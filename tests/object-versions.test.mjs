// The version feed: which transports carried one object.
//
// The fixtures below are rebuilt PROGRAMMATICALLY from the counts measured
// (docs/adt-api-reference.md, "Three ways this resource will lie"): a class whose five
// feeds hold 42/42/42/46/46 entries with 3 real requests and 42 transports of copies in
// `main`, a program with 13 entries / 2 real / 9 copies / 1 without a link, a domain with
// 8 / 2 / 4 / 1. Names and descriptions are demo values, never the system's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersionFeed,
  versionLinks,
  unionByTransport,
  VERSIONS_REL,
  TRANSPORT_REL,
  TRANSPORT_LINK_TYPE,
  ACTIVE_VERSION,
} from '../lib/object-versions.mjs';
import { transportTool } from '../tools/transport.mjs';
import { openJournal } from '../lib/journal.mjs';
import { contractErrors } from '../lib/completeness.mjs';
import { parseOpenRequests } from '../lib/open-requests.mjs';
import fs from 'node:fs';
import path from 'node:path';

// --- fixture builder, one entry at a time ------------------------------------------

const pad = (n) => String(n).padStart(5, '0');

function entry({ id, author = 'DEVA', transport, copy = false, title, updated, src, noLink = false, noTitle = false }) {
  const links = transport && !noLink
    ? `<atom:link adtcore:name="${transport}" href="/sap/bc/adt/vit/wb/object_type/%20%20%20%20rq/object_name/${transport}" rel="${TRANSPORT_REL}" type="application/vnd.sap.sapgui" title="${title}"/>` +
      `<atom:link adtcore:name="${transport}" href="/sap/bc/adt/cts/transportrequests/${transport}" rel="${TRANSPORT_REL}" type="${TRANSPORT_LINK_TYPE}" title="${title}"/>`
    : '';
  return (
    `<atom:entry${copy ? ' adtcore:isTestTransport="true"' : ''}>` +
    (author === null ? '<atom:author/>' : `<atom:author><atom:name>${author}</atom:name></atom:author>`) +
    `<atom:content type="text/plain" src="${src}/${pad(id)}/content"/>` +
    `<atom:id>${pad(id)}</atom:id>` +
    links +
    (noTitle || noLink ? '' : `<atom:title>${title}</atom:title>`) +
    `<atom:updated>${updated}</atom:updated>` +
    `</atom:entry>`
  );
}

/**
 * A feed: one entry per element of `versions` (a request number; the same number twice is
 * two versions written by one request, as measured), `copies` transports of copies (each
 * its own number, flagged by the SERVER attribute -- and deliberately titled WITHOUT the
 * "CP - " prefix, so a reader that keyed on the prefix would get them all wrong), plus the
 * active version 00000 with or without a holder. Dates derive from the number, so the same
 * request carries the same date in every feed.
 */
function feed(objectUri, href, { versions, copies, activeHolder = null, extra = '' }) {
  const src = `${objectUri}/${href}/20260901011434`;
  const when = (number) => `2026-07-${String(1 + (Number(number.slice(-2)) % 27)).padStart(2, '0')}T10:00:00Z`;
  const parts = [];
  let id = versions.length + copies;
  for (const number of versions) {
    parts.push(entry({ id, transport: number, title: `Demo change ${number}`, updated: when(number), src }));
    id -= 1;
  }
  // The active version sits between the newest real request and the copies, as measured.
  parts.push(
    activeHolder
      ? entry({ id: 0, author: null, transport: activeHolder, title: `Demo open ${activeHolder}`, updated: '2026-09-03T14:32:22Z', src })
      : entry({ id: 0, transport: null, title: null, updated: '2026-09-02T13:56:54Z', src, noLink: true })
  );
  for (let i = 0; i < copies; i++) {
    const number = `DEVK9${String(30000 + i).padStart(5, '0')}`;
    parts.push(entry({ id, transport: number, copy: true, title: `Demo copy ${i}`, updated: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00Z`, src }));
    id -= 1;
  }
  return (
    `<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<atom:title>Version List of DEMO</atom:title><atom:updated>2026-09-03T14:32:22Z</atom:updated>` +
    parts.join('') +
    extra +
    `</atom:feed>`
  );
}

const CLASS_URI = '/sap/bc/adt/oo/classes/zcl_demo';
const PROG_URI = '/sap/bc/adt/programs/programs/zdemo_report';
const DOMA_URI = '/sap/bc/adt/ddic/domains/zdo_demo';

/** Three real requests, newest first; the oldest wrote two versions, as measured. */
const REAL = ['DEVK900003', 'DEVK900002', 'DEVK900001'];

/**
 * The measured class: 42/42/42/46/46 entries; three includes name one real request,
 * testclasses two, main three -- and in main the newest request is the one HOLDING the
 * object (its only version there is 00000), which is exactly how the measured class read.
 */
const CLASS_FEEDS = {
  'includes/definitions/versions': feed(CLASS_URI, 'includes/definitions/versions', { versions: [REAL[2]], copies: 40 }),
  'includes/implementations/versions': feed(CLASS_URI, 'includes/implementations/versions', { versions: [REAL[2]], copies: 40 }),
  'includes/macros/versions': feed(CLASS_URI, 'includes/macros/versions', { versions: [REAL[2]], copies: 40 }),
  'includes/testclasses/versions': feed(CLASS_URI, 'includes/testclasses/versions', { versions: [REAL[1], REAL[2], REAL[2]], copies: 42 }),
  'includes/main/versions': feed(CLASS_URI, 'includes/main/versions', { versions: [REAL[1], REAL[2], REAL[2]], copies: 42, activeHolder: REAL[0] }),
};
const PROG_FEED = feed(PROG_URI, 'source/main/versions', { versions: [REAL[1], REAL[2], REAL[2]], copies: 9 });
const DOMA_FEED = feed(DOMA_URI, 'versions', { versions: [REAL[1], REAL[2], REAL[2]], copies: 4 });

const link = (href) => ({ href, rel: VERSIONS_REL, type: 'application/atom+xml;type=feed', title: 'Historic versions' });
const CLASS_STRUCTURE = {
  objectUrl: CLASS_URI,
  metaData: { 'adtcore:name': 'ZCL_DEMO', 'adtcore:type': 'CLAS/OC', 'class:visibility': 'public' },
  links: [{ href: 'source/main', rel: 'http://www.sap.com/adt/relations/source', type: 'text/plain' }],
  includes: ['definitions', 'implementations', 'macros', 'testclasses', 'main'].map((inc) => ({
    'class:includeType': inc,
    'adtcore:name': 'ZCL_DEMO',
    links: [link(`includes/${inc}/versions`), { href: `includes/${inc}`, rel: 'http://www.sap.com/adt/relations/source', type: 'text/plain' }],
  })),
};
const PROG_STRUCTURE = { objectUrl: PROG_URI, metaData: { 'adtcore:name': 'ZDEMO_REPORT', 'adtcore:type': 'PROG/P' }, links: [link('source/main/versions')] };
const DOMA_STRUCTURE = { objectUrl: DOMA_URI, metaData: { 'adtcore:name': 'ZDO_DEMO', 'adtcore:type': 'DOMA/DD' }, links: [link('versions')] };

// --- the fixtures reproduce the measured counts --------------------------------------

test('the fixtures carry the measured counts: 46/3/42, 13/2/9/1, 8/2/4/1', () => {
  const main = parseVersionFeed(CLASS_FEEDS['includes/main/versions']);
  assert.equal(main.entries.length, 46);
  assert.equal(main.entries.filter((e) => e.isTestTransport).length, 42);
  assert.equal(main.entries.filter((e) => !e.transport).length, 0, 'the active version has a holder here');
  const prog = parseVersionFeed(PROG_FEED);
  assert.equal(prog.entries.length, 13);
  assert.equal(prog.entries.filter((e) => e.isTestTransport).length, 9);
  assert.equal(prog.entries.filter((e) => !e.transport).length, 1);
  const doma = parseVersionFeed(DOMA_FEED);
  assert.equal(doma.entries.length, 8);
  assert.equal(doma.entries.filter((e) => e.isTestTransport).length, 4);
  assert.equal(doma.entries.filter((e) => !e.transport).length, 1);
  for (const f of [main, prog, doma]) assert.deepEqual(f.drift, [], 'the measured shape has no drift');
});

// --- the parser -----------------------------------------------------------------------

test('an entry is the version header: number, when, who, transport, the server flag, the content URI as a string', () => {
  const { entries } = parseVersionFeed(DOMA_FEED);
  const newest = entries[0];
  assert.equal(newest.id, '00007');
  assert.equal(newest.author, 'DEVA');
  assert.equal(newest.updated, '2026-07-03T10:00:00Z');
  assert.deepEqual(newest.transport, { number: 'DEVK900002', href: '/sap/bc/adt/cts/transportrequests/DEVK900002' });
  assert.equal(newest.isTestTransport, false);
  assert.equal(newest.title, 'Demo change DEVK900002', 'atom:title is the TRANSPORT description');
  assert.equal(newest.contentSrc, `${DOMA_URI}/versions/20260901011434/00007/content`);
  assert.equal(newest.contentType, 'text/plain');
  assert.equal(newest.links, 2, 'two links, sapgui and CTS, naming the same number');
});

test('a transport of copies is not a transport request: the server flag decides, never the title', () => {
  const { entries } = parseVersionFeed(PROG_FEED);
  const copies = entries.filter((e) => e.isTestTransport);
  assert.equal(copies.length, 9);
  assert.ok(copies.every((e) => !/^CP - /.test(e.title)), 'no fixture title starts with "CP - ", and the flag still finds them');
  const { transports, copies: c } = unionByTransport([{ where: 'object', entries }]);
  assert.deepEqual(transports.map((t) => t.number), ['DEVK900002', 'DEVK900001']);
  assert.equal(c.length, 9);
});

test('version 00000 is the active version: its holder is the open request, or null with no link and no title', () => {
  const held = parseVersionFeed(CLASS_FEEDS['includes/main/versions']).entries.find((e) => e.id === ACTIVE_VERSION);
  assert.equal(held.transport.number, 'DEVK900003');
  assert.equal(held.author, null, 'an empty <atom:author/> is no author, not a crash');
  const free = parseVersionFeed(DOMA_FEED).entries.find((e) => e.id === ACTIVE_VERSION);
  assert.equal(free.transport, null);
  assert.equal(free.title, null);
  assert.equal(free.links, 0);
  const u = unionByTransport([{ where: 'object', ...parseVersionFeed(DOMA_FEED) }]);
  assert.deepEqual(u.activeVersion, [{ where: 'object', updated: '2026-09-02T13:56:54Z', author: 'DEVA', holder: null }]);
  assert.deepEqual(u.withoutLink, [{ where: 'object', version: '00000', updated: '2026-09-02T13:56:54Z' }]);
});

test('a class keeps five histories, and only their union names every request', () => {
  const feeds = Object.entries(CLASS_FEEDS).map(([href, xml]) => ({ where: href.split('/')[1], ...parseVersionFeed(xml) }));
  // Three of the five, asked alone, answer one request and look healthy doing it.
  for (const where of ['definitions', 'implementations', 'macros']) {
    const alone = unionByTransport(feeds.filter((f) => f.where === where));
    assert.deepEqual(alone.transports.map((t) => t.number), ['DEVK900001']);
  }
  const u = unionByTransport(feeds);
  assert.deepEqual(u.transports.map((t) => t.number), ['DEVK900003', 'DEVK900002', 'DEVK900001']);
  const oldest = u.transports.find((t) => t.number === 'DEVK900001');
  assert.deepEqual(oldest.feeds, ['definitions', 'implementations', 'macros', 'testclasses', 'main']);
  assert.equal(oldest.versions.length, 7, 'one version in three includes, two in the other two');
  const holder = u.transports.find((t) => t.number === 'DEVK900003');
  assert.deepEqual(holder.versions, [{ where: 'main', version: '00000', updated: '2026-09-03T14:32:22Z' }], 'the open request is a transport that carries the object: its version is the active one');
  assert.equal(u.copies.length, 42, 'a copy transport is counted once across feeds');
  assert.equal(u.activeVersion.length, 5);
  assert.equal(u.activeVersion.filter((a) => a.holder).length, 1);
});

test('the versions link is taken from what the server published, on the object or on its includes', () => {
  assert.deepEqual(versionLinks(CLASS_STRUCTURE), [
    { where: 'definitions', href: 'includes/definitions/versions' },
    { where: 'implementations', href: 'includes/implementations/versions' },
    { where: 'macros', href: 'includes/macros/versions' },
    { where: 'testclasses', href: 'includes/testclasses/versions' },
    { where: 'main', href: 'includes/main/versions' },
  ]);
  assert.deepEqual(versionLinks(PROG_STRUCTURE), [{ where: 'object', href: 'source/main/versions' }]);
  assert.deepEqual(versionLinks(DOMA_STRUCTURE), [{ where: 'object', href: 'versions' }]);
  assert.deepEqual(versionLinks({ links: [] }), []);
  assert.deepEqual(versionLinks(undefined), []);
});

test('an element or attribute the measurement did not declare is drift, not silence', () => {
  const xml = feed(DOMA_URI, 'versions', {
    versions: ['DEVK900002'],
    copies: 0,
    extra: '<atom:entry adtcore:isTestTransport="false" adtcore:newThing="1"><atom:id>00099</atom:id><atom:summary>x</atom:summary></atom:entry>',
  });
  const { entries, drift } = parseVersionFeed(xml);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    drift.map((d) => `${d.node}${d.attribute ? '/@' + d.attribute : ''}`).sort(),
    ['atom:entry/@adtcore:newThing', 'atom:summary']
  );
  assert.ok(drift.every((d) => d.count === 1));
});

// --- the tool mode --------------------------------------------------------------------

const NO_OPEN_REQUEST = '<?xml version="1.0" encoding="utf-8"?><tpr:transportProperties xmlns:tpr="http://www.sap.com/adt/ris/transportProperties"/>';

function toolFor({ structure, feeds, search = 'hit', fail = null, open = NO_OPEN_REQUEST }) {
  const log = [];
  const journalLines = [];
  const cfg = {
    budget: { reads: 100 },
    auditSink: (line) => log.push(JSON.parse(line)),
    journalSink: (stream, record) => journalLines.push({ stream, ...record }),
  };
  const seen = [];
  const openSeen = [];
  const meta = structure.metaData;
  const session = {
    api: {
      searchObject: async () =>
        search === 'hit'
          ? [{ 'adtcore:name': meta['adtcore:name'], 'adtcore:type': meta['adtcore:type'], 'adtcore:uri': structure.objectUrl, 'adtcore:packageName': 'ZDEMO', 'adtcore:description': 'demo' }]
          : [],
      objectStructure: async (uri) => {
        if (uri !== structure.objectUrl) {
          const e = new Error('Not Found');
          e.response = { status: 404 };
          throw e;
        }
        return structure;
      },
    },
    raw: {
      httpClient: {
        request: async (url, config) => {
          if (url.includes('/objectproperties/transports?')) {
            openSeen.push({ url, config });
            if (open instanceof Error) throw open;
            return { status: 200, body: open, headers: { 'content-type': 'application/vnd.sap.adt.repository.trproperties.result.v1+xml' } };
          }
          seen.push({ url, config });
          if (fail && url.endsWith(fail)) {
            const e = new Error('Internal Server Error');
            e.response = { status: 500 };
            throw e;
          }
          const href = Object.keys(feeds).find((h) => url === `${structure.objectUrl}/${h}`);
          if (!href) throw new Error(`unexpected URL ${url}`);
          return { status: 200, body: feeds[href], headers: { 'content-type': 'application/atom+xml;type=feed' } };
        },
      },
    },
  };
  return { tool: transportTool(cfg, session, openJournal(cfg)), log, journalLines, seen, openSeen };
}

const outOf = async (h, args) => JSON.parse((await h.tool.handler(args)).content[0].text);

test('the object mode reads every feed the server published for a class and answers with the union', async () => {
  const h = toolFor({ structure: CLASS_STRUCTURE, feeds: CLASS_FEEDS });
  const out = await outOf(h, { object: { name: 'zcl_demo', type: 'CLAS/OC' } });
  assert.equal(out.mode, 'object');
  assert.deepEqual(out.object, { name: 'ZCL_DEMO', type: 'CLAS/OC', uri: CLASS_URI, foundBy: 'search' });
  assert.equal(out.feedsRead.length, 5);
  assert.deepEqual(out.transports.map((t) => t.number), ['DEVK900003', 'DEVK900002', 'DEVK900001']);
  assert.equal(out.copies.length, 42);
  assert.deepEqual(out.activeVersion.filter((a) => a.holder).map((a) => [a.where, a.holder]), [['main', 'DEVK900003']]);
  assert.equal(out.feeds.notRead, 0);
  assert.equal(out.drift, undefined);
  assert.deepEqual(contractErrors(out), []);
  // Every read went as GET, with the feed's one Accept, under the object.
  assert.equal(h.seen.length, 5);
  for (const s of h.seen) {
    assert.equal(s.config.method, 'GET');
    assert.equal(s.config.headers.Accept, 'application/atom+xml;type=feed');
    assert.ok(s.url.startsWith(CLASS_URI) && s.url.endsWith('/versions'));
  }
});

test('a program and a domain publish one feed each, at different paths, and the tool follows the published one', async () => {
  const p = await outOf(toolFor({ structure: PROG_STRUCTURE, feeds: { 'source/main/versions': PROG_FEED } }), { object: { name: 'ZDEMO_REPORT' } });
  assert.deepEqual(p.feedsRead.map((f) => f.href), ['source/main/versions']);
  assert.equal(p.transports.length, 2);
  assert.equal(p.copies.length, 9);
  assert.equal(p.versionsWithoutTransport.length, 1);
  const d = await outOf(toolFor({ structure: DOMA_STRUCTURE, feeds: { versions: DOMA_FEED } }), { object: { name: 'ZDO_DEMO', type: 'DOMA/DD' } });
  assert.deepEqual(d.feedsRead.map((f) => f.href), ['versions']);
  assert.equal(d.transports.length, 2);
  assert.equal(d.copies.length, 4);
  assert.equal(d.activeVersion[0].holder, null);
});

test('the audit trail names the object and the link, one line per feed, and never a transport description', async () => {
  const h = toolFor({ structure: CLASS_STRUCTURE, feeds: CLASS_FEEDS });
  await outOf(h, { object: { name: 'ZCL_DEMO' } });
  const lines = h.log.filter((l) => l.tool === 'adt_transport' && !/open requests/.test(l.target));
  assert.equal(lines.length, 5);
  for (const l of lines) {
    assert.match(l.subject ?? l.target ?? JSON.stringify(l), /CLAS\/OC ZCL_DEMO versions includes\/\w+\/versions/);
    assert.doesNotMatch(JSON.stringify(l), /Demo change|Demo copy|Demo open/);
  }
});

test('adt_transport reports the version content URI and never follows it: adt_read_source does', async () => {
  const h = toolFor({ structure: DOMA_STRUCTURE, feeds: { versions: DOMA_FEED } });
  const out = await outOf(h, { object: { name: 'ZDO_DEMO' } });
  assert.equal(h.seen.length, 1);
  assert.ok(h.seen.every((s) => !/\/content$/.test(s.url)));
  assert.equal(out.rule, undefined, "the fixed reading of the answer is the tool's description and docs/tools.md, not a field of every answer");
});

test('an object whose structure publishes no versions link is a gap, not an empty history', async () => {
  const structure = { objectUrl: '/sap/bc/adt/ddic/tables/zdemo_t', metaData: { 'adtcore:name': 'ZDEMO_T', 'adtcore:type': 'TABL/DT' }, links: [] };
  const h = toolFor({ structure, feeds: {} });
  const out = await outOf(h, { object: { name: 'ZDEMO_T' } });
  assert.deepEqual(out.transports, []);
  assert.deepEqual(out.feedsRead, []);
  assert.match(out.rule, /nothing was read/);
  assert.deepEqual(out.feeds, { read: false, published: 0 });
  assert.equal(out.complete, false, 'no feed is not an empty history');
  assert.equal(h.seen.length, 0);
  const gap = h.journalLines.find((l) => l.code === 'NO_VERSION_FEED');
  assert.ok(gap);
  assert.match(gap.impact, /NOT evidence/);
});

test('a feed that fails is an ADT_ERROR that says the other feeds are an undercount, and the answer is not given', async () => {
  const h = toolFor({ structure: CLASS_STRUCTURE, feeds: CLASS_FEEDS, fail: 'includes/macros/versions' });
  await assert.rejects(() => h.tool.handler({ object: { name: 'ZCL_DEMO' } }), (e) => {
    assert.equal(e.status, 500);
    return true;
  });
  const gap = h.journalLines.find((l) => l.code === 'ADT_ERROR');
  assert.match(gap.subject, /versions \(macros\)/);
  assert.match(gap.impact, /UNDERCOUNT/);
  // The three calls that happened are all on the record, the failed one with 0 bytes.
  assert.equal(h.log.filter((l) => l.tool === 'adt_transport').length, 3);
});

test('an object the search cannot see is still read when its URI is derivable, and the answer says so', async () => {
  const h = toolFor({ structure: PROG_STRUCTURE, feeds: { 'source/main/versions': PROG_FEED }, search: 'empty' });
  const out = await outOf(h, { object: { name: 'ZDEMO_REPORT', type: 'PROG/P' } });
  assert.equal(out.object.foundBy, 'uri');
  assert.equal(out.transports.length, 2);
  assert.equal(h.journalLines.some((l) => /^FOUND_BY/.test(String(l.code))), false, 'a read that succeeded is no gap');
});

test('a link the structure publishes outside the object is refused before any read', async () => {
  const structure = { ...DOMA_STRUCTURE, links: [link('/sap/bc/adt/ddic/domains/other/versions')] };
  const h = toolFor({ structure, feeds: {} });
  await assert.rejects(() => h.tool.handler({ object: { name: 'ZDO_DEMO' } }), (e) => e.name === 'RouteViolation');
  assert.equal(h.seen.length, 0);
  assert.ok(!h.journalLines.some((l) => l.code === 'ADT_ERROR'), 'a refusal is not an ADT gap');
});

// --- the open requests that hold the object now ----------------------------------

const OPEN = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'open-requests.xml'), 'utf8');

test('the open requests of an object: number, owner, status D and counts, as measured', () => {
  const { requests, drift } = parseOpenRequests(OPEN);
  assert.deepEqual(requests, [
    { number: 'DEVK900124', description: 'demo change', owner: 'DEVUSER1', status: 'D', createdAt: '2026-11-10T08:38:00Z', changedAt: '2026-11-10T08:38:00Z', entries: 4, objects: 4 },
  ]);
  assert.deepEqual(drift, []);
  assert.deepEqual(parseOpenRequests(NO_OPEN_REQUEST).requests, []);
  const odd = parseOpenRequests(OPEN.replace('status="D"', 'status="D" lockedBy="DEVUSER2"'));
  assert.deepEqual(odd.drift, [{ node: 'tpr:transport', attribute: 'lockedBy', count: 1 }]);
});

test('the object mode also names the open requests holding the object, with one more GET', async () => {
  const h = toolFor({ structure: PROG_STRUCTURE, feeds: { 'source/main/versions': PROG_FEED }, open: OPEN });
  const out = await outOf(h, { object: { name: 'ZDEMO_REPORT', type: 'PROG/P' } });
  assert.equal(h.openSeen.length, 1);
  assert.equal(h.openSeen[0].url, '/sap/bc/adt/repository/informationsystem/objectproperties/transports?uri=%2Fsap%2Fbc%2Fadt%2Fprograms%2Fprograms%2Fzdemo_report');
  assert.equal(h.openSeen[0].config.headers.Accept, 'application/vnd.sap.adt.repository.trproperties.result.v1+xml');
  assert.equal(out.openRequests.read, true);
  assert.deepEqual(out.openRequests.requests.map((r) => [r.number, r.status]), [['DEVK900124', 'D']]);
  assert.equal(out.openRequests.rule, undefined);
  assert.doesNotMatch(JSON.stringify(h.log), /demo change|DEVUSER1/, 'no description or owner in the trail');
  // Read beside the history even where no feed is published.
  const bare = { objectUrl: '/sap/bc/adt/ddic/tables/zdemo_t', metaData: { 'adtcore:name': 'ZDEMO_T', 'adtcore:type': 'TABL/DT' }, links: [] };
  const t = await outOf(toolFor({ structure: bare, feeds: {} }), { object: { name: 'ZDEMO_T' } });
  assert.deepEqual(t.openRequests.requests, []);
});

test('open requests that could not be read are read: false and a gap, never "in none"', async () => {
  const h = toolFor({ structure: PROG_STRUCTURE, feeds: { 'source/main/versions': PROG_FEED }, open: Object.assign(new Error('Service unavailable'), { err: 503 }) });
  const out = await outOf(h, { object: { name: 'ZDEMO_REPORT', type: 'PROG/P' } });
  assert.equal(out.openRequests.read, false);
  assert.equal(out.openRequests.requests, undefined);
  assert.equal(out.transports.length, 2, 'the history still answers');
  assert.ok(h.journalLines.some((l) => l.code === 'ADT_ERROR' && /open requests/.test(l.subject)));
});
