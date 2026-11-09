// Reading the journal back, and keeping it bounded.
//
// Two properties are worth tests here and the rest is formatting:
//
//   1. the same defect seen on N runs is ONE backlog row with a count, not N rows --
//      that is what makes the findings stream a backlog instead of a log;
//   2. the prune never quietly destroys the security trail: whole journal DAYS are
//      deleted, the audit file is REWRITTEN, and a line it cannot parse is kept;
//   3. a row is only ever retired by a CENSUS -- a sweeping tool run unnarrowed -- and a
//      row nobody re-checked reads as UNKNOWN, never as fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReport,
  quality,
  backlog,
  gapBacklog,
  renderMarkdown,
  reportFromDisk,
  classifyStaleness,
  narrowReproducedGaps,
} from '../lib/report.mjs';
import {
  journalPrunePlan,
  auditPrunePlan,
  cutoffDay,
  rewriteAudit,
  rewriteJsonl,
  selectivePrunePlan,
  oldestDay,
} from '../lib/prune.mjs';
import { openJournal, fingerprintOf } from '../lib/journal.mjs';

const call = (tool, adtCalls, ms, ok = true) => ({
  ts: '2026-09-08T10:00:00.000Z',
  tool,
  ok,
  adtCalls,
  ms,
});

// --- quality -----------------------------------------------------------------

test('the offline share counts answers that made zero ADT calls', () => {
  const q = quality([
    call('adt_clean_core_scan', 0, 900),
    call('adt_contract_check', 0, 300),
    call('adt_read_source', 2, 500),
    call('adt_where_used', 1, 100, false),
  ]);
  assert.equal(q.calls, 4);
  assert.equal(q.offlineAnswers, 2);
  assert.equal(q.offlineShare, 50);
  assert.equal(q.adtCalls, 3);
  assert.equal(q.okShare, 75);
  assert.equal(q.failed, 1);
  // Nearest rank, so the median of four is the upper middle: 100, 300, |500|, 900.
  assert.equal(q.msMedian, 500);
  const scan = q.tools.find((t) => t.tool === 'adt_clean_core_scan');
  assert.equal(scan.adtCallsPerAnswer, 0);
});

test('"not found in the system" is a negative answer, counted apart from the failures', () => {
  const q = quality([
    call('adt_object_info', 1, 100),
    { ...call('adt_object_info', 1, 100, false), outcome: "Object 'ZX' of type CLAS/OC not found in the system." },
    { ...call('adt_object_info', 1, 100, false), outcome: 'Request failed with status code 404' },
    call('adt_launchpad', 9, 100, false),
  ]);
  assert.equal(q.notFound, 1);
  assert.equal(q.failed, 2);
  assert.equal(q.ok, 1);
  const info = q.tools.find((t) => t.tool === 'adt_object_info');
  assert.deepEqual([info.failed, info.notFound], [1, 1]);
});

test('an empty journal reports zeroes rather than dividing by zero', () => {
  const q = quality([]);
  assert.equal(q.calls, 0);
  assert.equal(q.offlineShare, 0);
  assert.equal(q.msP95, 0);
  assert.deepEqual(q.tools, []);
});

// --- backlog -----------------------------------------------------------------

const finding = (code, subject, file, ts, fingerprint) => ({
  ts,
  code,
  severity: code === 'CC_LEVEL_C' ? 'high' : 'low',
  subject,
  file,
  repo: file.split('/')[0],
  fingerprint,
});

test('the same defect over several runs is one row with a count', () => {
  const rows = backlog([
    finding('CC_LEVEL_C', 'vbbe', 'zdemo_sd/a.ddls.asddls', '2026-09-01T08:00:00Z', 'aaa'),
    finding('CC_LEVEL_C', 'vbbe', 'zdemo_sd/a.ddls.asddls', '2026-09-05T08:00:00Z', 'aaa'),
    finding('CC_LEVEL_C', 'vbbe', 'zdemo_sd/a.ddls.asddls', '2026-09-08T08:00:00Z', 'aaa'),
    finding('CC_DEPRECATED', 'z_i_demo0081', 'zdemo_fin/z_i_demo0081.ddls.asddls', '2026-09-08T08:00:00Z', 'bbb'),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].times, 3);
  assert.equal(rows[0].first, '2026-09-01T08:00:00Z');
  assert.equal(rows[0].last, '2026-09-08T08:00:00Z');
  // Severity ranks before frequency: a high seen once outranks a low seen thirty times.
  assert.equal(rows[0].severity, 'high');
  assert.equal(rows[1].code, 'CC_DEPRECATED');
});

