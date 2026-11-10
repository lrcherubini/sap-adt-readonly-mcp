// The one POST: grammar closed, list closed, parser on the measured shape (2026-09-12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelect,
  previewPost,
  parsePreview,
  routineColumnsOf,
  padRoutine,
  CUSTOMIZING_TABLES,
  STANDARD_CUSTOMIZING_TABLES,
  installCustomizingTables,
  SelectViolation,
  DATA_PREVIEW_ACCEPT,
  MAX_ROWS,
  MAX_LINE,
  assertRanAsSent,
  likeLiteral,
  truncationOf,
} from '../lib/data-preview.mjs';

/** Column-major, exactly as the system answered `SELECT KALSM, STUNR, KOFRM FROM T683S ... UP TO 2 ROWS`. */
const col = (name, type, values) =>
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="${type}" dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
  (values.length ? `<dataPreview:dataSet>${values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join('')}</dataPreview:dataSet>` : '<dataPreview:dataSet/>') +
  '</dataPreview:columns>';
const FIXTURE =
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  '<dataPreview:totalRows>7028</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>' +
  "<dataPreview:executedQueryString>SELECT KALSM, STUNR, KOFRM FROM T683S WHERE KVEWE = 'A'   INTO     TABLE @DATA(LT_RESULT)   UP TO 2  ROWS   .</dataPreview:executedQueryString>" +
  '<dataPreview:queryExecutionTime>0.2180000</dataPreview:queryExecutionTime>' +
  col('KALSM', 'C', ['A10001', 'ZDEMO1']) +
  col('STUNR', 'N', ['010', '020']) +
  col('KOFRM', 'N', ['0000000', '0000953']) +
  '</dataPreview:tableData>';

// --- grammar -----------------------------------------------------------------

test('buildSelect: the whole table, listed fields, = / <> / IN, and the row cap', () => {
  assert.deepEqual(buildSelect({ table: 't683s' }), { table: 'T683S', rows: 50, sql: 'SELECT * FROM T683S' });
  assert.equal(
    buildSelect({
      table: 'T683S',
      fields: ['kalsm', 'STUNR', 'KOFRM'],
      where: [
        { field: 'KVEWE', value: 'A' },
        { field: 'KAPPL', op: '<>', value: 'M' },
        { field: 'KOFRM', op: 'IN', value: ['0000953', '0000954'] },
      ],
      rows: 5,
    }).sql,
    "SELECT KALSM, STUNR, KOFRM FROM T683S WHERE KVEWE = 'A' AND KAPPL <> 'M' AND KOFRM IN ('0000953', '0000954')"
  );
  assert.equal(buildSelect({ table: 'T683S', where: [{ field: 'X', value: "O'HARA" }] }).sql, "SELECT * FROM T683S WHERE X = 'O''HARA'");
});

test('buildSelect: only =, <> and IN, and at most MAX_ROWS rows', () => {
  assert.throws(() => buildSelect({ table: 'DDHEADANNO', where: [{ field: 'STRUCOBJN', op: '>=', value: 'I_A' }] }), SelectViolation);
  assert.throws(() => buildSelect({ table: 'DDHEADANNO', where: [{ field: 'STRUCOBJN', op: '<', value: 'I_B' }] }), SelectViolation);
  assert.throws(() => buildSelect({ table: 'DDHEADANNO', where: [{ field: 'STRUCOBJN', op: '>', value: 'I' }] }), SelectViolation);
  assert.equal(buildSelect({ table: 'DDHEADANNO', rows: 200 }).rows, 200);
  assert.throws(() => buildSelect({ table: 'DDHEADANNO', rows: 201 }), SelectViolation);
});

