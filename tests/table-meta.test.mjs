// lib/table-meta.mjs -- the DDIC header of a table, and the verdict it does and does not support.
//
// Offline: the fixtures are sources measured on the development system on 2026-09-22, with the provenance
// line (which carries the host) stripped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseTableMeta, verdictOf, listEntryLine, expandIncludes, appendRisk, completeness, readInChunks, DELIVERY_CLASSES, NOT_IN_SOURCE } from '../lib/table-meta.mjs';
import { CUSTOMIZING_TABLES, buildSelect, SelectViolation, validateCustomizingTable } from '../lib/data-preview.mjs';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const T683S = fixture('table-t683s.ddic.txt');
const TFRM = fixture('table-tfrm.ddic.txt');

test('T683S: the header annotations are read, not guessed', () => {
  const meta = parseTableMeta(T683S);
  assert.equal(meta.name, 'T683S');
  assert.equal(meta.label, 'Pricing Procedure: Data');
  assert.equal(meta.tableCategory, 'TRANSPARENT');
  assert.equal(meta.deliveryClass, 'C');
  assert.equal(meta.deliveryClassText, DELIVERY_CLASSES.get('C'));
  assert.equal(meta.dataMaintenance, 'RESTRICTED');
  assert.equal(meta.enhancementCategory, 'EXTENSIBLE_CHARACTER');
});

test('T683S: the field list survives foreign keys, WHERE lines and inline annotations', () => {
  const { fields } = parseTableMeta(T683S);
  const names = fields.map((f) => f.name);

  // The DDIC key, in order. A `where mandt = t683s.mandt` line inside the same statement must
  // never be mistaken for a field, and a `@AbapCatalog.foreignKey.*` line must not glue onto
  // the declaration that follows it.
  assert.deepEqual(
    fields.filter((f) => f.isKey).map((f) => f.name),
    ['MANDT', 'KVEWE', 'KAPPL', 'KALSM', 'STUNR', 'ZAEHK']
  );
  assert.equal(names.includes('CLIENT'), false, 'a WHERE operand was parsed as a field');
  assert.equal(names.includes('APPLICATION'), false, 'a WHERE operand was parsed as a field');

  // The three routine columns adt_customizing exists for, and a field with no `not null`.
  for (const c of ['KSCHL', 'KOBED', 'KOFRM', 'KOFRA', 'IS_ACCT_DETN_RELEVANT']) {
    assert.ok(names.includes(c), `${c} missing from the parsed field list`);
  }
  assert.deepEqual(
    fields.find((f) => f.name === 'KOBED'),
    { name: 'KOBED', type: 'KOBED', isKey: false }
  );
  assert.equal(fields.at(-1).name, 'INCLUSIONPOINTFROMTOISCOPIED', 'the last statement was dropped');
});

test('TFRM is class G: the reason the closed list is not a delivery-class rule', () => {
  // This is the whole record, as a test. TFRM is IN CUSTOMIZING_TABLES and its delivery class
  // is G, not C -- so a rule that admitted "class C" would have dropped a table the consumer
  // needs, and a rule widened to cover it (C+E+G+W) admits nearly the whole dictionary.
  // docs/security.md, "the delivery-class rule was measured and refused -- 2026-09-22".
  const meta = parseTableMeta(TFRM);
  assert.equal(meta.deliveryClass, 'G');
  assert.ok(CUSTOMIZING_TABLES.has('TFRM'));
  assert.notEqual(meta.deliveryClass, parseTableMeta(T683S).deliveryClass);
});

test('an annotation that is not in the source reads null, never a default', () => {
  const meta = parseTableMeta('define table zfoo {\n  key mandt : mandt not null;\n}');
  assert.equal(meta.deliveryClass, null);
  assert.equal(meta.deliveryClassText, null);
  assert.equal(meta.tableCategory, null);
  assert.equal(meta.label, null);
  // Not read is not class A: the verdict has to say so in its own word.
  assert.equal(verdictOf(meta).verdict, 'UNKNOWN');
});

