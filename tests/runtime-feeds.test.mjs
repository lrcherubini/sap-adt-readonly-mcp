// The Feed Reader's feeds: the generator, the three parsers, the routes, the tool. Fixtures are
// the measured bodies of 2026-09-12 with demo user names (the shape is the system's, byte for
// byte; the people are not).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FEEDS,
  FEED_ATTRIBUTES,
  MAX_CLAUSES,
  FeedQueryViolation,
  buildFeedQuery,
  parseFeedCatalog,
  parseDumpFeed,
  groupDumps,
  parseDumpSummary,
  parseGatewayFeed,
  parseGenericFeed,
  parseDumpResource,
  dumpPathOf,
} from '../lib/runtime-feeds.mjs';
import { TEMPLATES, buildUrl, RouteViolation } from '../lib/adt-get.mjs';
import { runtimeErrorsTool, auditKeyOf } from '../tools/runtime-errors.mjs';
import { contractErrors } from '../lib/completeness.mjs';

const fx = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const CATALOG = fx('feed-catalog-measured.xml');
const DUMPS = fx('runtime-dumps-measured.xml');
const GATEWAY = fx('gateway-errorlog-measured.xml');
const DUMP_RESOURCE = fx('runtime-dump-resource-measured.xml');
const DUMP_KEY = '/sap/bc/adt/runtime/dump/20260912153234vhdemohost_DEV_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20OTHERDEV%20%20%20%20001%20%20%20%20%20%20%2021';

// --- the generator -------------------------------------------------------------------------

test('buildFeedQuery writes the catalogue grammar, prefix form, and nothing else', () => {
  assert.equal(buildFeedQuery('dumps', [{ attribute: 'user', value: 'DEMOUSER' }]), 'and ( equals ( user , DEMOUSER ) )');
  assert.equal(buildFeedQuery('dumps', [{ attribute: 'objectName', op: 'contains', value: 'CL_ENH' }]), 'and ( contains ( objectName , CL_ENH ) )');
  assert.equal(buildFeedQuery('dumps', [{ attribute: 'datetime', op: 'greaterOrEquals', value: '2026-09-12T00:00:00' }]), 'and ( greaterOrEquals ( datetime , 2026-09-12T00:00:00 ) )');
  assert.equal(buildFeedQuery('atc', [{ attribute: 'package', value: 'ZDEMO_EXPENSES' }]), 'and ( equals ( package , ZDEMO_EXPENSES ) )');
  // Two clauses side by side dumped the server (2026-09-12 step 1f); the comma form
  // filters (2026-09-14 step 1: 33 -> 9 entries). So two, joined by ` , `, never more.
  assert.equal(MAX_CLAUSES, 2);
  const two = buildFeedQuery('dumps', [{ attribute: 'user', value: 'X' }, { attribute: 'objectName', op: 'notContains', value: 'CL_ENH' }]);
  assert.equal(two, 'and ( equals ( user , X ) , notContains ( objectName , CL_ENH ) )');
  assert.ok(!/\) [a-z]+ \(/.test(two), 'the side-by-side form is never produced');
  assert.ok(TEMPLATES.get('runtimeDumps').validate.$query.test(two), 'the route admits the comma form');
  assert.ok(!TEMPLATES.get('runtimeDumps').validate.$query.test('and ( equals ( user , X ) notContains ( objectName , CL_ENH ) )'), 'the route refuses the side-by-side form');
  assert.throws(
    () => buildFeedQuery('dumps', [{ attribute: 'user', value: 'X' }, { attribute: 'user', value: 'Y' }, { attribute: 'user', value: 'Z' }]),
    /at most 2 clauses/
  );
  assert.throws(() => buildUrl('runtimeDumps', { $query: 'and ( equals ( user , X ) equals ( user , Y ) )' }), RouteViolation, 'the route is the second fence');
  assert.equal(buildFeedQuery('gateway', [{ attribute: 'service_name', value: 'ZUI_X_O4' }]), 'and ( equals ( service_name , ZUI_X_O4 ) )');
  const bad = (feed, clauses, re) => assert.throws(() => buildFeedQuery(feed, clauses), (e) => e instanceof FeedQueryViolation && re.test(e.message));
  bad('nope', [{ attribute: 'user', value: 'X' }], /not a feed/);
  bad('dumps', [], /at least one clause/);
  bad('dumps', [{ attribute: 'username', value: 'X' }], /not an attribute of the dumps feed/);
  bad('dumps', [{ attribute: 'user', op: 'between', value: 'X' }], /not an operator/);
  bad('dumps', [{ attribute: 'user', value: "X ) ) or ( equals ( user , Y" }], /character the query alphabet/);
  bad('dumps', [{ attribute: 'user', value: '' }], /character the query alphabet/);
  bad('dumps', Array.from({ length: MAX_CLAUSES + 1 }, () => ({ attribute: 'user', value: 'X' })), /at most/);
});

