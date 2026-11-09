// What a transport carries INSIDE a customizing entry: the E071K key rows, decoded.
//
// Every number in this file comes from the sweep of 2026-09-09 recorded in
// docs/adt-api-reference.md, and the fixtures are rebuilt from those facts rather than
// pasted -- the key values are recomputed from the declared lengths, which is the same
// arithmetic the decoder under test performs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseObjectKeys,
  decodeKey,
  describeKey,
  collectObjectKeys,
  carriersOf,
  PROJECTION,
  TYPES_MEASURED_WITHOUT_KEYS,
  keyDecision,
} from '../lib/object-keys.mjs';
import { objFuncOf } from '../lib/transport-requests.mjs';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const CUSTOMIZING = fixture('objectkeys-customizing.xml');
const TEMPLATE = fixture('objectkeys-template.xml');

test('a transported key decomposes into the fields its table declares', () => {
  const doc = parseObjectKeys(CUSTOMIZING);
  assert.deepEqual(doc.object, {
    name: 'BUPAFLDMOD',
    type: 'CDAT',
    pgmid: 'R3TR',
    desc: 'Customizing de campos do Business Partner',
  });
  assert.deepEqual(doc.counts, { keys: 4, transported: 4, template: 0, tables: 3 });

  const first = doc.keys[0];
  assert.equal(first.table, 'TBZ3R');
  assert.equal(first.transported, true);
  assert.equal(first.position, 1);
  assert.equal(
    describeKey(first),
    'TBZ3R: CLIENT=001 OBJAP=BUPA TABNM=GS_KNA1 FLDNM=ZZ1_DEMODELIVERY_CUS FLDGR=0600'
  );
  // Nothing is left over: the declared layout covers the whole packed key. Measured over
  // 164 keys and 508 key fields -- 0 decode failures, 0 non-blank leftovers.
  assert.equal(first.undecoded, '');
  assert.deepEqual(doc.drift, []);
});

test('a key TEMPLATE is not a transported row, and only tk:position separates them', () => {
  // ⚠️ The measurement that makes this the load-bearing test: an ACGR role answers 200
  // with 28 of these, and E071K contains ZERO ACGR rows. Reading them as transported keys
  // would invent 28 rows per role -- an answer that is confident and false.
  const doc = parseObjectKeys(TEMPLATE);
  assert.deepEqual(doc.counts, { keys: 2, transported: 0, template: 2, tables: 2 });
  for (const k of doc.keys) {
    assert.equal(k.transported, false);
    assert.equal(k.position, null);
  }
  assert.equal(doc.isReadOnly, true);
});

test('the wildcard says the key is generic, and says nothing about transport', () => {
  // Falsified on 2026-09-09 and worth a test so it cannot come back: an earlier draft of
  // the dossier claimed `*` marked a template. Measured: 23 POSITIONED keys contain `*`
  // -- the seven UST12 rows carry FIELD="*" and they are in the exported table -- and 6
  // template keys do not.
  const layout = [
    { name: 'MANDT', type: 'C', length: 3, offset: 0 },
    { name: 'OBJCT', type: 'C', length: 10, offset: 3 },
    { name: 'FIELD', type: 'C', length: 10, offset: 13 },
  ];
  const out = decodeKey('001ZDEMO_AUTH*         ', layout);
  assert.deepEqual(
    out.fields.map((f) => [f.name, f.value, f.generic]),
    [
      ['MANDT', '001', false],
      ['OBJCT', 'ZDEMO_AUTH', false],
      ['FIELD', '*', true],
    ]
  );
  assert.deepEqual(out.warnings, []);
});

test('a non-character key field is reported, never sliced', () => {
  // Measured: exactly two non-character key fields exist in the whole population, and no
  // transported key belongs to either table. So this path is unreachable TODAY -- which
  // is precisely why it is asserted. A character offset does not address an integer, and
  // a wrong slice on one leaves no leftover behind to reveal itself.
  const doc = parseObjectKeys(TEMPLATE);
  const bor = doc.keys.find((k) => k.table === 'AGR_HIER_BOR');
  const unique = bor.fields.at(-1);
  assert.equal(unique.name, 'UNIQUE_NR');
  assert.equal(unique.type, 'I');
  assert.equal(unique.decoded, false);
  assert.equal(unique.value, null, 'no value is claimed for a field the offset does not address');
  assert.equal(typeof unique.raw, 'string', 'the raw span is still shown');
  assert.match(describeKey(bor), /UNIQUE_NR=\?$/);
  assert.equal(
    doc.drift.filter((d) => d.kind === 'non-character key field, not decoded').length,
    1
  );
});