test('parseTableMeta on something that is not a table answers no fields', () => {
  const meta = parseTableMeta('* nothing here');
  assert.equal(meta.name, null);
  assert.deepEqual(meta.fields, []);
});

test('the verdict refuses the two classes that are business data by definition', () => {
  for (const cls of ['A', 'L']) {
    const v = verdictOf({ deliveryClass: cls, tableCategory: 'TRANSPARENT' });
    assert.equal(v.verdict, 'REFUSE', `class ${cls} should be refused`);
    assert.match(v.why, new RegExp(`delivery class ${cls}`));
  }
  // And a non-transparent table, whatever its class: the data preview reads a table.
  assert.equal(verdictOf({ deliveryClass: 'C', tableCategory: 'INTERNAL' }).verdict, 'REFUSE');
});

test('the verdict never promotes a customizing class past REVIEW', () => {
  for (const cls of ['C', 'E', 'G', 'W', 'S']) {
    const v = verdictOf({ deliveryClass: cls, tableCategory: 'TRANSPARENT' });
    assert.equal(v.verdict, 'REVIEW', `class ${cls} should stay at REVIEW`);
  }
  // The sentence has to carry the counter-example, or the reviewer reads "C" as "safe".
  assert.match(verdictOf({ deliveryClass: 'C', tableCategory: 'TRANSPARENT' }).why, /personal data/);
});

