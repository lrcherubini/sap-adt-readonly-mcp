// objectproperties: the flat facet list measured on the three ENHO/XH (2026-09-14).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseObjectProperties, isClasenh, clasenhGap } from '../lib/object-properties.mjs';

const XML = fs.readFileSync(new URL('./fixtures/object-properties-measured.xml', import.meta.url), 'utf8');

test('the measured body: object header, package chain root-first, parent, owner, dates; no drift', () => {
  const p = parseObjectProperties(XML);
  assert.deepEqual(p.object, { name: 'ZDEMO_CLASENH', type: 'ENHO/XH', package: 'ZDEMO_PKG', text: 'Demo class enhancement' });
  assert.deepEqual(p.packagePath, ['YDEMO_ROOT', 'YDEMO_BASIS', 'ZDEMO_PKG']);
  assert.equal(p.parentPackage, 'YDEMO_BASIS');
  assert.equal(p.owner, 'DEMOUSER');
  assert.equal(p.apiState, 'NOT_RELEASED');
  assert.equal(p.language, 'EN');
  assert.equal(p.version, 'ACTIVE');
  assert.equal(p.created, '20190620');
  assert.equal(p.component, 'HOME');
  assert.equal(p.applicationComponent, null, "'-' is no component");
  assert.equal(p.properties.length, 18);
  assert.deepEqual(p.drift, []);
});

test('an unknown facet or element is drift, never a guess; a root package has no parent; empty is empty', () => {
  const p = parseObjectProperties(XML.replace('facet="COMP"', 'facet="NEWFACET"').replace('<opr:property facet="DOCU"', '<opr:extra/><opr:property facet="DOCU"'));
  assert.deepEqual(p.drift, [
    { node: 'opr:extra', count: 1, where: 'objectProperties' },
    { node: 'facet NEWFACET', count: 1, where: 'objectProperties' },
  ]);
  assert.equal(p.component, null);
  const root = parseObjectProperties(XML.replace(/<opr:property facet="PACKAGE" name="(YDEMO_ROOT|YDEMO_BASIS)"[\s\S]*?<\/opr:property>/g, ''));
  assert.deepEqual(root.packagePath, ['ZDEMO_PKG']);
  assert.equal(root.parentPackage, null);
  const e = parseObjectProperties('');
  assert.equal(e.object.name, null);
  assert.deepEqual(e.packagePath, []);
  assert.equal(e.owner, null);
});

test('isClasenh names ENHO/XH only, and the gap is one code with the place the code is', () => {
  assert.equal(isClasenh('ENHO/XH'), true);
  assert.equal(isClasenh('enho/xh'), true);
  assert.equal(isClasenh('ENHO/XHH'), false);
  assert.equal(isClasenh('ENHO/XHB'), false);
  assert.equal(isClasenh(undefined), false);
  const gaps = [];
  clasenhGap({ gap: (g) => gaps.push(g) }, 'ZX', 'why');
  assert.equal(gaps[0].code, 'CLASENH_NOT_IN_ADT');
  assert.equal(gaps[0].subject, 'ZX');
  assert.match(gaps[0].fallback, /SE19/);
  clasenhGap(undefined, 'ZX', 'why');
});