test('buildSelect refuses what the grammar cannot say, before any socket', () => {
  const bad = (input, re) => assert.throws(() => buildSelect(input), (e) => e instanceof SelectViolation && re.test(e.message));
  bad({ table: 'VBAK' }, /not in the customizing allow-list/);
  bad({ table: 'T683S; DROP TABLE X' }, /not an identifier/);
  bad({ table: 'T683S', fields: [] }, /non-empty array/);
  bad({ table: 'T683S', fields: ['A B'] }, /not an identifier/);
  bad({ table: 'T683S', where: [{ field: 'X', op: 'BETWEEN', value: 'a' }] }, /not one of/);
  bad({ table: 'T683S', where: [{ field: 'X', op: 'LIKE', value: ['A*'] }] }, /one search pattern/);
  bad({ table: 'T683S', where: [{ field: 'X', op: 'IN', value: 'a' }] }, /non-empty array/);
  bad({ table: 'T683S', where: [{ field: 'X', value: ['a'] }] }, /takes one value/);
  bad({ table: 'T683S', where: [{ field: 'X', value: "a' OR 1=1 --" }] }, /character the grammar does not allow/);
  bad({ table: 'T683S', where: [{ field: 'X', value: 'x;y' }] }, /character/);
  bad({ table: 'T683S', rows: 0 }, /1 to 200/);
  bad({ table: 'T683S', rows: MAX_ROWS + 1 }, /1 to 200/);
  bad({ table: 'T683S', rows: 2.5 }, /1 to 200/);
});

// A 16-routine IN list on PFRM routines: the statement of 2026-09-30, 257 characters.
const PFRM16 = [951, 952, 953, 954, 956, 957, 958, 969, 970, 971, 980, 985, 987, 988, 989, 996].map((n) => padRoutine(n, 7));
const PFRM_FIELDS = ['KVEWE', 'KAPPL', 'KALSM', 'STUNR', 'ZAEHK', 'KSCHL', 'KOFRM'];

