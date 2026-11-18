// The Transport Organizer: the parser, the task rule, and the tool over them.
//
// ⚠️ Not to be confused with tests/transport.test.mjs, which is about the MCP server's own
// HTTP transport and has nothing to do with CTS.
//
// The property these tests hold in place is the user's rule, and it is the whole reason
// this code exists: a task's objects move up into the request only when the task is
// RELEASED, so a reader that stops at the request's own object list under-reports every
// open request -- and, in the measured case rebuilt in
// tests/fixtures/transport-detail-customizing.xml, reports nothing at all about a request
// that holds four objects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTransportDocument,
  unionObjects,
  requestKind,
  statusOf,
  objFuncOf,
  OBJ_FUNC,
  PROJECTION,
} from '../lib/transport-requests.mjs';
import { transportTool } from '../tools/transport.mjs';
import { openJournal } from '../lib/journal.mjs';
import { contractErrors } from '../lib/completeness.mjs';

const fixture = (name) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

const CUSTOMIZING = fixture('transport-detail-customizing.xml');
const WORKBENCH = fixture('transport-detail-workbench.xml');
const LIST = fixture('transport-list.xml');

/** Edit only what is inside tm:all_objects, so the request's own list stays untouched. */
const withinAllObjects = (xml, edit) =>
  xml.replace(
    /(<tm:all_objects>)([\s\S]*?)(<\/tm:all_objects>)/,
    (_, open, inner, close) => open + edit(inner) + close
  );

const only = (xml) => {
  const doc = parseTransportDocument(xml);
  return { doc, request: doc.requests[0], union: unionObjects(doc.requests[0]) };
};

// --- the rule ------------------------------------------------------------------

test("an open task's objects are reported: the request's own list is not the answer", () => {
  const { request, union } = only(CUSTOMIZING);
  assert.equal(request.ownObjects.length, 0, 'the measured case: the own list IS empty');
  assert.equal(request.tasks.length, 1);
  assert.equal(request.tasks[0].status, 'modifiable', 'and the task is not released');
  assert.equal(union.unionCount, 4, 'four objects, none of them in the request itself');
  assert.deepEqual(
    union.objects.map((o) => `${o.type}/${o.name}`),
    ['CDAT/ZDEMO_VC_A', 'TABU/ZDEMO_TAB_C', 'TDAT/ZDEMO_TAB_D', 'VDAT/ZDEMO_V_B']
  );
  // Attribution survives the union: an object that appears ONLY under a task is work
  // that has not been merged into the request yet, and that is half the question.
  for (const o of union.objects) assert.deepEqual(o.sources, ['DEVK900118']);
});

test('the recomputed union matches the tm:all_objects the system itself returned', () => {
  for (const xml of [CUSTOMIZING, WORKBENCH]) {
    const { union } = only(xml);
    assert.equal(union.unionMatchesSystem, true);
    assert.equal(union.unionCount, union.systemUnion);
  }
  // 5 own minus 2 CORR = 3, union with 3 task objects of which 2 are duplicates = 5.
  const { union } = only(WORKBENCH);
  assert.equal(union.ownCount, 5);
  assert.equal(union.taskCount, 3);
  assert.equal(union.unionCount, 5);
});

test('an object in both the request and a task is reported once, naming both', () => {
  const { union } = only(WORKBENCH);
  const clas = union.objects.find((o) => o.type === 'CLAS');
  assert.deepEqual(clas.sources, ['request', 'DEVK900111']);
  const doma = union.objects.find((o) => o.type === 'DOMA');
  assert.deepEqual(doma.sources, ['request'], 'only in the request: nothing to merge');
});

test('CORR release and merge comments are not objects', () => {
  const { request, union } = only(WORKBENCH);
  assert.equal(request.comments.length, 2);
  assert.deepEqual(
    request.comments.map((c) => `${c.pgmid}/${c.type}`),
    ['CORR/RELE', 'CORR/MERG']
  );
  assert.equal(
    union.objects.some((o) => o.pgmid === 'CORR'),
    false,
    "a release comment did not move: the system's own tm:all_objects drops them too"
  );
});