test('a table with no key fields is an empty layout, not an absent table', () => {
  // Self-closed <tk:table/>. The same shape once cost a whole tm:task in this repository,
  // so it gets its own assertion here rather than a comment.
  const doc = parseObjectKeys(CUSTOMIZING);
  const empty = doc.tables.find((t) => t.name === 'TBZ3S');
  assert.ok(empty, 'the table is present');
  assert.deepEqual(empty.fields, []);
  // And a key on such a table is honest about it instead of silently decoding to nothing.
  const orphan = parseObjectKeys(
    CUSTOMIZING.replace('tk:tableName="TBZ1C"', 'tk:tableName="TBZ3S"')
  );
  const k = orphan.keys.find((x) => x.table === 'TBZ3S');
  assert.equal(k.layoutKnown, false);
  assert.deepEqual(k.fields, []);
  assert.match(describeKey(k), /layout unknown/);
});

test('the view a key was maintained through is carried, and it is optional', () => {
  // tk:viewName is E071K-VIEWNAME, measured on 13 of 164 keys. Required-by-accident would
  // drop every key that was maintained on the table directly.
  const doc = parseObjectKeys(CUSTOMIZING);
  assert.equal(doc.keys[1].view, 'V_TBZ3R');
  assert.equal(doc.keys[0].view, null);
});

test('MASSFLDLST has no client field: the declared layout is the authority', () => {
  // A decoder that assumed a leading MANDT would pass every other measured table and be
  // wrong by three characters on this one, silently.
  const out = decodeKey('KNA1      KNA1                          ZZ1_DEMODELIVERY_CUS', [
    { name: 'OBJECT', type: 'C', length: 10, offset: 0 },
    { name: 'TABNAME', type: 'C', length: 30, offset: 10 },
    { name: 'FIELDNAME', type: 'C', length: 30, offset: 40 },
  ]);
  assert.deepEqual(
    out.fields.map((f) => f.value),
    ['KNA1', 'KNA1', 'ZZ1_DEMODELIVERY_CUS']
  );
});

test('an attribute the measured projection does not declare is dropped and reported', () => {
  const doc = parseObjectKeys(
    CUSTOMIZING.replace('tk:position="000001"', 'tk:position="000001" tk:newThing="42"')
  );
  assert.deepEqual(doc.drift, [
    { node: 'tk:tableKey', attribute: 'tk:newThing', kind: 'undeclared attribute' },
  ]);
  // The answer still stands -- the MEASUREMENT is what aged.
  assert.equal(doc.counts.transported, 4);
});

test('an element the measured vocabulary does not contain is reported too', () => {
  // Seven elements were censused with no allowlist over 21 replies. An eighth is news.
  const doc = parseObjectKeys(CUSTOMIZING.replace('<tk:tables>', '<tk:checkruns/><tk:tables>'));
  assert.deepEqual(doc.drift, [
    { node: 'tk:checkruns', attribute: null, kind: 'undeclared element' },
  ]);
});

test('a key longer than its declared layout leaves a leftover that is visible', () => {
  const out = decodeKey('001SOMETHING_EXTRA', [{ name: 'MANDT', type: 'C', length: 3, offset: 0 }]);
  assert.equal(out.leftover, 'SOMETHING_EXTRA');
  assert.deepEqual(out.warnings, [
    { kind: 'key value longer than its declared layout', field: null },
  ]);
});

test('offsets are re-derived, not trusted: a non-cumulative layout is a gap', () => {
  const out = decodeKey('100XY', [
    { name: 'MANDT', type: 'C', length: 3, offset: 0 },
    { name: 'SHIFTED', type: 'C', length: 2, offset: 7 },
  ]);
  assert.deepEqual(
    out.warnings.map((w) => w.kind),
    ['declared offset is not cumulative']
  );
});

test('a key field with no declared offset stops the decode instead of guessing', () => {
  // The layout is the only authority there is. Without an offset there is no honest slice
  // to take, so the whole key stays undecoded and visible rather than half-read.
  const out = decodeKey('001ABC', [
    { name: 'MANDT', type: 'C', length: 3, offset: 0 },
    { name: 'NOWHERE', type: 'C', length: 3, offset: null },
  ]);
  assert.equal(out.layoutKnown, false);
  assert.deepEqual(out.fields, []);
  assert.equal(out.leftover, '001ABC');
  assert.deepEqual(out.warnings, [
    { kind: 'key field without offset or length', field: 'NOWHERE' },
  ]);
});

