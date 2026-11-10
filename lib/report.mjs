// Reading the journal back: quality, backlog, and the server's own limits.
//
// The three streams are append-only and deliberately dumb -- one line per event, no
// aggregation at write time, because an aggregate decided at write time is an aggregate
// nobody can re-cut later. All the interpretation lives here, and it is a separate
// module from scripts/report.mjs so that it can be tested on records in memory rather
// than on a filesystem full of days.
//
// What each block is FOR, since a report nobody acts on is just a longer log:
//
//   quality  what the answers cost, as a number rather than an assertion in a README:
//            the share that touched no DEV at all, and if a change makes the server
//            chattier, this is where it shows. Read it as the mix of tools actually
//            invoked -- it is not a measure of whether the offline tool was PREFERRED
//            where both would have answered, and nothing here can measure that.
//   findings a backlog of defects in the WORKSPACE, grouped by fingerprint so that the
//            same defect seen on twelve runs is one row with a count, not twelve rows.
//   gaps     a backlog of THIS SERVER's limits, ranked by how often each one actually
//            bit. That ranking is the whole point: it turns "someday we should read the
//            annotation chain" into "this blocked 14 answers".

import { digest, readStream } from './journal.mjs';
import {
  severityRank,
  codeInfo,
  emittedBy,
  ANY_TOOL,
  SWEEP_TOOLS,
} from './journal-codes.mjs';

const pct = (n, of) => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10);

/**
 * Percentile by UPPER position: the p-th value is the one at or above the p% mark, so on
 * an even-length list the "median" is the upper of the two middles. Latency here is a
 * warning sign, not a statistic, and rounding a warning sign downwards is the wrong
 * direction. Small n, so sorting on every call is free.
 *
 * It is deliberately NOT nearest-rank, which this comment used to call it: nearest-rank
 * takes the lower middle and, whenever p x n is a whole number, one value less than this.
 * The behaviour is the one that is wanted; only the name was wrong.
 */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * The quality block.
 *
 * `offlineShare` is the number that matters and the one most easily faked: it counts
 * answers that made ZERO ADT calls, taken from the read budget counter rather than from
 * anything a tool reports about itself.
 */
// The resolver's own words for "asked of the system, and it has no such object"
// (lib/resolve.mjs). A negative answer, not a failure of the tool: it is reported apart so the
// failed count means "the tool could not answer" -- 12 of the 27 failures on 2026-10-28 were this.
const NOT_FOUND = /not found in the system/i;
export const isNotFound = (c) => c?.ok === false && NOT_FOUND.test(String(c.outcome ?? ''));

export function quality(calls) {
  const ok = calls.filter((c) => c.ok === true);
  const notFound = calls.filter(isNotFound);
  const offline = calls.filter((c) => (c.adtCalls ?? 0) === 0);
  const durations = calls.map((c) => Number(c.ms ?? 0)).filter((n) => Number.isFinite(n));
  const byTool = new Map();
  for (const c of calls) {
    const key = String(c.tool ?? 'unknown');
    const row = byTool.get(key) ?? { tool: key, calls: 0, failed: 0, notFound: 0, adtCalls: 0, ms: [] };
    row.calls++;
    if (isNotFound(c)) row.notFound++;
    else if (c.ok === false) row.failed++;
    row.adtCalls += Number(c.adtCalls ?? 0);
    row.ms.push(Number(c.ms ?? 0));
    byTool.set(key, row);
  }
  return {
    calls: calls.length,
    ok: ok.length,
    notFound: notFound.length,
    failed: calls.length - ok.length - notFound.length,
    okShare: pct(ok.length, calls.length),
    offlineAnswers: offline.length,
    offlineShare: pct(offline.length, calls.length),
    adtCalls: calls.reduce((sum, c) => sum + Number(c.adtCalls ?? 0), 0),
    msMedian: percentile(durations, 50),
    msP95: percentile(durations, 95),
    tools: [...byTool.values()]
      .map((r) => ({
        tool: r.tool,
        calls: r.calls,
        failed: r.failed,
        notFound: r.notFound,
        adtCallsPerAnswer: Math.round((r.adtCalls / r.calls) * 100) / 100,
        msMedian: percentile(r.ms, 50),
      }))
      .sort((a, b) => b.calls - a.calls),
  };
}

