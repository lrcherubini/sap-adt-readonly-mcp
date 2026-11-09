// Where-used, reduced to precedent.
//
// This module exists because of one measurement: `usageReferences` on `I_PlantStdVH`
// returns **1,531 callers / 356 KB / 10,981 lines** and blew the response budget of the
// MCP reply outright (docs/adt-api-reference.md). So the raw list can never be handed
// back. It is also not what the question needs: of those 1,531 rows the useful ones are
// the CDS views that consume the entity, which is what a precedent is.
//
// Measured distribution of that call, kept here as the shape this filter is built for:
//
//   432 DEVC/K · 354 DDLS/DF (270 of them C_* consumption views) · 316 CLAS/OC ·
//   188 CLAS/OM · 52 DDLX/EX · 9 SRVD/SRV · 1 SHLP/DH
//
// and `usageInformation` carries the grade and the productive/test split:
// `gradeDirect` (731) vs `gradeComponent` (35), `includeProductive` vs `includeTest` (14).
//
// `usageInformation` is a free-text token list in the ADT reply, so it is matched
// case-insensitively by token and an EMPTY value is treated as unknown -- not as a
// failure of the filter. A row whose grade the system did not state is kept and marked,
// because dropping it would silently shrink the evidence.

/** Object types that can show how an entity is consumed in CDS. */
export const CDS_TYPES = ['DDLS/DF', 'DDLX/EX'];

const tokensOf = (text) =>
  String(text ?? '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());

/** Normalise a row from either the raw ADT reply or the tool's mapped shape. */
function normalize(r = {}) {
  const type = r.type ?? r['adtcore:type'] ?? '';
  return {
    name: r.name ?? r['adtcore:name'] ?? '',
    type,
    package: r.package ?? r.packageRef?.['adtcore:name'] ?? '',
    usage: r.usage ?? r.usageInformation ?? '',
    uri: r.uri ?? '',
  };
}

/**
 * Filter and cap a where-used list.
 *
 * @param {object[]} rows raw UsageReference[] or the mapped rows of adt_where_used
 * @param {{cap?:number, types?:string[], requireDirect?:boolean,
 *          requireProductive?:boolean, ownNamespace?:boolean}} opts
 * @returns {{total:number, kept:number, returned:number, truncated:boolean,
 *            byType:Record<string,number>, dropped:Record<string,number>,
 *            rows:object[], note:string}}
 */
export function summarizeUsage(rows, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? Math.max(0, opts.cap) : 20;
  const types = opts.types ?? CDS_TYPES;
  const requireDirect = opts.requireDirect ?? true;
  const requireProductive = opts.requireProductive ?? true;

  const all = (rows ?? []).map(normalize);
  const byType = {};
  for (const r of all) byType[r.type || '(none)'] = (byType[r.type || '(none)'] ?? 0) + 1;

  const dropped = {};
  const drop = (reason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
    return false;
  };

  const kept = all.filter((r) => {
    if (types.length && !types.includes(r.type)) return drop(`type not in ${types.join('/')}`);
    const t = tokensOf(r.usage);
    if (requireDirect && t.length && !t.includes('gradedirect')) {
      return drop('not a direct usage');
    }
    if (requireProductive && t.includes('includetest')) return drop('test code');
    return true;
  });

  // A Z consumer first: our own precedent beats a standard one, because it also shows
  // what a measured workspace already decided. Then a consumption view (C_*), which is where
  // the standard binds its value helps. Stable within a group, so the order the system
  // returned is preserved.
  const rank = (r) => {
    const n = r.name.toUpperCase();
    if (n.startsWith('Z') || n.startsWith('Y')) return 0;
    if (/^C_/.test(n)) return 1;
    return 2;
  };
  const ordered = kept
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);

  const returned = ordered.slice(0, cap);
  const unstated = kept.filter((r) => !tokensOf(r.usage).length).length;

  return {
    total: all.length,
    kept: kept.length,
    returned: returned.length,
    truncated: kept.length > returned.length,
    byType,
    dropped,
    rows: returned,
    note:
      `${all.length} callers, ${kept.length} of them ${types.join('/')}` +
      (requireDirect ? ' and direct' : '') +
      `; showing ${returned.length}` +
      (kept.length > returned.length ? ` (capped at ${cap})` : '') +
      (unstated ? `; ${unstated} kept with no grade stated by the system` : ''),
  };
}

/**
 * The consumers worth actually reading, given a budget of source reads.
 *
 * Separate from the summary on purpose: the summary is what the user sees, this is what
 * the pipeline is allowed to spend ADT calls on.
 */
export function precedentCandidates(summary, budget = 2) {
  return (summary?.rows ?? []).filter((r) => r.type === 'DDLS/DF').slice(0, Math.max(0, budget));
}