test('the union is not checked against a node the list resource does not send', () => {
  // null, never false. "Not checked" and "checked and disagreed" must not read the same.
  const doc = parseTransportDocument(LIST);
  for (const r of doc.requests) {
    const u = unionObjects(r);
    assert.equal(u.systemUnion, null);
    assert.equal(u.unionMatchesSystem, null);
  }
});

test('a union that disagrees with tm:all_objects is a gap, not a silent choice', async () => {
  // One object removed from tm:all_objects and nowhere else: the shape aged, the answer
  // still stands, and the disagreement has to be visible.
  const drifted = withinAllObjects(WORKBENCH, (inner) =>
    inner.replace(/<tm:abap_object[\s\S]*?\/>/, '')
  );
  const { union } = only(drifted);
  assert.equal(union.systemUnion, 4);
  assert.equal(union.unionCount, 5);
  assert.equal(union.unionMatchesSystem, false);

  const { out, journalLines } = await run({ body: drifted }, { number: 'DEVK900110' });
  const gap = journalLines.find((l) => l.code === 'SHAPE_DRIFT');
  assert.ok(gap, 'the disagreement is filed');
  assert.equal(gap.stream, 'gaps');
  assert.match(gap.detail, /recomputed 5 vs system 4/);
  assert.equal(out.requests[0].counts.union, 5, 'and the answer still carries all five');
});

// --- the attribute traps -------------------------------------------------------

test('tm:type is a code on a request and a text on a task, and they are read differently', () => {
  const { request } = only(WORKBENCH);
  assert.equal(request.kindCode, 'K');
  assert.equal(request.kind, 'workbench');
  assert.deepEqual(
    request.tasks.map((t) => t.taskType),
    ['Development/Correction', 'Repair']
  );
  // The localised text is never fed to the code reader: it is not a code.
  for (const t of request.tasks) assert.equal(requestKind(t.taskType), null);
  assert.equal('kind' in request.tasks[0], false, 'a task has no half of its own');
});

test('W is customizing and K is workbench', () => {
  assert.equal(requestKind('K'), 'workbench');
  assert.equal(requestKind('W'), 'customizing');
  assert.equal(requestKind('T'), 'transport-of-copies');
  assert.equal(requestKind('X'), null, 'a code never measured is not guessed');
  assert.equal(only(CUSTOMIZING).request.kind, 'customizing');
  assert.equal(only(WORKBENCH).request.kind, 'workbench');
});

test('a workbench request carrying a TABU entry is still workbench', () => {
  // The half is a property of the REQUEST and of nothing else. Measured on DEVK900113.
  const { request, union } = only(WORKBENCH);
  assert.equal(request.kind, 'workbench');
  assert.ok(union.objects.some((o) => o.type === 'TABU' && o.objFunc?.code === 'K'));
});

test('a protected transport is neither modifiable nor released', () => {
  // The third status, measured on DEVK900101. The client library's two-bucket
  // {modifiable, released} model has no place for it, which is how it goes unnoticed.
  assert.equal(statusOf('D'), 'modifiable');
  assert.equal(statusOf('R'), 'released');
  assert.equal(statusOf('L'), 'protected');
  assert.equal(statusOf(''), null);
  assert.equal(statusOf('Released'), null, 'the translated text is not a status');
});

test('tm:obj_info describes the object type and never carries a table key', () => {
  // The hypothesis this measurement falsified: admitting the customizing half does not
  // move the "the repository, never the contents of a table" frontier.
  const { union } = only(CUSTOMIZING);
  for (const o of union.objects) {
    assert.ok(o.objInfo, 'every customizing entry describes its type');
    assert.equal(/[=\s]key|\bKEY\b/.test(o.objInfo), false);
  }
  assert.deepEqual(
    union.objects.map((o) => o.type).sort(),
    ['CDAT', 'TABU', 'TDAT', 'VDAT'],
    'tables, views and view clusters -- never a row'
  );
});

// --- the projection ------------------------------------------------------------

test('an attribute the projection does not declare is dropped and reported as drift', () => {
  const grown = CUSTOMIZING.replaceAll('tm:type="CDAT"', 'tm:type="CDAT" tm:brand_new="42"');
  const doc = parseTransportDocument(grown);
  assert.deepEqual(doc.drift, [
    {
      node: 'tm:abap_object',
      attribute: 'tm:brand_new',
      // Where it was FIRST seen, and the counter says it was not a one-off.
      where: 'tm:all_objects of DEVK900117',
      count: 2,
    },
  ]);
  const union = unionObjects(doc.requests[0]);
  assert.equal(
    'tm:brand_new' in union.objects[0],
    false,
    'dropped from the answer, but never from the report'
  );
});