test('the generated line, once pasted, is an entry buildSelect accepts', () => {
  // T681A is a foreign-key target of T683S and is deliberately NOT in the list, so the
  // "before" half of this test is a real refusal and not an accident of the fixture.
  // The list lives in data/defaults/customizing-tables.json, one JSON object per line; the line
  // used to be a Map literal for lib/data-preview.mjs, which holds no list any more.
  const fields = [{ name: 'MANDT', isKey: true }, { name: 'KVEWE', isKey: true }, { name: 'KOTABNR', isKey: true }, { name: 'KAPPL', isKey: false }];
  const line = listEntryLine('t681a', fields);
  assert.match(line, /^ {4}\{/, 'indented like the entries of the file');
  const entry = JSON.parse(line);
  assert.equal(entry.name, 'T681A');
  assert.deepEqual(entry.keyColumns, ['KVEWE', 'KOTABNR'], 'the key from the source, without the client');
  const [name, spec] = validateCustomizingTable(entry, { origin: 'test' });

  // Adding it is what a reviewer does next, so prove the result works -- then put the module
  // back the way it was, because every other test reads the same Map.
  assert.throws(() => buildSelect({ table: 'T681A' }), SelectViolation);
  CUSTOMIZING_TABLES.set(name, spec);
  try {
    assert.equal(buildSelect({ table: 'T681A', rows: 5 }).sql, 'SELECT * FROM T681A');
  } finally {
    CUSTOMIZING_TABLES.delete(name);
  }
  assert.throws(() => buildSelect({ table: 'T681A' }), SelectViolation);
});

test('ZDEMO_PERSON_01 is class C and the row is a person: the record, as a test', () => {
  // The whole reason the closed list is not a delivery-class rule. If this ever reads anything
  // but C, the refusal recorded in docs/security.md (2026-09-22) has to be re-argued, not
  // assumed -- which is what a test is for.
  const meta = parseTableMeta(fixture('table-zdemo-person-01.ddic.txt'));
  assert.equal(meta.deliveryClass, 'C');
  assert.equal(meta.tableCategory, 'TRANSPARENT');

  const names = meta.fields.map((f) => f.name);
  for (const personal of ['VORNA', 'NACHN', 'GBDAT', 'GESCH', 'RACE', 'NATIO', 'EMAIL', 'PERNR']) {
    assert.ok(names.includes(personal), `${personal} missing: the counter-example lost its point`);
  }
  // RACE is sensitive personal data (LGPD art. 11) and its type is the SAP data element.
  assert.equal(meta.fields.find((f) => f.name === 'RACE').type, 'PBR_RACE');
  // `with value help` / `with foreign key` blocks must not swallow the field that follows them.
  assert.ok(names.includes('ANRED') && names.includes('PERNR'));

  // And the verdict is REVIEW, not REFUSE: the class cannot refuse it. Only the person reading
  // the field list above can. That is the point, and it is why the script prints them.
  assert.equal(verdictOf(meta).verdict, 'REVIEW');
});

test('an include is reported, because the field list is then incomplete', () => {
  // Both forms VBAK uses. A short list printed as if it were the whole table is how a field
  // nobody remembers stays invisible.
  const meta = parseTableMeta([
    '@AbapCatalog.tableCategory : #TRANSPARENT',
    '@AbapCatalog.deliveryClass : #A',
    'define table vbak {',
    '',
    '  key mandt   : mandt not null;',
    '  include tds_sd_custh_branch;',
    '  vbak_status : include vbak_status;',
    '  netwr       : netwr_ak;',
    '',
    '}',
  ].join('\n'));

  assert.deepEqual(meta.includes, ['TDS_SD_CUSTH_BRANCH', 'VBAK_STATUS']);
  assert.deepEqual(meta.fields.map((f) => f.name), ['MANDT', 'NETWR']);
  // VBAK is class A, so it never gets as far as the field list anyway.
  assert.equal(verdictOf(meta).verdict, 'REFUSE');
});

test('a table with no include says so with an empty list, not a missing key', () => {
  assert.deepEqual(parseTableMeta(TFRM).includes, []);
});

test('a built-in type keeps its length: ABAP.CHAR(20), not ABAP.CHAR', () => {
  // Measured on ZDEMO_INVOICE_LOG (the development system, 2026-09-22): a Z table often types its fields on a
  // built-in instead of a data element, and the width is part of what a reviewer reads.
  const meta = parseTableMeta([
    '@AbapCatalog.tableCategory : #TRANSPARENT',
    '@AbapCatalog.deliveryClass : #C',
    'define table zdemo_invoice_log {',
    '  key mandante : mandt not null;',
    '  key invoice   : abap.char(20) not null;',
    '  message_text     : abap.char(200);',
    '  amount       : abap.dec(13, 2);',
    '}',
  ].join('\n'));

  assert.deepEqual(meta.fields.map((f) => f.type), ['MANDT', 'ABAP.CHAR(20)', 'ABAP.CHAR(200)', 'ABAP.DEC(13, 2)']);
  // Class C, and the row is an invoice: the class cannot refuse it, only a reader of the fields can.
  assert.equal(verdictOf(meta).verdict, 'REVIEW');
});

test('an include with trailing tokens is NOT dropped in silence', () => {
  // The regression that matters. KNA1 declares `include si_kna1 not null;` and SI_KNA1 declares
  // a multi-line `include kna1brazil extend ... ;`. An end-anchored pattern matched neither, so
  // the ~150 fields of SI_KNA1 vanished without a field, an include or a warning.
  // Measured on the development system, 2026-09-22.
  const meta = parseTableMeta([
    '@AbapCatalog.tableCategory : #TRANSPARENT',
    '@AbapCatalog.deliveryClass : #A',
    'define table kna1 {',
    '  key kunnr : kunnr not null;',
    '  mcod3     : mcdd3;',
    '  include si_kna1 not null;',
    '  include incl_eew_kna1;',
    '  include kna1brazil',
    '    extend crtn :',
    '      remove foreign key',
    '    extend suframa :',
    '      remove foreign key;',
    '  paytrsn   : farp_payt_rsn;',
    '}',
  ].join('\n'));

  assert.deepEqual(meta.includes, ['SI_KNA1', 'INCL_EEW_KNA1', 'KNA1BRAZIL']);
  assert.deepEqual(meta.fields.map((f) => f.name), ['KUNNR', 'MCOD3', 'PAYTRSN']);
  // And `extend crtn :` must not have been taken for a field.
  assert.equal(meta.fields.some((f) => f.name === 'CRTN'), false);
});

// A reader over a fixed map, shaped like the one the script injects.
const readerOver = (map, calls = []) => async (names) => {
  calls.push([...names]);
  return new Map(names.map((n) => [n, map[n] ?? null]));
};
const struct = (name, body) => `define structure ${name} {\n${body}\n}`;

test('expandIncludes follows nesting and says where each field came from', async () => {
  const calls = [];
  const meta = parseTableMeta(struct('kna1', '  key kunnr : kunnr not null;\n  include si_kna1 not null;'));
  const { fields, resolved, unresolved } = await expandIncludes(
    meta,
    readerOver(
      {
        SI_KNA1: struct('si_kna1', '  anred : anred;\n  include kna1brazil;'),
        KNA1BRAZIL: struct('kna1brazil', '  crtn : j_1bcrtn;'),
      },
      calls
    )
  );

  assert.deepEqual(fields.map((f) => [f.name, f.from]), [
    ['KUNNR', null],
    ['ANRED', 'SI_KNA1'],
    ['CRTN', 'KNA1BRAZIL'],
  ]);
  assert.deepEqual(resolved, ['SI_KNA1', 'KNA1BRAZIL']);
  assert.deepEqual(unresolved, []);
  // One batched call per level of nesting, not one per structure.
  assert.deepEqual(calls, [['SI_KNA1'], ['KNA1BRAZIL']]);
});

test('an include that cannot be read is reported, never skipped', async () => {
  const meta = parseTableMeta(struct('zfoo', '  key mandt : mandt not null;\n  include gone;'));
  const { fields, resolved, unresolved } = await expandIncludes(meta, readerOver({}));
  assert.deepEqual(fields.map((f) => f.name), ['MANDT']);
  assert.deepEqual(resolved, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].name, 'GONE');
  assert.match(unresolved[0].why, /not an empty structure/);
});