test('every generated query passes the route regex, and free text does not', () => {
  for (const feed of FEEDS.keys()) {
    const route = TEMPLATES.get(FEEDS.get(feed).route);
    for (const attribute of FEED_ATTRIBUTES.get(feed)) {
      const q = buildFeedQuery(feed, [{ attribute, value: 'A-b.1' }]);
      assert.match(q, route.validate.$query, `${feed}.${attribute}`);
    }
    for (const q of ["user eq 'X'", 'and ( equals ( user , X ) ) or ( 1 )', 'and ( equals ( user , X;Y ) )', 'and ( )', '']) {
      assert.throws(() => buildUrl(FEEDS.get(feed).route, { $query: q }), RouteViolation, `${feed}: ${q}`);
    }
  }
  assert.equal(
    buildUrl('runtimeDumps', { $query: buildFeedQuery('dumps', [{ attribute: 'user', value: 'DEMOUSER' }]), $top: 5, $skip: 10 }),
    '/sap/bc/adt/runtime/dumps?%24query=and+%28+equals+%28+user+%2C+DEMOUSER+%29+%29&%24skip=10&%24top=5'
  );
  assert.equal(buildUrl('feedCatalog'), '/sap/bc/adt/feeds');
  assert.throws(() => buildUrl('feedCatalog', { $top: 1 }), RouteViolation);
  assert.throws(() => buildUrl('runtimeDumps', { maxResults: 2 }), RouteViolation, 'maxResults is ignored by the server (measured) and refused here');
  assert.throws(() => buildUrl('runtimeDumps', { $top: 0 }), RouteViolation);
  assert.throws(() => buildUrl('runtimeDumps', { $top: 1000 }), RouteViolation);
});

// --- the catalogue -------------------------------------------------------------------------

test('parseFeedCatalog: seven feeds, each with attributes, operators, paging and variants', () => {
  const c = parseFeedCatalog(CATALOG);
  assert.equal(c.title, 'ABAP System Monitoring');
  assert.deepEqual(c.drift, []);
  assert.deepEqual(
    c.feeds.map((f) => f.href),
    [
      '/sap/bc/adt/gw/errorlog',
      '/sap/bc/adt/eee/errorlog',
      '/sap/bc/adt/runtime/dumps',
      '/sap/bc/adt/error/urimapper?user=DEMOUSER',
      '/sap/bc/adt/atc/feeds/verdicts',
      '/sap/bc/adt/bo/feeds/ccviolations',
      '/sap/bc/adt/runtime/systemmessages',
    ]
  );
  const dumps = c.feeds.find((f) => f.title === 'ABAP Runtime Errors');
  assert.deepEqual(dumps.paging, { size: 50, max: 100 });
  assert.equal(dumps.refresh, '5 minutes');
  assert.equal(dumps.queryIsObligatory, false);
  assert.equal(dumps.queryDepth, 2);
  assert.deepEqual(dumps.attributes.map((a) => a.id), FEED_ATTRIBUTES.get('dumps'));
  assert.equal(dumps.attributes.find((a) => a.id === 'datetime').dataType, 'dateTime');
  assert.deepEqual(dumps.attributes.find((a) => a.id === 'user').operators, ['equals', 'notEquals']);
  assert.equal(dumps.operators.length, 10);
  assert.deepEqual(dumps.operators.find((o) => o.id === 'between'), { id: 'between', operands: 2, kind: 'RELATIONAL' });
  assert.deepEqual(dumps.variants, [
    { query: 'and ( equals ( user , DEMOUSER ) )', title: 'Runtime Errors caused by me (DEMOUSER)', isDefault: true },
    { query: 'and ( equals ( responsible , DEMOUSER ) )', title: 'Runtime Errors for objects I am responsible for (DEMOUSER)', isDefault: false },
  ]);
  const gw = c.feeds.find((f) => f.title === 'SAP Gateway Error Log');
  assert.deepEqual(gw.attributes.map((a) => a.id), FEED_ATTRIBUTES.get('gateway'));
  assert.equal(c.feeds.find((f) => f.title === 'ATC Findings').queryIsObligatory, true);
  // the two hrefs this server hard-codes are the ones the catalogue publishes
  for (const [, f] of FEEDS) assert.ok(c.feeds.some((x) => x.href === f.href), f.href);
});

