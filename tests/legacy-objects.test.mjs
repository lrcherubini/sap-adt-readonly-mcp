import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyKindOf, conditionFor, readLegacyObjects, GUIDANCE } from '../lib/legacy-objects.mjs';

// A data-preview reply in the measured column-major shape, echoing the statement it was sent.
const col = (name, values) =>
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
  (values.length ? `<dataPreview:dataSet>${values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join('')}</dataPreview:dataSet>` : '<dataPreview:dataSet/>') +
  '</dataPreview:columns>';
const reply = (sql, columns, total) => {
  const n = Object.values(columns)[0]?.length ?? 0;
  const esc = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `<dataPreview:totalRows>${total ?? n}</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>` +
    `<dataPreview:executedQueryString>${esc} INTO TABLE @DATA(LT_RESULT) UP TO 200 ROWS .</dataPreview:executedQueryString>` +
    '<dataPreview:queryExecutionTime>0.1</dataPreview:queryExecutionTime>' +
    Object.entries(columns).map(([k, v]) => col(k, v)).join('') + '</dataPreview:tableData>';
};
/** A raw client that answers each SELECT by the first rule whose regex matches it. */
function rawOf(rules, sent = []) {
  return {
    httpClient: {
      request: async (url, c) => {
        const sql = String(c.body).replace(/\s+/g, ' ').trim();
        sent.push(sql);
        const rule = rules.find(([re]) => re.test(sql));
        if (!rule) throw Object.assign(new Error('no rule'), { err: 500 });
        return { status: 200, body: reply(sql, rule[1], rule[2]), headers: {} };
      },
    },
  };
}

test('only APLO and CHKV have legacy objects, and a query becomes LIKE or =, never SQL', () => {
  assert.equal(legacyKindOf('APLO/TYP'), 'APLO');
  assert.equal(legacyKindOf('chkv'), 'CHKV');
  assert.equal(legacyKindOf('CLAS/OC'), null);
  assert.deepEqual(conditionFor('OBJECT', 'z*'), { field: 'OBJECT', op: 'LIKE', value: 'Z*' });
  assert.deepEqual(conditionFor('OBJECT', 'ZDEMO_LOG'), { field: 'OBJECT', op: '=', value: 'ZDEMO_LOG' });
  assert.equal(conditionFor('OBJECT', "Z%' OR 1=1"), null);
});

test('APLO: BALOBJ minus TADIR R3TR APLO are the SLG0 objects, with their texts', async () => {
  const sent = [];
  const raw = rawOf([
    [/FROM BALOBJ WHERE/, { OBJECT: ['ZDEMO_APP_LOG', 'ZDEMO_JOB_LOG', 'ZDEMO_RATES'] }],
    [/FROM TADIR/, { OBJ_NAME: ['ZDEMO_RATES'] }],
    [/FROM BALOBJT/, { SPRAS: ['P', 'E', 'E'], OBJECT: ['ZDEMO_APP_LOG', 'ZDEMO_APP_LOG', 'ZDEMO_JOB_LOG'], OBJTXT: ['Texto', 'Application log', 'Job log'] }],
  ], sent);
  const out = await readLegacyObjects(raw, 'APLO', 'Z*', { language: 'EN' });
  assert.equal(out.kind, 'SLG0');
  assert.deepEqual(out.objects, [
    { name: 'ZDEMO_APP_LOG', description: 'Application log' },
    { name: 'ZDEMO_JOB_LOG', description: 'Job log' },
  ]);
  assert.equal(out.adtObjectsMatched, 1);
  assert.equal(out.complete, true);
  assert.equal(out.guidance, GUIDANCE.APLO);
  assert.equal(sent[0], "SELECT OBJECT FROM BALOBJ WHERE OBJECT LIKE 'Z%' ESCAPE '#'");
  assert.equal(sent[1], "SELECT OBJ_NAME FROM TADIR WHERE PGMID = 'R3TR' AND OBJECT = 'APLO' AND OBJ_NAME LIKE 'Z%' ESCAPE '#'");
  // The logon language first, English as the fallback.
  const pt = await readLegacyObjects(raw, 'APLO', 'Z*', { language: 'PT' });
  assert.equal(pt.objects[0].description, 'Texto');
});

test('CHKV: SCI variants, global with text and local by name only -- no user is ever selected', async () => {
  const sent = [];
  const raw = rawOf([
    [/FROM SCICHKV_HD .*CIUSER = ' '/, { CHECKVNAME: ['DEFAULT', 'ZDEMO_GLOBAL'], CHECKVID: ['00001', '00010'] }],
    [/FROM SCICHKV_HD .*CIUSER <> ' '/, { CHECKVNAME: ['ZDEMO_LOCAL', 'ZDEMO_LOCAL'] }],
    [/FROM SCICHKV_TX/, { LANGUAGE: ['E'], CHECKVID: ['00010'], TEXT: ['Demo governance'] }],
  ], sent);
  const out = await readLegacyObjects(raw, 'CHKV', '*', { language: 'EN' });
  assert.equal(out.kind, 'SCI');
  assert.deepEqual(out.objects, [
    { name: 'DEFAULT', scope: 'global', description: null },
    { name: 'ZDEMO_GLOBAL', scope: 'global', description: 'Demo governance' },
    { name: 'ZDEMO_LOCAL', scope: 'local', description: null },
  ]);
  assert.ok(sent.every((s) => !/SELECT [^F]*\b(CIUSER|UNAM)\b[^F]*FROM/.test(s)), 'no user column in any select list');
  assert.ok(sent.every((s) => / IS_CHKV = ' '/.test(s) || /SCICHKV_TX/.test(s)), 'ADT-created (CHKV) variants are not legacy');
});

test('a capped read is complete: false, and a failed read files the gap and says nothing about legacy', async () => {
  const capped = rawOf([
    [/FROM BALOBJ WHERE/, { OBJECT: ['ZDEMO_A'] }, 342],
    [/FROM TADIR/, { OBJ_NAME: [] }],
    [/FROM BALOBJT/, { SPRAS: [], OBJECT: [], OBJTXT: [] }],
  ]);
  const c = await readLegacyObjects(capped, 'APLO', '/*');
  assert.equal(c.complete, false);

  const gaps = [];
  const failed = await readLegacyObjects(rawOf([]), 'APLO', 'Z*', { gap: (g) => gaps.push(g) });
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.objects, []);
  assert.match(failed.note, /not read/);
  assert.equal(gaps[0].code, 'LEGACY_OBJECTS_NOT_READ');
  assert.match(gaps[0].impact, /NOTHING is said about the legacy ones/);

  const odd = await readLegacyObjects(rawOf([]), 'CHKV', "Z' OR 1=1");
  assert.match(odd.note, /not searched/);
});
