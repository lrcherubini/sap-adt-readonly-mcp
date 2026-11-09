import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openJournal,
  shape,
  sanitizeMap,
  fingerprintOf,
  readStream,
  digest,
  identityOf,
  newRunId,
  narrowingOf,
  STREAMS,
} from '../lib/journal.mjs';
import { codeInfo, FINDING_CODES, GAP_CODES, severityRank } from '../lib/journal-codes.mjs';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');

/** A journal whose lines land in an array instead of on disk. */
function captured(over = {}) {
  const lines = [];
  const j = openJournal({
    journalSink: (stream, record) => lines.push({ stream, record }),
    ...over,
  });
  return { j, lines };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-journal-'));
}

// --- the allowlist, which is the whole safety property ----------------------------

test('shape drops a top-level field the stream does not declare', () => {
  const out = shape('findings', {
    code: 'ALIAS_DRIFT',
    subject: 'ZI_DemoSales',
    sqlPassword: 'hunter2',
    whateverElse: 'noise',
  });
  assert.equal(out.subject, 'ZI_DemoSales');
  assert.equal('sqlPassword' in out, false);
  assert.equal('whateverElse' in out, false);
});

test('a nested map keeps primitives and replaces objects with their size', () => {
  const out = sanitizeMap({
    entity: 'ZC_DemoInvMapTP',
    fields: ['BaseUnit', 'Plant'],
    tree: { a: 1, b: 2, c: 3 },
    count: 4,
    ok: false,
  });
  assert.equal(out.entity, 'ZC_DemoInvMapTP');
  assert.deepEqual(out.fields, { n: 2 });
  assert.deepEqual(out.tree, { keys: 3 });
  assert.equal(out.count, 4);
  assert.equal(out.ok, false);
});

test('a key named for content is dropped, but sourceType survives', () => {
  // The distinction is load-bearing: a finding about a source type has to be
  // able to report WHICH value it saw, while a `source` key must never pass.
  const out = sanitizeMap({
    source: 'define view entity ZC_X as select from mara { matnr }',
    body: '<xml/>',
    text: 'anything',
    sourceType: 'W',
    sourceConstruct: 'as select from',
  });
  assert.equal('source' in out, false);
  assert.equal('body' in out, false);
  assert.equal('text' in out, false);
  assert.equal(out.sourceType, 'W');
  assert.equal(out.sourceConstruct, 'as select from');
  assert.equal(out.droppedFields, 3);
});

test('a source body handed to the journal cannot reach the sink', () => {
  const { j, lines } = captured();
  j.call({
    tool: 'adt_read_source',
    outcome: 'answered',
    args: { objectName: 'ZCL_DEMO_ASSORTMENT', source: 'CLASS zcl_demo_assortment DEFINITION.' },
    result: { source: 'a'.repeat(9000), bytes: 8787 },
  });
  const text = JSON.stringify(lines);
  assert.equal(text.includes('CLASS zcl_demo_assortment'), false);
  assert.equal(text.includes('aaaaaaaaaa'), false);
  assert.equal(lines[0].record.result.bytes, 8787);
});

test('a long string is truncated and a CPF-length digit run is redacted', () => {
  const out = sanitizeMap({ note: 'x'.repeat(400), who: 'employee 12345678901 of a payroll provider' });
  assert.ok(out.note.length < 260, `got ${out.note.length}`);
  assert.equal(out.who.includes('12345678901'), false);
  assert.ok(out.who.includes('<redacted>'));
});

test('shape rejects an unknown stream name', () => {
  assert.throws(() => shape('everything', {}), /Unknown journal stream/);
});

// --- the closed code registry ------------------------------------------------------

test('an unregistered code throws instead of being written', () => {
  const { j, lines } = captured();
  assert.throws(() => j.finding({ code: 'SOMETHING_I_INVENTED' }), /not registered/);
  assert.equal(lines.length, 0);
});

test('a finding code cannot be written to the gaps stream, or the reverse', () => {
  const { j } = captured();
  assert.throws(() => j.gap({ code: 'ALIAS_DRIFT' }), /finding code/);
  assert.throws(() => j.finding({ code: 'CATALOG_MISS' }), /gap code/);
});

test('severity comes from the registry, not from the caller', () => {
  const { j, lines } = captured();
  j.finding({ code: 'CC_LEVEL_C', subject: 'vbbe', file: 'zdemo_sd/x.ddls.asddls' });
  assert.equal(lines[0].record.severity, 'high');
  assert.equal(lines[0].stream, 'findings');
});

