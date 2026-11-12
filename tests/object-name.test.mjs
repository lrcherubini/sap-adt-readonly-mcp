// The object name alphabet (lib/object-name.mjs), measured on the system: the name shapes the
// quick search answered for the families this server reads are admitted and encoded the way the
// ADT writes them; nothing else is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBJECT_NAME, OBJECT_SEGMENT, objectNameOf, objectSegmentOf } from '../lib/object-name.mjs';
import { buildUrl } from '../lib/adt-get.mjs';
import { API_RELEASE_OBJECT } from '../lib/api-release.mjs';
import { buildSelect } from '../lib/data-preview.mjs';

// Demo names in the measured shapes: a hyphen (function group), `&` and `$` (includes), `%`
// (a program), `+` and `#` (message classes), a namespace, a dot.
const MEASURED = ['ZDEMO-CUST', 'ZDEMO&I00', 'ZDEMO$QQ0', '%ZDEMO_X', 'ZDEMO+', 'ZDEMO#', '/ZDEMO/CL_DEMO', 'ZDEMO_2.0'];

test('every measured object name shape is admitted, upper-cased; anything else is not', () => {
  for (const n of MEASURED) assert.equal(objectNameOf(n.toLowerCase()), n, n);
  for (const bad of ['', 'ZDEMO X', "ZDEMO'X", 'ZDEMO(1)', 'ZDEMO,1', 'ZDEMO;1', '..', '.', 'Z'.repeat(41), '../ZDEMO', 'ZDEMO/X']) {
    assert.equal(objectNameOf(bad), null, bad);
  }
  assert.ok(OBJECT_NAME.test('Z'.repeat(40)));
});

test('a name leaves as the segment the ADT writes, and the routes that take one accept it', () => {
  assert.equal(objectSegmentOf('%ZDEMO_X'), '%25zdemo_x');
  assert.equal(objectSegmentOf('ZDEMO&I00'), 'zdemo%26i00');
  assert.equal(objectSegmentOf('/ZDEMO/CL_DEMO'), '%2fzdemo%2fcl_demo');
  for (const n of MEASURED) {
    const seg = objectSegmentOf(n);
    assert.ok(OBJECT_SEGMENT.test(seg), seg);
    assert.equal(buildUrl('textElementsProgramSymbols', { name: seg }).split('?')[0], `/sap/bc/adt/textelements/programs/${seg}/source/symbols`, n);
  }
  for (const bad of ['zdemo%20x', 'zdemo%27x', '..', 'a/b', '%2e%2e']) assert.throws(() => buildUrl('textElementsProgramSymbols', { name: bad }), bad);
});

test('the release state of a function module in a hyphenated group is asked', () => {
  assert.ok(API_RELEASE_OBJECT.test('/sap/bc/adt/functions/groups/zdemo-cust/fmodules/zdemo_fm'));
});

test('a data preview value or LIKE pattern may carry the measured name characters, as text', () => {
  const sql = buildSelect({ table: 'TADIR', fields: ['OBJ_NAME'], where: [{ field: 'OBJ_NAME', value: 'ZDEMO&I00' }, { field: 'OBJ_NAME', op: 'LIKE', value: '%ZDEMO*' }] }).sql;
  assert.match(sql, /OBJ_NAME = 'ZDEMO&I00'/);
  assert.match(sql, /OBJ_NAME LIKE '#%ZDEMO%' ESCAPE '#'/);
});
