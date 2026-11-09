#!/usr/bin/env node
// npm run logs:prune -- --days 90 [--apply] [--audit] [--dir <path>]
// npm run logs:prune -- --code SHAPE_UNOBSERVED [--run 4ed489] [--fingerprint ab12] \
//                       [--stream gaps] [--apply]
//
// Trims the analytical journal in logs/ and, with --audit, the security trail in
// %LOCALAPPDATA%\sap-adt\audit.log.
//
// TWO MODES, and they answer different questions:
//
//   by AGE (--days)   "this is older than I keep" -- deletes whole day-files.
//   by CONTENT        "this row asserts something that is no longer true" -- rewrites a
//   (--code/--run/     day-file without the matching rows. For the limit since measured
//    --fingerprint)    and the defect since fixed, which otherwise keep being reported
//                      as present for as long as their row survives.
//
// ⚠️ IT DOES NOTHING WITHOUT --apply. Deleting a log is not reversible, and the two
// artefacts here are the only record of what this server did; a maintenance script that
// destroys them on a typo is worse than a log that grows. So the default run PRINTS the
// plan and exits, and touching the audit trail needs its own flag on top of --apply --
// the journal is analysis, the audit file is evidence, and they should never be removed
// by the same reflex.
//
// ⚠️ Content selectors reach the JOURNAL ONLY, never the audit trail, and a content prune
// with no selector is REFUSED rather than treated as "everything".

import fs from 'node:fs';
import path from 'node:path';
import { offlineConfig, stateDir } from '../lib/config.mjs';
import {
  journalPrunePlan,
  auditPrunePlan,
  rewriteAudit,
  rewriteJsonl,
  selectivePrunePlan,
  cutoffDay,
  oldestDay,
} from '../lib/prune.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const apply = argv.includes('--apply');
const days = Number(flag('days') ?? 90);
if (!Number.isFinite(days) || days < 1) {
  console.error('--days must be a positive number of days to KEEP.');
  process.exit(2);
}

const cfg = offlineConfig();
const dir = flag('dir') ?? cfg.paths.logs;

// --- content mode ----------------------------------------------------------------
// Selecting by content is a different question from selecting by age, so it is a
// different run: mixing them would let a --days typo ride along with a --code that was
// meant to remove two rows.
const selectors = {
  code: flag('code'),
  run: flag('run'),
  fingerprint: flag('fingerprint'),
  stream: flag('stream'),
};
// `--stream` narrows a content prune; it selects nothing by itself. Falling through to
// the age mode with it would silently answer a question nobody asked.
if (selectors.stream && !(selectors.code || selectors.run || selectors.fingerprint)) {
  console.error(
    '--stream narrows a content prune, it does not select rows: add --code, --run or ' +
      '--fingerprint, or drop --stream to prune by age.'
  );
  process.exit(2);
}
if (selectors.code || selectors.run || selectors.fingerprint) {
  let plan;
  try {
    plan = selectivePrunePlan(dir, selectors);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const named = Object.entries(plan.selectors)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`journal (${dir}), rows matching ${named}: ${plan.drop}\n`);
  for (const f of plan.files) {
    console.log(`   ${f.stream}/${f.day}.jsonl  ${f.drop} row(s) out, ${f.keep.length} stay`);
  }
  if (!plan.drop) {
    console.log('   nothing matched -- the selectors are ANDed, and a typo matches nothing.');
  }
  if (plan.unparsed) {
    console.log(`   ${plan.unparsed} unparseable line(s) KEPT on purpose`);
  }
  if (apply && plan.drop) {
    for (const f of plan.files) {
      rewriteJsonl(f.file, f.keep);
      console.log(`   rewritten ${f.stream}/${f.day}.jsonl`);
    }
  }
  if (argv.includes('--audit')) {
    console.log('\n⚠️ --audit ignored: content selectors never reach the security trail.');
  }
  if (!apply) console.log('\nDry run. Add --apply to actually rewrite.');
  process.exit(0);
}

// --- age mode --------------------------------------------------------------------
const cutoff = cutoffDay(days);
console.log(`keeping everything from ${cutoff} onwards (${days} days)\n`);

const doomed = journalPrunePlan(dir, days);
const bytes = doomed.reduce((s, d) => s + d.bytes, 0);
console.log(`journal (${dir}): ${doomed.length} file(s), ${(bytes / 1024).toFixed(1)} KiB`);
for (const d of doomed) console.log(`   ${d.stream}/${d.day}.jsonl`);
// "0 file(s)" and nothing else reads like a broken tool. It is almost always the right
// answer -- the journal is younger than the window -- and saying which day is oldest is
// the difference between a silent no-op and an answer.
if (!doomed.length) {
  const oldest = oldestDay(dir);
  console.log(
    oldest
      ? `   nothing is old enough: the oldest day on disk is ${oldest}, the cutoff is ${cutoff}.`
      : `   there is no journal under ${dir} yet.`
  );
  console.log('   to remove a row whose fact is superseded, select it: --code / --run.');
}
if (apply) {
  let gone = 0;
  for (const d of doomed) {
    try {
      fs.rmSync(d.file);
      gone++;
    } catch (e) {
      console.log(`   ! could not delete ${d.file}: ${e.message}`);
    }
  }
  console.log(`   deleted ${gone}`);
}

if (argv.includes('--audit')) {
  const file = path.join(stateDir(), 'audit.log');
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    console.log(`\naudit trail: ${file} does not exist yet`);
  }
  if (text !== null) {
    const plan = auditPrunePlan(text, days);
    console.log(
      `\naudit trail (${file}): ${plan.drop} line(s) older than ${plan.cutoff} would go, ` +
        `${plan.keep.length} stay` +
        (plan.unparsed ? ` (${plan.unparsed} unparseable line(s) KEPT on purpose)` : '')
    );
    if (apply && plan.drop) {
      rewriteAudit(file, plan.keep);
      console.log('   rewritten');
    }
  }
}

if (!apply) console.log('\nDry run. Add --apply to actually delete.');