test('an element the projection does not declare is reported, not skipped in silence', () => {
  // ⚠️ The hole this closes. An undeclared ATTRIBUTE was drift from the start; an
  // undeclared ELEMENT was ignored without a word — and `<tm:key>` under tm:abap_object is
  // precisely the shape the E071K key of a customizing entry would take if this resource
  // ever exposed one. "No key is exposed here" now rests on a guard that would fire,
  // rather than on nobody having looked.
  const grown = CUSTOMIZING.replace(
    '</tm:task>',
    '<tm:key tm:tabkey="ZDEMO_ROLE_SAMPLE_001"/></tm:task>'
  );
  const doc = parseTransportDocument(grown);
  const el = doc.drift.find((d) => d.node === 'tm:key');
  assert.ok(el, 'the undeclared element is on the record');
  assert.equal(el.kind, 'undeclared element');
  assert.equal(el.where, 'request DEVK900117');
  // Still not interpreted: this parser does not invent a meaning for what it has not
  // measured. It refuses quietly in the answer and loudly in the report.
  assert.equal(JSON.stringify(doc.requests[0]).includes('ROLE_SAMPLE_001'), false);
});

test('a transport that deletes an object does not read like one that creates it', () => {
  // tm:obj_func is E071-OBJFUNC. Its domain was read on 2026-09-10: six values, German
  // text, no translation on the system. Before that the attribute was passed through as
  // a bare letter and a request that DELETES a domain looked like one that ships it.
  const { union } = only(WORKBENCH);
  const domain = union.objects.find((o) => o.type === 'DOMA');
  assert.deepEqual(domain.objFunc, {
    code: 'D',
    meaning: 'deleted',
    systemText: 'Object was deleted (only possible with deleted objects)',
  });
  const table = union.objects.find((o) => o.type === 'TABU');
  assert.equal(table.objFunc.meaning, 'hasKeyList');
  // The blank case: the document OMITS the attribute (like tm:wbtype), and offline it is
  // the 136/136 entries with no E071K row. It comes back null, not as a guessed 'normal',
  // so the key sweep can tell "the system said nothing" from "the system said blank".
  const clas = union.objects.find((o) => o.type === 'CLAS');
  assert.equal(clas.objFunc, null);
  assert.equal(objFuncOf('').meaning, 'normal', "an explicit blank is the domain's first value");
  assert.equal(OBJ_FUNC.size, 6, 'exactly the six values the domain declares');
});

test('an obj_func the domain does not declare is drift, not a guessed meaning', () => {
  const grown = WORKBENCH.replace('tm:obj_func="D"', 'tm:obj_func="Q"');
  const doc = parseTransportDocument(grown);
  const obj = unionObjects(doc.requests[0]).objects.find((o) => o.objFunc?.code === 'Q');
  assert.deepEqual(obj.objFunc, { code: 'Q', meaning: null, systemText: null });
  const d = doc.drift.find((x) => x.kind === 'undeclared value');
  assert.ok(d, 'the unknown code is on the record');
  assert.equal(d.attribute, 'tm:obj_func');
  assert.equal(d.value, 'Q');
  assert.equal(d.count, 1, 'one entry was changed; the other D stays declared');
});

test('the bulk the projection drops on purpose never reaches the answer', () => {
  // atom:link (3 per object, up to 195 in one document), tm:attributes (97 SAPCOMPONENT
  // rows per released request) and tm:dummy_uri. All three are in the fixtures.
  assert.match(WORKBENCH, /SAPCOMPONENT/);
  assert.match(WORKBENCH, /tm:dummy_uri/);
  assert.match(WORKBENCH, /atom:link/);
  const json = JSON.stringify(only(WORKBENCH));
  for (const gone of ['SAPCOMPONENT', 'dummy_uri', 'atom:link', 'img_activity']) {
    assert.equal(json.includes(gone), false, `${gone} is carried nowhere`);
  }
});

