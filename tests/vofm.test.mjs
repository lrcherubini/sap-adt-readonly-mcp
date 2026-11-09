// The VOFM naming rule, pinned against what MV80H200 does -- so a wrong transcription fails here,
// not in a customizing table whose routine column names a group VOFM does not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, groupOf } from '../lib/vofm-groups.mjs';

const ENUMERABLE = GROUPS.filter((g) => g.prefix);

test('the table is the FORM: 74 groups, 72 with an include, PBES and EXKO without', () => {
  assert.equal(GROUPS.length, 74);
  assert.equal(ENUMERABLE.length, 72);
  assert.deepEqual(
    GROUPS.filter((g) => !g.prefix).map((g) => g.grpze),
    ['PBES', 'EXKO']
  );
  // No group twice, no prefix shared by two groups -- the LIS groups all start with F but each
  // has its own fifth character.
  assert.equal(new Set(GROUPS.map((g) => g.grpze)).size, GROUPS.length);
  assert.equal(new Set(ENUMERABLE.map((g) => g.prefix)).size, ENUMERABLE.length);
});

test('the three ranges of MV80HTOP, and which groups get which', () => {
  const r = (grpze) => {
    const g = groupOf(grpze);
    return [g.first, g.last, g.digits];
  };
  assert.deepEqual(r('PFRM'), [600, 999, 3], 'user_grpno_first1..last1');
  assert.deepEqual(r('TDAT'), [50, 99, 2], 'first2..last2 AND the only SHIFT LEFT');
  assert.deepEqual(r('PSTK'), [50, 99, 3], 'first2..last2, no SHIFT: three digits stay');
  assert.deepEqual(r('FOFU'), [900, 999, 3], 'user_grpno_first3');
  // Everything else is the default range.
  const others = ENUMERABLE.filter((g) => !['TDAT', 'PSTK', 'FOFU'].includes(g.grpze));
  for (const g of others) assert.deepEqual([g.first, g.last, g.digits], [600, 999, 3], g.grpze);
});
