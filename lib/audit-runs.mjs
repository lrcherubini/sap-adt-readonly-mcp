// Reading the AUDIT TRAIL back: how often this server ran, and how it stopped.
//
// A separate module from lib/report.mjs on purpose. docs/security.md keeps two artefacts
// apart -- `logs/` is analysis, `audit.log` is evidence -- and the report is built on the
// first. Crossing into the second is opt-in (`npm run report -- --runs`), and this file is
// the whole crossing: it reads the run lines and counts them, and it does not look at the
// call lines' targets. Nothing here reports WHAT was read.
//
// Before the start/stop lines existed, a restart could only be inferred from the read
// counter falling back to 1 -- an inference that is wrong whenever two processes append to
// the same file, and blind to a process that started and read nothing. Runs that predate
// them are reported as what they are: unattributable.

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.mjs';

export const auditPath = (dir) => path.join(dir ?? stateDir(), 'audit.log');

/**
 * One row per run, oldest first.
 *
 * `stop: null` is a process with no stop line: STILL RUNNING, killed, or crashed. Which one
 * cannot be told from the file -- the pid is recorded but pids are reused, and a liveness
 * check would answer about whatever holds that pid now. So the row names the possibilities
 * instead of picking one.
 *
 * It is NOT the same as an unclean stop, which is a stop that happened and says the system
 * logout did not answer in time -- so the two are different fields, and neither is guessed
 * from the other.
 */
export function runsFromAudit(file = auditPath(), { since } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, runs: [], unattributed: 0, unreadable: 0, missing: true };
  }
  const runs = new Map();
  let unattributed = 0;
  let unreadable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (since && String(row.ts ?? '') < since) continue;
    // A line from before run ids: countable, never attributable. Saying how many there are
    // is the honest report; spreading them over the runs that do exist is not.
    if (!row.run) {
      unattributed++;
      continue;
    }
    const run =
      runs.get(row.run) ??
      { run: row.run, start: null, stop: null, refused: null, reads: 0, offline: 0, first: row.ts, last: row.ts };
    if (row.event === 'logon-refused') {
      run.refused = { ts: row.ts, status: row.status ?? null, user: row.user ?? null, client: row.client ?? null };
    } else if (row.event === 'start') {
      run.start = { ts: row.ts, pid: row.pid ?? null, user: row.user ?? null, client: row.client ?? null };
    } else if (row.event === 'stop') {
      run.stop = { ts: row.ts, reason: row.reason ?? null, clean: row.clean === true };
    } else if (row.adtCalls === 0) {
      // An offline answer is in the trail because it WAS invoked, and it cost the system
      // nothing. Counting it as a read would inflate the one number in this block that is
      // supposed to say what the system was asked for -- the same conflation the quality
      // block exists to avoid.
      run.offline++;
    } else {
      run.reads++;
    }
    if (row.ts < run.first) run.first = row.ts;
    if (row.ts > run.last) run.last = row.ts;
    runs.set(row.run, run);
  }
  return {
    file,
    runs: [...runs.values()].sort((a, b) => String(a.first).localeCompare(String(b.first))),
    unattributed,
    unreadable,
    missing: false,
  };
}

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);

/** Markdown for `npm run report -- --runs`. */
export function renderRuns({ runs, unattributed, unreadable, missing, file }) {
  const out = ['## Server runs — read from the audit trail', ''];
  if (missing) {
    out.push(`No audit trail at \`${file}\`. Nothing has been recorded, which is not the same as nothing having run.`);
    out.push('');
    return out.join('\n');
  }
  const started = runs.filter((r) => r.start);
  const stopped = runs.filter((r) => r.stop);
  const unclean = stopped.filter((r) => !r.stop.clean);
  const vanished = started.filter((r) => !r.stop);
  const refused = runs.filter((r) => r.refused);
  out.push(
    `${runs.length} run(s) · ${started.length} with a start line · ` +
      `${stopped.length} stopped on record (${unclean.length} without a confirmed SAP logout) · ` +
      `${vanished.length} with no stop line (still running, killed or crashed) · ` +
      `${refused.length} logon(s) refused by the system`
  );
  if (refused.length) {
    out.push('');
    out.push(
      `⚠️ ${refused.length} refused logon(s) on record. Repeated failures lock the SAP user, and the ` +
        'one-attempt rule holds per process only: this count is the one place they add up.'
    );
  }
  if (unattributed) {
    out.push('');
    out.push(
      `⚠️ ${unattributed} line(s) carry no run id — they predate the id, and cannot be attributed ` +
        'to any run above. They are counted here and nowhere else, because assigning them to a ' +
        'run would be a guess.'
    );
  }
  out.push('');
  if (!runs.length) {
    out.push('No run recorded.');
    out.push('');
    return out.join('\n');
  }
  out.push('| run | started | SAP reads | offline | ended | how |');
  out.push('|---|---|---:|---:|---|---|');
  for (const r of runs) {
    const dur = ms(r.start?.ts ?? r.first, r.stop?.ts ?? r.last);
    // A run with no START line was never a server: only the server writes the pair, so this
    // is one of the scripts, which begin and end without announcing either. Calling that
    // "killed or crashed" would be asserting a failure from the absence of a line the thing
    // never writes -- the same mistake as reading an empty report as a clean one.
    const how = r.refused
      ? `**logon refused** (HTTP ${r.refused.status ?? '?'})`
      : r.stop
      ? `${r.stop.reason ?? 'stop'}${r.stop.clean ? '' : ' — **SAP logout not confirmed**'}`
      : r.start
        ? '**no stop line** — still running, killed or crashed'
        : 'a script run (only the server writes start/stop)';
    out.push(
      `| \`${r.run}\` | ${String(r.start?.ts ?? r.first).slice(0, 16).replace('T', ' ')} | ` +
        `${r.reads} | ${r.offline} | ${dur === null ? '' : `${Math.round(dur / 1000)}s`} | ${how} |`
    );
  }
  out.push('');
  if (unreadable) out.push(`⚠️ ${unreadable} unreadable line(s) were skipped.`, '');
  return out.join('\n');
}