test('the detail resource carries two attributes the list does not, and it is declared', () => {
  assert.deepEqual(PROJECTION.requestDetailOnly, ['tm:status_text', 'tm:source_client']);
  assert.equal(only(WORKBENCH).request.statusText, 'Released');
  assert.equal(only(WORKBENCH).request.sourceClient, '001');
  const list = parseTransportDocument(LIST);
  assert.equal(list.drift.length, 0, 'their absence in a list answer is expected, not drift');
  assert.equal('statusText' in list.requests[0], false);
});

// --- the list ------------------------------------------------------------------

test('the list answer declares its own scope: released, two weeks, and other people', () => {
  const doc = parseTransportDocument(LIST);
  assert.equal(doc.resource, 'list');
  assert.equal(doc.requests.length, 3);
  // Quoted from the payload, not reworded: it is the only statement of the window.
  assert.deepEqual(doc.listScope.serverStated, ['Released (From Last 2 Weeks)']);
  assert.deepEqual(doc.listScope.buckets, ['customizing', 'workbench']);
  assert.equal(doc.listScope.openRequestsIncluded, false);
  // ⚠️ Three people, and only two of them own a request: DEVUSER3 owns a TASK inside someone
  // else's. Measured live on 2026-09-09, where a scope built from request owners alone
  // named two of the three -- an under-declaration that reads as a complete one.
  assert.deepEqual(doc.listScope.owners, ['DEVUSER1', 'DEVUSER2', 'DEVUSER3']);
  assert.equal(
    doc.requests.some((r) => r.owner === 'DEVUSER3'),
    false,
    'DEVUSER3 owns no request here, and is named anyway'
  );
  assert.deepEqual(
    doc.requests.map((r) => r.bucket),
    ['workbench', 'workbench', 'customizing']
  );
});

test('a genuinely empty request is reported empty, and a self-closed task still counts', () => {
  // Two different zeroes that must not collapse into one. DEVK900117 has an empty own
  // list and four objects; this one has an empty own list and no objects anywhere -- and
  // its only task comes back SELF-CLOSED, which an opening-tag-only reader drops whole,
  // losing the task, its owner and the fact that the emptiness was checked.
  const doc = parseTransportDocument(LIST);
  const empty = doc.requests.find((r) => r.number === 'DEVK900102');
  assert.equal(unionObjects(empty).unionCount, 0);
  assert.equal(empty.tasks.length, 1, 'the self-closed task is not dropped');
  assert.equal(empty.tasks[0].number, 'DEVK900103');
  assert.equal(empty.tasks[0].owner, 'DEVUSER3');
  assert.equal(empty.tasks[0].objects.length, 0);
  // And it did not swallow the request that follows it.
  assert.equal(doc.requests.length, 3);
});

test('an empty answer is empty, and it is not mistaken for a list', () => {
  // The 297-byte reply the collection gives to any query string. It must not read as
  // "this developer has no transports".
  const doc = parseTransportDocument('<tm:root adtcore:name="DEVUSER1"/>');
  assert.equal(doc.resource, 'empty');
  assert.deepEqual(doc.requests, []);
  assert.equal(doc.listScope, null);
});

// --- the tool ------------------------------------------------------------------

function toolWith(reply = {}, log = [], journalLines = []) {
  const cfg = {
    budget: { reads: 100 },
    auditSink: (line) => log.push(JSON.parse(line)),
    journalSink: (stream, record) => journalLines.push({ stream, ...record }),
  };
  const seen = [];
  const session = {
    raw: {
      httpClient: {
        request: async (url, config) => {
          seen.push({ url, config });
          return {
            status: 200,
            body: LIST,
            headers: { 'content-type': 'application/xml' },
            ...reply,
          };
        },
      },
    },
  };
  return { tool: transportTool(cfg, session, openJournal(cfg)), log, journalLines, seen };
}

async function run(reply, args) {
  const h = toolWith(reply);
  const res = await h.tool.handler(args);
  return { ...h, out: JSON.parse(res.content[0].text) };
}

test('the three modes are mutually exclusive, and none of them is a default', async () => {
  const { tool } = toolWith();
  await assert.rejects(() => tool.handler({}), /no default mode/);
  await assert.rejects(
    () => tool.handler({ number: 'DEVK900117', recent: true }),
    /never two/
  );
  await assert.rejects(
    () => tool.handler({ recent: true, object: { name: 'ZCL_DEMO' } }),
    /never two/
  );
  await assert.rejects(
    () => tool.handler({ object: { name: 'ZCL_DEMO' }, keys: true }),
    /carries no keys/
  );
  await assert.rejects(() => tool.handler({ number: 'nope' }), /not a transport request number/);
});

