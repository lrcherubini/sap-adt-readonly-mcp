// adt_syntax_check: the fourth POST, its fixed body, the measured reply shapes (fixtures
// anonymised from the run of 2026-11-10) and the inactive trap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCheckBody, checkRunPost, parseCheckRun, countByType, SyntaxCheckViolation, CHECK_RUN_URL } from '../lib/syntax-check.mjs';
import { syntaxCheckTool } from '../tools/syntax-check.mjs';
import { resetBudget } from '../lib/audit.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/checkrun/${name}`, import.meta.url), 'utf8');
const versionDoc = (v) => fs.readFileSync(new URL(`./fixtures/versions/zdemo_report2.object-${v}.xml`, import.meta.url), 'utf8');

const URI = '/sap/bc/adt/programs/programs/zdemo_report4';

test('the body names one object and one version, and nothing else can be put in it', () => {
  const b = buildCheckBody(URI, 'inactive');
  assert.equal(
    b.xml,
    '<?xml version="1.0" encoding="UTF-8"?><chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core"><chkrun:checkObject adtcore:uri="/sap/bc/adt/programs/programs/zdemo_report4" ' +
      'chkrun:version="inactive"/></chkrun:checkObjectList>',
  );
  assert.doesNotMatch(b.xml, /artifact|content/, 'no source is ever sent');
  for (const bad of [
    '/sap/bc/adt/ddic/ddl/sources/zdemo_i',
    '/sap/bc/adt/programs/programs/zdemo"/><x a="',
    '/sap/bc/adt/programs/programs/ZDEMO_UPPER',
    '/sap/bc/adt/programs/programs/zdemo/source/main',
    '',
  ]) {
    assert.throws(() => buildCheckBody(bad, 'active'), SyntaxCheckViolation, bad);
  }
  assert.throws(() => buildCheckBody(URI, 'workingArea'), SyntaxCheckViolation);
});

test('the POST goes to the one fixed path with the measured headers, and only with a built body', async () => {
  const sent = [];
  const raw = { httpClient: { request: async (url, cfg) => { sent.push({ url, ...cfg }); return { status: 200, body: fixture('clean.xml') }; } } };
  await assert.rejects(() => checkRunPost(raw, { xml: '<x/>', uri: URI }), SyntaxCheckViolation);
  assert.equal(sent.length, 0);
  const out = await checkRunPost(raw, buildCheckBody(URI, 'active'));
  assert.deepEqual([sent[0].url, sent[0].method], [CHECK_RUN_URL, 'POST']);
  assert.deepEqual(sent[0].headers, {
    Accept: 'application/vnd.sap.adt.checkmessages+xml',
    'Content-Type': 'application/vnd.sap.adt.checkobjects+xml',
  });
  assert.equal(out.status, 200);
  const failing = { httpClient: { request: async () => { const e = new Error('Service unavailable'); e.err = 503; throw e; } } };
  await assert.rejects(() => checkRunPost(failing, buildCheckBody(URI, 'active')), (e) => e.status === 503);
});

test('the measured replies parse: clean, one error with its position, not processed', () => {
  const clean = parseCheckRun(fixture('clean.xml'));
  assert.deepEqual(clean.drift, []);
  assert.deepEqual(clean.reports.map((r) => [r.reporter, r.status, r.messages.length]), [['abapCheckRun', 'processed', 0]]);
  const error = parseCheckRun(fixture('error.xml'));
  assert.deepEqual(error.drift, []);
  assert.deepEqual(error.reports[0].messages, [
    { type: 'E', text: 'The last statement is not complete (period missing).', uri: `${URI}/source/main`, line: 8, column: 0 },
  ]);
  assert.deepEqual(countByType(error.reports[0].messages), { E: 1 });
  assert.equal(parseCheckRun(fixture('not-processed.xml')).reports[0].status, 'notProcessed');
  const drifted = parseCheckRun(fixture('clean.xml').replace('chkrun:status=', 'chkrun:newThing="x" chkrun:status='));
  assert.deepEqual(drifted.drift, [{ node: 'chkrun:checkReport', attribute: 'chkrun:newThing' }]);
});