// --- the dumps -----------------------------------------------------------------------------

test('parseDumpFeed: the list, light', () => {
  const p = parseDumpFeed(DUMPS, { withReport: false });
  assert.equal(p.self, '/sap/bc/adt/runtime/dumps?from=20260912183319');
  assert.equal(p.entries.length, 2);
  assert.deepEqual(p.drift, []);
  const e = p.entries[0];
  assert.equal(e.runtimeError, 'OBJECTS_OBJREF_NOT_ASSIGNED_NO');
  assert.equal(e.program, 'CL_ENH_ADT_ENHO_OBJ_PERSIST===CP');
  assert.equal(e.user, 'DEMOUSER');
  assert.equal(e.userFullName, 'Demo User');
  assert.equal(e.published, '2026-09-12T18:33:19Z');
  assert.equal(e.title, "Access using a 'ZERO' object reference is not possible.");
  assert.equal(e.key, '20260912153319vhdemohost_DEV_00 DEMOUSER 001 23');
  assert.match(e.links.gui, /^adt:\/\/DEV\/sap\/bc\/adt\/vit\/runtime\/dumps\//);
  assert.match(e.links.self, /^adt:\/\/DEV\/sap\/bc\/adt\/runtime\/dump\//);
  assert.equal(e.report, undefined);
  assert.equal(p.entries[1].user, 'OTHERDEV');
});

test('parseDumpFeed: the report is parsed out of the summary -- header, texts, source, stack', () => {
  const { entries, drift } = parseDumpFeed(DUMPS);
  assert.deepEqual(drift, []);
  const r = entries[0].report;
  assert.equal(r.header['Runtime Error'], 'OBJECTS_OBJREF_NOT_ASSIGNED_NO');
  assert.equal(r.header.Exception, 'CX_SY_REF_IS_INITIAL');
  assert.equal(r.header['Application Component'], 'BC-DWB-AIE-SRC');
  assert.equal(r.header.Client, '001');
  assert.match(r.whatHappened, /had to be terminated/);
  assert.match(r.errorAnalysis, /GET_DATA_FROM_TOOL/);
  assert.match(r.whereTerminated, /line 30 of include "CL_ENH_ADT_ENHO_OBJ_PERSIST===CM00F"/);
  assert.equal(r.sourceExtract.length, 21);
  const marked = r.sourceExtract.filter((l) => l.marked);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].line, 30);
  assert.match(marked[0].code, /set_object_name\( i_enho_tool->get_name\( \) \)/);
  assert.equal(r.sourceExtract[0].line, 20);
  assert.equal(r.sourceExtract[20].line, 40);
  assert.equal(r.stack.length, 13);
  assert.deepEqual(r.stack[0], {
    no: 13,
    event: 'GET_DATA_FROM_TOOL',
    program: 'CL_ENH_ADT_ENHO_OBJ_PERSIST===CP',
    include: 'CL_ENH_ADT_ENHO_OBJ_PERSIST===CM00F',
    line: 30,
    uri: '/sap/bc/adt/oo/classes/cl_enh_adt_enho_obj_persist/source/main#start=434',
  });
  assert.equal(r.stack.at(-1).no, 1);
});