test('a read that throws does not lose the names it was asked about', async () => {
  const meta = parseTableMeta(struct('zfoo', '  include a;\n  include b;'));
  const { unresolved } = await expandIncludes(meta, async () => {
    throw new Error('HTTP 500');
  });
  assert.deepEqual(unresolved.map((u) => u.name).sort(), ['A', 'B']);
  assert.match(unresolved[0].why, /HTTP 500/);
});

test('a cycle terminates, and the depth cap is reported rather than silently truncating', async () => {
  const cyclic = parseTableMeta(struct('a', '  x : c1;\n  include a;'));
  const { fields, unresolved } = await expandIncludes(cyclic, readerOver({ A: struct('a', '  x : c1;\n  include a;') }));
  assert.deepEqual(fields.map((f) => f.name), ['X']);
  assert.deepEqual(unresolved, []);

  // A chain longer than the cap: the names still pending are named, not dropped.
  const chain = {};
  for (let i = 1; i <= 8; i += 1) chain[`S${i}`] = struct(`s${i}`, `  f${i} : c1;\n  include s${i + 1};`);
  const deep = parseTableMeta(struct('root', '  include s1;'));
  const out = await expandIncludes(deep, readerOver(chain), { maxDepth: 3 });
  assert.deepEqual(out.resolved, ['S1', 'S2', 'S3']);
  assert.deepEqual(out.unresolved.map((u) => u.name), ['S4']);
  assert.match(out.unresolved[0].why, /maxDepth 3/);
});

