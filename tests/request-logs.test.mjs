// The logs of one transport request: the parser over the measured shapes, and the `logs`
// option of adt_transport, which never reads a failed log as an empty one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseRequestLog } from '../lib/request-logs.mjs';
import { transportTool } from '../tools/transport.mjs';
import { openJournal } from '../lib/journal.mjs';
import { buildUrl, RouteViolation } from '../lib/adt-get.mjs';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const ACTIONS = fixture('request-logs/actionlogs.xml');
const MOVES = fixture('request-logs/transportlogs.xml');
const DETAIL = fixture('transport-detail-customizing.xml');

test('the action log is flat, and its separator lines are dropped', () => {
  const log = parseRequestLog(ACTIONS);
  assert.equal(log.type, 'LOG_TYPE_ACT_DDIC');
  assert.equal(log.count, 6);
  assert.deepEqual(log.entries.map((e) => e.key), ['TK(191)', 'TK(185)', 'TK(193)', 'TK(190)']);
  assert.match(log.entries[1].text, /DEVUSER1 created the request/);
  assert.equal(log.entries.some((e) => e.children), false);
  assert.equal(log.highestReturnCode, null, 'no step said a return code');
  assert.deepEqual(log.drift, []);
});

test('the transport log is a tree of systems and steps, each step with its return code', () => {
  const log = parseRequestLog(MOVES);
  const request = log.entries[0].children[0].children[0];
  assert.equal(request.text, 'DEVK900120  demo change');
  assert.deepEqual(request.children.map((s) => s.text), ['DEV', 'QAS']);
  const steps = request.children[0].children;
  assert.deepEqual(steps.map((s) => s.rc ?? null), [0, 0, 0, null]);
  assert.equal(log.highestReturnCode, 0);
  // The links are dropped: the server's file path never reaches the answer.
  assert.equal(JSON.stringify(log).includes('/usr/sap/trans'), false);
});

test('the highest return code is the worst step, and an unknown element is drift', () => {
  const failed = MOVES.replace(/(Export {2,}10\.11\.2026 09:24:30 +)\(0\) Ended successfully/, '$1(8) Ended with errors');
  assert.notEqual(failed, MOVES);
  assert.equal(parseRequestLog(failed).highestReturnCode, 8);
  const drifted = parseRequestLog(ACTIONS.replace('<log:name/>', '<log:name/><log:extra/>'));
  assert.deepEqual(drifted.drift, [{ node: 'log:extra', attribute: null, count: 1 }]);
});

test('the two log routes take a request number and nothing else', () => {
  assert.equal(buildUrl('transportActionLogs', { number: 'DEVK900120' }), '/sap/bc/adt/cts/transportrequests/DEVK900120/actionlogs');
  assert.equal(buildUrl('transportLogs', { number: 'DEVK900120' }), '/sap/bc/adt/cts/transportrequests/DEVK900120/transportlogs');
  for (const number of ['DEVK900120/objectkeys', '../DEVK900120', 'devk900120']) {
    assert.throws(() => buildUrl('transportLogs', { number }), RouteViolation, number);
  }
  assert.throws(() => buildUrl('transportActionLogs', { number: 'DEVK900120', systemName: 'DEV' }), RouteViolation);
});

function toolWith(replies, { failing = new Set() } = {}) {
  const audit = [];
  const journalLines = [];
  const cfg = {
    budget: { reads: 100 },
    auditSink: (line) => audit.push(JSON.parse(line)),
    journalSink: (stream, record) => journalLines.push({ stream, ...record }),
  };
  const seen = [];
  const session = {
    raw: {
      httpClient: {
        request: async (url, config) => {
          seen.push({ url, accept: config.headers.Accept });
          const suffix = /\/(actionlogs|transportlogs)$/.exec(url)?.[1] ?? 'detail';
          if (failing.has(suffix)) throw Object.assign(new Error('Service unavailable'), { err: 503 });
          return { status: 200, body: replies[suffix], headers: { 'content-type': 'application/xml' } };
        },
      },
    },
  };
  return { tool: transportTool(cfg, session, openJournal(cfg)), audit, journalLines, seen };
}

test('logs: true reads both logs of the named request, one GET each', async () => {
  const h = toolWith({ detail: DETAIL, actionlogs: ACTIONS, transportlogs: MOVES });
  const out = JSON.parse((await h.tool.handler({ number: 'DEVK900117', logs: true })).content[0].text);
  assert.deepEqual(h.seen.map((s) => s.url), [
    '/sap/bc/adt/cts/transportrequests/DEVK900117',
    '/sap/bc/adt/cts/transportrequests/DEVK900117/actionlogs',
    '/sap/bc/adt/cts/transportrequests/DEVK900117/transportlogs',
  ]);
  assert.equal(h.seen[1].accept, 'application/vnd.sap.adt.logs+xml');
  assert.equal(out.logs.actions.read, true);
  assert.equal(out.logs.actions.entries.length, 4);
  assert.equal(out.logs.transport.highestReturnCode, 0);
  assert.equal(h.audit.length, 3, 'one audit line per ADT call');
  assert.equal(JSON.stringify(h.audit).includes('DEVUSER1'), false, 'no log text in the trail');
  const plain = JSON.parse((await toolWith({ detail: DETAIL }).tool.handler({ number: 'DEVK900117' })).content[0].text);
  assert.equal(plain.logs, undefined, 'without logs: true nothing more is read');
});

test('a log that could not be read says so and files a gap; the other log still answers', async () => {
  const h = toolWith({ detail: DETAIL, actionlogs: ACTIONS }, { failing: new Set(['transportlogs']) });
  const out = JSON.parse((await h.tool.handler({ number: 'DEVK900117', logs: true })).content[0].text);
  assert.equal(out.logs.actions.read, true);
  assert.equal(out.logs.transport.read, false);
  assert.match(out.logs.transport.reason, /503/);
  assert.ok(h.journalLines.some((l) => l.code === 'ADT_ERROR' && /transport log/.test(l.subject)));
});

test('logs are asked only of a request named by number', async () => {
  const { tool } = toolWith({});
  await assert.rejects(() => tool.handler({ recent: true, logs: true }), /request you name by `number`/);
  await assert.rejects(() => tool.handler({ object: { name: 'ZDEMO_REPORT' }, logs: true }), /never two|by `number`/);
});