test('groupDumps: same error in the same program is one row; the line joins the key only with the report', () => {
  const dump = (id, runtimeError, program, published, line) => ({
    id,
    runtimeError,
    program,
    published,
    ...(line === undefined ? {} : { report: { sourceExtract: [{ line: line - 1, marked: false }, { line, marked: true }] } }),
  });
  const light = groupDumps([
    dump('a', 'CONVT_NO_NUMBER', 'ZDEMO_REPORT', '2026-09-12T10:00:00Z'),
    dump('b', 'OBJECTS_OBJREF_NOT_ASSIGNED', 'ZCL_DEMO_ONE===CP', '2026-09-12T09:00:00Z'),
    dump('c', 'CONVT_NO_NUMBER', 'ZDEMO_REPORT', '2026-09-12T08:00:00Z'),
    dump('d', 'CONVT_NO_NUMBER', 'ZDEMO_OTHER', '2026-09-12T11:00:00Z'),
  ]);
  assert.deepEqual(light[0], { runtimeError: 'CONVT_NO_NUMBER', program: 'ZDEMO_REPORT', count: 2, first: '2026-09-12T08:00:00Z', last: '2026-09-12T10:00:00Z', ids: ['a', 'c'] });
  assert.deepEqual(light.slice(1).map((g) => g.program), ['ZDEMO_OTHER', 'ZCL_DEMO_ONE===CP'], 'equal counts: the most recent first');
  assert.ok(light.every((g) => !('line' in g)), 'a light page has no line: none is invented');

  const full = groupDumps([
    dump('a', 'CONVT_NO_NUMBER', 'ZDEMO_REPORT', '2026-09-12T10:00:00Z', 30),
    dump('b', 'CONVT_NO_NUMBER', 'ZDEMO_REPORT', '2026-09-12T09:00:00Z', 30),
    dump('c', 'CONVT_NO_NUMBER', 'ZDEMO_REPORT', '2026-09-12T08:00:00Z', 44),
    { id: 'e', runtimeError: 'CONVT_NO_NUMBER', program: 'ZDEMO_REPORT', published: null, report: { sourceExtract: [] } },
  ]);
  assert.deepEqual(full.map((g) => [g.line, g.count]), [[30, 2], [44, 1], [null, 1]], 'no marked line is null, not a guess');
  assert.equal(full[2].first, null);
  assert.deepEqual(groupDumps(undefined), []);
});

test('parseDumpSummary: a section the measured summary does not have is drift, an empty summary is empty', () => {
  const r = parseDumpSummary('&lt;h4&gt;Chosen variables&lt;/h4&gt;&lt;p&gt;x&lt;/p&gt;');
  assert.deepEqual(r.drift, [{ node: 'h4', count: 1, where: 'Chosen variables' }]);
  assert.deepEqual(r.stack, []);
  const empty = parseDumpSummary('');
  assert.deepEqual(empty.header, {});
  assert.equal(empty.whatHappened, null);
});

test('parseDumpFeed: an undeclared element, entry attribute, category label or summary type is drift', () => {
  const aged = DUMPS.replace('<atom:entry xml:lang="PT">', '<atom:entry xml:lang="PT" adtcore:new="1"><atom:rights>x</atom:rights>')
    .replace('label="ABAP runtime error"', 'label="Kernel error"')
    .replace('<atom:summary type="html">', '<atom:summary type="text">');
  const { drift, entries } = parseDumpFeed(aged, { withReport: false });
  assert.ok(drift.some((d) => d.node === 'atom:rights'));
  assert.ok(drift.some((d) => d.node === 'atom:entry' && d.attribute === 'adtcore:new'));
  assert.ok(drift.some((d) => d.node === 'atom:category' && /Kernel error/.test(d.where)));
  assert.ok(drift.some((d) => d.node === 'atom:summary' && d.attribute === 'type'));
  assert.equal(entries[0].runtimeError, null, 'a relabelled category is not guessed');
});

// --- the gateway log -----------------------------------------------------------------------

