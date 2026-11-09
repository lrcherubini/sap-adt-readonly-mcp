// Clean Core level of a standard object, from the two catalogues.
//
// The mapping below is NOT this file's invention and must not be edited from memory. It
// is SAP's Cloudification Repository read as the four Clean Core levels. Two entries are
// counter-intuitive, and an earlier draft of this server had both wrong:
//
//   * `deprecated` is Level A. It is STILL RELEASED. There is a successor and it should
//     be migrated, but the ATC reports Info (SAP Note 3638292), not an error. Counting
//     it as debt overstates the remediation.
//   * absent from BOTH catalogues is Level C, not D. D means "no contract of any kind,
//     forbidden, Exception Form BEFORE coding, remediation in 6 months". C means
//     "internal unclassified: architect approval and reassessment in 12 months". They
//     are different obligations, so guessing the harsher one is not the safe option --
//     it is a different wrong answer.
//
// The whole point of reading a catalogue instead of a name is that "absent" is a real
// answer with a real level, rather than a shrug. lib/catalog.mjs already refuses the
// inference-from-absence; this file refuses the inference-from-severity.

import { codeInfo } from './journal-codes.mjs';

/**
 * state -> {level, why}. The key is the catalogue's own `state` value, whichever of the
 * two files it came from; `ABSENT` is this module's key for a name in neither.
 */
export const LEVEL_BY_STATE = new Map([
  ['released', { level: 'A', why: 'C1 contract -- full use' }],
  [
    'deprecated',
    {
      level: 'A',
      why:
        'still released: a successor exists and migration should be planned, but the ATC ' +
        'reports Info, not an error (SAP Note 3638292) -- this is not level debt',
    },
  ],
  [
    'notToBeReleased',
    { level: 'C', why: 'will not be released; a successor exists -- do not use in new code' },
  ],
  [
    'notToBeReleasedStable',
    { level: 'C', why: 'will not be released, with no removal plan -- stable, but not a contract' },
  ],
  ['classicAPI', { level: 'B', why: 'stable classic API -- an acceptable bridge in Standard ABAP' }],
  [
    'internalAPI',
    { level: 'C', why: 'internal object -- architect approval and reassessment in 12 months' },
  ],
  ['noAPI', { level: 'D', why: 'no contract of any kind -- forbidden' }],
  [
    'ABSENT',
    {
      level: 'C',
      why:
        'absent from BOTH catalogues: internal unclassified. NOT D -- D requires an ' +
        'Exception Form before coding and remediation in 6 months; C requires architect ' +
        'approval and reassessment in 12 months',
    },
  ],
]);

/** The journal code each non-A level maps to. Level A objects produce no finding. */
const CODE_BY_LEVEL = { B: 'CC_LEVEL_B', C: 'CC_LEVEL_C', D: 'CC_LEVEL_D' };

const LEVEL_ORDER = ['A', 'B', 'C', 'D'];
export const levelRank = (level) => {
  const i = LEVEL_ORDER.indexOf(String(level));
  return i === -1 ? -1 : i;
};

/**
 * Is this a customer object? Z/Y is ours; a /NAMESPACE/ prefix belongs to SAP or a
 * partner and is therefore judged like any other standard name.
 */
export const isCustomName = (name) => /^[ZY]/i.test(String(name ?? ''));

/**
 * The object types a data source can plausibly be, in the order worth trying.
 * A CDS entity and a DDIC table can share a name, and the CDS one is the answer when
 * both exist -- that is what the source actually reads.
 */
const SOURCE_TYPES = ['CDS_STOB', 'TABL', 'VIEW', 'FUNC', 'CLAS', 'INTF', 'BADI_DEF'];

/**
 * Classify one standard name against the catalogue.
 *
 * @returns {{name:string, level:string, state:string, objectType:string|null,
 *            successors:string[], why:string, inCatalog:boolean, custom:boolean}}
 */