test('every registered code has a severity and a meaning, and the two families are disjoint', () => {
  for (const [code, info] of [...FINDING_CODES, ...GAP_CODES]) {
    assert.ok(['high', 'medium', 'low'].includes(info.severity), `${code} severity`);
    assert.ok(info.meaning.length > 20, `${code} meaning`);
    assert.ok(severityRank(info.severity) < 3);
  }
  for (const code of FINDING_CODES.keys()) {
    assert.equal(GAP_CODES.has(code), false, `${code} is in both families`);
  }
  assert.equal(codeInfo('CC_LEVEL_B').family, 'finding');
  assert.equal(codeInfo('ADT_ERROR').family, 'gap');
  assert.equal(codeInfo('nope'), undefined);
});

test('call() keeps only registered codes in its codes array', () => {
  const { j, lines } = captured();
  j.call({ tool: 'adt_value_help', codes: ['EXPOSURE_INCONCLUSIVE', 'MADE_UP', ''] });
  assert.deepEqual(lines[0].record.codes, ['EXPOSURE_INCONCLUSIVE']);
});

// --- the fingerprint, which is what makes the stream a backlog ---------------------

test('the fingerprint is stable for the same defect and differs for another', () => {
  const a = fingerprintOf(['CC_LEVEL_C', 'zdemo_sd/x.ddls.asddls', 'vbbe']);
  const b = fingerprintOf(['CC_LEVEL_C', 'zdemo_sd/x.ddls.asddls', 'VBBE']);
  const c = fingerprintOf(['CC_LEVEL_C', 'zdemo_sd/x.ddls.asddls', 'kna1']);
  assert.equal(a, b, 'case must not change identity: sources use non-canonical casing');
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('a finding gets a fingerprint derived from code, file and subject', () => {
  const { j, lines } = captured();
  j.finding({ code: 'CC_LEVEL_B', file: 'a.ddls.asddls', subject: 'J_1BREAD_BRANCH_DATA' });
  j.finding({ code: 'CC_LEVEL_B', file: 'a.ddls.asddls', subject: 'J_1BREAD_BRANCH_DATA' });
  assert.equal(lines[0].record.fingerprint, lines[1].record.fingerprint);
});

test('digest counts occurrences and keeps first, last and the latest record', () => {
  const rows = [
    { ts: '2026-09-01T10:00:00Z', code: 'ALIAS_DRIFT', fingerprint: 'aaa', subject: 'one' },
    { ts: '2026-09-03T10:00:00Z', code: 'ALIAS_DRIFT', fingerprint: 'aaa', subject: 'one-newer' },
    { ts: '2026-09-02T10:00:00Z', code: 'EDMX_STALE', fingerprint: 'bbb', subject: 'two' },
  ];
  const out = digest(rows).sort((x, y) => y.times - x.times);
  assert.equal(out[0].times, 2);
  assert.equal(out[0].first, '2026-09-01T10:00:00Z');
  assert.equal(out[0].last, '2026-09-03T10:00:00Z');
  assert.equal(out[0].record.subject, 'one-newer');
  assert.equal(out[1].times, 1);
});

// Two subjects whose fingerprint comes out as twelve digits -- the shape that real journal rows
// were once written with '<redacted>' for, because twelve hex characters came out digits.
// (Synthetic subjects, chosen by searching for an all-digit hash.)
const NUMERIC = [
  { code: 'DDIC_FIELDS_NOT_READ', subject: 'ZDEMO_TRACK_7' },
  { code: 'EXPOSURE_INCONCLUSIVE', subject: 'cpi-demo_flow/Flow_50' },
];

test('a fingerprint that comes out all digits is kept, not redacted as a CPF', () => {
  const { j, lines } = captured();
  for (const r of NUMERIC) j.gap(r);
  const prints = lines.map((l) => l.record.fingerprint);
  for (const fp of prints) assert.match(fp, /^\d{12}$/, 'the case under test is an all-digit hash');
  assert.notEqual(prints[0], prints[1]);
  // The rule the exemption must not weaken: digits in a CONTENT field are still redacted.
  j.gap({ code: 'CATALOG_MISS', subject: '12345678901' });
  assert.equal(lines[2].record.subject, '<redacted>');
});

test("a '<redacted>' fingerprint already on disk is recomputed, never shared as a key", () => {
  const rows = NUMERIC.map((r, i) => ({ ts: `2026-09-2${3 + i}T12:00:00Z`, ...r, fingerprint: '<redacted>' }));
  const out = digest(rows);
  assert.equal(out.length, 2, 'two unrelated defects must stay two rows');
  assert.deepEqual(
    out.map((d) => d.fingerprint),
    NUMERIC.map((r) => fingerprintOf([r.code, '', r.subject]))
  );
  assert.equal(identityOf({ fingerprint: 'aaa' }), 'aaa', 'a well-formed key is taken as is');
});

// --- the file side -----------------------------------------------------------------

test('writes one JSONL line per record, into a per-day file per stream', () => {
  const dir = tempDir();
  try {
    const j = openJournal({ paths: { logs: dir } });
    j.call({ tool: 'adt_search', outcome: 'answered', adtCalls: 1 });
    j.finding({ code: 'CC_DEPRECATED', file: 'zdemo_001/zdemo_product_ext.ddls.asddls' });
    j.gap({ code: 'CATALOG_MISS', subject: 'vbbe' });
    const day = new Date().toISOString().slice(0, 10);
    for (const stream of STREAMS) {
      const file = path.join(dir, stream, `${day}.jsonl`);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1, `${stream} should have one line`);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.run, j.run);
      assert.match(parsed.ts, /^\d{4}-\d\d-\d\dT/);
    }
    assert.deepEqual(j.counts(), { calls: 1, findings: 1, gaps: 1, dropped: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the size cap stops appending and says so, instead of filling the disk', () => {
  const dir = tempDir();
  try {
    const j = openJournal({ paths: { logs: dir }, logs: { maxBytesPerDay: 200 } });
    for (let i = 0; i < 20; i++) j.call({ tool: 'adt_search', outcome: 'answered', adtCalls: i });
    const day = new Date().toISOString().slice(0, 10);
    const text = fs.readFileSync(path.join(dir, 'calls', `${day}.jsonl`), 'utf8');
    assert.ok(text.length < 600, `capped file grew to ${text.length}`);
    assert.ok(text.includes('LOG_TRUNCATED'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write failure is swallowed and counted, never thrown at the caller', () => {
  // A path whose parent is a file cannot be mkdir'd: the realistic shape of a broken
  // logs directory.
  const dir = tempDir();
  const blocked = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'x');
  try {
    const j = openJournal({ paths: { logs: blocked } });
    assert.equal(j.call({ tool: 'adt_search' }), null);
    assert.equal(j.counts().dropped, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logs:false disables every stream', () => {
  const { j, lines } = captured({ logs: false });
  assert.equal(j.enabled, false);
  assert.equal(j.call({ tool: 'adt_search' }), null);
  assert.equal(j.finding({ code: 'ALIAS_DRIFT' }), null);
  assert.equal(lines.length, 0);
});

test('readStream filters by day and survives a half-written line', () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'findings', '2026-09-01.jsonl'),
      `${JSON.stringify({ ts: '2026-09-01T00:00:00Z', code: 'EDMX_STALE' })}\n`
    );
    fs.writeFileSync(
      path.join(dir, 'findings', '2026-09-08.jsonl'),
      `${JSON.stringify({ ts: '2026-09-08T00:00:00Z', code: 'ALIAS_DRIFT' })}\n{"half-writ`
    );
    const all = readStream(dir, 'findings');
    assert.equal(all.records.length, 2);
    assert.equal(all.unreadable.length, 1);
    const recent = readStream(dir, 'findings', { since: '2026-09-05' });
    assert.equal(recent.records.length, 1);
    assert.equal(recent.records[0].code, 'ALIAS_DRIFT');
    assert.deepEqual(readStream(dir, 'calls').records, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('newRunId is short and hex', () => {
  assert.match(newRunId(), /^[0-9a-f]{6}$/);
});

// --- the git guarantee -------------------------------------------------------------

test('logs/ is ignored by git, and stays ignored', () => {
  // The journal lives inside the repository by decision (see the header of
  // lib/journal.mjs). This test is the brake: an edit to .gitignore that started
  // tracking analysis output would otherwise be silent.
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'check-ignore', '-v', 'logs/calls/2026-09-08.jsonl'], {
      encoding: 'utf8',
    });
  } catch (e) {
    assert.fail(
      'logs/calls/2026-09-08.jsonl is NOT git-ignored. Add /logs/ to .gitignore before ' +
        `journalling anything. (git said: ${e.stdout ?? e.message})`
    );
  }
  assert.match(out, /logs/);
});

test('scripts/probes/ is ignored by git, and stays ignored', () => {
  // Temporary probes read the system and are transcribed into docs/adt-api-reference.md;
  // the file itself is never the record and must never be committed (one was, in
  // once). The folder is git-ignored so that the rule is a property of the tree, and
  // this test is the brake on the .gitignore entry. The path need not exist for
  // check-ignore to answer.
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'check-ignore', '-v', 'scripts/probes/anything.mjs'], {
      encoding: 'utf8',
    });
  } catch (e) {
    assert.fail(
      'scripts/probes/anything.mjs is NOT git-ignored. Add /scripts/probes/ to .gitignore ' +
        `before writing a probe there. (git said: ${e.stdout ?? e.message})`
    );
  }
  assert.match(out, /\.gitignore:\d+:\/scripts\/probes\//);
});

test('no journal file carries a SAP source extension', () => {
  // Belt and braces for the allowlist: whatever ends up under logs/ must be JSONL.
  const dir = path.join(repoRoot, 'logs');
  if (!fs.existsSync(dir)) return;
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/\.jsonl$/.test(e.name)) bad.push(p);
    }
  };
  walk(dir);
  assert.deepEqual(bad, [], 'only .jsonl belongs under logs/');
});