test('parseGatewayFeed: the measured envelope is empty and says so; an entry comes back generic and unmeasured', () => {
  const g = parseGatewayFeed(GATEWAY);
  assert.equal(g.title, 'SAP Gateway Error Log');
  assert.deepEqual(g.entries, []);
  assert.equal(g.measured, false);
  assert.deepEqual(g.drift, []);
  const withEntry = GATEWAY.replace(
    '</atom:feed>',
    '<atom:entry><atom:id>x1</atom:id><atom:title>Service not found</atom:title><atom:published>2026-09-12T10:00:00Z</atom:published><atom:category term="/IWFND/CM_MGW/020" label="msg"/><atom:link href="adt://DEV/x" rel="alternate" type="text/html"/><atom:summary type="html">&lt;p&gt;Resource not found for segment&lt;/p&gt;</atom:summary><gw:extra>1</gw:extra></atom:entry></atom:feed>'
  );
  const e = parseGatewayFeed(withEntry).entries[0];
  assert.equal(e.title, 'Service not found');
  assert.match(e.summary, /Resource not found for segment/);
  assert.deepEqual(e.categories, [{ term: '/IWFND/CM_MGW/020', label: 'msg' }]);
  assert.ok(e.elements.includes('gw:extra'), 'every element of the entry is listed, so the unmeasured shape is visible');
});

// --- the tool ------------------------------------------------------------------------------

const journalLines = [];
const cfgWith = (log) => ({
  host: 'dev.example',
  client: '001',
  budget: { reads: 1000 },
  auditSink: (line) => log.push(JSON.parse(line)),
  journalSink: (stream, record) => journalLines.push({ stream, ...record }),
});
const journalOf = () => ({ enabled: true, gap: (g) => journalLines.push({ stream: 'gaps', ...g }) });
const sessionWith = (answer) => {
  const sent = [];
  const session = {
    api: {},
    raw: {
      httpClient: {
        request: async (url, cfg) => {
          sent.push({ url, ...cfg });
          const a = typeof answer === 'function' ? answer(url) : answer;
          if (a.status >= 400) throw Object.assign(new Error('server said no'), { err: a.status });
          return { status: 200, body: a.body, headers: { 'content-type': 'application/atom+xml;type=feed' } };
        },
      },
    },
  };
  return { session, sent };
};
const jsonOf = (res) => JSON.parse(res.content[0].text);

beforeEach(() => {
  journalLines.length = 0;
});

test('adt_runtime_errors: no default mode, never two modes, and no raw client is a clear refusal', async () => {
  const log = [];
  const { session } = sessionWith({ body: DUMPS });
  const tool = runtimeErrorsTool(cfgWith(log), session, journalOf());
  await assert.rejects(() => tool.handler({}), /no default mode/);
  await assert.rejects(() => tool.handler({ feeds: true, list: { feed: 'dumps' } }), /never two/);
  await assert.rejects(() => tool.handler({ list: { feed: 'nope' } }), /list.feed must be one of/);
  await assert.rejects(() => tool.handler({ list: { feed: 'dumps', max: 101 } }), /1 to 100/);
  await assert.rejects(() => tool.handler({ detail: { id: '' } }), /detail.id is required/);
  await assert.rejects(() => runtimeErrorsTool(cfgWith(log), { api: {} }, journalOf()).handler({ feeds: true }), /no raw client/);
  assert.equal(log.length, 0, 'nothing was audited: nothing was sent');
});

test('adt_runtime_errors feeds: one GET on the catalogue, audited as "feeds"', async () => {
  const log = [];
  const { session, sent } = sessionWith({ body: CATALOG });
  const out = jsonOf(await runtimeErrorsTool(cfgWith(log), session, journalOf()).handler({ feeds: true }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].url, '/sap/bc/adt/feeds');
  assert.equal(sent[0].headers.Accept, 'application/atom+xml;type=feed');
  assert.equal(out.mode, 'feeds');
  assert.equal(out.feeds.length, 7);
  assert.deepEqual(out.readable.map((r) => r.name), ['dumps', 'gateway', 'atc']);
  assert.deepEqual(log.map((l) => [l.tool, l.target]), [['adt_runtime_errors', 'feeds']]);
});

