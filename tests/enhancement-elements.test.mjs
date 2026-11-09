// The resource that names the append structures, parsed from the replies the development system gave on
// 2026-09-22. All five fixtures are verbatim -- see docs/adt-api-reference.md,
// "enhancement/elements -- the resource that NAMES the appends".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnhancementElements, enhancementRouteFor, segmentFor } from '../lib/enhancement-elements.mjs';

const reply = (n) => readFileSync(join(import.meta.dirname, 'fixtures', `${n}.enhancement-elements.xml`), 'utf8');

test('the root is the subject and the children are the appends', () => {
  const r = parseEnhancementElements(reply('wbrf'));
  assert.deepEqual(r.subject, { name: 'wbrf', type: 'TABL/DT' });
  assert.deepEqual(r.appends.map((a) => a.name), [
    'wbrf_addon_di',
    'wbrf_addon_gt',
    'wbrf_append_ehp6',
    'zdemo_str_exit',
  ]);
  assert.equal(r.drift.length, 0);
  // The subject is never counted as one of its own appends.
  assert.equal(r.appends.some((a) => a.name === 'wbrf'), false);
});

test('an append with no shorttext is still an append -- that one is the Custom Fields case', () => {
  const r = parseEnhancementElements(reply('incl_eew_kna1'));
  const zz1 = r.appends.find((a) => a.name.startsWith('zz1_'));
  assert.ok(zz1, 'the key-user append was dropped');
  assert.equal(zz1.shortText, null, 'it carries no documentation, and that must not disqualify it');
  assert.equal(r.appends.find((a) => a.name === 'crms4_bp_kna1').shortText,
    'Service: Append Struc. for Add. BP Data in KNA1');
});

test('two customer appends on one structure stay two', () => {
  const r = parseEnhancementElements(reply('kompcv'));
  const z = r.appends.filter((a) => a.name.startsWith('z')).map((a) => a.name);
  assert.deepEqual(z, ['zdemo_app_kompcv1', 'zdemo_app_kompcv2'], 'they were flattened into one');
});

test('a namespaced append name comes back readable', () => {
  const r = parseEnhancementElements(reply('merep_outtab_purchdoc'));
  assert.ok(r.appends.some((a) => a.name === '/isdfps/merep_outtab_purchdoc'));
  // adtcore:name carries PLAIN slashes; it is adtcore:uri that uses the %2f wrapper. The two
  // attributes disagree on spelling, so the segment form is built by segmentFor, never copied.
  const ns = r.appends.find((a) => a.name === '/isdfps/merep_outtab_purchdoc');
  assert.equal(ns.raw, '/isdfps/merep_outtab_purchdoc');
  assert.match(ns.uri, /%2fisdfps%2fmerep_outtab_purchdoc/);
  assert.equal(segmentFor(ns.name), '%2fisdfps%2fmerep_outtab_purchdoc');
});

test('the structure KOMPAZ names ZDEMO_KOMPAZ -- the case no other read reaches', () => {
  // KOMG includes KOMPAZ, whose source has one field (PDUMMY) and whose real content is here.
  const r = parseEnhancementElements(reply('kompaz'));
  assert.ok(r.appends.some((a) => a.name === 'zdemo_kompaz'));
});

test('the route follows the object kind, and an unknown kind gets none', () => {
  assert.equal(enhancementRouteFor('table'), 'tableEnhancements');
  assert.equal(enhancementRouteFor('structure'), 'structureEnhancements');
  assert.equal(enhancementRouteFor(null), null);
  assert.equal(enhancementRouteFor('view'), null);
});

test('segmentFor writes a namespace the way the ADT does, and refuses anything else', () => {
  assert.equal(segmentFor('WBRF'), 'wbrf');
  assert.equal(segmentFor('/ISDFPS/MEREP_OUTTAB_PURCHDOC'), '%2fisdfps%2fmerep_outtab_purchdoc');
  // A name that would become a second path segment, or leave the alphabet, gets no segment at all
  // -- the caller then says so instead of sending a path it guessed.
  for (const bad of ['', '   ', 'a/b/c', '../x', 'x y', 'a'.repeat(31)]) {
    assert.equal(segmentFor(bad), null, `segmentFor accepted '${bad}'`);
  }
});

test('an empty or unparseable reply yields no appends and no invented subject', () => {
  assert.deepEqual(parseEnhancementElements('').appends, []);
  assert.deepEqual(parseEnhancementElements(null).subject, { name: null, type: null });
});