function harness({ docVersion = 'inactive', reply = fixture('error.xml'), hitUri = URI, type = 'PROG/P', name = 'ZDEMO_REPORT4' } = {}) {
  const seen = [];
  const gaps = [];
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        seen.push({ url, method: opts.method });
        if (opts.method === 'GET') return { status: 200, body: versionDoc(docVersion), headers: {} };
        return { status: 200, body: reply, headers: {} };
      },
    },
  };
  const api = { searchObject: async () => [{ 'adtcore:name': name, 'adtcore:type': type, 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': hitUri }] };
  const cfg = { host: 'vhdemohost.example', client: '001', budget: { reads: 100 }, auditSink: () => {}, journalSink: () => {} };
  resetBudget();
  const journal = { enabled: true, gap: (g) => gaps.push(g) };
  return { tool: syntaxCheckTool(cfg, { api, raw }, journal), seen, gaps };
}

const json = (res) => JSON.parse(res.content[0].text);

test('active is one POST and answers the messages', async () => {
  const h = harness();
  const out = json(await h.tool.handler({ objectName: 'ZDEMO_REPORT4' }));
  assert.deepEqual(h.seen, [{ url: CHECK_RUN_URL, method: 'POST' }]);
  assert.deepEqual([out.version, out.checked, out.clean, out.count, out.byType], ['active', true, false, 1, { E: 1 }]);
  assert.equal(out.messages[0].line, 8);
});

test('inactive asks the object document first, and with no inactive version sends nothing', async () => {
  const none = harness({ docVersion: 'active', reply: fixture('inactive-without-inactive.xml') });
  const out = json(await none.tool.handler({ objectName: 'ZDEMO_REPORT4', version: 'inactive' }));
  assert.deepEqual(none.seen, [{ url: `${URI}?version=inactive`, method: 'GET' }], 'no POST: it would check an empty source');
  assert.equal(out.checked, false);
  assert.match(out.reason, /no inactive version/);

  const some = harness({ docVersion: 'inactive' });
  const read = json(await some.tool.handler({ objectName: 'ZDEMO_REPORT4', version: 'inactive' }));
  assert.deepEqual(some.seen.map((s) => s.method), ['GET', 'POST']);
  assert.equal(read.checked, true);
});

test('a report not processed is no verdict and is filed; a failed POST is filed and thrown', async () => {
  const h = harness({ reply: fixture('not-processed.xml') });
  const out = json(await h.tool.handler({ objectName: 'ZDEMO_REPORT4' }));
  assert.deepEqual([out.checked, out.status], [false, 'notProcessed']);
  assert.equal(out.clean, undefined, 'never called clean');
  assert.ok(h.gaps.some((g) => g.code === 'SYNTAX_NOT_CHECKED'));

  const failing = harness();
  failing.tool = syntaxCheckTool(
    { host: 'vhdemohost.example', client: '001', budget: { reads: 100 }, auditSink: () => {}, journalSink: () => {} },
    {
      api: { searchObject: async () => [{ 'adtcore:name': 'ZDEMO_REPORT4', 'adtcore:type': 'PROG/P', 'adtcore:uri': URI }] },
      raw: { httpClient: { request: async () => { throw Object.assign(new Error('boom'), { err: 500 }); } } },
    },
    { enabled: true, gap: (g) => failing.gaps.push(g) },
  );
  await assert.rejects(() => failing.tool.handler({ objectName: 'ZDEMO_REPORT4' }), /500/);
  assert.ok(failing.gaps.some((g) => g.code === 'SYNTAX_NOT_CHECKED'));
});

test('an object that is not a class or a program is refused before anything is sent', async () => {
  const h = harness({ hitUri: '/sap/bc/adt/ddic/ddl/sources/zdemo_i', type: 'DDLS/DF', name: 'ZDEMO_I' });
  await assert.rejects(() => h.tool.handler({ objectName: 'ZDEMO_I' }), SyntaxCheckViolation);
  assert.equal(h.seen.length, 0);
});

test('a reply with an undeclared attribute is answered and filed as drift; no session, no name, no call', async () => {
  const drifted = fixture('error.xml').replace('chkrun:type="E"', 'chkrun:type="E" chkrun:quickfix="x"');
  const h = harness({ reply: drifted });
  const out = json(await h.tool.handler({ objectName: 'ZDEMO_REPORT4' }));
  assert.equal(out.checked, true);
  assert.deepEqual(out.drift, [{ node: 'chkrun:checkMessage', attribute: 'chkrun:quickfix' }]);
  assert.ok(h.gaps.some((g) => g.code === 'SHAPE_DRIFT'));
  const bare = syntaxCheckTool({}, { api: {} }, null);
  await assert.rejects(() => bare.handler({ objectName: 'ZDEMO_REPORT4' }), /no raw client/);
  await assert.rejects(() => harness().tool.handler({ objectName: '  ' }), /needs an objectName/);
  const noReport = harness({ reply: '<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>' });
  const none = json(await noReport.tool.handler({ objectName: 'ZDEMO_REPORT4' }));
  assert.deepEqual([none.checked, none.status], [false, null]);
});

test('a message with a quickfix carries its marker; the link is never followed', () => {
  const r = parseCheckRun(fixture('error-quickfix.xml'));
  assert.deepEqual(r.drift, [], 'the measured link is declared');
  assert.deepEqual(r.reports[0].messages, [
    {
      type: 'E',
      text: 'Field "LV_UNDEFINED" is unknown.',
      uri: '/sap/bc/adt/oo/classes/zcl_demo_probe/source/main',
      line: 35,
      column: 37,
      quickfix: 'art.syntax:GTU',
    },
  ]);
  const other = parseCheckRun(fixture('error-quickfix.xml').replace('categories/quickfixes', 'categories/other'));
  assert.deepEqual(other.drift.map((d) => d.node), ['atom:link'], 'another link is drift, not a quickfix');
});
