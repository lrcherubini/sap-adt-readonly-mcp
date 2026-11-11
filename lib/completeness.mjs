// Whether an answer is complete, said in fields, never in prose.
//
// Every tool answers at its top level:
//
//   complete    true only when `incomplete` is empty
//   incomplete  [{list, code, count?, returned?, total?, reason?}] -- one entry per list or part
//               that the answer does not hold in full, the code from the closed set below
//
// and every list it cuts carries `returned`, `total` (null when nobody knows it), `truncated`
// (a boolean) and either `next` (repeat the call with this `offset` for the next page) or
// `narrowBy` (the arguments that reduce the result, where neither the server nor this server
// can page). A value like `truncated: 'possible'` is not an answer: it is refused by
// tests/completeness.test.mjs.
//
// "Not asked" is not incompleteness: a part the caller did not ask for says `asked: false`.
// Decision of the owner, 2026-11-11 (docs/security.md, "Completeness in fields").

/** The closed set of reasons a list or a part is not complete. */
export const COMPLETENESS_CODES = Object.freeze(
  new Map([
    ['CAP_REACHED', 'this server cut the list at a limit; `returned` and `total` say how much'],
    ['SERVER_PAGE_FULL', 'the system answered a full page and gives no total: more may exist'],
    ['NOT_READ', 'items or parts could not be read; `count` and `reason` say which'],
    ['PARSE_FAILED', 'the reply did not have the measured shape; nothing is concluded from it'],
    ['CANCELLED', 'the call was cancelled before the list was read in full'],
    ['BUDGET_REACHED', 'the call budget ran out before the list was read in full'],
    ['DEPTH_LIMIT', 'a hierarchy was walked to a depth limit; deeper levels were not read'],
    ['OUT_OF_SCOPE', 'objects of types this tool does not cover; `count` says how many'],
  ])
);

export class CompletenessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompletenessError';
  }
}

/** One entry of `incomplete`. The code must be in the closed set. */
export function gapOf(list, code, fields = {}) {
  if (!COMPLETENESS_CODES.has(code)) throw new CompletenessError(`'${code}' is not a completeness code (${[...COMPLETENESS_CODES.keys()].join(', ')}).`);
  return { list: String(list), code, ...fields };
}

/**
 * The answer with `complete` and `incomplete` at its top, entries validated. `complete` is
 * derived, never passed: an answer cannot say complete while listing what it lacks.
 */
export function finish(answer, incomplete = []) {
  const entries = incomplete.filter(Boolean).map((g) => gapOf(g.list, g.code, Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'list' && k !== 'code'))));
  return { complete: entries.length === 0, incomplete: entries, ...answer };
}

const intIn = (name, value, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CompletenessError(`${name} must be an integer from ${min} to ${max}; got ${value}.`);
  return n;
};

/**
 * One page of a list this server holds in full: `max` items from `offset`, `max` defaulting to
 * `defaultMax` and held to `ceiling`. The page says how much exists and where the next one starts.
 * @returns {{items, returned, total, offset, limit, truncated, next: {offset}|null}}
 */
export function page(list, { max, offset, defaultMax, ceiling } = {}) {
  const all = Array.isArray(list) ? list : [];
  const limit = max === undefined || max === null ? defaultMax : intIn('max', max, 1, ceiling);
  const from = offset === undefined || offset === null ? 0 : intIn('offset', offset, 0, Number.MAX_SAFE_INTEGER);
  const items = all.slice(from, from + limit);
  const end = from + items.length;
  return {
    items,
    returned: items.length,
    total: all.length,
    offset: from,
    limit,
    truncated: end < all.length,
    next: end < all.length ? { offset: end } : null,
  };
}

/** The `incomplete` entry for a page that does not reach the end of its list, or null. */
export const pageGap = (list, p) =>
  p.truncated ? gapOf(list, 'CAP_REACHED', { returned: p.returned, total: p.total, next: p.next }) : null;

/**
 * Every way a structured answer breaks the contract, as strings (empty when it holds): `complete`
 * a boolean that agrees with `incomplete`, every code in the closed set, no hedged value like
 * 'possible' anywhere, and every list with `truncated: true` saying how to get the rest.
 */
export function contractErrors(answer) {
  const errors = [];
  if (!answer || typeof answer !== 'object') return ['the answer is not an object'];
  if (typeof answer.complete !== 'boolean') errors.push('`complete` is not a boolean');
  if (!Array.isArray(answer.incomplete)) errors.push('`incomplete` is not an array');
  else {
    for (const g of answer.incomplete) {
      if (!COMPLETENESS_CODES.has(g?.code)) errors.push(`incomplete code '${g?.code}' is not in the closed set`);
      if (!g?.list) errors.push('an incomplete entry names no list');
    }
    if (answer.complete === true && answer.incomplete.length) errors.push('`complete` is true while `incomplete` lists entries');
    if (answer.complete === false && !answer.incomplete.length) errors.push('`complete` is false and `incomplete` says nothing');
  }
  const walk = (v, where) => {
    if (v === 'possible') errors.push(`${where} is 'possible': a hedge, not an answer`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      const cut = v.truncated === true || (typeof v.truncated === 'number' && v.truncated > 0);
      if (cut && !v.next && !v.narrowBy) errors.push(`${where} is truncated with neither \`next\` nor \`narrowBy\``);
      if ('truncated' in v && typeof v.truncated !== 'boolean' && typeof v.truncated !== 'number') errors.push(`${where}.truncated is neither a boolean nor a count`);
      for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k);
    }
  };
  walk(answer, '');
  return errors;
}