test('NOT_IN_SOURCE names the MECHANISMS, never a namespace', () => {
  // The sentence the script prints for EVERY table. It must name both ways a customer field
  // reaches a standard table from outside, because the field list is short by exactly those.
  assert.match(NOT_IN_SOURCE, /append structure/i);
  assert.match(NOT_IN_SOURCE, /Custom Fields app/);

  // And it must NOT pin a namespace. `ZZ1_DEMODELIVERY` reads as CFDF/FLD only because it was
  // created through the Custom Fields app; the same field added as an append in SE11 has no
  // CFDF object at all, and an append carries whatever name its author chose. A sentence that
  // said "ZZ1_*" would send the reader looking for the wrong thing and miss the classic path.
  assert.equal(/ZZ\d|ZZ_|CFDF/.test(NOT_IN_SOURCE), false, 'NOT_IN_SOURCE must not claim a namespace or an object type');
  assert.match(NOT_IN_SOURCE, /whatever they are named/);
});


test('enhancement category: NOT_CLASSIFIED is never folded into NOT_EXTENSIBLE', () => {
  // ABAP Keyword Documentation 7.58, ABENDDICDDL_DEFINE_STRUCT_PROPS (the system kernel is 7.58):
  // #NOT_EXTENSIBLE is "Cannot be enhanced"; #NOT_CLASSIFIED is "Not classified", which excludes
  // nothing. Folding them would turn unknown into clean -- the one direction never to round in.
  assert.equal(appendRisk({ enhancementCategory: 'NOT_EXTENSIBLE' }).closed, true);
  assert.equal(appendRisk({ enhancementCategory: 'NOT_CLASSIFIED' }).closed, false);
  for (const c of ['EXTENSIBLE_CHARACTER', 'EXTENSIBLE_CHARACTER_NUMERIC', 'EXTENSIBLE_ANY']) {
    assert.equal(appendRisk({ enhancementCategory: c }).closed, false, c);
  }
  // Absent, and a category outside the documented set, are both "nothing concluded".
  assert.equal(appendRisk({}).closed, null);
  assert.equal(appendRisk({ enhancementCategory: 'EXTENSIBLE_FUTURE_THING' }).closed, null);
});

test('the gap is per NODE: a resolved include can be the open one', async () => {
  // The measured chain, and the reason a per-table warning is not enough: KOMG includes KOMPAZ,
  // KOMPAZ holds only PDUMMY in its source, and it is KOMPAZ -- not KOMG -- that carries the
  // append ZDEMO_KOMPAZ with ZZDEMOFLD. Both are #EXTENSIBLE_CHARACTER_NUMERIC on the system (2026-09-22).
  const komg = parseTableMeta([
    '@AbapCatalog.enhancement.category : #EXTENSIBLE_CHARACTER_NUMERIC',
    '@AbapCatalog.tableCategory : #TRANSPARENT',
    'define structure komg {',
    '  mandt : mandt;',
    '  include kompaz;',
    '  include komgbrazil',
    '    extend crtn :',
    '      remove foreign key;',
    '}',
  ].join('\n'));

  const out = await expandIncludes(komg, readerOver({
    KOMPAZ: ['@AbapCatalog.enhancement.category : #EXTENSIBLE_CHARACTER_NUMERIC',
             'define structure kompaz {', '  pdummy : dummy;', '}'].join('\n'),
    KOMGBRAZIL: ['@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE',
                 'define structure komgbrazil {', '  crtn : j_1bcrtn;', '}'].join('\n'),
  }));

  assert.deepEqual(out.fields.map((f) => f.name), ['MANDT', 'PDUMMY', 'CRTN']);
  const c = completeness(out);
  assert.equal(c.complete, false);
  // KOMGBRAZIL is provably closed; KOMG and KOMPAZ are not -- and ZZDEMOFLD lives behind KOMPAZ.
  assert.deepEqual(c.closed, ['KOMGBRAZIL']);
  assert.deepEqual(c.open.sort(), ['KOMG', 'KOMPAZ']);
});