test('the misspelling in the payload is recognised, not reported as drift', () => {
  // `tk:postion` is spelled that way by the server. Declaring the correct spelling would
  // turn every key field of every reply into a drift row and bury the real ones.
  assert.ok(PROJECTION.field.includes('tk:postion'));
  const doc = parseObjectKeys(CUSTOMIZING);
  assert.deepEqual(doc.drift, []);
  assert.equal(doc.tables[0].fields[0].name, 'CLIENT');
});

// --- asking many objects, without asking too much -----------------------------

// `code` is what tm:obj_func said on the entry; undefined = the attribute was absent,
// which is how the transport document spells the blank (normal) case. TABU/CDAT entries
// are K on every document measured, so the helpers below default them to K.
const obj = (type, name, sources, code = ['TABU', 'CDAT', 'VDAT', 'TDAT'].includes(type) ? 'K' : undefined) => ({
  pgmid: 'R3TR',
  type,
  name,
  sources,
  objFunc: objFuncOf(code),
});
const refuse = (status) => {
  const e = new Error('I::000');
  e.status = status;
  return e;
};

test('the carrier is the task the object is attributed to', () => {
  // ⚠️ Measured: (task DEVK900116, TABU MASSFLDLST) -> 200, and the parent request -> 400
  // for the same object. An object that is ALSO in the request's own list gets the
  // request first, because that is the list it is in.
  assert.deepEqual(carriersOf(obj('TABU', 'X', ['DEVK900118']), 'DEVK900117'), ['DEVK900118']);
  assert.deepEqual(carriersOf(obj('TABU', 'X', ['request', 'DEVK900108']), 'DEVK900107'), [
    'DEVK900107',
    'DEVK900108',
  ]);
  assert.deepEqual(carriersOf({ type: 'TABU', name: 'X' }, 'DEVK900107'), ['DEVK900107']);
});

test('a 400 on one carrier tries the next, and 400 everywhere is not an empty answer', async () => {
  const asked = [];
  const got = await collectObjectKeys(
    async (carrier) => {
      asked.push(carrier);
      if (carrier === 'DEVK900107') throw refuse(400);
      return { body: CUSTOMIZING };
    },
    [obj('TABU', 'MASSFLDLST', ['request', 'DEVK900108'])],
    'DEVK900107'
  );
  assert.deepEqual(asked, ['DEVK900107', 'DEVK900108']);
  assert.equal(got.objects[0].carrier, 'DEVK900108');
  assert.equal(got.objects[0].status, 200);
  assert.equal(got.lookups, 2, 'both attempts are charged to the budget');

  const none = await collectObjectKeys(
    async () => {
      throw refuse(400);
    },
    [obj('TABU', 'MASSFLDLST', ['request'])],
    'DEVK900107'
  );
  assert.equal(none.objects[0].keys, null);
  assert.match(none.objects[0].note, /NOT\s+evidence that the object carries none/);
});

test('a failure that is not a 400 stops that object instead of walking the carriers', async () => {
  // 500 or a dead session says nothing about the carrier, and retrying every task would
  // multiply one broken call by the size of the request.
  let calls = 0;
  const got = await collectObjectKeys(
    async () => {
      calls += 1;
      throw refuse(500);
    },
    [obj('TABU', 'X', ['request', 'DEVK900108'])],
    'DEVK900107'
  );
  assert.equal(calls, 1);
  assert.equal(got.objects[0].status, 500);
  assert.match(got.objects[0].note, /could not be read/);
});