test('a name absent from both catalogues is reported apart, and not as high severity', () => {
  // Both rows are CC_LEVEL_C and both are correct. The obligations are not the same:
  // ACDOCA names a successor somebody can migrate to, and /gib/dcc_histm names nothing
  // because no release statement about it exists at all. Measured over the
  // workspace: 40 of the first kind, 115 of the second. Rendering 155 identical `high`
  // rows buries the 40 that are actually work.
  const absent = {
    ts: '2026-09-08T08:00:00Z',
    code: 'CC_LEVEL_C',
    severity: 'high',
    subject: '/gib/dcc_histm',
    file: 'zdemo_001/zdemo_cds_hist.ddls.asddls',
    repo: 'zdemo_001',
    context: { state: 'ABSENT', inCatalog: false, consumer: 'ZDEMO_CDS_HIST' },
    fingerprint: 'u1',
  };
  const debt = {
    ts: '2026-09-08T08:00:00Z',
    code: 'CC_LEVEL_C',
    severity: 'high',
    subject: 'ACDOCA',
    file: 'zdemo_001/zdemo_cds_acdoca.ddls.asddls',
    repo: 'zdemo_001',
    context: { state: 'notToBeReleased', inCatalog: true, consumer: 'ZDEMO_CDS_ACDOCA' },
    fix: 'successors: I_JOURNALENTRYITEM',
    fingerprint: 'd1',
  };
  const report = buildReport({ calls: [], findings: [absent, debt], gaps: [] });

  assert.equal(report.totals.findings, 1, 'only the actionable one is a finding');
  assert.equal(report.totals.high, 1);
  assert.equal(report.totals.unclassified, 1);
  assert.equal(report.totals.findingOccurrences, 2, 'nothing was dropped, only moved');
  assert.deepEqual(report.findings.map((f) => f.subject), ['ACDOCA']);
  assert.deepEqual(report.unclassified.map((f) => f.subject), ['/gib/dcc_histm']);
  assert.deepEqual(report.findingsByRepo.map((g) => `${g.repo}:${g.rows.length}`), ['zdemo_001:1']);

  const md = renderMarkdown(report);
  assert.match(md, /1 findings \(1 high\) · 1 names with no release statement/);
  assert.match(md, /## No release statement possible — not a severity, not a backlog/);
  assert.match(md, /abap-atc-cr-cv-s4hc/, 'it names the independent reference to check against');
  // The absent name must not also appear in the actionable backlog table.
  const backlogHalf = md.slice(0, md.indexOf('## No release statement possible'));
  assert.equal(backlogHalf.includes('/gib/dcc_histm'), false);
});

test('a report groups findings by repository and counts the high ones', () => {
  const report = buildReport({
    calls: [call('adt_clean_core_scan', 0, 10)],
    findings: [
      finding('CC_LEVEL_C', 'vbbe', 'zdemo_sd/a.ddls.asddls', '2026-09-08T08:00:00Z', 'a'),
      finding('CC_LEVEL_C', 'konv', 'zdemo_sd/b.ddls.asddls', '2026-09-08T08:00:00Z', 'b'),
      finding('CC_DEPRECATED', 'x', 'zdemo_001/x.ddls.asddls', '2026-09-08T08:00:00Z', 'c'),
    ],
    gaps: [
      { ts: '2026-09-08T08:00:00Z', code: 'UI5_APP_NOT_READ', subject: 'ZC_X', fingerprint: 'g1' },
      { ts: '2026-09-08T09:00:00Z', code: 'UI5_APP_NOT_READ', subject: 'ZC_X', fingerprint: 'g1' },
    ],
  });
  assert.equal(report.totals.findings, 3);
  assert.equal(report.totals.high, 2);
  assert.equal(report.totals.gaps, 1);
  assert.equal(report.totals.gapOccurrences, 2);
  assert.deepEqual(
    report.findingsByRepo.map((g) => `${g.repo}:${g.rows.length}`),
    ['zdemo_sd:2', 'zdemo_001:1']
  );
});

test('the Markdown says how much of the work cost the SAP system nothing', () => {
  const md = renderMarkdown(
    buildReport({
      calls: [call('adt_clean_core_scan', 0, 10), call('adt_read_source', 3, 40)],
      findings: [finding('CC_LEVEL_C', 'vbbe', 'zdemo_sd/a.ddls.asddls', '2026-09-08T08:00:00Z', 'a')],
      gaps: [{ ts: '2026-09-08T08:00:00Z', code: 'CATALOG_MISS', subject: 'ZFOO', fingerprint: 'g' }],
    })
  );
  assert.match(md, /answered \*\*without touching the SAP system\*\*: \*\*50%\*\*/);
  assert.match(md, /### zdemo_sd — 1/);
  assert.match(md, /`CC_LEVEL_C`/);
  // A gap row carries the registered meaning, so the report is readable a month later
  // without opening lib/journal-codes.mjs.
  assert.match(md, /absent from both catalogues/);
});

test('an empty report says nothing was found, and does not claim it is clean', () => {
  const md = renderMarkdown(buildReport({ calls: [], findings: [], gaps: [] }));
  assert.match(md, /an empty scan and a scan never run look the same/);
});

// --- round trip through disk ---------------------------------------------------

function tmpLogs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  return { dir, cfg: { paths: { logs: dir } } };
}

test('what the journal writes is what the report reads', () => {
  const { dir, cfg } = tmpLogs();
  const journal = openJournal(cfg);
  journal.call({ tool: 'adt_contract_check', ok: true, ms: 12, adtCalls: 0 });
  journal.finding({
    code: 'ALIAS_DRIFT',
    subject: 'ZI_DemoStorageLocation',
    file: 'abap-zdemo_assort/x.srvd.srvdsrv',
    context: { aliases: 'AssortStorageLocation, AssortStrLoc' },
  });
  journal.gap({ code: 'UI5_APP_NOT_READ', subject: 'UI5 ZDEMO_APP', detail: 'manifest.json: 404' });

  const report = reportFromDisk(dir);
  assert.equal(report.quality.offlineShare, 100);
  assert.equal(report.totals.findings, 1);
  assert.equal(report.findings[0].code, 'ALIAS_DRIFT');
  assert.equal(report.findings[0].context.aliases, 'AssortStorageLocation, AssortStrLoc');
  assert.equal(report.totals.gaps, 1);
  assert.equal(report.days, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--since drops the days before it', () => {
  const { dir } = tmpLogs();
  fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });
  const line = (ts) => `${JSON.stringify({ ts, code: 'CATALOG_MISS', subject: 'X' })}\n`;
  fs.writeFileSync(path.join(dir, 'findings', '2026-08-01.jsonl'), line('2026-08-01T00:00:00Z'));
  fs.writeFileSync(path.join(dir, 'findings', '2026-09-08.jsonl'), line('2026-09-08T00:00:00Z'));
  assert.equal(reportFromDisk(dir).totals.findingOccurrences, 2);
  assert.equal(reportFromDisk(dir, { since: '2026-09-01' }).totals.findingOccurrences, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- prune ---------------------------------------------------------------------

test('the cutoff is a day, computed backwards from now', () => {
  assert.equal(cutoffDay(90, new Date('2026-09-08T12:00:00Z')), '2026-06-10');
  assert.equal(cutoffDay(1, new Date('2026-01-01T00:00:00Z')), '2025-12-31');
});

test('pruning the journal names whole days and never touches the recent ones', () => {
  const { dir } = tmpLogs();
  fs.mkdirSync(path.join(dir, 'findings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'calls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'findings', '2026-01-02.jsonl'), 'x\n');
  fs.writeFileSync(path.join(dir, 'findings', '2026-09-07.jsonl'), 'x\n');
  fs.writeFileSync(path.join(dir, 'calls', '2026-01-02.jsonl'), 'x\n');
  // Not a day file: never a candidate for deletion.
  fs.writeFileSync(path.join(dir, 'findings', 'notes.md'), 'keep me');

  const plan = journalPrunePlan(dir, 30, new Date('2026-09-08T00:00:00Z'));
  assert.deepEqual(
    plan.map((p) => `${p.stream}/${p.day}`).sort(),
    ['calls/2026-01-02', 'findings/2026-01-02']
  );
  assert.equal(journalPrunePlan(dir, 3650, new Date('2026-09-08T00:00:00Z')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the audit prune keeps every line it cannot date', () => {
  const text = [
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', tool: 'adt_search' }),
    JSON.stringify({ ts: '2026-09-08T00:00:00Z', tool: 'adt_search' }),
    '{ this line is not JSON',
    JSON.stringify({ tool: 'adt_search' }),
    '',
  ].join('\n');
  const plan = auditPrunePlan(text, 30, new Date('2026-09-08T00:00:00Z'));
  assert.equal(plan.drop, 1, 'only the line that is provably old goes');
  assert.equal(plan.unparsed, 2);
  assert.equal(plan.keep.length, 3, 'an undateable line in a security trail is evidence');
});

test('the audit file is rewritten through a temporary, and ends with a newline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, 'old\n');
  rewriteAudit(file, ['a', 'b']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n');
  assert.equal(fs.existsSync(`${file}.pruning`), false);
  rewriteAudit(file, []);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same defect filed with and without provenance is ONE backlog row', () => {
  // Measured: adt_annotation_chain files what it can see (entity + element,
  // no workspace path) while an offline scanner files repo/file/line for the same
  // defect. The fingerprint includes file|repo, so both survived digest() and two real
  // defects rendered as four `high` rows in `npm run report`.
  const rows = backlog([
    {
      ts: '2026-09-09T10:00:00.000Z', code: 'ANNOTATION_HIDDEN_WITH_ROLE', severity: 'high',
      subject: 'ZC_DemoShelfStock.Plant', fingerprint: 'aaa',
      repo: 'abap-zdemo_assort',
      file: 'zdemo_assort/zi_demostoragelocation.ddlx.asddlxs', line: 42,
    },
    {
      ts: '2026-09-09T12:00:00.000Z', code: 'ANNOTATION_HIDDEN_WITH_ROLE', severity: 'high',
      subject: 'ZC_DemoShelfStock.Plant', fingerprint: 'bbb',
      context: { route: '/sap/bc/adt/ddic/ddlx/annotation/chain' },
    },
  ]);
  assert.equal(rows.length, 1, 'one defect, one row');
  assert.equal(rows[0].times, 2, 'both sightings are counted');
  assert.equal(rows[0].line, 42, 'the located row wins, so the backlog stays actionable');
  assert.equal(rows[0].last, '2026-09-09T12:00:00.000Z', 'last-seen comes from either side');
  assert.ok(rows[0].context, 'what only the unlocated row knew is not thrown away');
});

test('two located rows for one code are NOT merged: they are different places', () => {
  const rows = backlog([
    {
      ts: '2026-09-09T10:00:00.000Z', code: 'CC_DEPRECATED', severity: 'low',
      subject: 'x.ddls.asddls', fingerprint: 'aaa', repo: 'r1', file: 'a/x.ddls.asddls',
    },
    {
      ts: '2026-09-09T10:00:00.000Z', code: 'CC_DEPRECATED', severity: 'low',
      subject: 'x.ddls.asddls', fingerprint: 'bbb', repo: 'r2', file: 'b/x.ddls.asddls',
    },
  ]);
  assert.equal(rows.length, 2);
});

// --- selective prune -------------------------------------------------------------
//
// Deleting a whole day to retire one row is how a journal stops being read. The two ways
// this could go wrong are taking rows nobody asked for, and taking none.

/** A logs dir with one day of gaps: two rows, plus a line that does not parse. */
function tmpGaps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-'));
  fs.mkdirSync(path.join(dir, 'gaps'), { recursive: true });
  const rows = [
    JSON.stringify({ ts: '2026-09-09T00:00:00Z', run: 'aaa', code: 'SHAPE_UNOBSERVED', subject: 'r' }),
    JSON.stringify({ ts: '2026-09-09T00:01:00Z', run: 'bbb', code: 'CATALOG_MISS', subject: 'n' }),
    '{ half-written append',
  ];
  fs.writeFileSync(path.join(dir, 'gaps', '2026-09-09.jsonl'), `${rows.join('\n')}\n`);
  return dir;
}

test('a selective prune takes the rows named and leaves every other one', () => {
  const dir = tmpGaps();
  const plan = selectivePrunePlan(dir, { code: 'SHAPE_UNOBSERVED' });
  assert.equal(plan.drop, 1);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].keep.length, 2, 'the other row AND the unparseable line stay');
  assert.equal(plan.unparsed, 1);

  rewriteJsonl(plan.files[0].file, plan.files[0].keep);
  const left = fs.readFileSync(plan.files[0].file, 'utf8').trim().split('\n');
  assert.equal(left.length, 2);
  assert.equal(left.some((l) => l.includes('SHAPE_UNOBSERVED')), false);
  assert.equal(left.some((l) => l.includes('CATALOG_MISS')), true);
  assert.equal(left.some((l) => l.includes('half-written')), true, 'evidence, not noise');
  assert.equal(fs.existsSync(`${plan.files[0].file}.pruning`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selectors narrow, they never widen', () => {
  const dir = tmpGaps();
  // Every selector given must agree. A real code plus a wrong run matches NOTHING -- the
  // opposite would delete every SHAPE_UNOBSERVED on a mistyped run id.
  assert.equal(selectivePrunePlan(dir, { code: 'SHAPE_UNOBSERVED', run: 'zzz' }).drop, 0);
  assert.equal(selectivePrunePlan(dir, { code: 'SHAPE_UNOBSERVED', run: 'aaa' }).drop, 1);
  assert.equal(selectivePrunePlan(dir, { run: 'bbb' }).drop, 1);
  assert.equal(selectivePrunePlan(dir, { code: 'NOPE' }).drop, 0, 'a typo matches nothing');
  // `stream` narrows too, so it can never reach a stream it was not pointed at.
  assert.equal(selectivePrunePlan(dir, { code: 'SHAPE_UNOBSERVED', stream: 'calls' }).drop, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a row whose fingerprint was written '<redacted>' is named by the one the report prints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selective-'));
  fs.mkdirSync(path.join(dir, 'gaps'), { recursive: true });
  const masked = (code, subject) =>
    JSON.stringify({ ts: '2026-09-24T00:00:00Z', run: 'aaa', code, subject, fingerprint: '<redacted>' });
  fs.writeFileSync(
    path.join(dir, 'gaps', '2026-09-24.jsonl'),
    `${masked('DDIC_FIELDS_NOT_READ', 'ZDEMO_FREIGHT_TRACK')}\n${masked('UI5_APP_NOT_READ', 'x/y')}\n`
  );
  const printed = fingerprintOf(['DDIC_FIELDS_NOT_READ', '', 'ZDEMO_FREIGHT_TRACK']);
  assert.equal(selectivePrunePlan(dir, { fingerprint: printed }).drop, 1, 'only that one row');
  assert.equal(selectivePrunePlan(dir, { fingerprint: '<redacted>' }).drop, 0, 'the mask names nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a selective prune with nothing selected is refused, not read as everything', () => {
  const dir = tmpGaps();
  const before = fs.readFileSync(path.join(dir, 'gaps', '2026-09-09.jsonl'), 'utf8');
  assert.throws(() => selectivePrunePlan(dir, {}), /at least one of code, run or fingerprint/);
  assert.throws(() => selectivePrunePlan(dir, { stream: 'gaps' }), /at least one of/);
  assert.throws(() => selectivePrunePlan(dir, { code: 'X', stream: 'nope' }), /unknown stream/);
  assert.equal(fs.readFileSync(path.join(dir, 'gaps', '2026-09-09.jsonl'), 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an age prune that matches nothing can say which day is the oldest', () => {
  const dir = tmpGaps();
  assert.equal(oldestDay(dir), '2026-09-09');
  assert.equal(oldestDay(path.join(dir, 'nope')), null, 'no journal at all is null, not a throw');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- staleness -------------------------------------------------------------------
//
// What decides whether the report is a backlog or an archive.

/** A journalled call. Unnarrowed (no `args`) and successful unless said otherwise. */
// A complete scan of one package is the census; a row names the package it was filed in.
const sweep = (tool, run, ts, pkg = 'ZTEST') => ({ ts, run, tool, ok: true, adtCalls: 0, ms: 1, args: { package: pkg } });
const row = (code, subject, run, last, repo = 'ZTEST') => ({ code, subject, run, last, times: 1, severity: 'high', repo });

test('a row the latest census filed again is reproduced', () => {
  const [r] = classifyStaleness(
    [row('CATALOG_MISS', 'x', 'r2', '2026-09-09T10:00:00Z')],
    [
      sweep('adt_clean_core_scan', 'r1', '2026-09-08T10:00:00Z'),
      sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z'),
    ]
  );
  assert.equal(r.state, 'reproduced');
});

test('a row the latest census did NOT file again stops being counted', () => {
  const [r] = classifyStaleness(
    [row('CATALOG_MISS', 'x', 'r1', '2026-09-08T10:00:00Z')],
    [
      sweep('adt_clean_core_scan', 'r1', '2026-09-08T10:00:00Z'),
      sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z'),
    ]
  );
  assert.equal(r.state, 'notReproduced');
  assert.match(r.why, /did not file it again/);
});

test('nobody looked reads as UNKNOWN, never as fixed', () => {
  // The case that matters most: collapsing this into `notReproduced` would turn "nobody
  // checked" into "it is gone", which is the one mistake this server exists to refuse.
  const none = classifyStaleness([row('CATALOG_MISS', 'x', 'r1', '2026-09-09T10:00:00Z')], []);
  assert.equal(none[0].state, 'unknown');
  assert.match(none[0].why, /no complete scan of ZTEST/);

  // A census that ran BEFORE the row was filed is not a later look either.
  const before = classifyStaleness(
    [row('CATALOG_MISS', 'x', 'r9', '2026-09-09T10:00:00Z')],
    [sweep('adt_clean_core_scan', 'r1', '2026-09-08T10:00:00Z')]
  );
  assert.equal(before[0].state, 'unknown');
  assert.match(before[0].why, /has not swept ZTEST since/);
});

test('with no run id on both sides nothing is retired on a guess', () => {
  // Measured: the fixtures in this file carry no run id, and a timestamp alone cannot
  // tell "the sweep refiled this" from "the sweep never saw it".
  const [r] = classifyStaleness(
    [{ code: 'CATALOG_MISS', subject: 'x', last: '2026-09-08T10:00:00Z', times: 1, repo: 'ZTEST' }],
    [sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z')]
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.why, /no run id/);
});

test('a targeted tool can never retire anything, however often it ran', () => {
  // adt_annotation_chain answers ONE element per call. Ten calls about other elements say
  // nothing about this one -- measured: counting them as a re-look marked the live
  // ZC_DemoShelfStock.Plant defect as no longer reproduced.
  const calls = Array.from({ length: 10 }, (_, i) =>
    sweep('adt_annotation_chain', `c${i}`, `2026-09-09T1${i}:00:00Z`)
  );
  const [r] = classifyStaleness(
    [row('ANNOTATION_OVERRIDDEN', 'ZC_X.Y', 'old', '2026-09-09T09:00:00Z')],
    calls
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.why, /one target per call/);
});

test('a narrowed, incomplete or failed scan is not a census, and neither is a scan of another package', () => {
  // An entity filter, a level filter or a non-recursive run looked at less than the package;
  // an object left unread or a cap reached (the call line's `codes`) means the scan saw less
  // than is there; and a scan of ZOTHER says nothing about a row filed in ZTEST.
  const one = row('CATALOG_MISS', 'x', 'r1', '2026-09-08T10:00:00Z');
  const base = sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z');
  for (const args of [{ package: 'ZTEST', entity: 'ZI_X' }, { package: 'ZTEST', minLevel: 'C' }, { package: 'ZTEST', recursive: false }, {}]) {
    assert.equal(classifyStaleness([one], [{ ...base, args }])[0].state, 'unknown', JSON.stringify(args));
  }
  for (const code of ['SOURCE_NOT_READ', 'SCAN_AT_CAP']) {
    assert.equal(classifyStaleness([one], [{ ...base, codes: [code] }])[0].state, 'unknown', code);
  }
  assert.equal(classifyStaleness([one], [sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z', 'ZOTHER')])[0].state, 'unknown');
  assert.equal(classifyStaleness([one], [{ ...base, args: { package: 'ztest', maxObjects: 300 } }])[0].state, 'notReproduced', 'a raised cap is still a census');
  assert.match(classifyStaleness([{ ...one, repo: undefined }], [base])[0].why, /names none/);
  assert.equal(
    classifyStaleness([one], [{ ...sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z'), ok: false }])[0]
      .state,
    'unknown'
  );
});

test('the same defect refiled with better provenance is superseded, not gone', () => {
  // Two located rows for one defect: one points at the DDLX that hides the field, the
  // other at the DDLX that gives it a role. `foldUnlocated` cannot merge them, so the
  // older would read "no longer reproduced" while the newer reads "reproduced" -- of the
  // same defect. That is a third answer, and it has to be said out loud.
  const rows = [
    row('ANNOTATION_HIDDEN_WITH_ROLE', 'ZC_X.Plant', 'old', '2026-09-09T01:00:00Z'),
    row('ANNOTATION_HIDDEN_WITH_ROLE', 'ZC_X.Plant', 'new', '2026-09-09T13:00:00Z'),
  ];
  const out = classifyStaleness(rows, [sweep('adt_annotation_scan', 'new', '2026-09-09T13:00:00Z')]);
  assert.deepEqual(out.map((r) => r.state), ['superseded', 'reproduced']);
  assert.match(out[0].why, /not gone, relocated/);
});

test('an unregistered code is unknown, never attributed to a guess', () => {
  const [r] = classifyStaleness(
    [row('NOT_A_REAL_CODE', 'x', 'r1', '2026-09-08T10:00:00Z')],
    [sweep('adt_clean_core_scan', 'r2', '2026-09-09T10:00:00Z')]
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.why, /not in the emitter registry/);
});

test('a retired row leaves the counts but stays on the page', () => {
  const at = (ts, run, subject, fingerprint) => ({
    ts, run, code: 'CC_LEVEL_C', severity: 'high', subject, fingerprint,
    repo: 'zdemo_001', file: `zdemo_001/${subject}.ddls.asddls`,
    context: { state: 'notToBeReleased', inCatalog: true },
  });
  const report = buildReport({
    calls: [sweep('adt_clean_core_scan', 'new', '2026-09-09T13:00:00Z', 'zdemo_001')],
    findings: [
      at('2026-09-08T08:00:00Z', 'old', 'GONE', 'f1'),
      at('2026-09-09T13:00:00Z', 'new', 'STILL', 'f2'),
    ],
    gaps: [],
  });
  assert.equal(report.totals.findings, 1, 'only the reproduced one is backlog');
  assert.equal(report.totals.high, 1);
  assert.equal(report.totals.retired, 1);
  assert.deepEqual(report.findings.map((f) => f.subject), ['STILL']);
  assert.deepEqual(report.retired.map((f) => f.subject), ['GONE']);

  const md = renderMarkdown(report);
  assert.match(md, /## No longer reproduced/);
  assert.match(md, /GONE/, 'it is still readable');
  assert.match(md, /logs:prune -- --code/, 'and it says how to remove it for good');
});

// --- gaps are a limit of THIS SERVER, so they are digested by code ----------------

const gapOn = (code, subject, ts, run = 'r1') => ({
  ts,
  run,
  code,
  severity: 'medium',
  subject,
  detail: `${subject} could not be read`,
  fingerprint: `${code}|${subject}`,
});

test('one limit that bit on many subjects is ONE row, with the subjects as examples', () => {
  const records = ['A', 'B', 'C', 'D', 'E'].map((s, i) =>
    gapOn('SOURCE_NOT_READ', s, `2026-09-11T10:0${i}:00.000Z`)
  );
  const rows = gapBacklog(records);
  assert.equal(rows.length, 1, 'five subjects of one code are one limit, not five');
  assert.equal(rows[0].times, 5);
  assert.equal(rows[0].subjectCount, 5);
  assert.deepEqual(rows[0].subjects, ['A', 'B', 'C']);
  // The whole point: 85 unreadable files used to be 85 rows of `medium`, which buried
  // whatever else was open under a page nobody read.
  assert.equal(rows[0].code, 'SOURCE_NOT_READ');
});

test('two codes stay two rows, ranked by severity then by how often each bit', () => {
  const rows = gapBacklog([
    { ...gapOn('SOURCE_NOT_READ', 'A', '2026-09-11T10:00:00.000Z'), severity: 'medium' },
    { ...gapOn('SOURCE_NOT_READ', 'B', '2026-09-11T10:01:00.000Z'), severity: 'medium' },
    { ...gapOn('SEARCH_AT_CAP', 'Z*', '2026-09-11T10:02:00.000Z'), severity: 'low' },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.code, r.times]),
    [
      ['SOURCE_NOT_READ', 2],
      ['SEARCH_AT_CAP', 1],
    ]
  );
});

test('the rendered gap table names the code once and counts the subjects', () => {
  const report = buildReport({
    calls: [],
    findings: [],
    gaps: ['A', 'B', 'C', 'D'].map((s, i) =>
      gapOn('FEED_NOT_READ', s, `2026-09-11T10:0${i}:00.000Z`)
    ),
  });
  const md = renderMarkdown(report);
  assert.equal(report.gaps.length, 1);
  assert.equal((md.match(/FEED_NOT_READ/g) ?? []).length, 2, 'once in the table, once in the meanings');
  assert.match(md, /\+1/, 'the subjects beyond the examples are counted, not dropped');
});

test('a gap code re-filed by the latest sweep keeps only the subjects that sweep filed', () => {
  const gap = (run, subject, ts) => ({ ts, run, code: 'SOURCE_NOT_READ', severity: 'medium', subject });
  const records = [
    gap('old', 'adt_clean_core_scan zdemo_a', '2026-10-02T10:00:00.000Z'),
    gap('old', 'adt_clean_core_scan zdemo_b', '2026-10-02T10:00:01.000Z'),
    gap('new', 'adt_clean_core_scan zdemo_b', '2026-10-28T19:00:00.000Z'),
  ];
  const row = { code: 'SOURCE_NOT_READ', run: 'new', state: 'reproduced', why: 'filed by the latest sweep of adt_clean_core_scan', last: '2026-10-28T19:00:00.000Z' };
  const [kept, stale] = narrowReproducedGaps([row], records);
  assert.deepEqual(kept.subjects, ['adt_clean_core_scan zdemo_b']);
  assert.equal(kept.subjectCount, 1);
  assert.equal(stale.state, 'notReproduced');
  assert.equal(stale.subject, '1 subject(s): adt_clean_core_scan zdemo_a');
  assert.equal(stale.last, '2026-10-02T10:00:00.000Z');
  assert.match(stale.why, /^not filed again by the latest sweep of adt_clean_core_scan/);
  const unknown = { ...row, state: 'unknown' };
  assert.deepEqual(narrowReproducedGaps([unknown], records), [unknown]);
});
