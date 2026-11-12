// lib/limits.mjs: the gate on requests in flight to the system, and the tool-call rate of a
// caller. Both sit before the work, unlike the read budget, which counts after it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGate, createCallRate } from '../lib/limits.mjs';
import { createAdtHttp, LOGON_PATH, DEFAULT_CONCURRENCY } from '../lib/adt-http.mjs';
import { createRequestHandler } from '../lib/mcp-server.mjs';
import { buildTools } from '../tools/index.mjs';
import { validateSetting } from '../lib/environment.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the gate lets at most its number run at once, in the order they came', async () => {
  const gate = createGate(2);
  let inFlight = 0;
  let most = 0;
  const order = [];
  const work = (n) =>
    gate(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      order.push(n);
      await tick();
      await tick();
      inFlight -= 1;
      return n;
    });
  const all = Promise.all([1, 2, 3, 4, 5, 6].map(work));
  await tick();
  assert.equal(gate.inFlight(), 2);
  assert.equal(gate.waiting(), 4);
  assert.deepEqual(await all, [1, 2, 3, 4, 5, 6]);
  assert.equal(most, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
  assert.equal(gate.inFlight(), 0);
});

test('a run that fails gives its slot back', async () => {
  const gate = createGate(1);
  await assert.rejects(() => gate(async () => { throw new Error('refused'); }), /refused/);
  assert.equal(gate.inFlight(), 0);
  assert.equal(await gate(async () => 'next'), 'next');
});

test('the rate refuses the call past the number, per caller, and says how long to wait', () => {
  let at = 1_000_000;
  const rate = createCallRate(2, { now: () => at });
  assert.equal(rate.refusal('alice'), null);
  at += 10_000;
  assert.equal(rate.refusal('alice'), null);
  at += 10_000;
  const held = rate.refusal('alice');
  assert.equal(held.waitSeconds, 40, 'until the oldest call of the window is a minute old');
  assert.match(held.message, /2 tool calls per minute .* 'alice' has made 2 .* Try again in 40 s/);
  assert.equal(rate.refusal('bob'), null, 'another caller has a minute of their own');
  // A refused call is not counted: waiting the time said is enough.
  at += 40_000;
  assert.equal(rate.refusal('alice'), null);
  assert.ok(rate.refusal('alice'), 'and the window is full again');
});

test('a rate of 0 is no limit, and a call without a caller still has a ledger', () => {
  const off = createCallRate(0);
  for (let i = 0; i < 500; i++) assert.equal(off.refusal('alice'), null);
  const one = createCallRate(1, { now: () => 5 });
  assert.equal(one.refusal(null), null);
  assert.match(one.refusal(null).message, /'\(unnamed\)'/);
});

test('the settings: a number of requests at once, and calls per minute with 0 for none', () => {
  assert.equal(validateSetting('limits.adtConcurrency', '4'), 4);
  assert.throws(() => validateSetting('limits.adtConcurrency', '0'), /not an integer from 1 to 64/);
  assert.equal(validateSetting('limits.callsPerMinute', '0'), 0);
  assert.equal(validateSetting('limits.callsPerMinute', '120'), 120);
  assert.ok(DEFAULT_CONCURRENCY >= 1);
});

test('the HTTP client holds the requests past limits.adtConcurrency until one returns', async () => {
  const CFG = { host: 'vhdemohost.example', port: 44300, client: '001', language: 'EN', limits: { adtConcurrency: 2 } };
  let open = 0;
  let most = 0;
  const release = [];
  const request = (options, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const reply = (status, headers, body) => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = headers;
        onResponse(res);
        res.emit('data', Buffer.from(body));
        res.emit('end');
      };
      if (options.path.startsWith(LOGON_PATH)) {
        setImmediate(() => reply(200, { 'x-csrf-token': 'T', 'set-cookie': ['SAP_SESSIONID_DEV_001=s; path=/'] }, ''));
        return;
      }
      open += 1;
      most = Math.max(most, open);
      release.push(() => {
        open -= 1;
        reply(200, {}, 'ok');
      });
    };
    return req;
  };
  const client = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'p', request });
  await client.login();
  const all = Promise.all([1, 2, 3, 4, 5].map((n) => client.httpClient.request(`/sap/bc/adt/programs/programs/zdemo_${n}`)));
  await tick();
  assert.equal(open, 2, 'two reached the system; three wait');
  while (release.length) {
    release.shift()();
    await tick();
    await tick();
  }
  assert.equal((await all).length, 5);
  assert.equal(most, 2);
});

test('over the wire: the call past the rate is an isError answer with the wait, and nothing is read', async () => {
  let reads = 0;
  const cfg = { host: 'vhdemohost.example', client: '001', budget: { reads: 1000 }, auditSink: () => {}, journalSink: () => {}, paths: {} };
  const api = { searchObject: async () => { reads += 1; return []; } };
  const TOKEN = 'e'.repeat(64);
  let port;
  const server = http.createServer(createRequestHandler({ tools: buildTools(cfg, { api }), token: TOKEN, port: () => port, callsPerMinute: 2, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const c = new Client({ name: 'limits-test', version: '1.0.0' });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const call = () => c.callTool({ name: 'adt_search', arguments: { query: 'ZDEMO*' } });
    assert.equal((await call()).isError, undefined);
    assert.equal((await call()).isError, undefined);
    const held = await call();
    assert.equal(held.isError, true);
    assert.match(held.content[0].text, /Rate limit: 2 tool calls per minute .* 'local'/);
    assert.equal(reads, 2, 'the refused call asked nothing of the system');
    // Listing the tools is not a tool call: it is never held back.
    assert.ok((await c.listTools()).tools.length > 0);
  } finally {
    await c.close();
    await new Promise((r) => server.close(r));
  }
});