export function classifyName(name, catalog, types = SOURCE_TYPES) {
  const custom = isCustomName(name);
  if (custom) {
    return {
      name,
      level: null,
      state: 'CUSTOM',
      objectType: null,
      successors: [],
      why: 'a customer object: the Clean Core level applies to what IT consumes, not to itself',
      inCatalog: false,
      custom: true,
    };
  }
  const row = catalog?.lookup ? catalog.lookup(name, types) : undefined;
  const state = row?.state ?? 'ABSENT';
  const mapped = LEVEL_BY_STATE.get(state) ?? {
    level: 'C',
    // A state the catalogue grew after this table was written. Treating it as C keeps the
    // answer conservative WITHOUT claiming the harshest level, and says it is unmapped so
    // the gap is visible instead of silently absorbed.
    why: `catalogue state '${state}' is not in this module's mapping -- treated as C, unverified`,
  };
  return {
    name: row?.tadirObjName ?? name,
    level: mapped.level,
    state,
    objectType: row?.objectType ?? null,
    successors: (row?.successors ?? []).map((s) => String(s.tadirObjName ?? s).toUpperCase()),
    successorConcept: row?.successorConceptName ?? undefined,
    why: mapped.why,
    inCatalog: !!row,
    custom: false,
  };
}

/**
 * Classify a list of names (or of dataSourcesFrom hits).
 *
 * @param {(string|{name:string})[]} names
 * @param {object} catalog from loadCatalog()
 * @param {{minLevel?:string, includeCustom?:boolean}} [opts] `minLevel` keeps only
 *        results at or worse than that level ('B' drops the A's).
 * @returns {{results:object[], counts:object, unmapped:string[]}}
 */
export function classify(names, catalog, opts = {}) {
  const seen = new Map();
  for (const n of names ?? []) {
    const name = typeof n === 'string' ? n : n?.name;
    if (!name) continue;
    const key = String(name).toUpperCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  const min = opts.minLevel ? levelRank(opts.minLevel) : -1;
  const counts = { A: 0, B: 0, C: 0, D: 0, custom: 0 };
  const unmapped = [];
  const results = [];
  for (const name of seen.values()) {
    const r = classifyName(name, catalog);
    if (r.custom) {
      counts.custom++;
      if (!opts.includeCustom) continue;
    } else {
      counts[r.level] = (counts[r.level] ?? 0) + 1;
      if (!LEVEL_BY_STATE.has(r.state)) unmapped.push(r.state);
    }
    if (!r.custom && min >= 0 && levelRank(r.level) < min) continue;
    results.push(r);
  }
  results.sort(
    (a, b) => levelRank(b.level) - levelRank(a.level) || a.name.localeCompare(b.name)
  );
  return { results, counts, unmapped: [...new Set(unmapped)] };
}

/**
 * The journal record for one classification, or null for Level A.
 *
 * `deprecated` is the exception that proves the table: it IS Level A, so it is not a
 * level finding, but it still carries a migration hint worth accumulating -- hence its
 * own low-severity code rather than either silence or a false debt entry.
 */
export function findingFor(result, where = {}) {
  if (!result || result.custom) return null;
  const code = result.state === 'deprecated' ? 'CC_DEPRECATED' : CODE_BY_LEVEL[result.level];
  if (!code) return null;
  const info = codeInfo(code);
  const successors = result.successors.length
    ? `successors: ${result.successors.join(', ')}`
    : result.successorConcept
      ? `successor concept: ${result.successorConcept}`
      : 'the catalogue names no successor';
  return {
    code,
    severity: info?.severity,
    repo: where.repo ?? null,
    file: where.file ?? null,
    line: where.line ?? null,
    subject: result.name,
    context: {
      level: result.level,
      state: result.state,
      objectType: result.objectType,
      inCatalog: result.inCatalog,
      kind: where.kind ?? null,
      consumer: where.consumer ?? null,
    },
    effect: result.why,
    fix: successors,
  };
}