test('adt_runtime_errors list: the page and the generated $query reach the wire; the audit never carries a user', async () => {
  const log = [];
  const { session, sent } = sessionWith({ body: DUMPS });
  const tool = runtimeErrorsTool(cfgWith(log), session, journalOf());
  const out = jsonOf(await tool.handler({ list: { feed: 'dumps', filters: [{ attribute: 'user', value: 'DEMOUSER' }], max: 2, skip: 4 } }));
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].url, '/sap/bc/adt/runtime/dumps?%24query=and+%28+equals+%28+user+%2C+DEMOUSER+%29+%29&%24skip=4&%24top=2');
  assert.equal(out.mode, 'list');
  assert.equal(out.query, 'and ( equals ( user , DEMOUSER ) )');
  assert.deepEqual(out.page, { top: 2, skip: 4, returned: 2, truncated: true, next: { skip: 6 } });
  assert.equal(out.count, 2);
  assert.equal(out.complete, false, 'a full page is not proof of a complete list');
  assert.deepEqual(out.incomplete.find((i) => i.code === 'SERVER_PAGE_FULL').next, { skip: 6 });
  assert.deepEqual(contractErrors(out), []);
  assert.equal(typeof out.serverWindow.source, 'string');
  assert.equal(out.entries[0].report, undefined, 'light by default');
  assert.equal(out.groups.reduce((n, g) => n + g.count, 0), out.count, 'every dump of the page is in one group');
  assert.ok(out.groups.every((g) => !('line' in g)));
  assert.match(out.groupedBy, /this page only/);
  assert.equal(out.entries[0].user, 'DEMOUSER', 'the answer names the user: that is the question');
  assert.equal(log.at(-1).target, 'dumps top=2 skip=4 filtered');
  assert.ok(!JSON.stringify(log).includes('DEMOUSER'), 'the audit line carries no user');

  const full = jsonOf(await tool.handler({ list: { feed: 'dumps', report: true } }));
  assert.equal(sent[1].url, '/sap/bc/adt/runtime/dumps?%24top=50');
  assert.equal(full.page.truncated, false);
  assert.deepEqual(contractErrors(full), []);
  assert.equal(full.entries[0].report.stack.length, 13);
  assert.equal(full.groups.find((g) => g.program === full.entries[0].program).line, 30, 'with the report the line joins the key');
  await assert.rejects(() => tool.handler({ list: { feed: 'dumps', filters: [{ attribute: 'user', value: 'X ) or' }] } }), /character the query alphabet/);
  assert.equal(sent.length, 2, 'a refused filter never reaches the wire');
});

test('adt_runtime_errors list gateway: the envelope, flagged as unmeasured', async () => {
  const log = [];
  const { session, sent } = sessionWith({ body: GATEWAY });
  const out = jsonOf(await runtimeErrorsTool(cfgWith(log), session, journalOf()).handler({ list: { feed: 'gateway' } }));
  assert.equal(sent[0].url, '/sap/bc/adt/gw/errorlog?%24top=50');
  assert.equal(out.count, 0);
  assert.equal(out.entriesMeasured, false, 'the entries of this feed are not measured, and the answer says so');
});

