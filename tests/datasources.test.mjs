// What a CDS file reads, parsed from the file.
//
// Every case here is a shape that EXISTS in the 24 ABAP checkouts of a measured workspace,
// not a shape a CDS grammar allows in theory. The two that cost the most if got wrong:
// a `--` comment (production, zdemo_assort) hiding a `select from`, and `redirected
// to` being counted as an association, which is how a first measurement over-reported
// dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataSourcesFrom, definitionOf, byName } from '../lib/datasources.mjs';

const names = (hits) => hits.map((h) => h.name);
const of = (hits, kind) => hits.filter((h) => h.kind === kind).map((h) => h.name);

test('the four ways a view names a source are read apart', () => {
  const src = `
define view entity ZI_Demo
  as select from I_Product as p
  inner join   mara       as m on m.matnr = p.Product
  association [0..1] to I_ProductGroup_2 as _Group on _Group.ProductGroup = p.ProductGroup
  composition of ZI_DemoItem as _Item
{ key p.Product }
`;
  const hits = dataSourcesFrom(src, 'z/zi_demo.ddls.asddls');
  assert.deepEqual(of(hits, 'from'), ['I_Product']);
  assert.deepEqual(of(hits, 'join'), ['mara']);
  assert.deepEqual(of(hits, 'association'), ['I_ProductGroup_2']);
  assert.deepEqual(of(hits, 'composition'), ['ZI_DemoItem']);
  assert.equal(hits.every((h) => h.file === 'z/zi_demo.ddls.asddls'), true);
  assert.equal(hits.some((h) => 'alias' in h), false, 'no alias unless asked: the scan rows keep their shape');
});

test('aliases are read on request, after parameters too, and never from `as select`', () => {
  const src = `
define view entity ZI_Demo with parameters p_date : abap.dats
  as select from ZI_DemoSrc( p_date : $parameters.p_date ) as s
  left outer join mara on mara.matnr = s.Product
  association [0..1] to I_ProductGroup_2 as _Group on _Group.ProductGroup = s.ProductGroup
{ key s.Product }
`;
  const hits = dataSourcesFrom(src, null, { aliases: true });
  const alias = Object.fromEntries(hits.map((h) => [h.name, h.alias ?? null]));
  assert.deepEqual(alias, { ZI_DemoSrc: 's', mara: null, I_ProductGroup_2: null });
});

test('redirected to is its own kind, never folded into association', () => {
  // The measurement that produced this module counted `redirected to` as an
  // association and over-reported the dependency count. A projection repointing an
  // inherited association is not a new read of that entity.
  const src = `
define view entity ZC_Order as projection on ZR_OrderTP
{ key OrderId, _Item : redirected to composition child ZC_OrderItem }
`;
  const hits = dataSourcesFrom(src);
  assert.deepEqual(of(hits, 'projection'), ['ZR_OrderTP']);
  assert.deepEqual(of(hits, 'redirected'), ['ZC_OrderItem']);
  assert.deepEqual(of(hits, 'association'), []);
});

test('a -- comment hides a source, exactly as // does', () => {
  // Both forms are in production in a measured workspace, and one real file carries
  // `as select from` inside a comment. Counting it would invent a dependency.
  const src = `
-- as select from I_ShouldNotAppear
// as select from I_NeitherShouldThis
/* join I_NorThis */
define view entity ZI_X as select from I_Real { key a }
`;
  assert.deepEqual(names(dataSourcesFrom(src)), ['I_Real']);
});

test('extend view names the view being extended', () => {
  const src = 'extend view entity I_Product with ZE_ProductExt { zzfield }';
  const hits = dataSourcesFrom(src);
  assert.deepEqual(of(hits, 'extend'), ['I_Product']);
  assert.deepEqual(definitionOf(src), { name: 'ZE_ProductExt', kind: 'extend' });
});

test('a namespaced name survives intact', () => {
  const hits = dataSourcesFrom('define view entity ZI_W as select from /scwm/ordim_c { a }');
  assert.deepEqual(names(hits), ['/scwm/ordim_c']);
  assert.equal(hits[0].custom, false, 'a /NAMESPACE/ object is not ours');
});

test('casing is preserved and Z detection is case-insensitive', () => {
  // I_Productqm and I_Businesspartnertaxnumber are written that way in real sources.
  const hits = dataSourcesFrom('define view entity zi_a as select from I_Productqm { a }');
  assert.equal(hits[0].name, 'I_Productqm');
  assert.equal(definitionOf('define view entity zi_a as select from x { a }').name, 'zi_a');
});

test('a parameterised source yields the entity, not the parameters', () => {
  const hits = dataSourcesFrom("define view entity ZI_P as select from ZI_Q( p_date : $session.system_date ) { a }");
  assert.deepEqual(names(hits), ['ZI_Q']);
});

test('lines are reported for the citation, and repeats on one line collapse', () => {
  const src = ['define view entity ZI_L', '  as select from I_A', '  inner join I_B on 1 = 1', '{ a }'].join('\n');
  const hits = dataSourcesFrom(src, 'f.asddls');
  assert.deepEqual(
    hits.map((h) => `${h.name}:${h.line}`),
    ['I_A:2', 'I_B:3']
  );
});

test('definitionOf reads the three shapes a CDS file can have', () => {
  assert.deepEqual(definitionOf('define root view entity ZR_XTP as select from a { b }'), {
    name: 'ZR_XTP',
    kind: 'view entity',
  });
  assert.deepEqual(definitionOf('define view entity ZC_X as projection on ZR_XTP { b }'), {
    name: 'ZC_X',
    kind: 'projection',
  });
  assert.deepEqual(definitionOf('annotate entity ZC_X with { field; }'), {
    name: 'ZC_X',
    kind: 'annotate',
  });
  assert.deepEqual(definitionOf('-- nothing here'), { name: null, kind: null });
});

test('byName collapses a name to one entry keeping every citation', () => {
  const hits = dataSourcesFrom(
    'define view entity ZI_D as select from I_A\n inner join I_A on 1 = 1\n{ a }',
    'f.asddls'
  );
  const rows = byName(hits);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].kinds, ['from', 'join']);
  assert.equal(rows[0].at.length, 2);
});