test('the detail mode answers with the union and the per-task attribution', async () => {
  const { out, seen } = await run({ body: CUSTOMIZING }, { number: 'DEVK900117' });
  assert.equal(seen[0].url, '/sap/bc/adt/cts/transportrequests/DEVK900117');
  assert.equal(out.mode, 'detail');
  assert.equal(out.requests[0].counts.own, 0);
  assert.equal(out.requests[0].objects.length, 4);
  assert.equal(out.requests[0].tasks[0].objectCount, 4);
  assert.equal(out.requests[0].tasks[0].taskTypeText, 'Customizing Task');
  assert.equal(out.rule, undefined, "the fixed reading of the answer is the tool's description and docs/tools.md, not a field of every answer");
  assert.equal(out.scope, undefined, 'a request you named has no scope to declare');
});

test('the list mode carries its scope as data, not as a footnote', async () => {
  const { out, seen } = await run({ body: LIST }, { recent: true });
  assert.equal(seen[0].url, '/sap/bc/adt/cts/transportrequests');
  assert.equal(out.mode, 'recent');
  assert.equal(out.scope.releasedOnly, true);
  assert.equal(out.scope.window, 'last 2 weeks');
  assert.equal(out.scope.includesOthers, true);
  assert.deepEqual(out.scope.serverStated, ['Released (From Last 2 Weeks)']);
  assert.deepEqual(out.scope.owners, ['DEVUSER1', 'DEVUSER2', 'DEVUSER3']);
  assert.equal(out.scope.note, undefined, 'the fixed reading of the scope is docs/tools.md, not a field of every answer');
});

test('a truncated answer says how much it dropped', async () => {
  // The cut is LOCAL: this route has no paging and no date filter, so all 270 138 bytes
  // arrive whatever the caps say. Saying so is the difference between a cap and a filter.
  const { out } = await run({ body: LIST }, { recent: true, maxRequests: 2 });
  assert.equal(out.requests.length, 2);
  assert.deepEqual([out.requestsPage.total, out.requestsPage.next.offset], [3, 2]);
  assert.equal(out.requestsPage.truncated, undefined, 'the cut is said in incomplete');
  assert.deepEqual(contractErrors(out), []);
  const second = await run({ body: LIST }, { recent: true, maxRequests: 2, offset: 2 });
  assert.deepEqual([...out.requests, ...second.out.requests].map((r) => r.number), (await run({ body: LIST }, { recent: true })).out.requests.map((r) => r.number), 'two pages are the list once');
  const capped = await run({ body: WORKBENCH }, { number: 'DEVK900110', maxObjectsPerRequest: 2 });
  assert.equal(capped.out.requests[0].objects.length, 2);
  assert.deepEqual([capped.out.requests[0].objectsPage.total, capped.out.requests[0].objectsPage.next.objectsOffset], [5, 2]);
  assert.equal(capped.out.requests[0].counts.union, 5, 'the count is of what exists');
  assert.deepEqual(contractErrors(capped.out), []);
  const rest = await run({ body: WORKBENCH }, { number: 'DEVK900110', maxObjectsPerRequest: 2, objectsOffset: 2 });
  assert.equal(rest.out.requests[0].objects.length, 2);
  // Always present, so "no truncation" is stated rather than inferred from an absence.
  const whole = await run({ body: LIST }, { recent: true });
  assert.equal(whole.out.requestsPage.next, undefined);
});

test('the answer carries the description and the owner, and the audit line carries neither', async () => {
  const { out, log } = await run({ body: CUSTOMIZING }, { number: 'DEVK900117' });
  // `desc` is the only human statement of WHY those objects moved together.
  assert.equal(out.requests[0].desc, 'Sample customizing');
  assert.equal(out.requests[0].owner, 'DEVUSER1');
  assert.equal(log.length, 1, 'one ADT call');
  assert.equal(log[0].target, 'DEVK900117');
  const line = JSON.stringify(log[0]);
  assert.equal(line.includes('Parametrizacao'), false, 'no free text in the evidence trail');
  assert.equal(line.includes('ZDEMO_VC_A'), false);
});

