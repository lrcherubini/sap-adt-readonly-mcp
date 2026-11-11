// Go to definition: the request is built from the stored source and a bounded position, and the
// answer never reads as "defined nowhere" when the question was not asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNavigationRequest, navigationPost, parseNavigationTarget, NavigationViolation, NAVIGATION_PATH } from '../lib/navigation.mjs';
import { definitionTool } from '../tools/definition.mjs';
import { resetBudget } from '../lib/audit.mjs';

const URI = '/sap/bc/adt/oo/classes/zcl_demo_probe';

const SOURCE = Array.from({ length: 37 }, (_, i) => (i === 0 ? 'CLASS zcl_demo_probe DEFINITION' : `  " line ${i + 1}`)).join('\n');
const REPLY = '<?xml version="1.0" encoding="utf-8"?><adtcore:objectReference xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo_probe/source/main#start=10,18"/>';

test('the request is the measured form: fixed path, filter=definition, the position in the uri, the source as body', () => {
  const r = buildNavigationRequest({ sourceUri: `${URI}/source/main`, line: 26, column: 10, storedSource: SOURCE });
  assert.equal(
    r.url,
    '/sap/bc/adt/navigation/target?uri=%2Fsap%2Fbc%2Fadt%2Foo%2Fclasses%2Fzcl_demo_probe%2Fsource%2Fmain%23start%3D26%2C10&filter=definition'
  );
  assert.equal(r.body, SOURCE);
  assert.ok(Object.isFrozen(r));
  for (const bad of [
    { sourceUri: `${URI}/source/main`, line: 0, column: 0 },
    { sourceUri: `${URI}/source/main`, line: 38, column: 0 },
    { sourceUri: `${URI}/source/main`, line: 1, column: -1 },
    { sourceUri: `${URI}/source/main`, line: 1.5, column: 0 },
    { sourceUri: '/sap/bc/adt/programs/programs/zdemo/source/main', line: 1, column: 0 },
    { sourceUri: `${URI}/includes/testclasses`, line: 1, column: 0 },
    { sourceUri: `${URI}/source/main#start=1,1`, line: 1, column: 0 },
  ]) {
    assert.throws(() => buildNavigationRequest({ ...bad, storedSource: SOURCE }), NavigationViolation, JSON.stringify(bad));
  }
  assert.throws(() => buildNavigationRequest({ sourceUri: `${URI}/source/main`, line: 1, column: 0, storedSource: '  ' }), NavigationViolation);
});

test('the POST goes out only with a built request, with the measured headers', async () => {
  const sent = [];
  const raw = { httpClient: { request: async (url, opts) => { sent.push({ url, ...opts }); return { status: 200, body: REPLY }; } } };
  await assert.rejects(() => navigationPost(raw, { url: NAVIGATION_PATH, body: 'caller text' }), NavigationViolation);
  const built = buildNavigationRequest({ sourceUri: `${URI}/source/main`, line: 26, column: 10, storedSource: SOURCE });
  await navigationPost(raw, built);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].headers, { Accept: 'application/xml', 'Content-Type': 'text/plain' });
  assert.equal(sent[0].body, SOURCE);
});

test('the target is the reference the server names: source URI, object URI, line and column', () => {
  const one = { uri: `${URI}/source/main#start=10,18`, sourceUri: `${URI}/source/main`, objectUri: URI, line: 10, column: 18 };
  assert.deepEqual(parseNavigationTarget(REPLY), { target: one, targets: [one], drift: [] });
  // Two references are both named: an ambiguity is never resolved in silence.
  const two = REPLY.replace(/(<adtcore:objectReference\s[^>]*\/>)/, '$1$1');
  assert.equal(parseNavigationTarget(two).targets.length, 2);
  assert.equal(parseNavigationTarget('<?xml version="1.0"?>').target, null);
  assert.deepEqual(parseNavigationTarget(REPLY.replace('/>', '><adtcore:extra/></adtcore:objectReference>')).drift, [{ node: 'adtcore:extra' }]);
});

