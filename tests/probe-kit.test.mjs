import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProbeUrl, probe, args, collections } from '../scripts/probe-kit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'probe-kit-'));

function fakeDeps(root, reply = { status: 200, body: '<ok/>', headers: { 'content-type': 'x' } }) {
  const calls = [];
  const state = { loggedOff: false };
  const http = {
    async request(url, opts) {
      calls.push({ url, opts });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return {
    calls,
    state,
    deps: {
      root,
      config: () => ({ host: 'vhdemohost.example', client: '001', user: 'DEVUSER1' }),
      connectWith: async () => ({ raw: { httpClient: http } }),
      logoff: async () => {
        state.loggedOff = true;
      },
      log: () => {},
    },
  };
}

test('assertProbeUrl admits a relative ADT path', () => {
  assert.equal(assertProbeUrl('/sap/bc/adt/discovery'), '/sap/bc/adt/discovery');
  assert.equal(
    assertProbeUrl('/sap/bc/adt/ddic/tables/zdemo_t?x=a/b'),
    '/sap/bc/adt/ddic/tables/zdemo_t?x=a/b',
  );
});

test('assertProbeUrl refuses everything outside /sap/bc/adt/', () => {
  for (const url of [
    '',
    undefined,
    'https://vhdemohost.example/sap/bc/adt/discovery',
    '//vhdemohost.example/sap/bc/adt/x',
    '/sap/opu/odata/sap/ZDEMO_SRV/$metadata',
    '/sap/bc/adt/../../sap/opu/x',
    '/sap/bc/adt/./x',
    '/sap/bc/adt/%2E%2E/x',
    '/sap/bc/adt/x\\y',
    '/sap/bc/adt/x\r\nX-Header: y',
    '/sap/bc/adt/x y',
  ]) {
    assert.throws(() => assertProbeUrl(url), /probe-kit refuses/, String(url));
  }
});

test('kit.get sends GET with Accept only and saves the reply and the summary', async () => {
  const root = tmpRoot();
  const { calls, state, deps } = fakeDeps(root);
  const { out, summary } = await probe('kit-test', async (kit) => {
    const text = await kit.get('discovery', '/sap/bc/adt/discovery', 'application/xml');
    assert.equal(text, '<ok/>');
  }, deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { method: 'GET', headers: { Accept: 'application/xml' } });
  assert.equal(summary[0].status, 200);
  assert.equal(fs.readFileSync(path.join(out, summary[0].file), 'utf8'), '<ok/>');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')), summary);
  assert.ok(out.startsWith(root));
  assert.equal(state.loggedOff, true);
});

test('a refused URL never reaches the transport, and the session is still closed', async () => {
  const { calls, state, deps } = fakeDeps(tmpRoot());
  await assert.rejects(
    probe('kit-test', (kit) => kit.get('odata', '/sap/opu/odata/x'), deps),
    /probe-kit refuses/,
  );
  assert.equal(calls.length, 0);
  assert.equal(state.loggedOff, true);
});

test('an error reply is recorded in the summary, not swallowed', async () => {
  const err = Object.assign(new Error('Not Found'), { status: 404, body: '<exc/>' });
  const { deps } = fakeDeps(tmpRoot(), err);
  const { out, summary } = await probe('kit-test', async (kit) => {
    assert.equal(await kit.get('missing', '/sap/bc/adt/zdemo'), null);
  }, deps);
  assert.equal(summary[0].status, 404);
  assert.match(summary[0].error, /Not Found/);
  assert.equal(fs.readFileSync(path.join(out, summary[0].file), 'utf8'), '<exc/>');
});

test('the kit has no POST and cannot be extended', async () => {
  const { deps } = fakeDeps(tmpRoot());
  await probe('kit-test', async (kit) => {
    assert.deepEqual(Object.keys(kit).sort(), ['get', 'out', 'save', 'skip']);
    assert.ok(Object.isFrozen(kit));
    kit.save('../escape.txt', 'x');
    assert.ok(fs.existsSync(path.join(kit.out, 'escape.txt')));
  }, deps);
});

test('nothing the server loads imports the probe kit', () => {
  const files = [path.join(ROOT, 'server.mjs')];
  for (const dir of ['lib', 'tools']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.mjs')) files.push(p);
      }
    };
    walk(path.join(ROOT, dir));
  }
  const offenders = files.filter((f) => /probe-kit/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('args and collections keep their shape', () => {
  assert.deepEqual(args(['A', '--out', 'f.txt', '--dry']), { _: ['A'], out: 'f.txt', dry: true });
  const doc =
    '<app:collection href="/sap/bc/adt/demo"><atom:title>Demo</atom:title>' +
    '<app:accept>application/xml</app:accept></app:collection>';
  assert.deepEqual(collections(doc, /demo/i), [
    { href: '/sap/bc/adt/demo', title: 'Demo', accept: ['application/xml'], templates: [] },
  ]);
});