test('adt_runtime_errors detail: one dump by id, found in the page, then its resource and (on full) its report; not found is DUMP_NOT_READ, never "gone"', async () => {
  const log = [];
  const { session, sent } = sessionWith((url) => {
    if (url.startsWith('/sap/bc/adt/runtime/dumps')) return { body: DUMPS };
    if (url === DUMP_KEY) return { body: DUMP_RESOURCE };
    if (url === `${DUMP_KEY}/formatted`) return { body: 'Category ABAP Programming Error\nRuntime Errors OBJECTS_OBJREF_NOT_ASSIGNED_NO\n...\nChosen Variables\nLV_X = 42\n' };
    return { status: 404 };
  });
  const tool = runtimeErrorsTool(cfgWith(log), session, journalOf());
  const id = parseDumpFeed(DUMPS, { withReport: false }).entries[1].id;
  const out = jsonOf(await tool.handler({ detail: { id, max: 10 } }));
  assert.equal(sent[0].url, '/sap/bc/adt/runtime/dumps?%24top=10');
  assert.equal(sent[1].url, DUMP_KEY, 'the resource is read at the HTTP twin of the self link');
  assert.equal(sent[1].headers.Accept, 'application/vnd.sap.adt.runtime.dump.v1+xml');
  assert.equal(sent.length, 2, 'the formatted report is not read unless asked');
  assert.equal(out.mode, 'detail');
  assert.equal(out.searched, 2);
  assert.equal(out.entry.user, 'OTHERDEV');
  assert.equal(out.entry.report.header['Runtime Error'], 'OBJECTS_OBJREF_NOT_ASSIGNED_NO');
  assert.equal(out.resource.error, 'OBJECTS_OBJREF_NOT_ASSIGNED_NO');
  assert.equal(out.resource.chapters.length, 20);
  assert.equal(out.resource.chapters.find((c) => c.name === 'kap10').line, 321);
  assert.equal(out.formatted, undefined);
  assert.deepEqual(log.map((l) => l.target), ['dump 20260912153234vhdemohost_DEV_00 21', 'dump 20260912153234vhdemohost_DEV_00 21 resource']);
  assert.ok(!JSON.stringify(log).includes('OTHERDEV'));

  const full = jsonOf(await tool.handler({ detail: { id, max: 10, full: true } }));
  assert.equal(sent[4].url, `${DUMP_KEY}/formatted`);
  assert.equal(sent[4].headers.Accept, 'text/plain');
  assert.match(full.formatted, /LV_X = 42/);
  assert.deepEqual([full.resourcePart, full.formattedPart], [{ read: true }, { asked: true, read: true }]);
  assert.deepEqual(contractErrors(full), []);
  assert.equal(log.at(-1).target, 'dump 20260912153234vhdemohost_DEV_00 21 formatted');

  // The resource failing leaves the summary-based detail standing and files DUMP_NOT_READ.
  const broken = sessionWith((url) => (url.startsWith('/sap/bc/adt/runtime/dumps') ? { body: DUMPS } : { status: 500 }));
  const b = jsonOf(await runtimeErrorsTool(cfgWith([]), broken.session, journalOf()).handler({ detail: { id, full: true } }));
  assert.equal(b.entry.user, 'OTHERDEV');
  assert.equal(b.resource, undefined);
  assert.match(b.resourceNote, /not read/);
  assert.match(b.formattedNote, /not read/);
  assert.deepEqual(b.incomplete.map((i) => `${i.list}:${i.code}`), ['resource:NOT_READ', 'formatted:NOT_READ']);
  assert.deepEqual(contractErrors(b), []);
  assert.equal(journalLines.filter((l) => l.code === 'DUMP_NOT_READ').length, 2);
  journalLines.length = 0;
  assert.equal(auditKeyOf(id), '20260912153234vhdemohost_DEV_00 21', 'the adt:// id is reduced the same way');
  assert.ok(!JSON.stringify(log).includes('OTHERDEV'));

  await assert.rejects(() => tool.handler({ detail: { id: '20260101000000host_DEV_00 NOBODY 001 01' } }), /not among the 2 entries read/);
  const g = journalLines.find((l) => l.code === 'DUMP_NOT_READ');
  assert.ok(g);
  assert.equal(g.subject, '20260101000000host_DEV_00 01', 'the gap subject carries no user either');
  assert.match(g.impact, /NOT evidence that it was deleted/);
});

test('adt_runtime_errors: an ADT failure is FEED_NOT_READ, a route violation is not', async () => {
  const log = [];
  const { session } = sessionWith({ status: 500 });
  const tool = runtimeErrorsTool(cfgWith(log), session, journalOf());
  await assert.rejects(() => tool.handler({ list: { feed: 'dumps' } }), /500/);
  const g = journalLines.find((l) => l.code === 'FEED_NOT_READ');
  assert.ok(g);
  assert.match(g.impact, /NOT an empty log/);
  assert.equal(log.length, 0, 'nothing audited when nothing was read');
});

test('adt_runtime_errors: an aged shape files SHAPE_DRIFT and the entries still stand', async () => {
  const aged = DUMPS.replace('</atom:feed>', '<atom:generator>x</atom:generator></atom:feed>');
  const { session } = sessionWith({ body: aged });
  const out = jsonOf(await runtimeErrorsTool(cfgWith([]), session, journalOf()).handler({ list: { feed: 'dumps' } }));
  assert.equal(out.count, 2);
  assert.ok(out.drift.some((d) => d.node === 'atom:generator'));
  assert.ok(journalLines.some((l) => l.code === 'SHAPE_DRIFT'));
});