test('buildSelect breaks a long statement between tokens, never inside one, and leaves a short one on one line', () => {
  const pfrm = buildSelect({ table: 'T683S', fields: PFRM_FIELDS, where: [{ field: 'KOFRM', op: 'IN', value: PFRM16 }] }).sql;
  const lines = pfrm.split('\n');
  assert.equal(lines.length, 2, 'the 257-character statement of 2026-09-30 goes out on two lines');
  assert.ok(lines.every((l) => l.length <= MAX_LINE));
  assert.ok(lines.slice(1).every((l) => l.startsWith('  ') && !/^[*"]/.test(l.trimStart())), 'a continuation is indented and never opens as a comment');
  // Folded back, it is the one-line statement: no literal was cut, nothing was added.
  assert.equal(
    pfrm.replace(/\n\s*/g, ' '),
    `SELECT ${PFRM_FIELDS.join(', ')} FROM T683S WHERE KOFRM IN (${PFRM16.map((v) => `'${v}'`).join(', ')})`
  );
  for (const l of lines) assert.equal((l.match(/'/g) ?? []).length % 2, 0, `a literal straddles the break: ${l}`);
  // 255 fits one line (the server kept a 255-character line whole on 2026-10-01); 256 does not.
  const q = (n) => 'Q'.repeat(n);
  const at = (last) => buildSelect({ table: 'T683S', where: [{ field: 'KSCHL', op: 'IN', value: [q(60), q(60), q(60), q(last)] }] }).sql;
  assert.equal(at(24).length, MAX_LINE);
  assert.ok(!at(24).includes('\n'));
  assert.equal(at(25).split('\n').length, 2);
  // A long list: every line fits, whatever its length.
  const many = buildSelect({ table: 'T683S', where: [{ field: 'KOFRM', op: 'IN', value: Array.from({ length: 120 }, (_, i) => padRoutine(i + 1, 7)) }] }).sql;
  const manyLines = many.split('\n');
  assert.ok(manyLines.length > 4 && manyLines.every((l) => l.length <= MAX_LINE));
});

test('assertRanAsSent accepts the echo of the statement sent and refuses a truncated one', () => {
  assert.doesNotThrow(() =>
    assertRanAsSent("SELECT KALSM, STUNR, KOFRM FROM T683S WHERE KVEWE = 'A'", parsePreview(FIXTURE).executedQuery)
  );
  // Verbatim from the development system on 2026-10-01: `AND KVEWE = 'X'` was sent and never ran; status 200, 36 rows.
  const sent =
    "SELECT MANDT, KVEWE, KAPPL, KALSM FROM T683S WHERE KOFRM IN ('0000951', '0000952', '0000953', '0000954', '0000956', '0000957', '0000958', '0000969', '0000970', '0000971', '0000980', '0000985', '0000987', '0000988', '0000989', '0000996') AND KSCHL <> 'QQQ' AND KVEWE = 'X'";
  const ran = `${sent.slice(0, MAX_LINE)}   INTO     TABLE @DATA(LT_RESULT)   UP TO 5  ROWS   .`;
  assert.throws(() => assertRanAsSent(sent, ran), (e) => e.name === 'QueryAltered' && /different statement/.test(e.message));
  assert.throws(() => assertRanAsSent('SELECT * FROM T683S', null), (e) => e.name === 'QueryAltered' && /without executedQueryString/.test(e.message));
  // A prefix that happens to be a whole statement is still not the statement sent.
  assert.throws(() => assertRanAsSent("SELECT * FROM T683S WHERE KVEWE = 'A' AND KAPPL = 'V'", "SELECT * FROM T683S WHERE KVEWE = 'A' INTO TABLE @DATA(LT_RESULT) UP TO 5 ROWS ."), /different statement/);
});

test('LIKE takes a search pattern, never SQL: the module writes the literal and the ESCAPE', () => {
  // Measured 2026-11-09: `Z_%` matched every Z name (`_` is a wildcard); `Z#_%' ESCAPE '#'` one.
  assert.equal(likeLiteral('z_*'), "'Z#_%' ESCAPE '#'");
  assert.equal(likeLiteral('*LOG*'), "'%LOG%' ESCAPE '#'");
  assert.equal(likeLiteral('/DMO/*'), "'/DMO/%' ESCAPE '#'");
  assert.equal(likeLiteral('*'), "'%' ESCAPE '#'");
  assert.equal(
    buildSelect({ table: 'BALOBJ', fields: ['OBJECT'], where: [{ field: 'OBJECT', op: 'LIKE', value: 'Z*' }] }).sql,
    "SELECT OBJECT FROM BALOBJ WHERE OBJECT LIKE 'Z%' ESCAPE '#'"
  );
  // Injection attempts: none of them is a pattern, and none reaches a statement.
  for (const attack of [
    "Z%' OR '1'='1",
    "Z' OR 1=1 --",
    'Z") UNION',
    "Z*' ESCAPE '",
    '*"',
    "Z*' ESCAPE '!",
    'Z% ',
    'Z#*',
    '* FROM TADIR',
    'Z*;',
    'A'.repeat(31),
    '',
  ]) {
    assert.throws(() => likeLiteral(attack), SelectViolation, attack);
    assert.throws(() => buildSelect({ table: 'BALOBJ', where: [{ field: 'OBJECT', op: 'LIKE', value: attack }] }), SelectViolation, attack);
  }
});

test('a field allowlist: the columns a table admits, `*` meaning only those, filter-only columns never selected', () => {
  // SCICHKV_HD holds users (CIUSER, UNAM): admitted by exception with an allowlist (docs/security.md).
  const spec = CUSTOMIZING_TABLES.get('SCICHKV_HD');
  assert.deepEqual(spec.fields, ['CHECKVNAME', 'CHECKVID', 'IS_CHKV', 'TRANSPORT', 'REMOTE', 'HIDDEN', 'PROXY']);
  assert.deepEqual(spec.filterOnly, ['CIUSER']);
  assert.equal(
    buildSelect({ table: 'SCICHKV_HD', where: [{ field: 'CIUSER', op: '<>', value: ' ' }] }).sql,
    "SELECT CHECKVNAME, CHECKVID, IS_CHKV, TRANSPORT, REMOTE, HIDDEN, PROXY FROM SCICHKV_HD WHERE CIUSER <> ' '"
  );
  for (const fields of [['UNAM'], ['CIUSER'], ['CREADATE'], ['CHECKVNAME', 'UNAM']]) {
    assert.throws(() => buildSelect({ table: 'SCICHKV_HD', fields }), /may be read only for/, fields.join());
  }
  assert.throws(() => buildSelect({ table: 'SCICHKV_HD', where: [{ field: 'UNAM', value: 'X' }] }), /may be filtered only on/);
  assert.equal(CUSTOMIZING_TABLES.get('SCICHKV_TX').fields.includes('CIUSER'), false);
});

test('SFW_SWITCH_STATE: the state of a switch is read, the user a setting belongs to never is', () => {
  // Class L with USERNAME in the key, admitted by exception on 2026-11-09 (docs/security.md): the
  // only place a switch's state is stored. USERNAME filters (blank = the system setting) and is
  // never selected.
  const spec = CUSTOMIZING_TABLES.get('SFW_SWITCH_STATE');
  assert.deepEqual(spec.fields, ['SWITCH_ID', 'CLIENT', 'VERSION', 'STATE']);
  assert.deepEqual(spec.filterOnly, ['USERNAME']);
  assert.equal(
    buildSelect({ table: 'SFW_SWITCH_STATE', where: [{ field: 'SWITCH_ID', op: 'IN', value: ['ZDEMO_SW_A', 'ZDEMO_SW_B'] }, { field: 'USERNAME', op: '=', value: '' }] }).sql,
    "SELECT SWITCH_ID, CLIENT, VERSION, STATE FROM SFW_SWITCH_STATE WHERE SWITCH_ID IN ('ZDEMO_SW_A', 'ZDEMO_SW_B') AND USERNAME = ''"
  );
  for (const fields of [['USERNAME'], ['SWITCH_ID', 'USERNAME']]) {
    assert.throws(() => buildSelect({ table: 'SFW_SWITCH_STATE', fields }), /may be read only for/, fields.join());
  }
});

test('previewPost re-checks the allowlist on the statement: a hand-built SELECT cannot read a user field', async () => {
  const sent = [];
  const raw = { httpClient: { request: async (url, c) => (sent.push({ url, ...c }), { status: 200, body: '', headers: {} }) } };
  for (const sql of ['SELECT * FROM SCICHKV_HD', 'SELECT UNAM FROM SCICHKV_HD', 'SELECT CHECKVNAME, CIUSER FROM SCICHKV_HD']) {
    await assert.rejects(() => previewPost(raw, sql, 5), SelectViolation, sql);
  }
  assert.equal(sent.length, 0, 'nothing left the client');
});

test('the allow-list is closed and every entry says why', () => {
  assert.deepEqual(
    [...CUSTOMIZING_TABLES.keys()],
    ['T683S', 'T683U', 'T683T', 'T685', 'T685A', 'T685T', 'T682I', 'T681', 'TMC1T', 'TVCPA', 'TVCPF', 'TVCPL', 'TFRM', 'TFRMT', '/UI2/SEMOBJC', '/UI2/SEMOBJCT', '/UI2/SEMOBJ', 'BALOBJ', 'BALOBJT', 'SCICHKV_HD', 'SCICHKV_TX', 'TADIR', 'DDHEADANNO', 'T052', 'T052U', 'TVARVC', 'TPAER', 'T133A', 'T133B', 'T133C', 'D020S', 'D020T', 'D021T', 'DDFTX', 'TSDIR', 'DYNPSOURCE', 'T130M', 'T133K', 'T133S', 'T133T', 'TSTC', 'TSTCP', 'MDLV', 'MDLG', 'T460A', 'T460T', 'T438A', 'T438T', 'T439A', 'T141', 'T141T', 'TVMS', 'TVMST', 'TFACD', 'TFACT', 'TFAIN', 'TFACS', 'THOC', 'THOCI', 'THOL', 'THOLT', 'FHC_CONFIG', 'FHC_C_FCAL', 'T001', 'T001K', 'T001L', 'T001W', 'T001B', 'T001Z', 'SFW_PACKAGE', 'SFW_SW_BF', 'SFW_ACTIVE_BFUNC', 'SFW_SWITCHT', 'SFW_BFT', 'SFW_SWITCH_STATE']
  );
  for (const [t, spec] of CUSTOMIZING_TABLES) assert.ok(spec.why.length > 10, `${t} has no reason`);
  assert.ok(![...CUSTOMIZING_TABLES.keys()].some((t) => /^[ZY]/.test(t)), 'the standard list carries no customer table');
});

test('an installation adds its own tables through the same validation, and never redefines a standard one', () => {
  assert.throws(() => installCustomizingTables([{ name: 'zdemo_x', why: 'a demo table with a filter column', filterOnly: ['OWNER'] }]), /filterOnly needs a fields allowlist/);
  assert.throws(() => installCustomizingTables([{ name: 'zdemo_x', why: 'a demo table with a filter column', fields: ['A', 'OWNER'], filterOnly: ['OWNER'] }]), /also a selectable field/);
  installCustomizingTables([]);
  try {
    installCustomizingTables([{ name: 'zdemo_region', why: 'state -> sales district of a demo integration', keyColumns: ['region'] }]);
    assert.ok(CUSTOMIZING_TABLES.has('ZDEMO_REGION'), 'names are normalized to upper case');
    assert.deepEqual(CUSTOMIZING_TABLES.get('ZDEMO_REGION').keyColumns, ['REGION']);
    assert.match(buildSelect({ table: 'ZDEMO_REGION', rows: 5 }).sql, /FROM ZDEMO_REGION/);
    // Installing again replaces, never accumulates.
    installCustomizingTables([{ name: 'ZDEMO_OTHER', why: 'another demo table for this test' }]);
    assert.ok(!CUSTOMIZING_TABLES.has('ZDEMO_REGION'));
    assert.throws(() => buildSelect({ table: 'ZDEMO_REGION' }), /not in the customizing allow-list/);
    const cases = [
      [{ name: 'T683S', why: 'redefine a standard table' }, /already in the standard list/],
      [{ name: 'ZX;DROP', why: 'not an identifier at all' }, /not an identifier/],
      [{ name: 'ZDEMO_X' }, /'why' is required/],
      [{ name: 'ZDEMO_X', why: 'x'.repeat(301) }, /longer than 300/],
      [{ name: 'ZDEMO_X', why: 'routine column of an unknown group', routineColumns: { KOBED: 'NOPE' } }, /not a VOFM group/],
      [{ name: 'ZDEMO_X', why: 'routine column that is not a regex', routineColumns: { '(': 'PBED' } }, /neither an identifier nor a valid regex/],
      [{ name: 'ZDEMO_X', why: 'key columns that are not identifiers', keyColumns: ['A B'] }, /keyColumns/],
    ];
    for (const [bad, re] of cases) assert.throws(() => installCustomizingTables([bad]), re, JSON.stringify(bad));
  } finally {
    installCustomizingTables([]);
  }
  assert.equal(CUSTOMIZING_TABLES.size, STANDARD_CUSTOMIZING_TABLES.size, 'an empty install is the standard list');
});

// --- the POST ----------------------------------------------------------------

test('previewPost sends the one measured request, and refuses anything buildSelect did not build', async () => {
  const sent = [];
  const raw = { httpClient: { request: async (url, cfg) => { sent.push({ url, ...cfg }); return { status: 200, body: FIXTURE, headers: { 'content-type': DATA_PREVIEW_ACCEPT } }; } } };
  const out = await previewPost(raw, 'SELECT * FROM T683S', 2);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].url, '/sap/bc/adt/datapreview/freestyle?rowNumber=2');
  assert.deepEqual(sent[0].headers, { Accept: DATA_PREVIEW_ACCEPT, 'Content-Type': 'text/plain' });
  assert.equal(out.status, 200);
  assert.equal(out.table, 'T683S');
  assert.equal(out.bytes, Buffer.byteLength(FIXTURE));

  await assert.rejects(() => previewPost(raw, 'SELECT * FROM VBAK', 2), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'UPDATE T683S SET X = 1', 2), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'SELECT * FROM T683S', 0), SelectViolation);
  await assert.rejects(() => previewPost({}, 'SELECT * FROM T683S', 2), SelectViolation);
  assert.equal(sent.length, 1);

  // What buildSelect breaks goes out as it was built, line breaks included.
  const long = buildSelect({ table: 'T683S', fields: PFRM_FIELDS, where: [{ field: 'KOFRM', op: 'IN', value: PFRM16 }] }).sql;
  await previewPost(raw, long, 2);
  assert.equal(sent[1].body, long);
  // A line the server would cut, a line that opens as a comment, a CR, another table hidden on a second line.
  await assert.rejects(() => previewPost(raw, `SELECT * FROM T683S WHERE KSCHL IN ('${'Q'.repeat(250)}')`, 2), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'SELECT *\n* FROM T683S', 2), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'SELECT *\r\n  FROM T683S', 2), SelectViolation);
  await assert.rejects(() => previewPost(raw, 'SELECT * FROM T683S\n  WHERE X = 1 UNION SELECT * FROM VBAK', 2), SelectViolation);
  assert.equal(sent.length, 2);
});

