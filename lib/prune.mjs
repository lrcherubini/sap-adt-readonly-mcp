// Keeping the logs bounded, and doing it in two different ways on purpose.
//
// There are two logs in this server and they are NOT the same kind of artefact:
//
//   logs/<stream>/<day>.jsonl   the analytical journal, inside the repository, git
//                               ignored. ANALYSIS -- it may be edited.
//   %LOCALAPPDATA%/audit.log    the security trail docs/security.md promises: one
//                               append-only file, outside any git work tree.
//                               EVIDENCE -- trimmed by age, never by content.
//
// That distinction is the whole design, and it decides what each half is allowed to do.
//
// The journal is pruned two ways. By AGE, which deletes whole day-files. And SELECTIVELY,
// by code, run or fingerprint, which rewrites a day-file without the matching rows --
// because a limit that has since been measured, or a defect that has since been fixed,
// keeps being reported as present for as long as its row survives, and there was no way
// to retire one short of deleting the whole day around it.
//
// The audit file gets neither: it is trimmed by age and REWRITTEN, never deleted, and no
// content selector reaches it. A security trail that a maintenance script can edit by
// code is not one. The rewrite keeps every line inside the window, keeps every line it
// cannot parse (an unparseable line in an audit trail is evidence of something, never
// noise to discard), and both rewriters go through a temporary file so an interrupted
// prune cannot truncate what it was trimming.

import fs from 'node:fs';
import path from 'node:path';
import { STREAMS, identityOf } from './journal.mjs';

/** ISO day, N days before `now`. Days are compared as strings -- ISO sorts correctly. */
export function cutoffDay(days, now = new Date()) {
  const d = new Date(now.getTime() - Number(days) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Which journal files fall outside the window.
 *
 * @returns {{stream:string, file:string, day:string, bytes:number}[]}
 */
export function journalPrunePlan(dir, days, now = new Date()) {
  const cutoff = cutoffDay(days, now);
  const doomed = [];
  for (const stream of STREAMS) {
    const base = path.join(dir ?? '', stream);
    let names;
    try {
      names = fs.readdirSync(base).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const day = name.slice(0, 10);
      if (day >= cutoff) continue;
      const file = path.join(base, name);
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        /* counted as zero; the delete below still tries */
      }
      doomed.push({ stream, file, day, bytes });
    }
  }
  return doomed;
}

/**
 * Split an audit file into what stays and what goes.
 *
 * A line with no readable `ts` is KEPT. In a security trail the unparseable line is the
 * interesting one, and a prune that quietly ate it would be the exact failure the trail
 * exists to prevent.
 *
 * @returns {{keep:string[], drop:number, unparsed:number, cutoff:string}}
 */
export function auditPrunePlan(text, days, now = new Date()) {
  const cutoff = cutoffDay(days, now);
  const keep = [];
  let drop = 0;
  let unparsed = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let ts = null;
    try {
      ts = JSON.parse(line)?.ts ?? null;
    } catch {
      unparsed++;
      keep.push(line);
      continue;
    }
    if (typeof ts !== 'string') {
      unparsed++;
      keep.push(line);
      continue;
    }
    if (ts.slice(0, 10) < cutoff) {
      drop++;
      continue;
    }
    keep.push(line);
  }
  return { keep, drop, unparsed, cutoff };
}

/**
 * Rewrite a line-oriented file through a temporary, so an interrupted prune cannot
 * truncate it. Used for both the audit trail and a selectively pruned journal day.
 */
export function rewriteJsonl(file, keep) {
  const tmp = `${file}.pruning`;
  fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
}

/** The audit trail's rewriter. Same mechanics under its own name, because the two
 *  artefacts are governed differently and the call sites should not read alike. */
export const rewriteAudit = rewriteJsonl;

/** The content selectors `selectivePrunePlan` understands. A row matches when EVERY
 *  selector given agrees -- they narrow, never widen. */
const SELECTORS = ['code', 'run', 'fingerprint'];

/**
 * The earliest day present in any stream, or null when there is no journal at all.
 *
 * Exists so an age prune that removes nothing can say WHY. "0 files" on its own is
 * indistinguishable from a broken tool, and it is almost always the correct answer.
 */
export function oldestDay(dir) {
  let oldest = null;
  for (const stream of STREAMS) {
    let names;
    try {
      names = fs.readdirSync(path.join(dir ?? '', stream));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)) continue;
      const day = n.slice(0, 10);
      if (!oldest || day < oldest) oldest = day;
    }
  }
  return oldest;
}

/**
 * Which journal ROWS a set of content selectors matches, per file.
 *
 * The counterpart to `journalPrunePlan`: that one answers "which days are too old", this
 * one answers "which rows say something that is no longer true". A row is only ever
 * removed because the fact it asserts has been superseded -- a route since measured, a
 * defect since fixed -- and the caller must name it, because there is deliberately no way
 * to ask for "everything".
 *
 * A line that does not parse is KEPT and counted. In the journal an unparseable line is
 * far more likely to be a half-written append than noise, and a prune that silently ate
 * it would destroy the one row worth looking at.
 *
 * @param {string} dir the logs directory
 * @param {{code?:string, run?:string, fingerprint?:string, stream?:string}} selectors
 * @returns {{files:{stream:string,file:string,day:string,drop:number,keep:string[]}[],
 *            drop:number, unparsed:number, selectors:object}}
 */
export function selectivePrunePlan(dir, selectors = {}) {
  const active = Object.fromEntries(
    SELECTORS.filter((k) => selectors[k] != null && selectors[k] !== '').map((k) => [
      k,
      String(selectors[k]),
    ])
  );
  if (!Object.keys(active).length) {
    throw new Error(
      'a selective prune needs at least one of code, run or fingerprint: there is no ' +
        '"match everything" here on purpose.'
    );
  }
  const only = selectors.stream ? String(selectors.stream) : null;
  if (only && !STREAMS.includes(only)) {
    throw new Error(`unknown stream '${only}' -- expected one of ${STREAMS.join(', ')}.`);
  }

  const out = { files: [], drop: 0, unparsed: 0, selectors: active };
  for (const stream of STREAMS) {
    if (only && stream !== only) continue;
    const base = path.join(dir ?? '', stream);
    let names;
    try {
      names = fs.readdirSync(base).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const file = path.join(base, name);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const keep = [];
      let drop = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let row = null;
        try {
          row = JSON.parse(line);
        } catch {
          out.unparsed++;
          keep.push(line);
          continue;
        }
        // The fingerprint is matched as the report prints it, so a '<redacted>' key that
        // `identityOf` recomputes can be named here too.
        const field = (k) => (k === 'fingerprint' ? identityOf(row) : row?.[k]);
        if (Object.entries(active).every(([k, v]) => String(field(k) ?? '') === v)) {
          drop++;
          continue;
        }
        keep.push(line);
      }
      if (drop) {
        out.files.push({ stream, file, day: name.slice(0, 10), drop, keep });
        out.drop += drop;
      }
    }
  }
  return out;
}
