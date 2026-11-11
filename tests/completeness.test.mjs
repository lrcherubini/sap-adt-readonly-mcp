// The completeness contract (lib/completeness.mjs): every answer says in fields whether it is
// complete, every cut says how to get the rest, and no value hedges. The helpers are tested here;
// each tool's answers are checked against `contractErrors` in its own test file, and the list
// below names the tools whose answers do not follow the contract yet -- it only shrinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finish, gapOf, page, pageGap, contractErrors, COMPLETENESS_CODES, CompletenessError } from '../lib/completeness.mjs';

const root = path.join(import.meta.dirname, '..');

test('finish derives `complete` from `incomplete`, and refuses a code outside the closed set', () => {
  assert.deepEqual(finish({ rows: [] }), { complete: true, incomplete: [], rows: [] });
  const out = finish({ rows: [1] }, [null, { list: 'rows', code: 'CAP_REACHED', returned: 1, total: 3 }]);
  assert.equal(out.complete, false);
  assert.deepEqual(out.incomplete, [{ list: 'rows', code: 'CAP_REACHED', returned: 1, total: 3 }]);
  assert.throws(() => finish({}, [{ list: 'rows', code: 'MAYBE' }]), CompletenessError);
  assert.throws(() => gapOf('rows', 'possible'), CompletenessError);
  assert.ok(COMPLETENESS_CODES.size >= 8);
});

test('page: max to a ceiling, offset from zero, and the next page where the list goes on', () => {
  const list = Array.from({ length: 7 }, (_, i) => i);
  const p1 = page(list, { defaultMax: 3, ceiling: 5 });
  assert.deepEqual(p1, { items: [0, 1, 2], returned: 3, total: 7, offset: 0, limit: 3, truncated: true, next: { offset: 3 } });
  const p2 = page(list, { max: 5, offset: p1.next.offset, defaultMax: 3, ceiling: 5 });
  assert.deepEqual(p2.items, [3, 4, 5, 6]);
  assert.equal(p2.truncated, false);
  assert.equal(p2.next, null);
  assert.deepEqual([...p1.items, ...p2.items], list, 'two pages are the whole list, nothing repeated, nothing lost');
  assert.deepEqual(page(list, { offset: 9, defaultMax: 3, ceiling: 5 }).items, []);
  for (const bad of [{ max: 0 }, { max: 6 }, { max: 1.5 }, { offset: -1 }, { offset: 'x' }]) {
    assert.throws(() => page(list, { defaultMax: 3, ceiling: 5, ...bad }), CompletenessError, JSON.stringify(bad));
  }
  assert.deepEqual(pageGap('rows', p1), { list: 'rows', code: 'CAP_REACHED', returned: 3, total: 7, next: { offset: 3 } });
  assert.equal(pageGap('rows', p2), null);
});

test('contractErrors names every way an answer breaks the contract', () => {
  assert.deepEqual(contractErrors(finish({ rows: [], page: { truncated: false } })), []);
  assert.deepEqual(contractErrors(finish({ list: { truncated: true, next: { offset: 5 } } }, [{ list: 'list', code: 'CAP_REACHED' }])), []);
  const bad = contractErrors({
    complete: true,
    incomplete: [{ list: 'rows', code: 'NOPE' }],
    rows: { truncated: 'possible' },
    other: { truncated: true },
    counted: { truncated: 4 },
  });
  for (const expected of [/not in the closed set/, /complete` is true while/, /'possible'/, /neither a boolean nor a count/, /other is truncated with neither/, /counted is truncated with neither/]) {
    assert.ok(bad.some((e) => expected.test(e)), `${expected} in ${bad.join(' | ')}`);
  }
  assert.deepEqual(contractErrors({ rows: [] }), ['`complete` is not a boolean', '`incomplete` is not an array']);
  assert.match(contractErrors({ complete: false, incomplete: [] })[0], /says nothing/);
});

/** Files that still hedge with 'possible'. Each cycle removes its own; the list only shrinks. */
const STILL_HEDGING = new Set(['tools/runtime-errors.mjs', 'lib/data-preview.mjs']);

test("no answer hedges with 'possible': the literal is gone from every migrated file", () => {
  const offenders = [];
  for (const dir of ['tools', 'lib']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs'))) {
      const rel = `${dir}/${f}`;
      if (rel === 'lib/completeness.mjs') continue;
      const text = fs.readFileSync(path.join(root, dir, f), 'utf8');
      const hedges = /['"]possible['"]/.test(text);
      if (hedges && !STILL_HEDGING.has(rel)) offenders.push(rel);
      if (!hedges && STILL_HEDGING.has(rel)) offenders.push(`${rel} no longer hedges: remove it from STILL_HEDGING`);
    }
  }
  assert.deepEqual(offenders, []);
});