/** Coded records as a backlog: one row per fingerprint, severity first, then frequency. */
/**
 * Merge a provenance-less row into the located row for the same defect.
 *
 * The fingerprint is hash(code, file|repo, subject), so the SAME defect filed twice with
 * different provenance gets two fingerprints and shows up as two backlog rows. That is
 * not hypothetical: an MCP tool files what it can see — it has the entity and the element
 * but no workspace path — while a package scan files the same defect with repo, file
 * and line. Observed 2026-09-09 on ANNOTATION_HIDDEN_WITH_ROLE: two real defects rendered
 * as four `high` rows.
 *
 * A row with no file and no repo cannot be a DIFFERENT occurrence of the same code on the
 * same subject; it is the same finding, known less precisely. So it folds into the located
 * one, keeping the location and summing the counts. Two rows that both carry a location
 * are left alone — those are genuinely different places.
 */
function foldUnlocated(rows) {
  const located = new Map();
  for (const r of rows) {
    if (r.file || r.repo) located.set(`${r.code}|${r.subject}`, r);
  }
  const out = [];
  for (const r of rows) {
    const host = !r.file && !r.repo ? located.get(`${r.code}|${r.subject}`) : null;
    if (!host) {
      out.push(r);
      continue;
    }
    host.times += r.times;
    if (r.first < host.first) host.first = r.first;
    if (r.last > host.last) host.last = r.last;
    // Keep the richer context rather than dropping what the less-located row knew.
    host.context = host.context ?? r.context;
  }
  return out;
}

export function backlog(records) {
  return foldUnlocated(
    digest(records)
    .map((d) => ({
      code: d.record.code,
      // The run that filed it LAST. Timestamps cannot tell a reproduced row from a
      // superseded one -- both have a call after them -- but the run id can.
      run: d.record.run ?? '',
      severity: d.record.severity ?? codeInfo(d.record.code)?.severity ?? 'low',
      subject: d.record.subject ?? '',
      repo: d.record.repo ?? '',
      file: d.record.file ?? '',
      line: d.record.line,
      detail: d.record.detail ?? '',
      context: d.record.context ?? undefined,
      times: d.times,
      first: d.first,
      last: d.last,
      fingerprint: d.fingerprint,
    }))
  ).sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.times - a.times ||
      String(a.subject).localeCompare(String(b.subject))
  );
}

/**
 * A gap is a LIMIT OF THIS SERVER, so it is digested by code -- one row per limit.
 *
 * Findings are digested by subject because there the subject IS the identity: the same
 * code on two files is two defects, in two places, for two people. A gap is the opposite.
 * `SOURCE_NOT_READ` on 85 objects is one limit that bit 85 times, and printing it as 85
 * rows of `medium` does not make the backlog richer -- it makes it unreadable, and it
 * buries whatever is underneath.
 *
 * The subjects are not thrown away: a few go on the row as examples, the total is counted,
 * and `--json` still carries every record. What changes is what the page ranks.
 */
export function gapBacklog(records, { examples = 3 } = {}) {
  const rows = records ?? [];
  const subjects = new Map();
  for (const r of rows) {
    const code = String(r?.code ?? '');
    if (!subjects.has(code)) subjects.set(code, new Set());
    if (r?.subject) subjects.get(code).add(String(r.subject));
  }
  return digest(rows.map((r) => ({ ...r, fingerprint: String(r?.code ?? '') })))
    .map((d) => {
      const seen = [...(subjects.get(d.record.code) ?? [])].sort();
      return {
        code: d.record.code,
        run: d.record.run ?? '',
        severity: d.record.severity ?? codeInfo(d.record.code)?.severity ?? 'low',
        // The first example doubles as `subject` so the row stays shaped like a backlog
        // row for everything downstream; `subjects` is what the reader should look at.
        subject: seen[0] ?? '',
        subjects: seen.slice(0, examples),
        subjectCount: seen.length,
        detail: d.record.detail ?? '',
        times: d.times,
        first: d.first,
        last: d.last,
        fingerprint: d.fingerprint,
      };
    })
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        b.times - a.times ||
        String(a.code).localeCompare(String(b.code))
    );
}

/**
 * Aggregate the three streams.
 *
 * @param {{calls:object[], findings:object[], gaps:object[]}} streams
 */
