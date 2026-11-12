// The journal: three append-only JSONL streams that make this server's own quality
// measurable, and its findings reusable.
//
//   logs/calls/<date>.jsonl     one line per tool invocation  -> quality
//   logs/findings/<date>.jsonl  one line per workspace defect -> input for corrections
//   logs/gaps/<date>.jsonl      one line per limit of this server -> what to improve
//
// WHY THIS LIVES INSIDE THE REPOSITORY, and how that squares with docs/security.md.
// The state directory (%LOCALAPPDATA%\sap-adt\) holds the environment store, the loopback
// token and the audit trail, and lib/config.mjs REFUSES TO START if that path resolves
// inside a git work tree. None of that changes. The journal is a
// different class of artefact: analysis metadata -- object names, codes, counters,
// timings -- and it is most useful sitting next to the code that produced it, where a
// report can be generated and read. It is git-ignored (`/logs/`), asserted so by a
// test.
//
// The safety property is not "we promise not to log secrets". It is the same one the
// guard uses: ABSENCE OF CAPABILITY.
//
//   * a top-level field that is not on that stream's allowlist is DROPPED, not logged;
//   * nested maps (args, result, context) accept PRIMITIVES ONLY -- an object or array
//     value is replaced by its size, so a source body or a payload cannot pass through
//     even if a caller hands one over;
//   * keys actually named for content (source, body, text, payload, password, token, ...)
//     are dropped whatever their value;
//   * strings are truncated, and a run of 11+ digits is redacted, because integration
//     payloads can carry personal tax ids and account numbers.
//
// Nothing here may ever break a read: every write is best-effort inside try/catch. A
// logging failure that hid an answer would be worse than no logging.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { codeInfo } from './journal-codes.mjs';
import { currentCall } from './call-context.mjs';

export const STREAMS = ['calls', 'findings', 'gaps'];

/** Top-level fields each stream accepts. Anything else is dropped. */
const FIELDS = {
  calls: [
    'ts',
    'run',
    'tool',
    'ok',
    'outcome',
    'ms',
    'adtCalls',
    'budgetLeft',
    'args',
    'result',
    'codes',
  ],
  findings: [
    'ts',
    'run',
    'code',
    'severity',
    'repo',
    'file',
    'line',
    'subject',
    'context',
    'effect',
    'fix',
    'fingerprint',
  ],
  gaps: [
    'ts',
    'run',
    'code',
    'severity',
    'subject',
    'detail',
    'impact',
    'fallback',
    'fingerprint',
  ],
};

/** Fields whose value is a nested map of primitives rather than a scalar. */
const NESTED = new Set(['args', 'result', 'context']);

/**
 * Keys named for content, refused whatever they hold. Anchored on purpose: `source`
 * is refused, `sourceType` is kept -- a finding about SOURCE_TYPE has to be able to
 * say which value it saw.
 */
const CONTENT_KEY =
  /^(source|src|payload|body|text|content|snippet|code_?text|password|passwd|pwd|token|secret|credential|cookie|authorization|auth)$/i;

const MAX_STRING = 200;
const MAX_NESTED_KEYS = 24;
const DEFAULT_MAX_BYTES_PER_DAY = 4_000_000;

/**
 * A short id for one process, so the three streams and the audit log correlate.
 *
 * The canonical one is `runId()` in lib/config.mjs, memoised per process and written by
 * lib/audit.mjs too; `openJournal` takes it from `cfg.run`. This stays as the fallback for
 * a journal opened without a config, and for tests that want an id of their own.
 */
export const newRunId = () => crypto.randomBytes(3).toString('hex');

/**
 * What narrowed a sweep, as the `args` of its call line. An EMPTY object means a census.
 *
 * This is not cosmetics: `classifyStaleness` retires a row only on a sweep that ran
 * unnarrowed, and it reads that from `args`. The sweep scripts used to journal no
 * `args` at all, so a `--repo zdemo_assort` run was indistinguishable from a full one
 * and could retire a row in any other repository. One function so they all agree on what
 * "unnarrowed" looks like -- an absent flag must not arrive here as `undefined`, `null`
 * or `''` and turn `{}` into something.
 *
 * What that costs, replayed over a real journal on 2026-09-23: one `--repo` run of
 * `scan:clean-core` turned 181 of 216 findings into `notReproduced` -- stopped counting as
 * work -- in repositories that run never opened. The guard is the whole of what prevents it.
 */