test('previewPost reports the status the client hides in err', async () => {
  const raw = { httpClient: { request: async () => { throw Object.assign(new Error('nope'), { err: 406, localizedMessage: 'not acceptable' }); } } };
  await assert.rejects(() => previewPost(raw, 'SELECT * FROM T683S', 2), (e) => e.status === 406 && /406/.test(e.message));
});

// --- the parser --------------------------------------------------------------

test('parsePreview turns the column-major reply into rows, with the total the server counted', () => {
  const p = parsePreview(FIXTURE);
  assert.equal(p.totalRows, 7028);
  assert.match(p.executedQuery, /UP TO 2  ROWS/);
  assert.equal(p.executionTime, '0.2180000');
  assert.deepEqual(p.columns.map((c) => `${c.name}:${c.type}`), ['KALSM:C', 'STUNR:N', 'KOFRM:N']);
  assert.deepEqual(p.rows, [
    { KALSM: 'A10001', STUNR: '010', KOFRM: '0000000' },
    { KALSM: 'ZDEMO1', STUNR: '020', KOFRM: '0000953' },
  ]);
  assert.deepEqual(p.drift, []);
});

test('parsePreview: an empty data set is zero rows, and an unknown node or attribute is drift', () => {
  const empty = FIXTURE.replace(/<dataPreview:dataSet>.*?<\/dataPreview:dataSet>/g, '<dataPreview:dataSet/>').replace('7028', '0');
  const p = parsePreview(empty);
  assert.equal(p.totalRows, 0);
  assert.deepEqual(p.rows, []);
  assert.equal(p.columns.length, 3);

  const aged = FIXTURE.replace('</dataPreview:tableData>', '<dataPreview:warnings>x</dataPreview:warnings></dataPreview:tableData>').replace('dataPreview:colType=""', 'dataPreview:colType="" dataPreview:unit="EA"');
  const d = parsePreview(aged).drift;
  assert.ok(d.some((x) => x.node === 'warnings'));
  assert.ok(d.some((x) => x.attribute === 'unit'));
});