function harness({ reply = REPLY, type = 'CLAS/OC', fail = false } = {}) {
  const seen = [];
  const gaps = [];
  const audit = [];
  const api = {
    searchObject: async () => [{ 'adtcore:name': 'ZCL_DEMO_PROBE', 'adtcore:type': type, 'adtcore:packageName': 'ZDEMO', 'adtcore:uri': URI }],
    getObjectSource: async (uri) => {
      seen.push({ read: uri });
      return SOURCE;
    },
  };
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        seen.push({ url, method: opts.method, body: opts.body });
        if (fail) throw Object.assign(new Error('Service unavailable'), { err: 503 });
        return { status: 200, body: reply };
      },
    },
  };
  const cfg = { budget: { reads: 100 }, auditSink: (l) => audit.push(JSON.parse(l)), journalSink: () => {} };
  resetBudget();
  return { tool: definitionTool(cfg, { api, raw }, { enabled: true, gap: (g) => gaps.push(g) }), seen, gaps, audit };
}

const json = (res) => JSON.parse(res.content[0].text);

test('the tool reads the stored source, sends exactly it, and answers the target', async () => {
  const h = harness();
  const out = json(await h.tool.handler({ objectName: 'ZCL_DEMO_PROBE', line: 26, column: 10 }));
  assert.deepEqual(h.seen[0], { read: `${URI}/source/main` });
  assert.equal(h.seen[1].method, 'POST');
  assert.equal(h.seen[1].body, SOURCE, 'the body is the text the server stores, nothing else');
  assert.equal(out.found, true);
  assert.deepEqual([out.target.line, out.target.column, out.target.sameObject], [10, 18, true]);
  assert.equal(h.audit.length, 2);
  assert.doesNotMatch(JSON.stringify(h.audit), /line 2/, 'no source in the trail');
});

test('no reference is "named none", a failed POST is a gap, and only a class is asked', async () => {
  const none = json(await harness({ reply: '<?xml version="1.0"?>' }).tool.handler({ objectName: 'ZCL_DEMO_PROBE', line: 26, column: 10 }));
  assert.equal(none.found, false);
  assert.match(none.reason, /named none/);

  const failing = harness({ fail: true });
  await assert.rejects(() => failing.tool.handler({ objectName: 'ZCL_DEMO_PROBE', line: 26, column: 10 }), /503/);
  assert.ok(failing.gaps.some((g) => g.code === 'DEFINITION_NOT_READ' && /NOT "defined nowhere"/.test(g.impact)));

  const prog = harness({ type: 'PROG/P' });
  await assert.rejects(() => prog.tool.handler({ objectName: 'ZCL_DEMO_PROBE', line: 1, column: 0 }), NavigationViolation);
  assert.equal(prog.seen.length, 0, 'nothing read, nothing sent');
  await assert.rejects(() => harness().tool.handler({ objectName: 'ZCL_DEMO_PROBE', objectType: 'PROG/P', line: 1, column: 0 }), NavigationViolation);
});

test('the definition answers the contract, and drift is PARSE_FAILED', async () => {
  const { contractErrors } = await import('../lib/completeness.mjs');
  const ok = json(await harness().tool.handler({ objectName: 'ZCL_DEMO_PROBE', line: 26, column: 10 }));
  assert.deepEqual(contractErrors(ok), []);
  assert.equal(ok.complete, true);
  assert.equal(ok.targetCount, 1);
  const drifted = json(await harness({ reply: REPLY.replace('/>', '><adtcore:extra/></adtcore:objectReference>') }).tool.handler({ objectName: 'ZCL_DEMO_PROBE', line: 26, column: 10 }));
  assert.deepEqual(contractErrors(drifted), []);
  assert.deepEqual(drifted.incomplete.map((i) => i.code), ['PARSE_FAILED']);
});