test('neither the description nor the owner of a transport reaches the journal', () => {
  // The journal is ANALYSIS and it is editable; the audit log is EVIDENCE. Neither is a
  // place for what a developer typed into tm:desc, and the drift report is the one line
  // of this tool that could carry payload text if it were built carelessly.
  const drifted = withinAllObjects(CUSTOMIZING, (inner) =>
    inner.replace(/<tm:abap_object[\s\S]*?\/>/, '')
  );
  return run({ body: drifted }, { number: 'DEVK900117' }).then(({ journalLines }) => {
    const text = JSON.stringify(journalLines);
    assert.ok(journalLines.some((l) => l.code === 'SHAPE_DRIFT'));
    for (const secret of ['Sample customizing', 'DEVUSER1', 'ZDEMO_VC_A']) {
      assert.equal(text.includes(secret), false, `${secret} must not reach the journal`);
    }
  });
});

test('an ADT failure is a gap, and it never reads as "the request is empty"', async () => {
  const journalLines = [];
  const cfg = {
    budget: { reads: 100 },
    auditSink: () => {},
    journalSink: (stream, record) => journalLines.push({ stream, ...record }),
  };
  const session = {
    raw: {
      httpClient: {
        request: async () => {
          throw Object.assign(new Error('nope'), { status: 500, url: '/x' });
        },
      },
    },
  };
  const failing = transportTool(cfg, session, openJournal(cfg));
  await assert.rejects(() => failing.handler({ number: 'DEVK900117' }));
  const gap = journalLines.find((l) => l.code === 'ADT_ERROR');
  assert.ok(gap);
  assert.match(gap.impact, /NOT evidence that the request is empty/);
});

// --- which ROWS moved, not only which objects ---------------------------------

const OBJECTKEYS = fixture('objectkeys-customizing.xml');

/** A harness that answers by URL, because the whole point here is WHICH url was asked. */
function keysToolWith(answers) {
  const seen = [];
  const log = [];
  const cfg = {
    budget: { reads: 500 },
    auditSink: (line) => log.push(JSON.parse(line)),
    journalSink: () => {},
  };
  const session = {
    raw: {
      httpClient: {
        request: async (url) => {
          seen.push(url);
          const answer = answers(url);
          // ⚠️ The library THROWS on 4xx and carries the status in `err`, measured
          // 2026-09-09. The stub has to lie the same way the real one does.
          if (typeof answer === 'number') {
            const e = new Error('I::000');
            e.err = answer;
            throw e;
          }
          return { status: 200, body: answer, headers: { 'content-type': 'application/xml' } };
        },
      },
    },
  };
  return { tool: transportTool(cfg, session, openJournal(cfg)), seen, log };
}

test('table keys are refused for the list: 672 objects is not a question anyone asked', async () => {
  const { tool } = toolWith();
  await assert.rejects(() => tool.handler({ recent: true, keys: true }), /ask by `number`/);
});

test('the key sweep addresses the TASK that carries the object, not the request', async () => {
  // ⚠️ The measurement this test exists for: (task DEVK900116, TABU MASSFLDLST) answered
  // 200 while the parent request answered 400 for the same object. DEVK900117 is the
  // matching fixture -- four objects, all of them only in task DEVK900118.
  const { tool, seen } = keysToolWith((url) =>
    url.includes('/objectkeys') ? OBJECTKEYS : CUSTOMIZING
  );
  const out = JSON.parse((await tool.handler({ number: 'DEVK900117', keys: true })).content[0].text);

  assert.equal(out.keys.lookups, 4);
  for (const url of seen.slice(1)) {
    assert.match(url, /^\/sap\/bc\/adt\/cts\/transportrequests\/DEVK900118\/objectkeys\?/);
  }
  assert.match(seen[1], /objName=ZDEMO_VC_A&objType=CDAT/);

  const first = out.requests[0].keys[0];
  assert.equal(first.carrier, 'DEVK900118');
  assert.equal(first.status, 200);
  assert.equal(first.counts.transported, 4);
  assert.equal(
    first.keys[0].decoded,
    'TBZ3R: CLIENT=001 OBJAP=BUPA TABNM=GS_KNA1 FLDNM=ZZ1_DEMODELIVERY_CUS FLDGR=0600'
  );
  assert.equal(first.keys[1].view, 'V_TBZ3R');
});