/**
 * A name absent from BOTH release catalogues.
 *
 * It comes out of the classifier as Level C, which is the rule and is correct -- what is
 * not stated released is not released. But it is a DIFFERENT obligation from a catalogued
 * `notToBeReleased`, and mixing them makes the backlog unusable in both directions.
 * Measured: 155 Level C, of which 115 are absent and 40 name a successor. The
 * 40 are work somebody can start on Monday; for the 115 no successor exists to migrate to,
 * because no statement about them exists at all -- and some of that is the coverage of the
 * catalogues rather than debt in the code (`A_Product` and `A_SalesOrder` are among them).
 *
 * So they are reported apart, and NOT as high severity: a question nobody has answered is
 * not the same as a debt someone has to pay.
 */
const isUnclassified = (f) => f.context?.state === 'ABSENT' || f.context?.inCatalog === false;

/**
 * Has the thing that filed this row run again since -- and did it say so again?
 *
 * The journal only ever grows, so without this every row is reported as a present fact
 * forever: a limit measured away months ago still ranks as the top `high` gap, and a
 * defect fixed in the workspace still shows in its owner's backlog. Re-running the sweep
 * is what makes a row current: a complete scan of the same package.
 *
 * Three answers, and the third is the one that matters:
 *
 *   reproduced     the emitting tool ran after this row's `last` and filed it again.
 *   notReproduced  the emitting tool ran after, and did not. Evidence it is gone.
 *   unknown        no successful call of that tool is recorded after it. NOT resolved --
 *                  nobody looked. Measured on this journal: 10 runs in findings/gaps have
 *                  no matching row in `calls` at all, because the day-file predates the
 *                  CLI journaling its own runs.
 *
 * Collapsing `unknown` into `notReproduced` would turn "nobody checked" into "it is
 * fixed", which is the one mistake this server exists to refuse.
 *
 * @param {object[]} rows    a backlog, already digested
 * @param {object[]} calls   the calls stream
 */
/** Arguments a census may carry: anything else narrows what the run looked at or filed. */
const CENSUS_ARGS = new Set(['package', 'recursive', 'maxObjects', 'upstream', 'refresh']);
const INCOMPLETE = new Set(['SOURCE_NOT_READ', 'SCAN_AT_CAP']);

/** The package a call was a complete census of, or null. */
export function censusOf(c) {
  if (!c?.ts || c.ok === false || !SWEEP_TOOLS.has(c.tool)) return null;
  const args = c.args ?? {};
  if (!args.package || args.recursive === false) return null;
  if (Object.keys(args).some((k) => !CENSUS_ARGS.has(k))) return null;
  if ((c.codes ?? []).some((code) => INCOMPLETE.has(code))) return null;
  return String(args.package).toUpperCase();
}