// --- the call -> gap link, and the journal's own counters -------------------------

test('collect reports the codes filed while it was open, and nothing from outside it', () => {
  const { j } = captured();
  j.gap({ code: 'SEARCH_AT_CAP', subject: 'before' });
  const frame = j.collect();
  j.gap({ code: 'BATCH_ITEM_NOT_READ', subject: 'CI_KOMK_CM' });
  j.finding({ code: 'CC_DEPRECATED', file: 'zdemo_001/x.ddls.asddls' });
  const codes = frame.end();
  j.gap({ code: 'CATALOG_MISS', subject: 'after' });
  assert.deepEqual(codes.sort(), ['BATCH_ITEM_NOT_READ', 'CC_DEPRECATED']);
});

test('the same code twice in one call is one entry, not a tally', () => {
  const { j } = captured();
  const frame = j.collect();
  for (const s of ['A', 'B', 'C']) j.gap({ code: 'BATCH_ITEM_NOT_READ', subject: s });
  assert.deepEqual(frame.end(), ['BATCH_ITEM_NOT_READ']);
});

test('a frame closed twice does not pop somebody else s', () => {
  const { j } = captured();
  const outer = j.collect();
  const inner = j.collect();
  j.gap({ code: 'CATALOG_MISS', subject: 'x' });
  assert.deepEqual(inner.end(), ['CATALOG_MISS']);
  assert.deepEqual(inner.end(), ['CATALOG_MISS'], 'end is idempotent');
  j.gap({ code: 'SEARCH_AT_CAP', subject: 'y' });
  // The inner frame owned the first code; once closed, the outer one takes over.
  assert.deepEqual(outer.end(), ['SEARCH_AT_CAP']);
});