test('keys are asked where the system says there are keys, and the type census only falsifies', async () => {
  // tm:obj_func="K" is E071-OBJFUNC "has rows in the key list" (domain read 2026-09-10,
  // 136/136 blank without E071K rows, 14/14 K with them). So the entry decides, not a
  // list of types kept by hand: D is skipped on the system's word even on a TABU, and a
  // K on a type the census says has no keys is asked AND reported as drift.
  assert.deepEqual(keyDecision(obj('TABU', 'ZT', ['T'], 'K')), { ask: true, by: 'objFunc' });
  assert.deepEqual(keyDecision(obj('TABU', 'ZT', ['T'], 'D')), { ask: false, by: 'objFunc' });
  assert.deepEqual(keyDecision(obj('CLAS', 'ZCL', ['T'], '')), { ask: false, by: 'objFunc' });
  const contradiction = keyDecision(obj('DDLS', 'ZI_X', ['T'], 'K'));
  assert.equal(contradiction.ask, true);
  assert.equal(contradiction.by, 'objFunc');
  assert.equal(contradiction.drift.kind, 'obj_func K on a type measured without keys');

  const asked = [];
  const got = await collectObjectKeys(
    async (carrier, o) => {
      asked.push(o.name);
      return { body: CUSTOMIZING };
    },
    [
      obj('TABU', 'ZCUST', ['DEVK1'], 'K'),
      obj('TABU', 'ZGONE', ['DEVK1'], 'D'),
      obj('DDLS', 'ZI_K', ['DEVK1'], 'K'),
    ],
    'DEVK1'
  );
  assert.deepEqual(asked, ['ZCUST', 'ZI_K']);
  assert.deepEqual(got.skipped, [{ type: 'TABU', by: 'objFunc', count: 1 }]);
  assert.deepEqual(got.objects.map((o) => o.askedBy), ['objFunc', 'objFunc']);
  assert.deepEqual(
    got.drift.map((d) => d.kind),
    ['obj_func K on a type measured without keys'],
    'the census contradicts the system once, and says so once'
  );
});

test('an entry without obj_func is decided by the census, and an unmeasured type is still asked', async () => {
  // ⚠️ The asymmetry is the point. 109 objects of these eleven types answered 400 for
  // every carrier, so asking again costs a call and buys nothing. A type in NEITHER
  // census is attempted -- absence from a measurement is not evidence -- and every
  // object names the path it took, because a skip on the census and a skip on the
  // system's word are different strengths of evidence.
  assert.ok(TYPES_MEASURED_WITHOUT_KEYS.has('DDLS'));
  const asked = [];
  const got = await collectObjectKeys(
    async (carrier, o) => {
      asked.push(o.type);
      return { body: TEMPLATE };
    },
    [
      obj('DDLS', 'ZI_A', ['DEVK1']),
      obj('DEVC', 'ZPKG', ['DEVK1']),
      obj('DDLS', 'ZI_B', ['DEVK1']),
      obj('SOTR', 'ZTEXT', ['DEVK1']),
    ],
    'DEVK1'
  );
  assert.deepEqual(asked, ['SOTR'], 'only the type nobody has measured is asked');
  assert.deepEqual(got.skipped, [
    { type: 'DDLS', by: 'census', count: 2 },
    { type: 'DEVC', by: 'census', count: 1 },
  ]);
  assert.equal(got.objects.length, 1);
  assert.equal(got.objects[0].askedBy, 'unmeasured');
  assert.ok(
    !got.drift.some((d) => /obj_func/.test(d.kind)),
    'a template-only reply on a blank entry is what was measured (ACGR): no counter-example'
  );
});

test('transported keys on an entry the system did not mark K are drift, not silence', async () => {
  const got = await collectObjectKeys(
    async () => ({ body: CUSTOMIZING }),
    [obj('SOTR', 'ZTEXT', ['DEVK1'])],
    'DEVK1'
  );
  assert.equal(got.objects[0].askedBy, 'unmeasured');
  assert.equal(got.objects[0].counts.transported > 0, true);
  assert.deepEqual(
    got.drift.map((d) => d.kind),
    ['transported keys on an entry without obj_func K']
  );
});

test('the budget is spent, never exceeded, and the rest is counted as not asked', async () => {
  let calls = 0;
  const got = await collectObjectKeys(
    async () => {
      calls += 1;
      return { body: CUSTOMIZING };
    },
    [obj('TABU', 'A', ['T']), obj('TABU', 'B', ['T']), obj('TABU', 'C', ['T'])],
    'R',
    { maxLookups: 2 }
  );
  assert.equal(calls, 2);
  assert.equal(got.lookups, 2);
  assert.equal(got.notAttempted, 1);
  assert.equal(got.objects.length, 2);
});

test('drift found while sweeping says which object it came from', async () => {
  const got = await collectObjectKeys(
    async () => ({ body: CUSTOMIZING.replace('<tk:tables>', '<tk:whatIsThis/><tk:tables>') }),
    [obj('CDAT', 'BUPAFLDMOD', ['DEVK900118'])],
    'DEVK900117'
  );
  assert.deepEqual(got.drift, [
    {
      node: 'tk:whatIsThis',
      attribute: null,
      kind: 'undeclared element',
      where: 'CDAT BUPAFLDMOD',
    },
  ]);
});