export function classifyStaleness(rows, calls = []) {
  // A call only counts as a fresh look when it was a CENSUS OF ONE PACKAGE: a sweeping tool,
  // run on `package` with nothing else narrowing it (no entity, no level, no cap on what is
  // reported), recursive, and complete -- no object left unread (SOURCE_NOT_READ) and no cap
  // reached (SCAN_AT_CAP), both of which the call line carries in `codes`. It retires rows of
  // THAT package only: a scan of ZDEMO_A says nothing about a row filed in ZDEMO_B.
  const sweeps = new Map();
  for (const c of calls) {
    const pkg = censusOf(c);
    if (!pkg) continue;
    const key = `${c.tool}|${pkg}`;
    const prev = sweeps.get(key);
    if (!prev || c.ts > prev.ts) sweeps.set(key, { run: c.run, ts: c.ts });
  }

  // Same defect, filed twice with different provenance. One row points at the DDLX that
  // hides the field, the other at the DDLX that gives it a role -- both located, so
  // `foldUnlocated` leaves them apart, and the older one would read as "gone" while the
  // newer one reads as "reproduced". It is superseded, which is not the same fact.
  const reproducedKeys = new Set();

  const first = rows.map((row) => {
    const origin = emittedBy(row.code);
    // An unregistered code cannot be attributed, and guessing which tool owns it would be
    // the same error in a smaller font.
    if (!origin) return { ...row, state: 'unknown', why: 'code not in the emitter registry' };

    const tools = origin.tools === ANY_TOOL ? [...SWEEP_TOOLS] : origin.tools;
    const sweeping = tools.filter((t) => SWEEP_TOOLS.has(t));
    // An ACCEPTED LIMIT, not a defect: a gap filed per target (ENHANCEMENTS_NOT_READ,
    // BATCH_ITEM_NOT_READ, SHAPE_DRIFT, UI5_APP_NOT_READ, ...) has no census that could prove it
    // gone, so it stays `unknown`, and unknown counts as open -- nobody looked is not resolved.
    // It closes by re-reading that target, or by `npm run logs:prune -- --code <CODE> --apply`.
    if (!sweeping.length) {
      return {
        ...row,
        state: 'unknown',
        why: `${tools.join('/')} answers one target per call -- no run of it is a census`,
      };
    }
    const pkg = row.repo ? String(row.repo).toUpperCase() : null;
    const who = sweeping.join('/');
    if (!pkg) {
      return { ...row, state: 'unknown', why: `a scan of ${who} is a census of one package, and this row names none` };
    }
    const latest = sweeping
      .map((t) => sweeps.get(`${t}|${pkg}`))
      .filter(Boolean)
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
      .at(-1);

    if (!latest) return { ...row, state: 'unknown', why: `no complete scan of ${pkg} by ${who} recorded` };
    // Retiring a row means asserting that a specific later sweep looked and did not find
    // it. Without a run id on both sides there is no way to tell "the sweep refiled this"
    // from "the sweep never saw it", so nothing is retired on a guess.
    if (!row.run || !latest.run) {
      return { ...row, state: 'unknown', why: 'no run id to match this against a sweep' };
    }
    if (row.run === latest.run) {
      reproducedKeys.add(`${row.code}|${row.subject}`);
      return { ...row, state: 'reproduced', why: `filed by the latest sweep of ${who} on ${pkg}`, lastRun: latest.ts };
    }
    if (latest.ts > row.last) {
      return {
        ...row,
        state: 'notReproduced',
        why: `${who} swept ${pkg} at ${latest.ts.slice(0, 16)} and did not file it again`,
        lastRun: latest.ts,
      };
    }
    return { ...row, state: 'unknown', why: `${who} has not swept ${pkg} since this was filed` };
  });

  return first.map((row) =>
    row.state === 'notReproduced' && reproducedKeys.has(`${row.code}|${row.subject}`)
      ? {
          ...row,
          state: 'superseded',
          why: 'the same defect was filed again with different provenance -- not gone, relocated',
        }
      : row
  );
}

/**
 * A gap row is one per CODE, so a sweep that re-files the code for one subject used to keep
 * every subject it ever filed under "latest sweep": a sweep that re-filed a gap for the two
 * subjects refused by design kept counting the seven it had since read.
 * A reproduced row keeps only the subjects that run filed; the others become one
 * notReproduced row of their own, named, so they leave the counts without leaving the report.
 */
export function narrowReproducedGaps(rows, records, { examples = 3 } = {}) {
  const out = [];
  for (const row of rows) {
    if (row.state !== 'reproduced' || !row.run) {
      out.push(row);
      continue;
    }
    const ofCode = records.filter((r) => String(r?.code ?? '') === row.code);
    const current = new Set(ofCode.filter((r) => r.run === row.run).map((r) => String(r.subject ?? '')));
    const stale = [...new Set(ofCode.map((r) => String(r.subject ?? '')))].filter((x) => x && !current.has(x)).sort();
    const kept = [...current].filter(Boolean).sort();
    out.push({ ...row, subject: kept[0] ?? '', subjects: kept.slice(0, examples), subjectCount: kept.length });
    if (stale.length) {
      out.push({
        ...row,
        state: 'notReproduced',
        subject: `${stale.length} subject(s): ${stale.join(', ')}`,
        subjects: stale.slice(0, examples),
        subjectCount: stale.length,
        last: ofCode.filter((r) => stale.includes(String(r.subject ?? ''))).map((r) => r.ts).sort().at(-1) ?? row.last,
        why: `${row.why.replace(/^filed by/, 'not filed again by')}, which filed the code for other subjects`,
      });
    }
  }
  return out;
}

/** Still open: confirmed by the latest sweep, or never re-checked. Both need somebody. */
const isOpen = (r) => r.state === 'reproduced' || r.state === 'unknown';

