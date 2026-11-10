// A line diff of two versions of one source, computed here.
//
// The ADT has no compare resource: the IDE's "Compare with" reads both versions and diffs them
// on the client (measured in its communication log, 2026-11-10). This module does the same, with
// no dependency: Myers' O(ND) algorithm on the lines left after the common head and tail are
// trimmed, rendered as a unified diff.
//
// Two caps keep an answer honest instead of large. `maxEdit` bounds the work: past that many
// inserted plus deleted lines the diff is not computed and the answer says so (`complete:
// false`, `reason`). `maxLines` bounds the rendered text: the hunks stop there, the counts still
// cover the whole diff, and `complete` is false. Neither cap is ever silent.

export const DEFAULT_CONTEXT = 3;
export const DEFAULT_MAX_EDIT = 2000;
export const DEFAULT_MAX_LINES = 400;

/** Lines of a source, with CRLF and CR read as LF and one trailing newline ignored. */
export function splitLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (s === '') return [];
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
}

/**
 * The edit script between `a` and `b` (arrays of lines), or null when it needs more than
 * `maxEdit` inserted plus deleted lines. Each op is {op: ' '|'-'|'+', a, b, line}, with the
 * 0-based index of the line in `a` (for ' ' and '-') and in `b` (for ' ' and '+').
 */
export function editScript(a, b, maxEdit = DEFAULT_MAX_EDIT) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const mid = myers(midA, midB, maxEdit);
  if (!mid) return null;
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ op: ' ', a: i, b: i, line: a[i] });
  for (const o of mid) {
    ops.push({
      op: o.op,
      a: o.a === null ? null : o.a + head,
      b: o.b === null ? null : o.b + head,
      line: o.line,
    });
  }
  for (let i = tail; i > 0; i--) {
    ops.push({ op: ' ', a: a.length - i, b: b.length - i, line: a[a.length - i] });
  }
  return ops;
}

// Myers (1986), forward pass with one snapshot of V per step for the walk back. The snapshot of
// step d covers diagonals -(d+1)..d+1, so the memory is quadratic in the edit count, which
// `maxEdit` bounds, never in the length of the source.
function myers(a, b, maxEdit) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const limit = Math.min(n + m, maxEdit);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const at = (k) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: ' ', a: x, b: y, line: a[x] });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: '+', a: null, b: prevY, line: b[prevY] });
      else ops.push({ op: '-', a: prevX, b: null, line: a[prevX] });
      x = prevX;
      y = prevY;
    }
  }
  return ops.reverse();
}

/**
 * The unified diff of two sources. Returns {added, removed, hunks, text, complete, reason?};
 * `text` is empty when the sources are equal line by line.
 */
export function lineDiff(fromText, toText, opts = {}) {
  const {
    fromLabel = 'a',
    toLabel = 'b',
    context = DEFAULT_CONTEXT,
    maxEdit = DEFAULT_MAX_EDIT,
    maxLines = DEFAULT_MAX_LINES,
  } = opts;
  const a = splitLines(fromText);
  const b = splitLines(toText);
  const ops = editScript(a, b, maxEdit);
  if (!ops) {
    return {
      added: null,
      removed: null,
      hunks: null,
      text: '',
      complete: false,
      reason: `more than ${maxEdit} lines changed: the diff was not computed`,
    };
  }
  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.filter((o) => o.op === '-').length;
  if (!added && !removed) return { added, removed, hunks: 0, text: '', complete: true };

  // Group the changes into hunks: a change plus `context` equal lines on each side, merged when
  // two changes are closer than twice the context.
  const changed = ops.map((o, i) => (o.op === ' ' ? -1 : i)).filter((i) => i >= 0);
  const ranges = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let complete = true;
  for (const [lo, hi] of ranges) {
    const slice = ops.slice(lo, hi + 1);
    const aLines = slice.filter((o) => o.op !== '+');
    const bLines = slice.filter((o) => o.op !== '-');
    const aStart = aLines.length ? aLines[0].a + 1 : startOf(ops, lo, 'a');
    const bStart = bLines.length ? bLines[0].b + 1 : startOf(ops, lo, 'b');
    const header = `@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`;
    if (out.length + 1 + slice.length > maxLines + 2) {
      complete = false;
      break;
    }
    out.push(header, ...slice.map((o) => `${o.op}${o.line}`));
  }
  return {
    added,
    removed,
    hunks: ranges.length,
    text: out.join('\n'),
    complete,
    ...(complete ? {} : { reason: `the diff is longer than ${maxLines} lines: later hunks left out` }),
  };
}

// The 1-based line a hunk with no line on one side starts after (unified diff convention).
function startOf(ops, lo, side) {
  for (let i = lo - 1; i >= 0; i--) if (ops[i][side] !== null) return ops[i][side] + 1;
  return 0;
}