test('complete is claimed only when every node is provably closed', async () => {
  const root = parseTableMeta([
    '@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE',
    'define structure zclosed {', '  a : c1;', '  include zsub;', '}',
  ].join('\n'));
  const out = await expandIncludes(root, readerOver({
    ZSUB: ['@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE', 'define structure zsub {', '  b : c1;', '}'].join('\n'),
  }));
  const c = completeness(out);
  assert.equal(c.complete, true);
  assert.deepEqual(c.closed.sort(), ['ZCLOSED', 'ZSUB']);

  // One unresolved include is enough to withdraw the claim, even with every node closed.
  const withGap = { ...out, unresolved: [{ name: 'X', why: 'read failed' }] };
  assert.equal(completeness(withGap).complete, false);
});

test('nodes carry the depth they were found at', async () => {
  const root = parseTableMeta('define structure a {' + '\n' + '  include b;' + '\n' + '}');
  const out = await expandIncludes(root, readerOver({
    B: 'define structure b {' + '\n' + '  include c;' + '\n' + '}',
    C: 'define structure c {' + '\n' + '  x : c1;' + '\n' + '}',
  }));
  assert.deepEqual(out.nodes.map((n) => [n.name, n.depth]), [['A', 0], ['B', 1], ['C', 2]]);
});


test('a structure is told apart from a table, and refused as a candidate', () => {
  // KOMG is `define structure`. Before this, the report said "delivery class (not in the source)"
  // -- which reads as a gap in the read, when in truth a structure HAS no delivery class. The two
  // are different answers and the tool must not spend one on the other. Measured.
  const komg = parseTableMeta(['define structure komg {', '  mandt : mandt;', '}'].join('\n'));
  assert.equal(komg.kind, 'structure');
  assert.equal(komg.deliveryClass, null);

  const v = verdictOf(komg);
  assert.equal(v.verdict, 'REFUSE');
  assert.match(v.why, /STRUCTURE/);
  // And NOT the "class was not read" sentence, which would send the reader to SE11 for nothing.
  assert.equal(/was NOT read/.test(v.why), false);

  // A real table still reports its kind, and is judged on its class as before.
  const t683s = parseTableMeta(T683S);
  assert.equal(t683s.kind, 'table');
  assert.equal(verdictOf(t683s).verdict, 'REVIEW');

  // A table whose class genuinely did not come back is still UNKNOWN, not REFUSE.
  assert.equal(verdictOf({ kind: 'table' }).verdict, 'UNKNOWN');
});

// --- the three forms that failed on live tables, 2026-09-22 ------------------------------------

test('an APPEND source parses -- `extend type <t> with <n>`, not `define`', () => {
  // Verbatim from the development system. Until this form parsed, an append resolved, its source came back, and
  // its field list was empty -- so the report named the append and printed nothing under it.
  const meta = parseTableMeta(
    "@EndUserText.label : ''\n" +
      '@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n' +
      'extend type incl_eew_kna1 with zz1_demo7x2kq9mbt4wpl3rncy8hfa {\n\n' +
      '  zz1_demodelivery_cus : zz1_demodelivery not null;\n\n}'
  );
  assert.equal(meta.kind, 'append');
  assert.equal(meta.name, 'ZZ1_DEMO7X2KQ9MBT4WPL3RNCY8HFA');
  assert.equal(meta.extendsTarget, 'INCL_EEW_KNA1', 'the object it extends is the useful half');
  assert.deepEqual(meta.fields.map((f) => f.name), ['ZZ1_DEMODELIVERY_CUS']);
  // It is not a table and must never be proposed as one.
  assert.equal(verdictOf(meta).verdict, 'REFUSE');
  assert.match(verdictOf(meta).why, /APPEND structure/);
});

test('an append whose fields carry no Z at all still parses', () => {
  const meta = parseTableMeta(
    '@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n' +
      'extend type wbrf with zdemo_str_exit {\n  dt_comp : augdt;\n  st_comp : zdemo_de_comp;\n}'
  );
  assert.deepEqual(meta.fields.map((f) => f.name), ['DT_COMP', 'ST_COMP']);
  assert.equal(meta.extendsTarget, 'WBRF');
});

