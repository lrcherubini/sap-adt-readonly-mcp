// lib/object-shape.mjs: the object document and the outline, without the ADT's namespaces,
// epoch dates or URI-fragment positions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectOf, propertiesOf, outlineOf, positionOf, isoOf, objectOfUri } from '../lib/object-shape.mjs';

test('the object a URI names, for the collections read; anything else is null', () => {
  assert.deepEqual(objectOfUri('/sap/bc/adt/oo/classes/zcx_demo_error/source/main#start=1,6'), { name: 'ZCX_DEMO_ERROR', type: 'CLAS/OC' });
  assert.deepEqual(objectOfUri('adt://DEV/sap/bc/adt/oo/interfaces/zif_demo'), { name: 'ZIF_DEMO', type: 'INTF/OI' });
  assert.deepEqual(objectOfUri('/sap/bc/adt/functions/groups/zdemo_fg/fmodules/z_demo_fm/source/main'), { name: 'Z_DEMO_FM', type: 'FUGR/FF' });
  assert.deepEqual(objectOfUri('/sap/bc/adt/ddic/dataelements/%2fdmo%2fcarrier_id'), { name: '/DMO/CARRIER_ID', type: 'DTEL/DE' });
  assert.deepEqual(objectOfUri('/sap/bc/adt/programs/includes/zdemo_inc%zz'), { name: 'ZDEMO_INC%ZZ', type: 'PROG/I' }, 'a malformed escape stays');
  assert.equal(objectOfUri('/sap/bc/adt/vit/wb/object_type/trant/object_name/ZDEMO'), null);
  assert.equal(objectOfUri(undefined), null);
});

test('the identity of a hit, without namespaces', () => {
  const hit = { 'adtcore:name': 'ZCL_DEMO', 'adtcore:type': 'CLAS/OC', 'adtcore:packageName': 'ZDEMO_PKG', 'adtcore:description': 'Demo', 'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_demo' };
  assert.deepEqual(objectOf(hit), { name: 'ZCL_DEMO', type: 'CLAS/OC', package: 'ZDEMO_PKG', description: 'Demo', uri: '/sap/bc/adt/oo/classes/zcl_demo' });
  assert.equal(objectOf(null), null);
});

test('the properties: every attribute unprefixed, identity left out, dates as ISO, a clash keeps its prefix', () => {
  // The metaData block of a class as the library returned it (measured shape, names anonymised).
  const meta = {
    'class:final': false,
    'class:visibility': 'public',
    'abapsource:fixPointArithmetic': true,
    'adtcore:responsible': 'DEVUSER1',
    'adtcore:masterSystem': 'DEV',
    'adtcore:name': 'ZCL_DEMO',
    'adtcore:type': 'CLAS/OC',
    'adtcore:description': 'Demo',
    'adtcore:descriptionTextLimit': 60,
    'adtcore:changedAt': 1783329682000,
    'adtcore:createdAt': 1783296000000,
    'adtcore:version': 'active',
    'class:version': '2',
  };
  const p = propertiesOf(meta);
  assert.equal(p.final, false);
  assert.equal(p.visibility, 'public');
  assert.equal(p.fixPointArithmetic, true);
  assert.equal(p.responsible, 'DEVUSER1');
  assert.equal(p.changedAt, '2026-07-06T09:21:22.000Z');
  assert.equal(p.createdAt, '2026-07-06T00:00:00.000Z');
  for (const k of ['name', 'type', 'description', 'descriptionTextLimit']) assert.equal(p[k], undefined, `${k} is in object`);
  assert.equal(p['adtcore:version'], 'active', 'two attributes would share the name: both keep their prefix');
  assert.equal(p['class:version'], '2');
  assert.equal(p.version, undefined);
  assert.deepEqual(propertiesOf(undefined), {});
});

test('a position fragment is numbers; no start is no position', () => {
  assert.deepEqual(positionOf('./source/main#start=7,6;end=7,16'), { line: 7, column: 6, endLine: 7, endColumn: 16 });
  assert.deepEqual(positionOf('./source/main#type=CLAS%2FOM;name=X;start=12'), { line: 12 });
  assert.equal(positionOf('/sap/bc/adt/textelements/classes/zcl_demo'), null);
  assert.equal(isoOf('20261112'), '20261112', 'only epoch milliseconds are converted here');
});

test('the outline: identifier and block positions decoded, other links kept, children the same', () => {
  const REL = 'http://www.sap.com/adt/relations/source/';
  const out = outlineOf([
    {
      name: 'CONSTRUCTOR',
      type: 'CLAS/OM',
      visibility: 'public',
      constructor: true,
      links: [
        { rel: `${REL}definitionIdentifier`, href: './source/main#start=12,12;end=12,23', type: 'CLAS/OM' },
        { rel: `${REL}implementationIdentifier`, href: './source/main#start=30,7;end=30,18' },
        { rel: `${REL}definitionBlock`, href: './source/main#start=12,4;end=18,33' },
        { rel: `${REL}implementationBlock`, href: './source/main#start=30,0;end=49,11' },
      ],
      children: [{ name: 'P', links: [{ rel: `${REL}definitionIdentifier`, href: './source/main#start=14,8' }], children: [] }],
    },
    { name: 'ZCL_DEMO', type: 'CLAS/OCX', links: [{ rel: `${REL}definitionIdentifier`, href: '/sap/bc/adt/textelements/classes/zcl_demo' }], children: [] },
  ]);
  assert.deepEqual(out[0], {
    name: 'CONSTRUCTOR',
    type: 'CLAS/OM',
    visibility: 'public',
    constructor: true,
    at: { line: 12, column: 12, endLine: 12, endColumn: 23 },
    implementationAt: { line: 30, column: 7, endLine: 30, endColumn: 18 },
    definitionBlock: { line: 12, column: 4, endLine: 18, endColumn: 33 },
    implementationBlock: { line: 30, column: 0, endLine: 49, endColumn: 11 },
    children: [{ name: 'P', at: { line: 14, column: 8 } }],
  });
  assert.deepEqual(out[1].links, [{ rel: 'definitionIdentifier', href: '/sap/bc/adt/textelements/classes/zcl_demo' }], 'a link that is no position is kept');
  assert.deepEqual(outlineOf(null), []);
});