export function buildReport(streams, meta = {}) {
  const calls = streams.calls ?? [];
  const all = classifyStaleness(backlog(streams.findings ?? []), calls);
  const classified = all.filter((f) => !isUnclassified(f));
  const unclassified = all.filter(isUnclassified);
  // A row the latest sweep did not file again, or that the same defect superseded, is not
  // backlog. It stays in the report -- deleting it is a separate, deliberate act (see
  // `npm run logs:prune -- --code`) -- but it stops being counted as work.
  const findings = classified.filter(isOpen);
  const retired = classified.filter((f) => !isOpen(f));
  const allGaps = narrowReproducedGaps(classifyStaleness(gapBacklog(streams.gaps ?? []), calls), streams.gaps ?? []);
  const gaps = allGaps.filter(isOpen);
  const retiredGaps = allGaps.filter((g) => !isOpen(g));

  const byRepo = new Map();
  for (const f of findings) {
    const key = f.repo || f.file?.split('/')[0] || '(unattributed)';
    byRepo.set(key, [...(byRepo.get(key) ?? []), f]);
  }
  return {
    ...meta,
    quality: quality(calls),
    findings,
    unclassified,
    retired,
    findingsByRepo: [...byRepo.entries()]
      .map(([repo, rows]) => ({ repo, rows }))
      .sort((a, b) => b.rows.length - a.rows.length),
    gaps,
    retiredGaps,
    totals: {
      findings: findings.length,
      unclassified: unclassified.length,
      findingOccurrences: all.reduce((s, f) => s + f.times, 0),
      gaps: gaps.length,
      gapOccurrences: gaps.reduce((s, g) => s + g.times, 0),
      retired: retired.length + retiredGaps.length,
      unchecked: [...findings, ...gaps].filter((r) => r.state === 'unknown').length,
      // Deliberately over open `findings` only: see isUnclassified and isOpen above.
      high: findings.filter((f) => f.severity === 'high').length,
    },
  };
}

/** Read the three streams off disk and aggregate them. */
export function reportFromDisk(dir, opts = {}) {
  const calls = readStream(dir, 'calls', opts);
  const findings = readStream(dir, 'findings', opts);
  const gaps = readStream(dir, 'gaps', opts);
  return buildReport(
    { calls: calls.records, findings: findings.records, gaps: gaps.records },
    {
      dir,
      since: opts.since ?? null,
      days: new Set([...calls.files, ...findings.files, ...gaps.files].map((f) => f.slice(-16, -6)))
        .size,
      unreadable: [...calls.unreadable, ...findings.unreadable, ...gaps.unreadable],
    }
  );
}

const short = (text, n = 90) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const where = (row) => (row.line ? `${row.file}:${row.line}` : row.file || row.repo || '');