test('a QUOTED include alias is still an include -- the RAP draft generator writes one', () => {
  // ZDEMO_INVMAP_D declares `"%admin" : include sych_bdl_draft_admin_inc;` and ZDEMO_CTR_MAN_D
  // declares the same include unaliased. The quoted form matched neither branch, so six draft
  // fields were dropped from the source list and then reported as arriving from an append.
  const meta = parseTableMeta(
    'define table zdemo_invmap_d {\n' +
      '  key client         : abap.clnt not null;\n' +
      '  baseunit           : meins;\n' +
      '  "%admin"           : include sych_bdl_draft_admin_inc;\n}'
  );
  assert.deepEqual(meta.includes, ['SYCH_BDL_DRAFT_ADMIN_INC']);
  assert.deepEqual(meta.fields.map((f) => f.name), ['CLIENT', 'BASEUNIT'], 'the alias became a field');
});

test('the three include forms are all recorded', () => {
  const meta = parseTableMeta(
    'define table vbak {\n' +
      '  include vbak_status;\n' +
      '  tech_fields : include vbak_tech_fields;\n' +
      '  "%admin" : include sych_bdl_draft_admin_inc;\n}'
  );
  assert.deepEqual(meta.includes, ['VBAK_STATUS', 'VBAK_TECH_FIELDS', 'SYCH_BDL_DRAFT_ADMIN_INC']);
});

test('an append whose whole body is an include has no field and one include', () => {
  // WBRF_ADDON_GT, /VSO/R_KNA1_A and J_3GKNA1A are all shaped this way. Reporting "no fields" for
  // one of them says the opposite of the truth: it brings a whole structure.
  const meta = parseTableMeta(
    '@AbapCatalog.enhancement.category : #EXTENSIBLE_CHARACTER\n' +
      'extend type wbrf with wbrf_addon_gt {\n\n  include wb2b_cond_key;\n\n}'
  );
  assert.equal(meta.kind, 'append');
  assert.deepEqual(meta.fields, []);
  assert.deepEqual(meta.includes, ['WB2B_COND_KEY']);
});

test('an append may declare fields BOTH before and after an include', () => {
  // AKNA1_FMFG, verbatim down to the foreign-key clauses. This is the shape that breaks the
  // "fields until the next marker" attribution: the DDIC flat list puts DUNS and the three that
  // follow after the .include marker, so the append's own block under-reports it by four.
  const meta = parseTableMeta(
    'extend type kna1 with akna1_fmfg {\n\n' +
      '  @AbapCatalog.foreignKey.screenCheck : true\n' +
      '  alc         : fmfg_alc\n' +
      '    with foreign key fmfgt_alc\n' +
      '      where mandt = kna1.mandt\n' +
      '        and alc = akna1_fmfg.alc;\n' +
      '  pmt_office  : fmfg_pmt_off;\n' +
      '  include si_fmfg_vp2;\n' +
      '  duns        : fmccrduns;\n' +
      '  duns4       : fmccrduns4;\n' +
      '  sam_ue_id   : fmfg_unique_entity_id;\n' +
      '  sam_eft_ind : fmfg_eft_ind;\n\n}'
  );
  assert.deepEqual(meta.fields.map((f) => f.name), [
    'ALC',
    'PMT_OFFICE',
    'DUNS',
    'DUNS4',
    'SAM_UE_ID',
    'SAM_EFT_IND',
  ]);
  assert.deepEqual(meta.includes, ['SI_FMFG_VP2']);
  // The foreign-key clause must not become a field: `where mandt = kna1.mandt` has no colon.
  assert.equal(meta.fields.some((f) => /WHERE|MANDT/.test(f.name)), false);
});

