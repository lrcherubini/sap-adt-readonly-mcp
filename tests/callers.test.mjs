// A token per caller: who a hosted server answers to, and how the audit trail names them.
// The store holds a name and a token's SHA-256; the token is shown once and never stored.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callerOf, tokenHash, newCallerToken, LOCAL_CALLER, CALLER_NAME } from '../lib/auth.mjs';
import { runCommand, parseArgs } from '../lib/config-cli.mjs';
import { readCallers } from '../lib/environment.mjs';
import { createRequestHandler } from '../lib/mcp-server.mjs';
import { inCall, currentCall } from '../lib/call-context.mjs';
import { record, resetBudget } from '../lib/audit.mjs';
import { buildTools } from '../tools/index.mjs';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
function storeFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-callers-'));
  made.push(dir);
  return path.join(dir, 'sap-adt.db');
}
const run = (file, ...argv) => runCommand(parseArgs(argv), { file, legacy: null });

const LOCAL = 'a'.repeat(64);

test('callerOf names the local token, a caller s token, and refuses every other', () => {
  const alice = newCallerToken();
  const bob = newCallerToken();
  const callers = [{ name: 'alice', tokenSha256: alice.tokenSha256 }, { name: 'bob', tokenSha256: bob.tokenSha256 }];
  assert.deepEqual(callerOf(`Bearer ${LOCAL}`, { token: LOCAL, callers }), { caller: LOCAL_CALLER });
  assert.deepEqual(callerOf(`Bearer ${alice.token}`, { token: LOCAL, callers }), { caller: 'alice' });
  assert.deepEqual(callerOf(`bearer  ${bob.token}\n`, { token: LOCAL, callers }), { caller: 'bob' });
  assert.match(callerOf(`Bearer ${'c'.repeat(64)}`, { token: LOCAL, callers }).failure, /neither the local one nor a caller s/);
  assert.match(callerOf(undefined, { token: LOCAL, callers }).failure, /no Authorization header/);
  // The hash is not a token: presenting what the store holds opens nothing.
  assert.ok(callerOf(`Bearer ${alice.tokenSha256}`, { token: LOCAL, callers }).failure);
  // Without callers the two reasons of the local token are kept.
  assert.match(callerOf('Bearer short', { token: LOCAL }).failure, /token length/);
  assert.match(callerOf(`Bearer ${'b'.repeat(64)}`, { token: LOCAL }).failure, /does not match/);
  assert.equal(tokenHash(alice.token), alice.tokenSha256);
  assert.equal(CALLER_NAME.test('alice.souza-2'), true);
});

test('token add prints the token once and stores only its hash; list never shows either', () => {
  const file = storeFile();
  const added = run(file, 'token', 'add', 'Alice').data;
  assert.equal(added.name, 'alice', 'one person is never two callers by spelling');
  assert.match(added.token, /^[0-9a-f]{64}$/);
  assert.equal(added.replaced, false);
  const stored = readCallers({ file });
  assert.deepEqual(stored.map((c) => c.name), ['alice']);
  assert.equal(stored[0].tokenSha256, tokenHash(added.token));
  assert.equal(fs.readFileSync(file).includes(added.token), false, 'the token itself is not in the store file');
  const listed = run(file, 'token', 'list');
  assert.deepEqual(Object.keys(listed.data[0]).sort(), ['createdAt', 'name']);
  assert.equal(listed.text.includes(stored[0].tokenSha256), false);
});

test('a second add replaces the token, remove ends it, and a bad name is refused', () => {
  const file = storeFile();
  const first = run(file, 'token', 'add', 'alice').data;
  const second = run(file, 'token', 'add', 'alice').data;
  assert.equal(second.replaced, true);
  const callers = readCallers({ file });
  assert.ok(callerOf(`Bearer ${first.token}`, { token: LOCAL, callers }).failure, 'the earlier token no longer works');
  assert.deepEqual(callerOf(`Bearer ${second.token}`, { token: LOCAL, callers }), { caller: 'alice' });
  assert.equal(run(file, 'token', 'remove', 'ALICE').data.removed, true);
  assert.equal(run(file, 'token', 'remove', 'alice').data.removed, false);
  assert.deepEqual(readCallers({ file }), []);
  assert.throws(() => run(file, 'token', 'add', 'local'), /not a caller name/);
  assert.throws(() => run(file, 'token', 'add', 'two words'), /not a caller name/);
  assert.throws(() => run(file, 'token'), /usage: token list/);
  assert.deepEqual(readCallers({ file: path.join(path.dirname(file), 'absent.db') }), [], 'no store: no caller');
});

test('callers are not exported, and import --replace does not drop them', () => {
  const file = storeFile();
  run(file, 'token', 'add', 'alice');
  run(file, 'set', 'client', '001');
  assert.equal(JSON.stringify(run(file, 'export').data).includes('alice'), false);
  const src = path.join(path.dirname(file), 'env.json');
  fs.writeFileSync(src, JSON.stringify({ client: '002' }));
  run(file, 'import', src, '--replace');
  assert.deepEqual(readCallers({ file }).map((c) => c.name), ['alice']);
});

test('a read is written to the trail with the caller of its request, and without one outside a request', async () => {
  resetBudget();
  const lines = [];
  const cfg = { budget: { reads: 1000 }, auditSink: (l) => lines.push(JSON.parse(l)) };
  record(cfg, 'adt_search', 'ZDEMO_A', 10);
  await inCall(async () => {
    record(cfg, 'adt_search', 'ZDEMO_B', 10);
    // A call started inside it (a tool that composes tools) is the same caller s.
    await inCall(async () => record(cfg, 'adt_read_source', 'ZDEMO_C', 10));
    assert.equal(currentCall().caller, 'alice');
  }, { caller: 'alice' });
  assert.deepEqual(lines.map((l) => [l.target, l.caller]), [['ZDEMO_A', undefined], ['ZDEMO_B', 'alice'], ['ZDEMO_C', 'alice']]);
});

test('over the wire: each token reads as its own caller, and an unknown one is refused', async () => {
  resetBudget();
  const lines = [];
  const cfg = { host: 'vhdemohost.example', client: '001', budget: { reads: 1000 }, auditSink: (l) => lines.push(JSON.parse(l)), journalSink: () => {}, paths: {} };
  const api = { searchObject: async () => [] };
  const alice = newCallerToken();
  let port;
  const server = http.createServer(
    createRequestHandler({ tools: buildTools(cfg, { api }), token: LOCAL, port: () => port, callers: [{ name: 'alice', tokenSha256: alice.tokenSha256 }], log: () => {} })
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const search = async (token, query) => {
    const c = new Client({ name: 'callers-test', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    await c.callTool({ name: 'adt_search', arguments: { query } });
    await c.close();
  };
  try {
    await search(alice.token, 'ZDEMO_ALICE*');
    await search(LOCAL, 'ZDEMO_LOCAL*');
    assert.deepEqual(lines.map((l) => [l.target.split(' ')[0], l.caller]), [['ZDEMO_ALICE*', 'alice'], ['ZDEMO_LOCAL*', 'local']]);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${'d'.repeat(64)}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), null, 'still no OAuth advertised');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