/** Markdown, because the destination of a finding is a backlog item somebody pastes. */
export function renderMarkdown(report) {
  const q = report.quality;
  const out = [];
  out.push('# MCP journal report');
  out.push('');
  out.push(
    `${q.calls} tool calls${report.since ? ` since ${report.since}` : ''}` +
      `${report.days ? ` over ${report.days} day(s)` : ''} · ` +
      `${report.totals.findings} findings (${report.totals.high} high) · ` +
      (report.totals.unclassified
        ? `${report.totals.unclassified} names with no release statement · `
        : '') +
      `${report.totals.gaps} server gaps`
  );
  out.push('');

  out.push('## Quality');
  out.push('');
  if (!q.calls) {
    out.push('No tool call has been journaled yet.');
  } else {
    out.push(
      `- answered: **${q.okShare}%** (${q.ok}/${q.calls})` +
        (q.notFound ? `, ${q.notFound} not found in the system (a negative answer, not a failure)` : '') +
        (q.failed ? `, ${q.failed} failed` : '')
    );
    // How much of the work cost the SAP system nothing (refusals, cached indexes).
    out.push(
      `- answered **without touching the SAP system**: **${q.offlineShare}%** ` +
        `(${q.offlineAnswers}/${q.calls}), ${q.adtCalls} ADT calls in total`
    );
    out.push(`- latency: median ${q.msMedian} ms, p95 ${q.msP95} ms`);
    out.push('');
    out.push('| tool | calls | failed | not found | ADT calls / answer | median ms |');
    out.push('|---|---:|---:|---:|---:|---:|');
    for (const t of q.tools) {
      out.push(`| ${t.tool} | ${t.calls} | ${t.failed} | ${t.notFound} | ${t.adtCallsPerAnswer} | ${t.msMedian} |`);
    }
  }
  out.push('');

  out.push('## Findings — workspace backlog');
  out.push('');
  if (!report.findings.length) {
    out.push('Nothing found. Note that an empty scan and a scan never run look the same here.');
  } else {
    for (const group of report.findingsByRepo) {
      out.push(`### ${group.repo} — ${group.rows.length}`);
      out.push('');
      out.push('| sev | code | where | subject | seen |');
      out.push('|---|---|---|---|---:|');
      for (const f of group.rows) {
        out.push(
          `| ${f.severity} | \`${f.code}\` | ${short(where(f), 60)} | ` +
            `${short(f.subject, 70)} | ${f.times}× |`
        );
      }
      out.push('');
    }
  }

  if (report.unclassified?.length) {
    out.push('## No release statement possible — not a severity, not a backlog');
    out.push('');
    out.push(
      `${report.unclassified.length} name(s) are absent from BOTH release catalogues. That is ` +
        'Level C by the rule, and it is NOT the same obligation as a catalogued ' +
        '`notToBeReleased`: no successor is named because no statement about them exists at ' +
        'all. Some of this is the coverage of the catalogues rather than debt in the code. ' +
        'Check one in SAP\'s viewer (sap.github.io/abap-atc-cr-cv-s4hc) before treating any ' +
        'of it as work.'
    );
    out.push('');
    out.push('| name | read by | where | seen |');
    out.push('|---|---|---|---:|');
    for (const f of report.unclassified) {
      out.push(
        `| ${short(f.subject, 40)} | ${short(f.context?.consumer ?? '', 30)} | ` +
          `${short(where(f), 55)} | ${f.times}× |`
      );
    }
    out.push('');
  }

  out.push('## Gaps — this server’s own limits, ranked by how often they bit');
  out.push('');
  if (!report.gaps.length) {
    out.push('No gap recorded.');
  } else {
    out.push('| sev | code | bit | on | examples | first | checked |');
    out.push('|---|---|---:|---:|---|---|---|');
    for (const g of report.gaps) {
      const examples =
        (g.subjects ?? []).map((x) => short(x, 24)).join(', ') +
        (g.subjectCount > (g.subjects ?? []).length ? ` +${g.subjectCount - g.subjects.length}` : '');
      out.push(
        `| ${g.severity} | \`${g.code}\` | ${g.times}× | ${g.subjectCount} | ${examples || '-'} | ` +
          `${String(g.first ?? '').slice(0, 10)} | ${g.state === 'reproduced' ? 'latest sweep' : '**never re-checked**'} |`
      );
    }
    out.push('');
    // The meaning is the useful half of a gap and does not fit a table cell. One row per
    // code now, so it can be printed in full instead of cut at 70 characters.
    for (const g of report.gaps) {
      out.push(`- \`${g.code}\` - ${short(codeInfo(g.code)?.meaning, 400)}`);
    }
  }
  out.push('');

  // Rows the journal itself says are no longer current. They are NOT deleted here: the
  // journal only grows, and removing a row is a deliberate act with its own command.
  const retired = [...(report.retired ?? []), ...(report.retiredGaps ?? [])];
  if (retired.length) {
    out.push('## No longer reproduced — kept, not counted');
    out.push('');
    out.push(
      'A full sweep ran after these were filed and did not file them again, or the same ' +
        'defect came back with better provenance. They are out of the counts above and ' +
        'still on disk. To remove one for good: ' +
        '`npm run logs:prune -- --code <CODE> --apply`.'
    );
    out.push('');
    out.push('| state | code | subject | last seen | why |');
    out.push('|---|---|---|---|---|');
    for (const r of retired) {
      out.push(
        `| ${r.state} | \`${r.code}\` | ${short(r.subject, 40)} | ` +
          `${String(r.last ?? '').slice(0, 10)} | ${short(r.why, 70)} |`
      );
    }
    out.push('');
  }

  if (report.totals?.unchecked) {
    out.push(
      `⚠️ **${report.totals.unchecked} of the rows above have never been re-checked.** ` +
        'No unnarrowed sweep of the tool that filed them has run since — which is not the ' +
        'same as them still being true, and is very much not the same as them being fixed. ' +
        '`adt_annotation_chain` in particular answers one element per call, so no number of ' +
        'its calls ever amounts to a census.'
    );
    out.push('');
  }
  if (report.unreadable?.length) {
    out.push(`⚠️ ${report.unreadable.length} unreadable line(s) or file(s) were skipped.`);
    out.push('');
  }
  return out.join('\n');
}