test('parsePreview: columns that disagree on the row count are drift, and the shortest wins', () => {
  const p = parsePreview(FIXTURE.replace('<dataPreview:data>0000953</dataPreview:data>', ''));
  assert.equal(p.rows.length, 1);
  assert.ok(p.drift.some((x) => x.node === 'dataSet'));
});

// --- routine columns ---------------------------------------------------------

test('routineColumnsOf resolves declared columns and patterns against the columns returned', () => {
  assert.deepEqual(routineColumnsOf('T683S', ['KVEWE', 'KOBED', 'KOFRM', 'KOFRA']), {
    columns: [{ column: 'KOBED', grpze: 'PBED' }, { column: 'KOFRM', grpze: 'PFRM' }, { column: 'KOFRA', grpze: 'PFRA' }],
    missing: [],
  });
  const tvcpa = routineColumnsOf('TVCPA', ['AUARN', 'GRBED', 'GRUAK', 'GRUAP', 'GRUKO']);
  assert.deepEqual(tvcpa.columns.map((c) => `${c.column}=${c.grpze}`), ['GRBED=ABED', 'GRUAK=ADAT', 'GRUAP=ADAT', 'GRUKO=ADAT']);
  assert.deepEqual(routineColumnsOf('T683S', ['KVEWE']).missing, ['KOBED', 'KOFRM', 'KOFRA']);
  assert.deepEqual(routineColumnsOf('NOPE', ['X']), { columns: [], missing: [] });
  assert.equal(padRoutine(953, 7), '0000953');
  assert.equal(padRoutine('953', 3), '953');
});