test('a namespaced append parses like any other', () => {
  const meta = parseTableMeta(
    "@EndUserText.label : 'KNA1 Append; obsolete (compare note 2393142)'\n" +
      'extend type kna1 with /vso/r_kna1_a {\n\n  include /vso/r_kna1_i;\n\n}'
  );
  assert.equal(meta.name, '/VSO/R_KNA1_A');
  assert.equal(meta.extendsTarget, 'KNA1');
  assert.deepEqual(meta.includes, ['/VSO/R_KNA1_I']);
});

test('a batch cap must CHUNK, not truncate', async () => {
  // KOMG names 28 appends. `names.slice(0, 25)` reported the last three as "source not read", and
  // one of them was ZDEMO_KOMPAZ -- the object the append route was built to reach. The cap did not
  // fail where it was wrong; it failed where the answer was read.
  const asked = [];
  const read = async (chunk) => {
    asked.push(chunk.length);
    return new Map(chunk.map((n) => [n, `define structure ${n} { f : char1; }`]));
  };
  const names = Array.from({ length: 28 }, (_, i) => `S${i}`);
  const got = await readInChunks(names, read);
  assert.deepEqual(asked, [25, 3], 'it must send two requests, not one truncated one');
  assert.equal(got.size, 28);
  assert.equal(got.has('S27'), true, 'the 28th name was dropped');
});

test('chunking an empty list asks nothing', async () => {
  let called = 0;
  await readInChunks([], async () => { called += 1; return new Map(); });
  assert.equal(called, 0);
});

// --- an include that does not exist is not a gap -----------------------------------------------

test('a reader may answer {source, error}, and the REASON decides what the gap is', async () => {
  // Measured on the development system, 2026-09-22, expanding KOMG: four of its six unresolved includes are
  // customer includes that were never implemented -- CI_KOMK_CM answers "not found in the system".
  // They contribute no field, so the list is NOT short, and reporting them as a gap makes the
  // warning fire on nearly every large standard structure.
  // Both nodes are #NOT_EXTENSIBLE so the only thing that could make the list incomplete is the
  // unresolved include -- which is what this test is about.
  const closed = '@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n';
  const meta = parseTableMeta(`${closed}define structure komg { include ci_komk_cm; include si_real; }`);
  const read = async (chunk) =>
    new Map(
      chunk.map((n) => [
        n,
        n === 'SI_REAL'
          ? { source: `${closed}define structure si_real { a : char1; }`, error: null }
          : { source: null, error: "Error: Object 'CI_KOMK_CM' not found in the system." },
      ])
    );
  const out = await expandIncludes(meta, read);
  const u = out.unresolved.find((x) => x.name === 'CI_KOMK_CM');
  assert.equal(u.missing, true);
  assert.match(u.why, /does not exist in this system/);

  const c = completeness(out);
  assert.deepEqual(c.missing, ['CI_KOMK_CM']);
  assert.deepEqual(c.gaps, [], 'an absent include was counted as a hole in the field list');
  assert.equal(c.complete, true, 'nothing is missing from the list: the include has no fields');
});

test('a read that failed for ANY other reason is still a gap', async () => {
  const meta = parseTableMeta('define structure komg { include prodh; }');
  const read = async (chunk) =>
    new Map(chunk.map((n) => [n, { source: null, error: "Error: 'PRODH' names 3 unrelated objects" }]));
  const out = await expandIncludes(meta, read);
  assert.equal(out.unresolved[0].missing, false);
  assert.match(out.unresolved[0].why, /names 3 unrelated objects/, 'the reason must survive verbatim');
  const c = completeness(out);
  assert.deepEqual(c.gaps, ['PRODH']);
  assert.equal(c.complete, false);
});

test('a reader that answers a bare source still works', async () => {
  // The older shape: tests and any other caller may hand back a string.
  const meta = parseTableMeta('define structure t { include si_a; }');
  const out = await expandIncludes(meta, async (chunk) =>
    new Map(chunk.map((n) => [n, 'define structure si_a { z : char1; }']))
  );
  assert.deepEqual(out.fields.map((f) => f.name), ['Z']);
  assert.deepEqual(out.unresolved, []);
});
