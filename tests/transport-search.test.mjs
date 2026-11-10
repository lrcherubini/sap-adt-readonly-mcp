// The saved search of the IDE's Transport Organizer: read, never created, and answered with
// requests and tasks only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfigurations, parseConfiguration } from '../lib/transport-search.mjs';
import { transportTool } from '../tools/transport.mjs';
import { openJournal } from '../lib/journal.mjs';
import { buildUrl, RouteViolation } from '../lib/adt-get.mjs';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'transport-search', name), 'utf8');
const CONFIGURATIONS = fixture('configurations.xml');
const CONFIGURATION = fixture('configuration.xml');
const LIST = fixture('list-by-configuration.xml');
const ID = '0050569700001EDFBA9B000000000001';
const HREF = `/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/${ID}`;
const NONE = '<?xml version="1.0" encoding="utf-8"?><configurations:configurations xmlns:configurations="http://www.sap.com/adt/configurations"/>';

test('the configuration list gives the id and href of each saved search', () => {
  assert.deepEqual(parseConfigurations(CONFIGURATIONS), [{ id: ID, href: HREF }]);
  assert.deepEqual(parseConfigurations(NONE), []);
  assert.deepEqual(parseConfigurations('<atom:link href="/sap/bc/adt/somewhere/else"/>'), [], 'a foreign link is not a configuration');
});

test('a configuration answers its properties, empty ones as empty strings', () => {
  const p = parseConfiguration(CONFIGURATION);
  assert.equal(p.User, 'DEVUSER1');
  assert.equal(p.Modifiable, 'true');
  assert.equal(p.Released, 'true');
  assert.equal(p.FromDate, '');
  assert.equal(Object.keys(p).length, 10);
});

test('the list route takes only a configuration the server named', () => {
  assert.equal(
    buildUrl('transportListByConfiguration', { configUri: HREF }),
    `/sap/bc/adt/cts/transportrequests?targets=true&configUri=${encodeURIComponent(HREF)}`
  );
  for (const configUri of ['/sap/bc/adt/cts/transportrequests', `${HREF}/x`, '/sap/bc/adt/oo/classes/zcl_demo']) {
    assert.throws(() => buildUrl('transportListByConfiguration', { configUri }), RouteViolation, configUri);
  }
  assert.throws(() => buildUrl('transportListByConfiguration', { configUri: HREF, user: 'DEVUSER2' }), RouteViolation);
  assert.throws(() => buildUrl('transportSearchConfiguration', { id: '../configurations' }), RouteViolation);
});

function toolWith(replies) {
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
          seen.push({ url, method: config.method, accept: config.headers.Accept });
          const key = url.includes('configUri=') ? 'list' : url.endsWith(ID) ? 'configuration' : 'configurations';
          const body = replies[key];
          if (body instanceof Error) throw body;
          return { status: 200, body, headers: { 'content-type': 'application/xml' } };
        },
      },
    },
  };
  return { tool: transportTool(cfg, session, openJournal(cfg)), audit, journalLines, seen };
}

const outOf = async (h, args) => JSON.parse((await h.tool.handler(args)).content[0].text);

test('saved: true reads the saved configuration and the list it drives, requests and tasks only', async () => {
  const h = toolWith({ configurations: CONFIGURATIONS, configuration: CONFIGURATION, list: LIST });
  const out = await outOf(h, { saved: true });
  assert.deepEqual(h.seen.map((s) => s.method), ['GET', 'GET', 'GET']);
  assert.equal(h.seen[2].accept, 'application/vnd.sap.adt.transportorganizertree.v1+xml');
  assert.equal(out.mode, 'saved');
  assert.equal(out.read, true);
  assert.equal(out.configuration.properties.User, 'DEVUSER1');
  assert.deepEqual(out.requests.map((r) => [r.number, r.status, r.objectCount]), [
    ['DEVK900130', 'modifiable', 2],
    ['DEVK900120', 'released', 1],
    ['DEVK900140', 'modifiable', 0],
  ]);
  assert.equal(out.requests[0].tasks[0].objectCount, 2);
  assert.doesNotMatch(JSON.stringify(out.requests), /ZCL_DEMO|ZDEMO_REPORT/, 'objects are counted, never listed');
  assert.deepEqual(out.scope.serverStated, ['Modifiable', 'Released (From Last 2 Weeks)']);
  assert.equal(h.audit.length, 3);
  assert.doesNotMatch(JSON.stringify(h.audit), /demo methods|demo change/);
  assert.equal(h.journalLines.length, 0, 'the measured shape drifts nowhere');
});

test('without a saved configuration nothing is read or created, and the gap says so', async () => {
  const h = toolWith({ configurations: NONE });
  const out = await outOf(h, { saved: true });
  assert.equal(h.seen.length, 1);
  assert.equal(out.read, false);
  assert.match(out.reason, /none is created/);
  assert.ok(h.journalLines.some((l) => l.code === 'SAVED_SEARCH_NOT_FOUND'));
});

test('a failed read of the list is a gap and an error, never "no requests"', async () => {
  const h = toolWith({ configurations: CONFIGURATIONS, configuration: CONFIGURATION, list: Object.assign(new Error('Service unavailable'), { err: 503 }) });
  await assert.rejects(() => h.tool.handler({ saved: true }), /503/);
  assert.ok(h.journalLines.some((l) => l.code === 'ADT_ERROR' && /saved search \(list\)/.test(l.subject)));
});

test('saved is one mode among four, and takes neither keys nor logs', async () => {
  const { tool } = toolWith({});
  await assert.rejects(() => tool.handler({ saved: true, recent: true }), /never two/);
  await assert.rejects(() => tool.handler({ saved: true, number: 'DEVK900120' }), /never two/);
  await assert.rejects(() => tool.handler({ saved: true, logs: true }), /only for a request you name/);
  await assert.rejects(() => tool.handler({ saved: true, keys: true }), /only for a request you name/);
  await assert.rejects(() => tool.handler({}), /saved: true/);
});
