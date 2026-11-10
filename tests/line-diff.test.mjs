// The local line diff behind version comparison: correct on every pair, minimal, and never
// silent about a cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editScript, lineDiff, splitLines } from '../lib/line-diff.mjs';

// Rebuild both sides from a script: the '-' and ' ' lines are `a`, the '+' and ' ' lines are `b`.
const sides = (ops) => ({
  a: ops.filter((o) => o.op !== '+').map((o) => o.line),
  b: ops.filter((o) => o.op !== '-').map((o) => o.line),
});

// Length of the longest common subsequence, by dynamic programming: the edit count of a minimal
// script is |a| + |b| - 2 * LCS.
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[b.length];
}

// A small deterministic generator, so a failure names a reproducible case.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('the script rebuilds both sides and is minimal, on 500 random pairs', () => {
  const r = rng(7);
  for (let n = 0; n < 500; n++) {
    const a = Array.from({ length: Math.floor(r() * 12) }, () => 'xyz'[Math.floor(r() * 3)]);
    const b = Array.from({ length: Math.floor(r() * 12) }, () => 'xyz'[Math.floor(r() * 3)]);
    const ops = editScript(a, b);
    assert.deepEqual(sides(ops), { a, b }, `case ${n}: ${a.join('')} -> ${b.join('')}`);
    const edits = ops.filter((o) => o.op !== ' ').length;
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), `case ${n} is minimal`);
  }
});

test('line endings do not count as a change, and one trailing newline is ignored', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  const d = lineDiff('REPORT zdemo.\r\nWRITE 1.\r\n', 'REPORT zdemo.\nWRITE 1.');
  assert.deepEqual([d.added, d.removed, d.text, d.complete], [0, 0, '', true]);
});

test('a one-line change is one hunk with its context, numbered from 1', () => {
  const from = [
    'REPORT zdemo_report.',
    '',
    'PARAMETERS p_test AS CHECKBOX.',
    "PARAMETERS p_str TYPE string DEFAULT 'str1'.",
    'START-OF-SELECTION.',
  ].join('\n');
  const to = from.replace("'str1'", "'str2'");
  const d = lineDiff(from, to, { fromLabel: '00001', toLabel: '00000' });
  assert.equal(d.complete, true);
  assert.deepEqual([d.added, d.removed, d.hunks], [1, 1, 1]);
  assert.equal(
    d.text,
    [
      '--- 00001',
      '+++ 00000',
      '@@ -1,5 +1,5 @@',
      ' REPORT zdemo_report.',
      ' ',
      ' PARAMETERS p_test AS CHECKBOX.',
      "-PARAMETERS p_str TYPE string DEFAULT 'str1'.",
      "+PARAMETERS p_str TYPE string DEFAULT 'str2'.",
      ' START-OF-SELECTION.',
    ].join('\n'),
  );
});

test('changes far apart are separate hunks; an empty side starts at 0', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const b = [...a];
  b[1] = 'changed 1';
  b[18] = 'changed 18';
  const d = lineDiff(a.join('\n'), b.join('\n'));
  assert.equal(d.hunks, 2);
  assert.match(d.text, /@@ -1,5 \+1,5 @@/);
  assert.match(d.text, /@@ -16,5 \+16,5 @@/);
  const created = lineDiff('', 'WRITE 1.');
  assert.match(created.text, /@@ -0,0 \+1,1 @@\n\+WRITE 1\./);
});

test('past maxEdit the diff is not computed, and the answer says so', () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
  const d = lineDiff(a.join('\n'), b.join('\n'), { maxEdit: 20 });
  assert.equal(d.complete, false);
  assert.equal(d.added, null, 'no count is invented when nothing was computed');
  assert.match(d.reason, /more than 20 lines changed/);
});

test('past maxLines the text stops, the counts still cover everything', () => {
  const a = Array.from({ length: 200 }, (_, i) => `same ${i}`);
  const b = a.map((l, i) => (i % 10 === 0 ? `new ${i}` : l));
  const d = lineDiff(a.join('\n'), b.join('\n'), { maxLines: 30 });
  assert.equal(d.complete, false);
  assert.deepEqual([d.added, d.removed, d.hunks], [20, 20, 20]);
  assert.ok(d.text.split('\n').length <= 32, 'two header lines plus at most maxLines');
  assert.match(d.reason, /longer than 30 lines/);
});
