// The four measured shapes of the enhanced-object href, and the fifth that is reported
// rather than guessed. The percent-encoding rule is the one that cost a full sweep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhancedObjectOf, parseEnhancedObject, REL_ENHANCED } from '../lib/enhancement-target.mjs';

const REL = `http://www.sap.com/adt/relations/${REL_ENHANCED}`;
const structureWith = (href) => ({ links: [{ rel: 'self', href: '/x' }, { rel: REL, href }] });

test('a program, a function group, a class and an ENHO are the four measured shapes', () => {
  assert.deepEqual(
    parseEnhancedObject('/sap/bc/adt/programs/programs/sapfv45l/enhancements/options?context=x'),
    { uri: '/sap/bc/adt/programs/programs/sapfv45l', kind: 'PROG', name: 'SAPFV45L' }
  );
  assert.deepEqual(
    parseEnhancedObject('/sap/bc/adt/functions/groups/v45a/enhancements/options'),
    { uri: '/sap/bc/adt/functions/groups/v45a', kind: 'FUGR', name: 'V45A' }
  );
  assert.deepEqual(
    parseEnhancedObject('/sap/bc/adt/oo/classes/cl_foo/enhancements/options'),
    { uri: '/sap/bc/adt/oo/classes/cl_foo', kind: 'CLAS', name: 'CL_FOO' }
  );
  assert.deepEqual(
    parseEnhancedObject('/sap/bc/adt/enhancements/enhoxhb/oid_sapfv45p/enhancements/options'),
    { uri: '/sap/bc/adt/enhancements/enhoxhb/oid_sapfv45p', kind: 'ENHO', name: 'OID_SAPFV45P' }
  );
});

test('a namespaced object keeps its URI percent-encoded and decodes only the name', () => {
  const t = parseEnhancedObject('/sap/bc/adt/functions/groups/%2fscwm%2fto_whr/enhancements/options');
  assert.equal(t.uri, '/sap/bc/adt/functions/groups/%2fscwm%2fto_whr');
  assert.equal(t.name, '/SCWM/TO_WHR');
  assert.equal(t.kind, 'FUGR');
});

test('a shape not measured is reported as ? with the last segment, never guessed', () => {
  assert.deepEqual(parseEnhancedObject('/sap/bc/adt/bopf/objects/zbo/enhancements/options'), {
    uri: '/sap/bc/adt/bopf/objects/zbo',
    kind: '?',
    name: 'ZBO',
  });
});

test('enhancedObjectOf reads the link by relation suffix, and answers null without it', () => {
  assert.deepEqual(enhancedObjectOf(structureWith('/sap/bc/adt/oo/classes/cl_foo/enhancements/options')), {
    uri: '/sap/bc/adt/oo/classes/cl_foo',
    kind: 'CLAS',
    name: 'CL_FOO',
  });
  // Every ENHO/XHB (BAdI implementation) lands here: correct, not a failure.
  assert.equal(enhancedObjectOf({ links: [{ rel: 'self', href: '/x' }] }), null);
  assert.equal(enhancedObjectOf({}), null);
  assert.equal(enhancedObjectOf(undefined), null);
});

// --- the XHB body -----------------------------------------------------------------------------

test('parseEnhoXhb: spot, BAdI, implementing class and the three referenced objects, no drift on the measured shape', async () => {
  const { parseEnhoXhb } = await import('../lib/enhancement-target.mjs');
  const fs = await import('node:fs');
  const xml = fs.readFileSync(new URL('./fixtures/enhoxhb-measured.xml', import.meta.url), 'utf8');
  const b = parseEnhoXhb(xml);
  assert.deepEqual(b.drift, []);
  assert.equal(b.name, 'ZDEMO_BADI_IMPL');
  assert.equal(b.type, 'ENHO/XHB');
  assert.equal(b.package, 'ZDEMO');
  assert.equal(b.toolType, 'BADI_IMPL');
  assert.equal(b.switchSupported, true);
  assert.deepEqual(
    b.usages.map((u) => [u.usage, u.type, u.name]),
    [
      ['USEO', 'CLAS/OC', 'ZCL_DEMO_BADI_IMPL'],
      ['EXTO', 'ENHS/XSB', '/XNFE/ES_INVOICE_ENHANCE'],
      ['USEO', 'INTF/OI', '/XNFE/IF_BADI_INVOICE_ENHANCE'],
    ]
  );
  assert.equal(b.usages[1].uri, '/sap/bc/adt/enhancements/enhsxsb/%2fxnfe%2fes_invoice_enhance', 'the URI stays percent-encoded');
  assert.equal(b.implementations.length, 1);
  const i = b.implementations[0];
  assert.equal(i.name, 'ZDEMO_BADI_IMPL');
  assert.equal(i.active, true);
  assert.equal(i.default, false);
  assert.equal(i.runtimeBehavior, 'Implementation will be called');
  assert.deepEqual(i.spot, { name: '/XNFE/ES_INVOICE_ENHANCE', type: 'ENHS/XSB', uri: '/sap/bc/adt/enhancements/enhsxsb/%2fxnfe%2fes_invoice_enhance' });
  assert.equal(i.badi.name, '/XNFE/BADI_INVOICE_ENHANCE');
  assert.equal(i.badi.type, 'ENHS/XB');
  assert.deepEqual(i.implementingClass, { name: 'ZCL_DEMO_BADI_IMPL', type: 'CLAS/OC', uri: '/sap/bc/adt/oo/classes/zcl_demo_badi_impl' });
  // An element the measured body does not have is drift; a body without implementations is empty, not a crash.
  assert.deepEqual(parseEnhoXhb(xml.replace('<enho:contentSpecific>', '<enho:contentSpecific><enho:filters/>')).drift, [{ node: 'enho:filters', count: 1, where: 'enhoxhb' }]);
  assert.deepEqual(parseEnhoXhb('').implementations, []);
  assert.equal(parseEnhoXhb('').name, null);
});
