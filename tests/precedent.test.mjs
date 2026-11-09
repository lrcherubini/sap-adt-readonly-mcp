// Precedent on disk.
//
// tests/fixtures/precedent/ mirrors the two roots the tool really scans (ABAP checkouts and a
// folder of exported standard sources), with synthetic blocks shaped like the measured ones:
//
//   zdemo_item_rating/  the five parameter edges of zc_demoitemrating, one of which
//                    carries the additionalBinding shape seen in real checkouts
//   zdemo_assort/  a value help on a PARAMETER inside a DDLX (bare name, no type)
//   zdemo_roster/   a customer convention, value split over two lines, comments between
//   object_dumps/    two standard edges, one behind a GENERATED marker, both with a
//                    further annotation between the value help and the element
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { edgesFromText, parseVhdValue } from '../lib/precedent.mjs';

/** Every value-help edge in the fixture sources -- the texts the system would return for them. */
function fixtureEdges(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(...edgesFromText(fs.readFileSync(full, 'utf8'), path.relative(path.join(import.meta.dirname, '..'), full).split(path.sep).join('/')));
    }
  };
  walk(dir);
  return out;
}

const ROOT = path.join(import.meta.dirname, 'fixtures', 'precedent');
const edges = fixtureEdges(ROOT);
const by = (name) => edges.filter((e) => e.entity === name);
const precedentFor = (name) => edges.filter((e) => e.entity.toUpperCase() === String(name).toUpperCase());

test('every edge in the fixtures is found, and nothing else', () => {
  assert.equal(edges.length, 10);
  assert.equal(new Set(edges.map((e) => e.file)).size, 4, 'from four sources');
});

test('an element edge is attributed to the element that follows it', () => {
  const [cpf] = by('ZI_DemoRosterTaxIdVH');
  assert.equal(cpf.element, 'Stcd2');
  assert.equal(cpf.kind, 'element');
  assert.equal(cpf.entityElement, 'Stcd2');
  assert.match(cpf.file, /zc_demorostermonitor\.ddls\.asddls$/);
  assert.equal(typeof cpf.line, 'number');
});

test('a parameter edge is recognised as a parameter, in both syntaxes', () => {
  // `P_Plant : werks_d` in a view, and a bare `p_channel` under `parameters` in a DDLX.
  const [plant] = by('I_Plant');
  assert.equal(plant.element, 'P_Plant');
  assert.equal(plant.kind, 'parameter');

  const [channel] = by('ZI_DemoChannel');
  assert.equal(channel.element, 'p_channel');
  assert.equal(channel.kind, 'parameter', 'a DDLX parameter is not an element');
  assert.match(channel.file, /\.asddlxs$/);
});

test('an annotation between the value help and the element does not break attribution', () => {
  // The standard dumps put @ObjectModel.foreignKey.association in between.
  const [billing] = by('I_BillingDocumentStdVH');
  assert.equal(billing.element, 'CancelledBillingDocument');
  const [customer] = by('I_Customer_VH');
  assert.equal(customer.element, 'PayerParty');
  assert.equal(customer.entityElement, 'Customer');
});

test('additionalBinding is captured with its usage enum, unevaluated', () => {
  const [loc] = by('I_StorageLocation');
  assert.deepEqual(loc.additionalBinding, [
    { localElement: 'P_Plant', element: 'Plant', usage: '#FILTER_AND_RESULT' },
  ]);
  assert.match(loc.file, /zc_demoitemrating\.ddls\.asddls$/);
});

test('an entity with no binding precedent shows none, not an invented binding', () => {
  // This null is what makes the tool say "the binding depends on the consuming view".
  assert.ok(by('I_Plant').every((e) => !e.additionalBinding?.length));
  assert.deepEqual(precedentFor('I_NeverSeen'), []);
});

test('lookup is case-insensitive, because the catalogue is uppercase', () => {
  assert.equal(precedentFor('i_storagelocation').length, 1);
  assert.equal(precedentFor('I_STORAGELOCATION').length, 1);
});

test('a commented-out binding is not a precedent', () => {
  const edges = edgesFromText(`
    define view entity ZC_X as select from Y {
      // @Consumption.valueHelpDefinition: [{ entity: { name: 'I_Dead', element: 'D' } }]
      @Consumption.valueHelpDefinition: [{ entity: { name: 'I_Live', element: 'L' } }]
      key Field
    }
  `);
  assert.deepEqual(edges.map((e) => e.entity), ['I_Live']);
});

test('several definitions in one annotation are several edges', () => {
  const recs = parseVhdValue(
    "[{ entity: { name: 'I_A', element: 'A' }, qualifier: 'Q1' }, " +
      "{ entity: { name: 'I_B', element: 'B' } }]"
  );
  assert.equal(recs.length, 2);
  assert.equal(recs[0].qualifier, 'Q1');
  assert.equal(recs[1].entity.name, 'I_B');
});

test('the entity element and a binding element are not confused for each other', () => {
  const [rec] = parseVhdValue(
    "[{ entity: { name: 'I_StorageLocation', element: 'StorageLocation' }, " +
      "additionalBinding: [ { localElement: 'P_Plant', element: 'Plant', usage: #FILTER } ] }]"
  );
  assert.equal(rec.entity.element, 'StorageLocation');
  assert.equal(rec.additionalBinding[0].element, 'Plant');
});

test('a value that is not a value help definition yields nothing', () => {
  assert.deepEqual(parseVhdValue(''), []);
  assert.deepEqual(parseVhdValue('[{ label: "no entity" }]'), []);
  assert.deepEqual(edgesFromText('define view entity X as select from Y { key A }'), []);
});
