// lib/system-signature.mjs: every answer says which system and client it was read from, what
// kind of client that is, and the role the installation gives the system.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readClientCategory, signatureOf, signatureLine, withSignature, CLIENT_CATEGORIES } from '../lib/system-signature.mjs';
import { createRequestHandler } from '../lib/mcp-server.mjs';
import { buildTools } from '../tools/index.mjs';
import { contractErrors } from '../lib/completeness.mjs';
import { validateSetting } from '../lib/environment.mjs';

const CFG = { system: 'DEV', client: '001', systemRole: 'DEV', budget: { reads: 1000 }, auditSink: () => {} };

/** A data preview reply of T000 with one row, in the measured column-major shape. */
const t000Reply = (category, sql = "SELECT MANDT, CCCATEGORY FROM T000 WHERE MANDT = '001'") =>
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  '<dataPreview:totalRows>1</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>' +
  `<dataPreview:executedQueryString>${sql.replace(/'/g, '&apos;')} INTO TABLE @DATA(LT_RESULT) UP TO 1 ROWS .</dataPreview:executedQueryString><dataPreview:queryExecutionTime>1</dataPreview:queryExecutionTime>` +
  '<dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT" dataPreview:type="C" dataPreview:description="Client" dataPreview:keyAttribute="true" dataPreview:colType="C" dataPreview:isKeyFigure="false"/>' +
  '<dataPreview:dataSet><dataPreview:data>001</dataPreview:data></dataPreview:dataSet></dataPreview:columns>' +
  '<dataPreview:columns><dataPreview:metadata dataPreview:name="CCCATEGORY" dataPreview:type="C" dataPreview:description="Category" dataPreview:keyAttribute="false" dataPreview:colType="C" dataPreview:isKeyFigure="false"/>' +
  `<dataPreview:dataSet><dataPreview:data>${category}</dataPreview:data></dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>`;

const sessionAnswering = (answer) => {
  const sent = [];
  return {
    sent,
    session: {
      raw: {
        httpClient: {
          request: async (url, opts) => {
            sent.push({ url, ...opts });
            return answer(url, opts);
          },
        },
      },
    },
  };
};

test('the category of the logon client is one data preview on T000, and its meaning is the domain s', async () => {
  const gaps = [];
  const { session, sent } = sessionAnswering(() => ({ status: 200, body: t000Reply('C'), headers: {} }));
  const category = await readClientCategory(CFG, session, { gap: (g) => gaps.push(g) });
  assert.deepEqual(category, { read: true, code: 'C', meaning: 'customizing' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.match(String(sent[0].body), /SELECT MANDT, CCCATEGORY FROM T000 WHERE MANDT = '001'/);
  assert.deepEqual(gaps, []);
  assert.deepEqual(Object.keys(CLIENT_CATEGORIES), ['P', 'T', 'C', 'D', 'E', 'S']);
});

test('a category the read could not give is said, filed, and never a guess', async () => {
  const gaps = [];
  const journal = { gap: (g) => gaps.push(g) };
  const failing = sessionAnswering(() => { throw Object.assign(new Error('no authorization'), { status: 403 }); });
  const refused = await readClientCategory(CFG, failing.session, journal);
  assert.equal(refused.read, false);
  assert.match(refused.reason, /no authorization/);
  assert.equal(gaps[0].code, 'CLIENT_CATEGORY_NOT_READ');
  assert.equal((await readClientCategory(CFG, {}, journal)).read, false, 'no raw client');
  const odd = sessionAnswering(() => ({ status: 200, body: t000Reply('X'), headers: {} }));
  assert.deepEqual(await readClientCategory(CFG, odd.session, journal), { read: true, code: 'X', meaning: 'not a value of domain CCCATEGORY' });
  const other = sessionAnswering(() => ({ status: 200, body: t000Reply('P', 'SELECT * FROM T000'), headers: {} }));
  assert.equal((await readClientCategory(CFG, other.session, journal)).read, false, 'a statement the server rewrote is not this one');
});

test('the signature names system, client, category and role; the line is for a person', () => {
  const sig = signatureOf(CFG, { read: true, code: 'P', meaning: 'production' });
  assert.deepEqual(sig, { sid: 'DEV', client: '001', category: { read: true, code: 'P', meaning: 'production' }, role: 'DEV' });
  assert.equal(signatureLine(sig), 'DEV/001 (P production, DEV)');
  const unread = signatureOf({ system: 'DEV', client: '001' }, null);
  assert.deepEqual(unread.category, { read: false, reason: 'not read at start' });
  assert.equal(unread.role, null);
  assert.equal(signatureLine(unread), 'DEV/001 (category not read)');
  assert.equal(validateSetting('systemRole', 'qas'), 'QAS');
  assert.throws(() => validateSetting('systemRole', 'a role with spaces'), /short label/);
});

test('withSignature stamps the structured content and each JSON text, and leaves a source and an error alone', () => {
  const sig = signatureOf(CFG, { read: true, code: 'C', meaning: 'customizing' });
  const json = withSignature({ content: [{ type: 'text', text: '{"complete":true,"incomplete":[],"n":1}' }], structuredContent: { complete: true, incomplete: [], n: 1 } }, sig);
  assert.deepEqual(json.structuredContent, { system: sig, complete: true, incomplete: [], n: 1 });
  assert.equal(json.content[0].text, JSON.stringify(json.structuredContent));
  const source = withSignature({ content: [{ type: 'text', text: '{ "a source that starts with a brace' }, { type: 'text', text: '{"complete":true,"incomplete":[]}' }], structuredContent: { complete: true, incomplete: [], source: 'x' } }, sig);
  assert.equal(source.content[0].text, '{ "a source that starts with a brace');
  assert.deepEqual(JSON.parse(source.content[1].text).system, sig);
  const error = { content: [{ type: 'text', text: 'Error: no' }], isError: true };
  assert.equal(withSignature(error, sig), error);
  assert.equal(withSignature(json, null), json);
});

let server;
let port;
const TOKEN = 'f'.repeat(64);
before(async () => {
  const api = { searchObject: async () => [] };
  const cfg = { host: 'vhdemohost.example', client: '001', system: 'DEV', budget: { reads: 1000 }, auditSink: () => {}, journalSink: () => {}, paths: {} };
  cfg.systemSignature = signatureOf({ ...cfg, systemRole: 'QAS' }, { read: true, code: 'T', meaning: 'test' });
  server = http.createServer(createRequestHandler({ tools: buildTools(cfg, { api }), token: TOKEN, port: () => port, signature: cfg.systemSignature, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => new Promise((r) => server.close(r)));

test('over the wire: an answer carries the signature in front, and still keeps the completeness contract', async () => {
  const c = new Client({ name: 'signature-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  try {
    const res = await c.callTool({ name: 'adt_search', arguments: { query: 'ZDEMO*' } });
    assert.deepEqual(res.structuredContent.system, { sid: 'DEV', client: '001', category: { read: true, code: 'T', meaning: 'test' }, role: 'QAS' });
    assert.equal(Object.keys(res.structuredContent)[0], 'system', 'first, where it is seen');
    assert.equal(res.content[0].text, JSON.stringify(res.structuredContent));
    assert.deepEqual(contractErrors(res.structuredContent), []);
    const refused = await c.callTool({ name: 'adt_search', arguments: {} });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.structuredContent.system, res.structuredContent.system, 'a refusal names the system like an answer does');
    assert.equal(refused.structuredContent.error.code, 'INVALID_ARGUMENTS');
  } finally {
    await c.close();
  }
});