export const narrowingOf = (values) =>
  Object.fromEntries(
    Object.entries(values ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );

/**
 * Stable identity of a finding or gap, so a report can say first seen / last seen /
 * how many times instead of printing the same defect once per run. This is what makes
 * the stream a backlog rather than a log.
 */
export function fingerprintOf(parts) {
  const text = (Array.isArray(parts) ? parts : [parts])
    .map((p) => String(p ?? '').toLowerCase())
    .join('\u0000');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** The shape `fingerprintOf` returns, and the only one `shape` passes through verbatim. */
const FINGERPRINT = /^[0-9a-f]{12}$/;

/**
 * The key a stored record groups and prunes under.
 *
 * A row written before `shape` exempted the fingerprint may carry '<redacted>' where its
 * hash was: twelve hex characters are 11+ digits in a row about once in 130, and the
 * digit-run rule erased those. Two unrelated defects then shared one key -- the report merged them
 * and a prune could name neither. Such a key is recomputed from the parts the writer
 * hashed, never trusted.
 */
export function identityOf(r) {
  const fp = r?.fingerprint;
  if (fp != null && !String(fp).includes('<redacted>')) return fp;
  return fingerprintOf([r?.code, r?.file ?? r?.repo ?? '', r?.subject ?? '']);
}

/** Truncate, and redact digit runs long enough to be a tax id or an account number. */
function scalar(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  }
  if (typeof value !== 'string') return undefined;
  const redacted = value.replace(/\d{11,}/g, '<redacted>');
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…` : redacted;
}

/**
 * A nested map reduced to primitives. An object or array value never survives as
 * content: it becomes its own size, which is the only part of it worth counting.
 */
export function sanitizeMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(out).length >= MAX_NESTED_KEYS) {
      dropped++;
      continue;
    }
    if (CONTENT_KEY.test(key)) {
      dropped++;
      continue;
    }
    if (value && typeof value === 'object') {
      out[key] = Array.isArray(value) ? { n: value.length } : { keys: Object.keys(value).length };
      continue;
    }
    if (value === undefined) continue;
    const s = scalar(value);
    if (s === undefined) {
      dropped++;
      continue;
    }
    out[key] = s;
  }
  if (dropped) out.droppedFields = dropped;
  return out;
}

/** Reduce a record to the fields its stream declares, sanitising as it goes. */
export function shape(stream, record) {
  const allowed = FIELDS[stream];
  if (!allowed) throw new Error(`Unknown journal stream '${stream}'`);
  const out = {};
  for (const key of allowed) {
    const value = record?.[key];
    if (value === undefined || value === null) {
      if (value === null && !NESTED.has(key)) out[key] = null;
      continue;
    }
    if (NESTED.has(key)) {
      const map = sanitizeMap(value);
      if (map && Object.keys(map).length) out[key] = map;
      // A nested field given a NUMBER is kept as one. It used to be dropped in silence, and
      // `result` is the field the six sweeps have been writing a count into since they were
      // built -- the count never once reached the journal, and nothing said so. A field that
      // discards what it is handed is the same defect as a code that overstates what it found.
      //
      // A number and nothing else, deliberately. These fields are the ones hardest closed
      // against content -- a map of primitives, every key checked -- and "how much came
      // back" is the only scalar meaning any of them has. A free string here would be new
      // surface on the field with the least reason to have any.
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (key === 'codes') {
      const codes = (Array.isArray(value) ? value : [value])
        .map((c) => String(c ?? ''))
        .filter((c) => c && codeInfo(c));
      if (codes.length) out[key] = codes;
      continue;
    }
    // A hash this module computed carries no content, so the digit-run rule must not
    // touch it -- see `identityOf` for what it did when it did.
    if (key === 'fingerprint' && typeof value === 'string' && FINGERPRINT.test(value)) {
      out[key] = value;
      continue;
    }
    const s = scalar(value);
    if (s !== undefined) out[key] = s;
  }
  return out;
}

function dayFile(dir, stream, when) {
  const day = when.toISOString().slice(0, 10);
  return path.join(dir, stream, `${day}.jsonl`);
}

/**
 * Open the journal for this process.
 *
 * @param {object} cfg the server config; `cfg.paths.logs` is the directory,
 *        `cfg.journalSink(stream, record)` replaces the file (tests), and
 *        `cfg.logs === false` disables it entirely.
 * @returns {{run:string, call:Function, finding:Function, gap:Function,
 *            counts:Function, enabled:boolean}}
 */
export function openJournal(cfg = {}) {
  const enabled = cfg.logs !== false;
  const dir = cfg.paths?.logs;
  const sink = typeof cfg.journalSink === 'function' ? cfg.journalSink : null;
  const maxBytes = cfg.logs?.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY;
  const run = cfg.run ?? newRunId();
  const counts = { calls: 0, findings: 0, gaps: 0, dropped: 0 };
  const capped = new Set();
  /**
   * A stack of code collectors, one frame per `collect()` in progress.
   *
   * The `codes` field of the calls stream exists so a call line can say WHICH limits that
   * answer ran into -- the link between "this took 4 seconds and answered" and "and it
   * could not read three of the names". It was declared, allowlisted and tested, and no
   * caller ever filled it, so the link was never actually there.
   *
   * A stack rather than a single array because a handler may call another, and only the
   * innermost frame should own a code. Frames are pushed and popped in `collect`, so a
   * code emitted outside any of them is simply not collected -- never attributed to a
   * call that did not produce it.
   *
   * Inside a tool call the stack is the call's own (lib/call-context.mjs), so calls in flight
   * together never read each other's codes; this one serves code that runs outside every call.
   */
  const collected = [];
  const frames = () => currentCall()?.frames ?? collected;

  function emit(stream, record) {
    if (!enabled) return null;
    let line;
    try {
      const shaped = shape(stream, { ts: new Date().toISOString(), run, ...record });
      if (record?.code) frames().at(-1)?.push(record.code);
      // Counted on the way OUT, not on the way in. It used to be incremented right after
      // shaping, so a record whose write then failed was counted in its stream AND in
      // `dropped` -- the one number that reports on the journal itself, disagreeing with
      // itself. Every accepted path goes through `done()`; the failure path is the catch.
      const done = () => {
        counts[stream]++;
        return shaped;
      };
      if (sink) {
        sink(stream, shaped);
        return done();
      }
      if (!dir) return done();
      line = JSON.stringify(shaped);
      const file = dayFile(dir, stream, new Date());
      if (capped.has(file)) return done();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      if (size + line.length > maxBytes) {
        capped.add(file);
        fs.appendFileSync(
          file,
          `${JSON.stringify(
            shape('gaps', {
              ts: new Date().toISOString(),
              run,
              code: 'LOG_TRUNCATED',
              severity: 'low',
              subject: stream,
              detail: `the day file passed ${maxBytes} bytes; appending stopped for this run`,
            })
          )}\n`
        );
        return done();
      }
      fs.appendFileSync(file, `${line}\n`);
      return done();
    } catch (e) {
      // Best effort, always. A journal write must never be the reason an answer fails.
      //
      // But it must not be SILENT either, and this is the one failure that cannot be
      // reported through the journal -- reporting it there is what just failed. If the
      // directory is read-only or the disk is full, every stream stops and `npm run
      // report` says "nothing journaled", which reads as "nothing happened". So the
      // first drop of the process says so on stderr, once: enough to notice, not enough
      // to bury an answer under repeated warnings.
      counts.dropped++;
      if (counts.dropped === 1) {
        process.stderr.write(
          `[sap-adt] journal write failed (${e?.message ?? e}); logging is off for this ` +
            `run, the answers are not affected. An empty report from now on means ` +
            `UNRECORDED, not clean.
`
        );
      }
      return null;
    }
  }

  /** A coded record: the code must be registered, and it carries its own severity. */
  function coded(stream, record) {
    const info = codeInfo(record?.code);
    if (!info) {
      // An unregistered code is a bug in the caller, not data. Say so loudly rather
      // than writing a line nothing can interpret later.
      throw new Error(
        `Journal code '${record?.code}' is not registered in lib/journal-codes.mjs. ` +
          'Add it there, with a severity and a meaning, or use an existing one.'
      );
    }
    if (info.family === 'finding' && stream !== 'findings') {
      throw new Error(`'${record.code}' is a finding code and cannot be written to '${stream}'`);
    }
    if (info.family === 'gap' && stream !== 'gaps') {
      throw new Error(`'${record.code}' is a gap code and cannot be written to '${stream}'`);
    }
    const fingerprint =
      record.fingerprint ??
      fingerprintOf([record.code, record.file ?? record.repo ?? '', record.subject ?? '']);
    return emit(stream, { severity: info.severity, ...record, fingerprint });
  }

  /**
   * Open a frame; `end()` closes it and returns the codes filed while it was open.
   *
   * A pair rather than `collect(fn)` on purpose: the caller needs the codes on BOTH
   * paths, and a failed answer is exactly when "which limits did it hit" is worth having.
   * A wrapper that only returned them on success would drop them where they matter most.
   * `end()` is idempotent, so a caller that ends in a `finally` and again on the way out
   * cannot pop somebody else's frame.
   */
  function collect() {
    const frame = [];
    // The stack this frame was opened on, kept: `end()` may run after the call's context is gone.
    const stack = frames();
    stack.push(frame);
    let closed = false;
    return {
      /** The codes filed so far, without closing the frame. */
      codes: () => [...new Set(frame)],
      end() {
        if (!closed) {
          const at = stack.lastIndexOf(frame);
          if (at >= 0) stack.splice(at, 1);
          closed = true;
        }
        return [...new Set(frame)];
      },
    };
  }

  return {
    run,
    enabled,
    /** One tool invocation. `codes` links it to the findings/gaps it produced. */
    call: (record) => emit('calls', record),
    finding: (record) => coded('findings', record),
    gap: (record) => coded('gaps', record),
    collect,
    counts: () => ({ ...counts }),
  };
}

