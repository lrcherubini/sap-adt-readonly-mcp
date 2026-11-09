// A 500 is a dump until proven otherwise: one feed read names it, the original error stands.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dumpAfter500, explainWithDump, statusOf, SKEW_MS } from '../lib/dump-after-500.mjs';
import { buildTools } from '../tools/index.mjs';

const DUMPS = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'runtime-dumps-measured.xml'), 'utf8');
// The newest entry of the fixture.
const NEWEST = Date.parse('2026-09-12T18:33:19Z');

const journalLines = [];
const cfgWith = (log) => ({
  host: 'dev.example',
  client: '001',
  user: 'demouser',
  budget: { reads: 1000 },
  auditSink: (line) => log.push(JSON.parse(line)),
  journalSink: (stream, record) => journalLines.push({ stream, ...record }),
});
const journalOf = () => ({ enabled: true, gap: (g) => journalLines.push({ stream: 'gaps', ...g }) });
const sessionWith = (answer, user = 'DEMOUSER') => {
  const sent = [];
  const session = {
    api: {},
    user,
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

beforeEach(() => {
  journalLines.length = 0;
});

test('statusOf reads the three measured shapes and nothing below 100', () => {
  assert.equal(statusOf({ status: 500 }), 500);
  assert.equal(statusOf({ err: 500 }), 500);
  assert.equal(statusOf({ response: { status: 404 } }), 404);
  assert.equal(statusOf({ err: 0, message: 'x' }), null);
  assert.equal(statusOf(null), null);
});

test('not a 500: nothing is read, nothing is filed', async () => {
  const { session, sent } = sessionWith({ body: DUMPS });
  const out = await dumpAfter500({ cfg: cfgWith([]), session, journal: journalOf(), tool: 't', error: { err: 404 }, since: 0 });
  assert.equal(out, null);
  assert.equal(sent.length, 0);
  assert.equal(journalLines.length, 0);
});

test('a 500 with a dump of this user since the call: one clause, $top=1, the dump attached, SERVER_DUMPED filed without the user', async () => {
  const log = [];
  const { session, sent } = sessionWith({ body: DUMPS });
  const error = Object.assign(new Error('Request failed with status code 500'), { err: 500 });
  const out = await dumpAfter500({ cfg: cfgWith(log), session, journal: journalOf(), tool: 'adt_transport', error, since: NEWEST - 1000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/sap/bc/adt/runtime/dumps?%24query=and+%28+equals+%28+user+%2C+DEMOUSER+%29+%29&%24top=1');
  assert.deepEqual(sent[0].headers, { Accept: 'application/atom+xml;type=feed' });
  assert.equal(out.checked, true);
  assert.equal(out.matched, true);
  assert.equal(out.dump.runtimeError, 'OBJECTS_OBJREF_NOT_ASSIGNED_NO');
  assert.equal(out.dump.program, 'CL_ENH_ADT_ENHO_OBJ_PERSIST===CP');
  assert.equal(out.dump.key, '20260912153319vhdemohost_DEV_00 23');
  assert.match(out.dump.id, /^\/sap\/bc\/adt\/vit\/runtime\/dumps\//);
  const g = journalLines.find((l) => l.code === 'SERVER_DUMPED');
  assert.equal(g.subject, 'adt_transport');
  assert.match(g.detail, /OBJECTS_OBJREF_NOT_ASSIGNED_NO in CL_ENH_ADT_ENHO_OBJ_PERSIST===CP \(ST22 20260912153319vhdemohost_DEV_00 23/);
  assert.ok(!JSON.stringify(journalLines).includes('DEMOUSER'), 'the user never reaches the journal');
  assert.ok(!JSON.stringify(log).includes('DEMOUSER'), 'nor the audit');
  assert.equal(log[0].target, 'dump after 500');
  assert.match(explainWithDump(out), /the SAP system dumped: OBJECTS_OBJREF_NOT_ASSIGNED_NO in CL_ENH_ADT_ENHO_OBJ_PERSIST===CP \(ST22 20260912153319vhdemohost_DEV_00 23; adt_runtime_errors detail \{id: "\/sap\/bc\/adt\/vit\/runtime\/dumps\//);
});

test('a 500 whose newest dump is OLDER than the call is not explained by it: matched false, still filed', async () => {
  const { session } = sessionWith({ body: DUMPS });
  const out = await dumpAfter500({ cfg: cfgWith([]), session, journal: journalOf(), tool: 't', error: { err: 500 }, since: NEWEST + SKEW_MS + 1 });
  assert.equal(out.matched, false);
  assert.equal(out.dump, null);
  assert.equal(out.newest, '2026-09-12T18:33:19Z');
  const g = journalLines.find((l) => l.code === 'SERVER_DUMPED');
  assert.match(g.detail, /no dump of this user since the call started \(newest: 2026-09-12T18:33:19Z\)/);
  assert.match(explainWithDump(out), /none of this user found since the call started/);
  // Inside the skew it still counts.
  const inSkew = await dumpAfter500({ cfg: cfgWith([]), session, journal: journalOf(), tool: 't', error: { err: 500 }, since: NEWEST + SKEW_MS - 1 });
  assert.equal(inSkew.matched, true);
});

test('the feed failing after a 500 files DUMP_NOT_READ and explains nothing; no raw session or no user reads nothing', async () => {
  const { session } = sessionWith({ status: 500 });
  const out = await dumpAfter500({ cfg: cfgWith([]), session, journal: journalOf(), tool: 't', error: { err: 500 }, since: 0 });
  assert.equal(out.checked, true);
  assert.equal(out.matched, false);
  assert.equal(journalLines.find((l) => l.code === 'DUMP_NOT_READ').subject, 't');
  assert.equal(journalLines.some((l) => l.code === 'SERVER_DUMPED'), false);
  assert.match(explainWithDump(out), /none of this user found/);

  const noRaw = await dumpAfter500({ cfg: cfgWith([]), session: { api: {} }, journal: journalOf(), tool: 't', error: { err: 500 }, since: 0 });
  assert.equal(noRaw.checked, false);
  const noUser = await dumpAfter500({ cfg: { budget: { reads: 1 } }, session: { ...sessionWith({ body: DUMPS }, '').session }, journal: journalOf(), tool: 't', error: { err: 500 }, since: 0 });
  assert.equal(noUser.checked, false);
  assert.equal(explainWithDump(noRaw), '');
  assert.equal(explainWithDump(null), '');
});

test('through the tool wrapper: a tool that throws a 500 rethrows it with the dump in the message and a SERVER_DUMPED line', async () => {
  const log = [];
  const { session, sent } = sessionWith({ body: DUMPS });
  session.sources = { catalog: null, mirror: null, precedent: null };
  session.api = {
    searchObject: async () => {
      throw Object.assign(new Error('Request failed with status code 500'), { err: 500 });
    },
  };
  const tools = buildTools(cfgWith(log), session);
  const search = tools.find((t) => t.definition.name === 'adt_search');
  await assert.rejects(
    () => search.handler({ query: 'ZCL_DEMO_UTILITIES', objectType: 'ENHO/XH' }),
    (e) => {
      // The fixture's newest dump is of 2026-09-12 and the wrapper's clock is now, so the
      // feed was read and answered "none since the call": the sentence, not the dump.
      assert.match(e.message, /status code 500 -- HTTP 500 \(probably a dump on the SAP system; none of this user found since the call started\)/);
      assert.equal(e.dump, undefined);
      return true;
    }
  );
  assert.equal(sent.length, 1, 'one feed read, after the failure');
  assert.equal(sent[0].url, '/sap/bc/adt/runtime/dumps?%24query=and+%28+equals+%28+user+%2C+DEMOUSER+%29+%29&%24top=1');
  const call = journalLines.find((l) => l.stream === 'calls' && l.tool === 'adt_search');
  assert.equal(call.ok, false);
  assert.match(call.outcome, /probably a dump on the SAP system/);
  assert.equal(journalLines.find((l) => l.code === 'SERVER_DUMPED').subject, 'adt_search');

  // A 404 through the same wrapper reads no feed.
  session.api.searchObject = async () => {
    throw Object.assign(new Error('Request failed with status code 404'), { err: 404 });
  };
  await assert.rejects(() => search.handler({ query: 'X' }), /404$/);
  assert.equal(sent.length, 1);
});
