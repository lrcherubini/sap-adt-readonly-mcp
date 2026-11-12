// The server as an MCP client sees it: a real Streamable HTTP round trip on an ephemeral loopback
// port, the SDK's own Client on the other side, the tools built over a fake ADT session. What the
// specification asks of a server is checked here, not inferred from the code:
//   * initialize: serverInfo with title and version, instructions;
//   * tools/list: title, behaviour annotations, closed input schemas;
//   * tools/call: structuredContent next to the text, a bad call as isError (never a crash);
//   * transport: loopback Host/Origin enforced (DNS rebinding), bearer token required.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildTools } from '../tools/index.mjs';
import { createRequestHandler, hostFailure, SERVER_INFO, INSTRUCTIONS } from '../lib/mcp-server.mjs';
import { progressOf, schemaErrors, closeSchema, withStructuredContent, TOOL_META } from '../lib/tool-meta.mjs';
import { validateSetting, validateEnvironment } from '../lib/environment.mjs';

const TOKEN = 'b'.repeat(64);
const hit = (name, type, pkg, uri) => ({ 'adtcore:name': name, 'adtcore:type': type, 'adtcore:packageName': pkg, 'adtcore:description': `${name} description`, 'adtcore:uri': uri });
const api = {
  searchObject: async () => [hit('ZI_DEMO', 'DDLS/DF', 'ZDEMO', '/sap/bc/adt/ddic/ddl/sources/zi_demo')],
  objectStructure: async () => ({ objectUrl: '/sap/bc/adt/ddic/ddl/sources/zi_demo', metaData: {}, links: [] }),
  getObjectSource: async () => 'define view entity ZI_DEMO as select from t001 {}',
};
const cfg = { host: 'dev.example', client: '001', budget: { reads: 1000 }, auditSink: () => {}, journalSink: () => {}, paths: {} };
const tools = buildTools(cfg, { api }, { enabled: false });

let server;
let port;
before(async () => {
  server = http.createServer(createRequestHandler({ tools, token: TOKEN, port: () => port, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => new Promise((r) => server.close(r)));

async function client() {
  const c = new Client({ name: 'protocol-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  return c;
}

test('initialize: the server names itself with a title and its package version, and gives instructions', async () => {
  const c = await client();
  const info = c.getServerVersion();
  assert.equal(info.name, 'sap-adt');
  assert.equal(info.title, SERVER_INFO.title);
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.equal(c.getInstructions(), INSTRUCTIONS);
  assert.match(c.getInstructions(), /Read-only/);
  await c.close();
});

test('tools/list: every tool has a title, read-only hints and a closed input schema', async () => {
  const c = await client();
  const { tools: listed } = await c.listTools();
  assert.equal(listed.length, tools.length);
  for (const t of listed) {
    assert.ok(t.title, `${t.name} has a title`);
    assert.equal(t.title, TOOL_META[t.name].title);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.annotations.openWorldHint, true, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} refuses unknown arguments`);
  }
  assert.equal(listed.find((t) => t.name === 'adt_atc_run').annotations.idempotentHint, false, 'each run leaves a worklist');
  assert.equal(listed.find((t) => t.name === 'adt_search').annotations.idempotentHint, true);
  await c.close();
});

test('tools/call: the answer comes as structuredContent AND as the same JSON in text', async () => {
  const c = await client();
  const res = await c.callTool({ name: 'adt_search', arguments: { query: 'ZI_DEMO' } });
  assert.equal(res.isError, undefined);
  assert.ok(res.structuredContent, 'structured');
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  await c.close();
});

test('tools/call: a malformed call is an isError result that names the problem, not a protocol failure', async () => {
  const c = await client();
  const unknown = await c.callTool({ name: 'adt_search', arguments: { query: 'X', qurey: 'typo' } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown argument 'qurey'/);
  const missing = await c.callTool({ name: 'adt_search', arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /missing required argument 'query'/);
  await c.close();
});

test('transport: a foreign Host or Origin is refused (DNS rebinding), and so is a missing token', async () => {
  const post = (headers) =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end('{}');
    });
  const auth = { Authorization: `Bearer ${TOKEN}` };
  assert.equal(await post({ ...auth, Origin: 'https://evil.example' }), 403);
  assert.equal(await post({ ...auth, Host: `evil.example:${port}` }), 403);
  assert.equal(await post({ ...auth, Host: '127.0.0.1:1' }), 403, 'another port is another endpoint');
  assert.equal(await post({}), 401);
  assert.equal(await post({ Origin: `http://localhost:${port}` }), 401, 'a loopback origin passes the gate, then needs the token');
});

test('transport: only POST on /mcp reaches the protocol; GET and DELETE are 405, another path is 404', async () => {
  const ask = (method, path, headers = {}) =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, allow: res.headers.allow, body }));
      });
      req.end();
    });
  const auth = { Authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' };
  // Answered and closed: a stream opened here would never end, and this test would not either.
  const get = await ask('GET', '/mcp', auth);
  assert.equal(get.status, 405);
  assert.equal(get.allow, 'POST');
  assert.equal(JSON.parse(get.body).error.message, 'Method not allowed.');
  assert.equal((await ask('DELETE', '/mcp', auth)).status, 405);
  assert.equal((await ask('GET', '/mcp')).status, 401, 'the token is asked before the method is judged');
  assert.equal((await ask('POST', '/mcp-other', auth)).status, 404);
  assert.equal((await ask('POST', '/mcpx', auth)).status, 404, 'a path that merely starts with /mcp is not the endpoint');
  assert.equal((await ask('GET', '/mcp?x=1', auth)).status, 405, 'a query does not change the path');
});