/**
 * Read a stream back. Used by scripts/report.mjs, and separated from it so the
 * aggregation is testable without a filesystem full of days.
 *
 * @returns {{records:object[], files:string[], unreadable:string[]}}
 */
export function readStream(dir, stream, opts = {}) {
  const since = opts.since ? String(opts.since).slice(0, 10) : null;
  const base = path.join(dir ?? '', stream);
  const out = { records: [], files: [], unreadable: [] };
  let names;
  try {
    names = fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')).sort();
  } catch (e) {
    // A stream directory that does not exist yet is the normal state of a fresh
    // install, and it returns nothing. A directory that exists and cannot be LISTED is
    // a different thing entirely and would otherwise render as "no findings".
    if (fs.existsSync(base)) out.unreadable.push(`${base}: not listed (${e.message ?? e})`);
    return out;
  }
  for (const name of names) {
    const day = name.slice(0, 10);
    if (since && day < since) continue;
    const file = path.join(base, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      out.unreadable.push(file);
      continue;
    }
    out.files.push(file);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.records.push(JSON.parse(line));
      } catch {
        // A half-written last line is normal for an append-only file being read live.
        out.unreadable.push(`${file}: one unparseable line`);
      }
    }
  }
  return out;
}

/**
 * Group coded records by fingerprint: first seen, last seen, how many times, and the
 * latest full record. This is the shape a backlog wants, and the reason the
 * fingerprint exists.
 */
export function digest(records) {
  const byPrint = new Map();
  for (const r of records) {
    const key = identityOf(r);
    const seen = byPrint.get(key);
    if (!seen) {
      byPrint.set(key, { fingerprint: key, times: 1, first: r.ts, last: r.ts, record: r });
      continue;
    }
    seen.times++;
    if (r.ts < seen.first) seen.first = r.ts;
    if (r.ts >= seen.last) {
      seen.last = r.ts;
      seen.record = r;
    }
  }
  return [...byPrint.values()];
}
