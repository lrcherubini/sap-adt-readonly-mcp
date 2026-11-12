// After a 500: the system almost always dumped.
//
// Measured over rounds 14-16 (2026-09-11 .. 2026-09-14): every HTTP 500 this server has
// seen from the ADT but one was an ABAP runtime error on the other side -- `enhoxh`
// persistence (OBJECTS_OBJREF_NOT_ASSIGNED_NO in CL_ENH_ADT_ENHO_OBJ_PERSIST), a two-clause
// feed `$query` (ASSERTION_FAILED in CL_ADT_FQL_QUERY). The one exception (round 16: a
// program include whose name carries '=' answers 500 ExceptionResourceReadFailure with no
// dump) is why the feed is READ and not assumed. The client library reports all of them
// as "Request failed with status code 500", which is the least useful sentence the system
// could have sent. The ST22 entry, one feed read away, names the runtime error, the
// exception and the program that terminated -- what a person needs to decide whether the
// call was ill-formed or the server is defective, and what the improvement backlog needs
// to rank it.
//
// So a 500 costs one more call: the newest dump of THIS user (one clause -- the fewest the
// grammar takes; the comma form of two is also measured safe since 2026-09-14), published
// no earlier than the call that failed. A dump older
// than the call is somebody else's story and is reported as "none in the window", never
// attached. The read is best-effort: a failure here files DUMP_NOT_READ and the original
// error stands unchanged -- an explanation that hid the failure it explains would be worse
// than none.
//
// What reaches the journal: runtime error, exception, program, the ST22 key with the user
// stripped (`auditKeyOf`), the timestamp. Never the title, never a variable, never the
// user's name -- the same boundary as adt_runtime_errors.

import { namedGet, transportFor } from './adt-get.mjs';
import { auditKeyOf, buildFeedQuery, parseDumpFeed } from './runtime-feeds.mjs';
import { record } from './audit.mjs';
import { callOverlapped } from './call-context.mjs';

/** A dump published this long BEFORE the failed call still counts: clocks differ by seconds, not minutes. */
export const SKEW_MS = 15_000;

/**
 * The HTTP status carried by what the ADT client threw, in the measured order (see
 * adtFailure in lib/adt-get.mjs); null when there is none.
 */
export function statusOf(error) {
  const candidates = [error?.status, error?.err, error?.response?.status];
  return candidates.map(Number).find((n) => Number.isInteger(n) && n >= 100) ?? null;
}

/**
 * Explain a 500 by the dump it left, if it left one.
 *
 * @param {object} p
 * @param {object} p.cfg
 * @param {{raw?:object, user?:string}} p.session
 * @param {{enabled?:boolean, gap?:Function}} p.journal
 * @param {string} p.tool     the tool whose call failed
 * @param {Error}  p.error    what it threw
 * @param {number} p.since    epoch ms when the call started
 * @returns {Promise<null|{checked:boolean, matched:boolean, dump?:object, newest?:string|null, reason?:string}>}
 *   null when the error is not a 500 (nothing to explain).
 */
export async function dumpAfter500({ cfg, session, journal, tool, error, since }) {
  if (statusOf(error) !== 500) return null;
  const gap = (g) => journal?.enabled && journal.gap(g);
  const user = String(session?.user ?? cfg?.user ?? '').trim().toUpperCase();
  if (!session?.raw || !user) {
    return { checked: false, matched: false, reason: 'no raw session or no user name to filter the dump feed by' };
  }
  let out;
  try {
    out = await namedGet(transportFor(session.raw), 'runtimeDumps', {
      $query: buildFeedQuery('dumps', [{ attribute: 'user', value: user }]),
      $top: 1,
    });
  } catch (e) {
    gap({
      code: 'DUMP_NOT_READ',
      subject: tool,
      detail: `after a 500, the dump feed itself answered ${e?.status ?? '?'}: ${e?.message}`,
      impact: 'the 500 stands unexplained; it is still most likely a dump',
      fallback: 'ST22 in the GUI, or adt_runtime_errors list {feed:"dumps"} once the server answers',
    });
    return { checked: true, matched: false, reason: e?.message };
  }
  record(cfg, tool, 'dump after 500', out.bytes);
  const hit = parseDumpFeed(out.body, { withReport: false }).entries[0];
  const at = hit ? Date.parse(hit.published) : NaN;
  const matched = Boolean(hit) && Number.isFinite(at) && at >= Number(since) - SKEW_MS;
  // Every call logs on as the same SAP user. With another call in flight, "a dump of this user
  // since the call started" may be the other call's: it is then a candidate, said as one.
  const shared = callOverlapped();
  const dump = matched
    ? {
        runtimeError: hit.runtimeError ?? null,
        program: hit.program ?? null,
        key: auditKeyOf(hit.id),
        id: hit.id,
        published: hit.published,
      }
    : null;
  gap({
    code: 'SERVER_DUMPED',
    subject: tool,
    detail: dump
      ? `${dump.runtimeError ?? '?'} in ${dump.program ?? '?'} (ST22 ${dump.key}, ${dump.published})${shared ? '; other calls were in flight, so it may belong to one of them' : ''}`
      : `HTTP 500 and no dump of this user since the call started (newest: ${hit?.published ?? 'none'})`,
    impact: dump
      ? shared
        ? 'the SAP system terminated while answering this call or another one in flight with it: the call was not served'
        : 'the SAP system terminated while answering: the call was not served, and the same call will dump again'
      : 'the SAP system answered 500 without a dump of this user: another user, another cause, or the feed lagged',
    fallback: dump
      ? `adt_runtime_errors detail {id, full:true} reads the report; the id is in the error`
      : 'ST22 in the GUI for the minute of the call',
  });
  return { checked: true, matched, dump, shared, newest: hit?.published ?? null };
}

/** The sentence appended to the tool's error, so the caller sees the dump without a second call. */
export function explainWithDump(explained) {
  if (!explained?.checked) return '';
  if (!explained.matched) return ` -- HTTP 500 (probably a dump on the SAP system; none of this user found since the call started)`;
  const d = explained.dump;
  if (explained.shared) {
    return ` -- HTTP 500, and the SAP system dumped in the same moment: ${d.runtimeError ?? '?'} in ${d.program ?? '?'} (ST22 ${d.key}; adt_runtime_errors detail {id: ${JSON.stringify(d.id)}, full: true}). Other calls were in flight under the same SAP user, so this dump may belong to one of them: read it before blaming this call`;
  }
  return ` -- the SAP system dumped: ${d.runtimeError ?? '?'} in ${d.program ?? '?'} (ST22 ${d.key}; adt_runtime_errors detail {id: ${JSON.stringify(d.id)}, full: true})`;
}