test('hostFailure accepts the loopback names on this port only', () => {
  assert.equal(hostFailure({ host: '127.0.0.1:2237' }, 2237), null);
  assert.equal(hostFailure({ host: 'localhost:2237', origin: 'http://127.0.0.1:5173' }, 2237), null);
  assert.equal(hostFailure({ host: '[::1]:2237' }, 2237), null);
  assert.match(hostFailure({ host: '127.0.0.1' }, 2237), /not this loopback endpoint/);
  assert.match(hostFailure({ host: '127.0.0.1:2237', origin: 'null' }, 2237), /opaque/);
  assert.match(hostFailure({ host: '127.0.0.1:2237', origin: 'not a url' }, 2237), /not a URL/);
});

test('hostFailure answers to the public hosts an installation listed, and to no other name', () => {
  const publicHosts = ['adt.vhdemohost.example', 'adt.vhdemohost.example:8443'];
  assert.equal(hostFailure({ host: 'adt.vhdemohost.example' }, 2237, { publicHosts }), null);
  assert.equal(hostFailure({ host: 'ADT.vhdemohost.example:8443' }, 2237, { publicHosts }), null, 'a host name has no case');
  assert.equal(hostFailure({ host: '127.0.0.1:2237' }, 2237, { publicHosts }), null, 'loopback still answers: the proxy on the same machine');
  assert.match(hostFailure({ host: 'adt.vhdemohost.example:9999' }, 2237, { publicHosts }), /neither this loopback endpoint nor a listed public host/);
  assert.match(hostFailure({ host: 'other.vhdemohost.example' }, 2237, { publicHosts }), /nor a listed public host/);
  // A browser page: only one served under a listed name, or loopback.
  assert.equal(hostFailure({ host: 'adt.vhdemohost.example', origin: 'https://adt.vhdemohost.example' }, 2237, { publicHosts }), null);
  assert.equal(hostFailure({ host: 'adt.vhdemohost.example', origin: 'https://adt.vhdemohost.example:8443' }, 2237, { publicHosts }), null);
  assert.match(hostFailure({ host: 'adt.vhdemohost.example', origin: 'https://evil.example' }, 2237, { publicHosts }), /is not loopback/);
  assert.match(hostFailure({ host: 'adt.vhdemohost.example' }, 2237), /not this loopback endpoint/, 'no list: loopback only, as before');
});