test('a 400 is reported as unresolved, never as "this object has no keys"', async () => {
  const { tool } = keysToolWith((url) => (url.includes('/objectkeys') ? 400 : CUSTOMIZING));
  const out = JSON.parse((await tool.handler({ number: 'DEVK900117', keys: true })).content[0].text);
  for (const o of out.requests[0].keys) {
    assert.equal(o.status, 400);
    assert.equal(o.keys, null);
    assert.match(o.note, /NOT evidence that the object carries none/);
    assert.deepEqual(o.carriersTried, ['DEVK900118']);
  }
});

test('the sweep stops at its budget and counts the objects it never asked about', async () => {
  const { tool, seen } = keysToolWith((url) =>
    url.includes('/objectkeys') ? OBJECTKEYS : CUSTOMIZING
  );
  const out = JSON.parse(
    (await tool.handler({ number: 'DEVK900117', keys: true, maxKeyLookups: 2 })).content[0].text
  );
  assert.equal(out.keys.lookups, 2);
  assert.equal(out.keys.budget, 2);
  // Not asked is not the same as answered empty, and the answer says which it is.
  assert.equal(out.keys.objectsNotAsked, 2);
  assert.equal(out.requests[0].keys.length, 2);
  assert.equal(seen.filter((u) => u.includes('/objectkeys')).length, 2);
});

test('the audit trail counts the key lookups and carries no key value', async () => {
  const { tool, log } = keysToolWith((url) =>
    url.includes('/objectkeys') ? OBJECTKEYS : CUSTOMIZING
  );
  await tool.handler({ number: 'DEVK900117', keys: true });
  // One line per ADT call, so the read budget counts what the sweep actually spent.
  const lines = log.filter((l) => String(l.target ?? '').includes('objectkeys'));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].target, 'DEVK900118 objectkeys CDAT ZDEMO_VC_A');
  const text = JSON.stringify(log);
  assert.doesNotMatch(text, /ZZ1_DEMODELIVERY_CUS/, 'no decoded key value reaches the trail');
  assert.doesNotMatch(text, /BUPA/);
});

// --- object mode on a class enhancement (2026-09-14) ---------------------------

test('adt_transport object on an ENHO/XH reads nothing: the structure resource dumps the server, and the answer says whose history to ask instead', async () => {
  const log = [];
  const journalLines = [];
  const cfg = { budget: { reads: 100 }, auditSink: (line) => log.push(JSON.parse(line)), journalSink: (stream, record) => journalLines.push({ stream, ...record }) };
  let structureAsked = 0;
  const session = {
    api: {
      searchObject: async () => [{ 'adtcore:name': 'ZDEMO_CLASENH', 'adtcore:type': 'ENHO/XH', 'adtcore:packageName': 'ZDEMO_PKG', 'adtcore:uri': '/sap/bc/adt/enhancements/enhoxh/zdemo_clasenh' }],
      objectStructure: async () => { structureAsked++; throw new Error('dumps'); },
    },
    raw: { httpClient: { request: async () => { throw new Error('no read expected'); } } },
  };
  const tool = transportTool(cfg, session, openJournal(cfg));
  const out = JSON.parse((await tool.handler({ object: { name: 'ZDEMO_CLASENH' } })).content[0].text);
  assert.equal(structureAsked, 0);
  assert.equal(out.mode, 'object');
  assert.equal(out.clasenh, true);
  assert.deepEqual(out.transports, []);
  assert.deepEqual(out.feedsRead, []);
  assert.match(out.rule, /nothing was read and no history is claimed/);
  assert.match(out.rule, /object that USES the added methods/);
  assert.equal(journalLines.find((l) => l.code === 'CLASENH_NOT_IN_ADT').subject, 'ZDEMO_CLASENH');
  assert.ok(!journalLines.some((l) => l.code === 'NO_VERSION_FEED'));
  // The open requests are still asked (one GET), and the answer is not complete.
  assert.ok('openRequests' in out);
  assert.equal(out.complete, false);
  assert.deepEqual(contractErrors(out), []);
  assert.ok(out.incomplete.some((i) => i.list === 'transports' && i.code === 'NOT_READ'));
});
