// The type contract is structural: a type the code names without a decision fails the build.
//
// The failure it prevents is the one of 2026-10-01 -- a field list asked of a data element, a
// source read of a form-based type -- answered with a dead end that read like an answer. Fixing
// the one type that bit left the next one armed, so the guard is over every type the code
// names, not over the types that already bit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TYPE_CONTRACT, contractOf, sourceRefusal } from '../lib/type-contract.mjs';
import { buildTools } from '../tools/index.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('every object type the tools or the resolver name has a decision in the contract', () => {
  const named = new Set();
  for (const f of ['tools/index.mjs', 'lib/resolve.mjs']) {
    for (const m of read(f).matchAll(/'([A-Z]{4}\/[A-Z]{1,4})'/g)) named.add(m[1]);
  }
  assert.ok(named.size >= 10, `the scan found only ${named.size} type literals: the pattern has drifted`);
  const missing = [...named].filter((t) => !TYPE_CONTRACT.has(t));
  assert.deepEqual(missing, [], 'a type the code names must say what adt_object_info and adt_read_source answer for it');
});

test('every entry carries its evidence and a well-formed decision', () => {
  const tools = new Set(buildTools({ host: 'x', client: '001', budget: { reads: 1 } }, { api: {}, sources: {} }).map((t) => t.definition.name));
  for (const [type, c] of TYPE_CONTRACT) {
    assert.match(type, /^[A-Z]{4}\/[A-Z]{1,4}$/, type);
    assert.equal(typeof c.fields, 'boolean', `${type}: fields is a decision, not a default`);
    assert.match(c.evidence ?? '', /\d{4}-\d{2}-\d{2}|call log|lib\/resolve\.mjs/, `${type}: evidence names a dated reading or where the claim comes from`);
    if (c.source !== true) {
      assert.ok(tools.has(c.source?.refuse), `${type}: a refusal names a tool that exists (${c.source?.refuse})`);
      assert.ok(c.source.why, `${type}: a refusal says why`);
      assert.equal(c.fields, false, `${type}: a type without source has no field list either`);
    }
  }
});

test('the refusal names the call that answers, with the parameters that tool takes', () => {
  assert.match(sourceRefusal('dtel/de', 'btcxpgstat').message, /DTEL\/DE BTCXPGSTAT has no source text.*adt_object_info\(\{ objectName: 'BTCXPGSTAT', objectType: 'DTEL\/DE' \}\)/);
  assert.match(sourceRefusal('DEVC/K', 'ZDEMO_DEV').message, /adt_package_tree\(\{ packageName: 'ZDEMO_DEV' \}\)/);
  assert.equal(sourceRefusal('CLAS/OC', 'ZCL_X'), null);
  assert.equal(sourceRefusal('XSLT/VT', 'ZX'), null, 'an undecided type is attempted, not refused');
  assert.equal(contractOf('xslt/vt'), null);
});