test('the settings: an address to listen on, names to answer to, and never the first without the second', () => {
  assert.equal(validateSetting('bindHost', '0.0.0.0'), '0.0.0.0');
  assert.equal(validateSetting('bindHost', '::1'), '::1');
  assert.throws(() => validateSetting('bindHost', 'localhost'), /not an IP address/);
  assert.deepEqual(validateSetting('publicHosts', 'ADT.vhdemohost.example;adt.vhdemohost.example:8443'), ['adt.vhdemohost.example', 'adt.vhdemohost.example:8443']);
  assert.throws(() => validateSetting('publicHosts', 'https://adt.vhdemohost.example'), /not a host name/);
  assert.throws(() => validateSetting('publicHosts', 'adt.vhdemohost.example:0'), /not a host name/);
  assert.throws(() => validateEnvironment({ settings: { bindHost: '0.0.0.0' } }), /is not loopback: set publicHosts first/);
  assert.doesNotThrow(() => validateEnvironment({ settings: { bindHost: '127.0.0.1' } }));
  assert.doesNotThrow(() => validateEnvironment({ settings: { bindHost: '0.0.0.0', publicHosts: ['adt.vhdemohost.example'] } }));
});

test('the schema check covers type, enum, ranges, items and unknown keys, and never coerces', () => {
  const schema = closeSchema({
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 3 },
      mode: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'string', enum: ['X', 'Y'] }, minItems: 1, maxItems: 2 },
      either: { type: ['string', 'array'] },
      nested: { type: 'object', properties: { k: { type: 'boolean' } } },
    },
    required: ['n'],
  });
  assert.deepEqual(schemaErrors(schema, { n: 2, mode: 'a', list: ['X'], either: 'x', nested: { k: true } }), []);
  const errs = schemaErrors(schema, { n: '2', mode: 'c', list: ['Z', 'X', 'Y'], either: 3, nested: { k: true, extra: 1 }, other: null });
  assert.equal(errs.length, 6);
  assert.match(errs.join('\n'), /argument 'n' must be integer, got string/);
  assert.match(errs.join('\n'), /must be one of a, b/);
  assert.match(errs.join('\n'), /at most 2 item/);
  assert.match(errs.join('\n'), /'list'\[0\] must be one of X, Y/);
  assert.match(errs.join('\n'), /unknown argument 'extra' in argument 'nested'/);
  assert.deepEqual(schemaErrors(schema, { n: 9 }), ["argument 'n' must be <= 3, got 9"]);
  assert.deepEqual(schemaErrors(schema, { n: 1, other: null }), [], 'null is absent, as clients send it');
  // A pattern an input schema advertises is enforced, like every other keyword.
  const versioned = { type: 'object', properties: { v: { type: 'string', pattern: '^(active|[0-9]{5})$' } } };
  assert.deepEqual(schemaErrors(versioned, { v: '00012' }), []);
  assert.deepEqual(schemaErrors(versioned, { v: '12' }), ["argument 'v' must match ^(active|[0-9]{5})$, got '12'"]);
});

test('structuredContent only for one JSON object; text stays text', () => {
  assert.deepEqual(withStructuredContent({ content: [{ type: 'text', text: '{"a":1}' }] }).structuredContent, { a: 1 });
  assert.equal(withStructuredContent({ content: [{ type: 'text', text: 'REPORT z.' }] }).structuredContent, undefined);
  assert.equal(withStructuredContent({ content: [{ type: 'text', text: '{ not json' }] }).structuredContent, undefined);
  assert.equal(withStructuredContent({ content: [{ type: 'text', text: '[1]' }] }).structuredContent, undefined);
});

test('progress is sent only when the client asked for it, and a failed notification never fails the call', async () => {
  const sent = [];
  progressOf({ _meta: { progressToken: 't1' }, sendNotification: async (n) => sent.push(n) })(2, 5, 'reading');
  assert.deepEqual(sent, [{ method: 'notifications/progress', params: { progressToken: 't1', progress: 2, total: 5, message: 'reading' } }]);
  progressOf({ sendNotification: async (n) => sent.push(n) })(1, 1);
  assert.equal(sent.length, 1, 'no token, no notification');
  progressOf({ _meta: { progressToken: 0 }, sendNotification: async () => { throw new Error('gone'); } })(1);
});