test('parseDumpResource: header, links and the chapter index in reading order; dumpPathOf keeps the key encoded', () => {
  const r = parseDumpResource(DUMP_RESOURCE);
  assert.deepEqual(r.drift, []);
  assert.equal(r.error, 'OBJECTS_OBJREF_NOT_ASSIGNED_NO');
  assert.equal(r.exception, 'CX_SY_REF_IS_INITIAL');
  assert.equal(r.author, 'OTHERDEV');
  assert.equal(r.terminatedProgram, 'CL_ENH_ADT_ENHO_OBJ_PERSIST===CP');
  assert.equal(r.datetime, '2026-09-12T18:32:34Z');
  assert.equal(r.links.length, 7);
  assert.equal(r.links.find((l) => l.relation === 'contents').contentType, 'text/plain');
  assert.match(r.links.find((l) => l.relation.endsWith('/termination')).uri, /^adt:\/\//);
  assert.deepEqual(r.chapters.slice(0, 3).map((c) => c.name), ['kap0', 'kap1', 'kap2'], 'sorted by chapterOrder, not document order');
  assert.deepEqual(r.chapters.find((c) => c.name === 'kap10'), { name: 'kap10', title: 'Chosen Variables', category: 'ABAP Developer View', line: 321, order: 13 });
  assert.equal(parseDumpResource('<dump:dump exception=""/>').exception, null);
  assert.deepEqual(parseDumpResource('<dump:dump><dump:extra/></dump:dump>').drift, [{ node: 'dump:extra', count: 1, where: 'dump' }]);

  assert.equal(dumpPathOf(`adt://DEV${DUMP_KEY}`), DUMP_KEY);
  assert.equal(dumpPathOf(DUMP_KEY), DUMP_KEY);
  assert.equal(dumpPathOf('adt://DEV/sap/bc/adt/vit/runtime/dumps/x'), null);
  assert.equal(dumpPathOf(`adt://DEV${DUMP_KEY}/formatted`), null);
  assert.equal(dumpPathOf(''), null);
});

test('auditKeyOf strips the user out of a dump key', () => {
  assert.equal(auditKeyOf('20260912153319vhdemohost_DEV_00 DEMOUSER 001 23'), '20260912153319vhdemohost_DEV_00 23');
  assert.equal(auditKeyOf('single'), 'single');
  assert.equal(auditKeyOf(''), '?');
});

test('sparse bodies: every optional piece missing comes back null or empty, never a crash and never a guess', () => {
  const c = parseFeedCatalog('<atom:feed><atom:entry><atom:title>Bare</atom:title><atom:link href="/x"/></atom:entry></atom:feed>');
  assert.equal(c.feeds.length, 1);
  assert.equal(c.feeds[0].href, '/x');
  assert.equal(c.feeds[0].accept, null);
  assert.deepEqual(c.feeds[0].attributes, []);
  assert.deepEqual(c.feeds[0].variants, []);
  assert.equal(c.feeds[0].queryIsObligatory, false);
  assert.equal(c.feeds[0].paging, null);
  const d = parseDumpFeed('<atom:feed><atom:entry><atom:id>x</atom:id><atom:summary type="html"></atom:summary></atom:entry></atom:feed>');
  assert.equal(d.self, null);
  assert.equal(d.entries.length, 1);
  assert.equal(d.entries[0].user, null);
  assert.equal(d.entries[0].runtimeError, null);
  assert.equal(d.entries[0].program, null);
  assert.deepEqual(d.entries[0].links, { gui: null, self: null });
  assert.deepEqual(d.entries[0].report.sourceExtract, []);
  assert.deepEqual(d.entries[0].report.stack, []);
  const g = parseGenericFeed('<atom:feed><atom:entry><atom:title>t</atom:title></atom:entry></atom:feed>');
  assert.equal(g.entries[0].id, null);
  assert.equal(g.entries[0].summary, null);
  assert.deepEqual(g.entries[0].categories, []);
  const r = parseDumpResource('<dump:dump><dump:links><dump:link/></dump:links><dump:chapters><dump:chapter name="k"/></dump:chapters></dump:dump>');
  assert.deepEqual(r.links, [{ relation: null, uri: null, contentType: null }]);
  assert.equal(r.chapters[0].title, null);
  assert.ok(Number.isNaN(r.chapters[0].line));
  assert.equal(parseDumpSummary(null).errorAnalysis, null);
});