// Measured 2026-11-09: a literal holding the ABAP SQL keyword FIELDS ('PSM_FMFG_FIELDS_ITEM')
// makes the server answer totalRows 0 plus a <message>, beside the rows it did return. Asked
// for 1 row of 24, the reply read as "not truncated" -- a cut hidden by a count of 0.
const replyWith = ({ total, message, rows }) =>
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  `<dataPreview:totalRows>${total}</dataPreview:totalRows>` +
  (message ? '<dataPreview:message>count failed</dataPreview:message>' : '') +
  '<dataPreview:executedQueryString>SELECT OBJ_NAME FROM TADIR</dataPreview:executedQueryString>' +
  '<dataPreview:columns><dataPreview:metadata dataPreview:name="OBJ_NAME" dataPreview:type="C" dataPreview:description="OBJ_NAME" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>' +
  `<dataPreview:dataSet>${rows.map((r) => `<dataPreview:data>${r}</dataPreview:data>`).join('')}</dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>`;

test('a count the reply contradicts is unknown, and an unknown count at the cap is a possible cut', () => {
  const broken = parsePreview(replyWith({ total: 0, message: true, rows: ['ZDEMO_A'] }));
  assert.equal(broken.totalRows, null, 'never 0 beside a row');
  assert.match(broken.countNote, /not usable.*answered 0 with a message/);
  assert.deepEqual(broken.drift, [], 'message is a measured node, not drift');
  assert.equal(truncationOf(broken, 1), 'possible', 'as many rows as asked: may be cut');
  assert.equal(truncationOf(broken, 50), false, 'fewer than asked: nothing was cut');

  // Fewer counted than returned is impossible, with or without a message.
  assert.equal(parsePreview(replyWith({ total: 1, rows: ['ZDEMO_A', 'ZDEMO_B'] })).totalRows, null);

  // A usable count decides as before.
  const fine = parsePreview(replyWith({ total: 24, rows: ['ZDEMO_A'] }));
  assert.equal(fine.totalRows, 24);
  assert.equal(fine.countNote, undefined);
  assert.equal(truncationOf(fine, 1), true);
  assert.equal(truncationOf(parsePreview(replyWith({ total: 1, rows: ['ZDEMO_A'] })), 1), false);
});
