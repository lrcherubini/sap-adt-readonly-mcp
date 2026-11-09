// Where-used reduction. The input sizes and the type mix here are the ones MEASURED on
// `usageReferences('I_PlantStdVH')`: 1,531 rows, 356 KB, and the distribution
// 432 DEVC/K · 354 DDLS/DF · 316 CLAS/OC · 188 CLAS/OM · 52 DDLX/EX · 9 SRVD/SRV ·
// 1 SHLP/DH. The rows themselves are generated to that shape -- the reply was too large
// to keep as a fixture, which is the whole reason this module exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage, precedentCandidates, CDS_TYPES } from '../lib/usage.mjs';

/** Build a where-used list with the measured mix. */
function measuredShape() {
  const rows = [];
  const add = (n, type, name, usage) => {
    for (let i = 0; i < n; i++) {
      rows.push({
        'adtcore:name': `${name}${i}`,
        'adtcore:type': type,
        usageInformation: usage,
        packageRef: { 'adtcore:name': 'ODATA_MM_IM' },
        uri: `/sap/bc/adt/x/${name}${i}`,
      });
    }
  };
  add(432, 'DEVC/K', 'PKG', 'gradeDirect,includeProductive');
  add(270, 'DDLS/DF', 'C_Consumer', 'gradeDirect,includeProductive');
  add(70, 'DDLS/DF', 'I_Other', 'gradeComponent,includeProductive');
  add(14, 'DDLS/DF', 'C_TestView', 'gradeDirect,includeTest');
  add(316, 'CLAS/OC', 'CL_X', 'gradeDirect,includeProductive');
  add(188, 'CLAS/OM', 'CL_Y', 'gradeDirect,includeProductive');
  add(52, 'DDLX/EX', 'C_Ext', 'gradeDirect,includeProductive');
  add(9, 'SRVD/SRV', 'UI_SRV', 'gradeDirect,includeProductive');
  add(1, 'SHLP/DH', 'H_PLANT', 'gradeDirect,includeProductive');
  return rows;
}

test('a 1,352-row where-used comes back as a bounded summary, never a dump', () => {
  const rows = measuredShape();
  const s = summarizeUsage(rows);
  assert.equal(s.total, rows.length);
  assert.equal(s.rows.length, 20, 'the default cap');
  assert.equal(s.truncated, true);
  // Only the CDS types survive, direct and productive: 270 C_* + 52 extensions.
  assert.equal(s.kept, 322);
  assert.equal(s.byType['DEVC/K'], 432, 'the full distribution is still reported');
  assert.match(s.note, /322 of them DDLS\/DF\/DDLX\/EX and direct; showing 20 \(capped at 20\)/);
  // The serialised summary has to be small enough to return: the raw reply was 356 KB.
  assert.ok(JSON.stringify(s).length < 8000, JSON.stringify(s).length);
});

test('the filter drops what it drops for a stated reason', () => {
  const s = summarizeUsage(measuredShape());
  assert.equal(s.dropped['type not in DDLS/DF/DDLX/EX'], 432 + 316 + 188 + 9 + 1);
  assert.equal(s.dropped['not a direct usage'], 70, 'gradeComponent');
  assert.equal(s.dropped['test code'], 14, 'includeTest');
  assert.equal(
    Object.values(s.dropped).reduce((a, b) => a + b, 0) + s.kept,
    s.total,
    'every row is either kept or accounted for'
  );
});

test('our own consumers are ranked ahead of the standard ones', () => {
  const s = summarizeUsage([
    { name: 'C_StandardThing', type: 'DDLS/DF', usage: 'gradeDirect' },
    { name: 'I_Something', type: 'DDLS/DF', usage: 'gradeDirect' },
    { name: 'ZC_DemoItemRating', type: 'DDLS/DF', usage: 'gradeDirect' },
  ]);
  assert.deepEqual(s.rows.map((r) => r.name), [
    'ZC_DemoItemRating',
    'C_StandardThing',
    'I_Something',
  ]);
});

test('both row shapes are accepted: the raw ADT reply and the mapped one', () => {
  const raw = summarizeUsage([
    {
      'adtcore:name': 'C_X',
      'adtcore:type': 'DDLS/DF',
      usageInformation: 'gradeDirect',
      packageRef: { 'adtcore:name': 'PKG' },
    },
  ]);
  const mapped = summarizeUsage([
    { name: 'C_X', type: 'DDLS/DF', usage: 'gradeDirect', package: 'PKG' },
  ]);
  assert.deepEqual(raw.rows, mapped.rows);
  assert.equal(raw.rows[0].package, 'PKG');
});

test('a row whose grade the system did not state is kept and counted, not dropped', () => {
  // Silently discarding these would shrink the evidence for a reason the system never
  // gave. They are kept, and the note says how many.
  const s = summarizeUsage([
    { name: 'C_A', type: 'DDLS/DF', usage: '' },
    { name: 'C_B', type: 'DDLS/DF' },
  ]);
  assert.equal(s.kept, 2);
  assert.deepEqual(s.dropped, {});
  assert.match(s.note, /2 kept with no grade stated by the system/);
});

test('an empty where-used is an empty summary, not an error', () => {
  const s = summarizeUsage([]);
  assert.equal(s.total, 0);
  assert.equal(s.kept, 0);
  assert.equal(s.truncated, false);
  assert.deepEqual(s.rows, []);
  assert.deepEqual(summarizeUsage(undefined).rows, []);
});

test('the cap is honoured, including zero', () => {
  const rows = measuredShape();
  assert.equal(summarizeUsage(rows, { cap: 3 }).rows.length, 3);
  assert.equal(summarizeUsage(rows, { cap: 0 }).rows.length, 0);
  assert.equal(summarizeUsage(rows, { cap: 0 }).truncated, true);
  assert.equal(summarizeUsage(rows, { cap: 10000 }).truncated, false);
});

test('the filters can be widened deliberately', () => {
  const rows = measuredShape();
  const all = summarizeUsage(rows, { types: [], requireDirect: false, cap: 10000 });
  assert.equal(all.kept, rows.length - 14, 'only the test code still goes');
  const classes = summarizeUsage(rows, { types: ['CLAS/OC'], cap: 10000 });
  assert.equal(classes.kept, 316);
  assert.deepEqual(CDS_TYPES, ['DDLS/DF', 'DDLX/EX']);
});

test('precedent candidates are DDLS only and respect the read budget', () => {
  const s = summarizeUsage(measuredShape());
  const c = precedentCandidates(s, 2);
  assert.equal(c.length, 2);
  assert.ok(c.every((r) => r.type === 'DDLS/DF'));
  assert.equal(precedentCandidates(s, 0).length, 0, 'a zero budget spends no ADT call');
  assert.deepEqual(precedentCandidates(undefined), []);
});
