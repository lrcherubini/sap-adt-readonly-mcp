// The DDIC-active field list, folded out of a `ddicElement` reply.
//
// Both fixtures are VERBATIM replies read from the development system on 2026-09-22 (docs/adt-api-reference.md,
// "On a TABLE the answer is FLAT and includes the appends"). WBRF is the reconciliation case: its
// four `.append` markers were matched one by one against the source of each append, and the pairing
// held 4 of 4. KOMPAZ is the structure that answers an empty tree -- kept as a fixture because the
// empty tree is a MEASUREMENT, and a parser that reads it as "no fields" is the defect this file
// exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { foldDdicElement, compareViews, parseTableMeta } from '../lib/table-meta.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, 'fixtures', n), 'utf8'));

const WBRF = fixture('wbrf.ddicelement.json');
const KOMPAZ = fixture('kompaz.ddicelement.json');

test('the package is not a field', () => {
  const f = foldDdicElement(WBRF);
  assert.equal(f.package, 'WZRE');
  assert.equal(
    f.fields.some((x) => x.name === 'WZRE'),
    false,
    'the DEVC/K child was counted as a field'
  );
  // 33 children = 27 fields + 5 markers + 1 package.
  assert.equal(f.fields.length, 27);
});

test('markers split the list into blocks, and a block may own no field at all', () => {
  const f = foldDdicElement(WBRF);
  const markers = f.blocks.map((b) => b.marker);
  assert.deepEqual(markers, [null, '.append', '.append', '.include', '.append', '.append']);

  // Block 0 is the table's own fields; the rest is what each block contributed.
  assert.deepEqual(
    f.blocks.map((b) => b.fields.length),
    [19, 1, 0, 3, 2, 2],
    'the zero-field block is WBRF_ADDON_GT, whose whole body is `include wb2b_cond_key` -- ' +
      'the .include that follows it. A block is the fields UNTIL the next marker, never the next field.'
  );
});

test('the fields of a block are the ones measured against each append source', () => {
  const f = foldDdicElement(WBRF);
  const of = (i) => f.blocks[i].fields.map((x) => x.name);
  assert.deepEqual(of(1), ['CORR_DOCUMENT'], 'WBRF_ADDON_DI');
  assert.deepEqual(of(3), ['KNUMH', 'KOPOS', 'COCO_NUM'], 'the include inside WBRF_ADDON_GT');
  assert.deepEqual(of(4), ['SETTLEMENT_DATE', 'SETTL_DATE_SEQ_ID'], 'WBRF_APPEND_EHP6');
  assert.deepEqual(of(5), ['DT_COMP', 'ST_COMP'], 'ZDEMO_STR_EXIT, the customer append');
});

test('field properties survive the fold', () => {
  const f = foldDdicElement(WBRF);
  const dt = f.fields.find((x) => x.name === 'DT_COMP');
  assert.equal(dt.dataElement, 'AUGDT');
  assert.equal(dt.isKey, false);
  assert.equal(dt.marker, '.append');
  const key = f.fields.find((x) => x.name === 'MANDT');
  assert.equal(key.isKey, true);
  assert.equal(key.dataType, 'CLNT');
  assert.equal(key.length, 3);
});

test('an empty tree is NOT a table without fields', () => {
  const f = foldDdicElement(KOMPAZ);
  assert.equal(f.ok, false);
  assert.equal(f.fields.length, 0);
  assert.match(f.why, /NOT evidence/);
  // The whole point: a caller that reads `fields.length === 0` as an answer must be stopped by `ok`.
  assert.equal(compareViews([{ name: 'PDUMMY' }], f).available, false);
});

test('compareViews isolates the fields that reach the table from outside any source', () => {
  // The WBRF source names its own 19 fields and no append -- an append is invisible in the base
  // source, which is the entire reason the second view exists.
  const sourceFields = foldDdicElement(WBRF).blocks[0].fields;
  const cmp = compareViews(sourceFields, foldDdicElement(WBRF));
  assert.equal(cmp.available, true);
  assert.equal(cmp.appendMarkers, 4);
  assert.deepEqual(cmp.fromOutside.map((f) => f.name), [
    'CORR_DOCUMENT',
    'KNUMH',
    'KOPOS',
    'COCO_NUM',
    'SETTLEMENT_DATE',
    'SETTL_DATE_SEQ_ID',
    'DT_COMP',
    'ST_COMP',
  ]);
  // DT_COMP and ST_COMP are customer fields with no Z anywhere in the FIELD name. Only the append
  // is called ZDEMO_STR_EXIT -- which is why no name heuristic can find them.
  assert.equal(
    cmp.fromOutside.every((f) => !/^(ZZ|Y)/.test(f.name)),
    true
  );
});

test('a field the source has and the active table does not is reported, never dropped', () => {
  const cmp = compareViews([{ name: 'GHOST_FIELD' }], foldDdicElement(WBRF));
  assert.deepEqual(cmp.missingFromDdic, ['GHOST_FIELD']);
});

test('a table source still cannot see its own append -- the two views are not redundant', () => {
  // Sanity: the parser and the fold answer different questions about the same object.
  const meta = parseTableMeta(
    "@EndUserText.label : 'x'\n@AbapCatalog.deliveryClass : #A\ndefine table wbrf {\n  key mandt : mandt;\n  ruuid : sysuuid_x16;\n}"
  );
  assert.equal(
    meta.fields.some((f) => f.name === 'DT_COMP'),
    false,
    'if a source read ever names an append field, this whole second view can be deleted'
  );
});