test('a code filed outside every frame is attributed to no call', () => {
  const { j } = captured();
  j.gap({ code: 'CATALOG_MISS', subject: 'orphan' });
  const frame = j.collect();
  assert.deepEqual(frame.end(), []);
});

test('a write that failed is counted as dropped ONLY, never also as written', () => {
  const dir = tempDir();
  const blocked = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'x');
  const j = openJournal({ paths: { logs: blocked } });
  j.call({ tool: 'adt_search' });
  j.gap({ code: 'CATALOG_MISS', subject: 'x' });
  const counts = j.counts();
  assert.equal(counts.dropped, 2);
  // The counter that reports on the journal itself has to agree with itself: two attempts,
  // two drops, and nothing claimed as written.
  assert.equal(counts.calls + counts.findings + counts.gaps, 0);
});

test('narrowingOf keeps what narrowed a run and nothing else', () => {
  assert.deepEqual(narrowingOf({ repo: 'zdemo_assort', entity: undefined, key: '' }), {
    repo: 'zdemo_assort',
  });
  // An empty object is what makes a sweep a census, so it must be reachable.
  assert.deepEqual(narrowingOf({ repo: undefined, entity: null }), {});
  assert.deepEqual(narrowingOf(undefined), {});
  // Zero is a narrowing, not an absence.
  assert.deepEqual(narrowingOf({ max: 0 }), { max: 0 });
});

test('a nested field takes a count, and still refuses a string', () => {
  // `result` is where the six sweeps write "how much came back". It was declared, written
  // on every run, and dropped by shape because the field is treated as a map -- so the
  // count never once reached the journal and nothing said so.
  assert.equal(shape('calls', { tool: 'x', result: 8 }).result, 8);
  assert.equal(shape('calls', { tool: 'x', result: 0 }).result, 0, 'zero is an answer');
  // A number and nothing else: these are the fields hardest closed against content.
  assert.equal('result' in shape('calls', { tool: 'x', result: 'SELECT * FROM vbak' }), false);
  assert.equal('args' in shape('calls', { tool: 'x', args: [1, 2] }), false);
  assert.deepEqual(shape('calls', { tool: 'x', args: { repo: 'z' } }).args, { repo: 'z' });
});
