// The active search: asking the system when the field's own words cannot reach the
// concept.
//
// The rows below keep the SHAPE and the PROPORTION measured on the system for T006 --
// 15,963 callers, 57 of them DDLS/DF, exactly one released -- because the whole design
// rests on that ratio: the reply is huge, almost none of it is an answer, and the
// filtering has to happen here rather than in the caller's context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCatalog } from '../lib/catalog.mjs';
import {
  conceptFromName,
  conceptViewsFrom,
  searchConceptEntities,
  conceptFromValueTable,
} from '../lib/concept-search.mjs';

const catalog = loadCatalog(path.join(import.meta.dirname, 'fixtures', 'catalog-mini.json'));

const row = (name, type = 'DDLS/DF', usage = 'gradeDirect') => ({
  'adtcore:name': name,
  'adtcore:type': type,
  usageInformation: usage,
});

test('conceptFromName strips the VDM prefix and any namespace', () => {
  assert.equal(conceptFromName('I_UnitOfMeasure'), 'UNITOFMEASURE');
  assert.equal(conceptFromName('C_ProductType'), 'PRODUCTTYPE');
  assert.equal(conceptFromName('/DMBE/I_UNITOFMEASURE'), 'UNITOFMEASURE');
  assert.equal(conceptFromName('I_Unit_Of_Measure'), 'UNITOFMEASURE');
  assert.equal(conceptFromName(undefined), '');
});

test('the VDM view outranks every other model reading the same table', () => {
  const found = conceptViewsFrom(
    [
      row('CL_SOMETHING', 'CLAS/OC'),
      row('/DMBE/I_UNITOFMEASURE'),
      row('SEPMRA_I_QUANTITYUNIT'),
      row('I_UNITOFMEASURE'),
    ],
    catalog
  );
  assert.equal(found.total, 4);
  assert.equal(found.cdsCallers, 3, 'the class is not a CDS caller');
  // Only I_UNITOFMEASURE is in the catalogue as released: the other two are another
  // application's namespace and demo content, and neither is released.
  assert.equal(found.released, 1);
  assert.deepEqual(found.views.map((v) => v.name), ['I_UNITOFMEASURE']);
});

test('a table nothing released reads is a stated dead end, not an empty answer', async () => {
  const api = {
    async usageReferences() {
      return [row('/DMBE/I_UNITOFMEASURE'), row('ZCL_LOCAL', 'CLAS/OC')];
    },
  };
  const spent = { calls: 0 };
  const found = await conceptFromValueTable(api, 'T006', catalog, spent, {
    resolve: async () => ({ hit: { 'adtcore:uri': '/sap/bc/adt/ddic/tables/t006' } }),
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /2 objects read T006/);
  assert.match(found.reason, /none of those is released/);
  assert.equal(spent.calls, 2, 'resolve + where-used, and nothing more');
});

test('a field with no value table cannot use this route, and costs nothing', async () => {
  const spent = { calls: 0 };
  const found = await conceptFromValueTable({}, undefined, catalog, spent, {
    resolve: async () => assert.fail('must not resolve'),
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /no value table/);
  assert.equal(spent.calls, 0);
});

test('a failing where-used is reported, never swallowed into "no value help"', async () => {
  const spent = { calls: 0 };
  const found = await conceptFromValueTable(
    {
      async usageReferences() {
        throw new Error('timeout');
      },
    },
    'T006',
    catalog,
    spent,
    { resolve: async () => ({ hit: { 'adtcore:uri': '/x' } }) }
  );
  assert.equal(found.ok, false);
  assert.match(found.reason, /where-used on T006 failed: timeout/);
  assert.equal(spent.calls, 2, 'the failed call is still charged to the budget');
});

test('the repository search is anchored and type-filtered, and keeps only released hits', async () => {
  const seen = [];
  const api = {
    async searchObject(query, objectType, max) {
      seen.push([query, objectType, max]);
      return query.startsWith('I_')
        ? [
            { 'adtcore:name': 'I_UNITOFMEASURE' },
            { 'adtcore:name': 'I_UNITOFMEASURESTDVH' },
            { 'adtcore:name': 'I_UNITOFMEASUREENHCD' }, // real, and NOT in the catalogue
          ]
        : [];
    },
  };
  const spent = { calls: 0 };
  const r = await searchConceptEntities(api, 'UNITOFMEASURE', catalog, spent);
  assert.equal(r.ok, true);
  // ⚠️ Anchored, never `*CONCEPT*`: measured live, `*UNITOFMEASURE*` capped at 60 comes
  // back truncated ALPHABETICALLY, stopping before I_UNITOFMEASURESTDVH with nothing to
  // say it dropped anything.
  assert.deepEqual(seen.map((s) => s[0]), ['I_UNITOFMEASURE*', 'C_UNITOFMEASURE*']);
  assert.ok(seen.every((s) => s[1] === 'DDLS/DF'), 'the type pre-filter is what makes it cheap');
  // Value-help shaped first, and the unreleased hit is gone -- the system search knows
  // nothing about Clean Core, so the catalogue is still the gate.
  assert.deepEqual(r.names, ['I_UNITOFMEASURESTDVH', 'I_UNITOFMEASURE']);
  assert.equal(spent.calls, 2);
});

test('a search that hit its cap says so, because the missing answer would be invisible', async () => {
  const api = {
    async searchObject(query, objectType, max) {
      return Array.from({ length: max }, (_, i) => ({ 'adtcore:name': `X_NOTHING_${i}` }));
    },
  };
  const r = await searchConceptEntities(api, 'PRODUCT', catalog, { calls: 0 }, { max: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.truncated, true);
  assert.match(r.reason, /hit its cap of 5/);
});

test('a search that fails is reported with the query that failed', async () => {
  const api = {
    async searchObject() {
      throw new Error('HTTP 500');
    },
  };
  const spent = { calls: 0 };
  const r = await searchConceptEntities(api, 'PLANT', catalog, spent);
  assert.equal(r.ok, false);
  assert.match(r.reason, /I_PLANT\*: HTTP 500/);
  assert.equal(spent.calls, 1);
});
