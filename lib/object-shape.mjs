// The object document and the outline of the ADT, in the shape an agent reads.
//
// The ADT answers with namespaced attributes (`adtcore:responsible`, `class:final`), epoch
// milliseconds for dates, a link list of ADT relations, and positions as URI fragments
// (`./source/main#start=7,6;end=7,16`). Handed on as they arrive, the model reads the plumbing
// and has to decode every position. Here:
//
//   objectOf(hit)       name, type, package, description, uri
//   propertiesOf(meta)  every attribute of metaData with its prefix dropped (a clash keeps the
//                       prefix), the identity already in `object` left out, dates as ISO 8601
//   outlineOf(elements) each element with `at` / `implementationAt` {line, column} from the
//                       identifier links, and the blocks as {from, to}; children the same
//
// Nothing is dropped that says something: an attribute this module does not know is kept under
// its own (unprefixed) name.

/** Attributes already said by `object`, or about the document rather than the object. */
const IDENTITY = new Set(['adtcore:name', 'adtcore:type', 'adtcore:description', 'adtcore:descriptionTextLimit']);

/** epoch milliseconds (as the library converts ADT dates) -> ISO 8601 UTC; anything else as is. */
export function isoOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  return v;
}

/** The identity of a search hit or resolved object, without the ADT's namespaces. */
export function objectOf(hit) {
  if (!hit) return null;
  return {
    name: hit['adtcore:name'] ?? null,
    type: hit['adtcore:type'] ?? null,
    package: hit['adtcore:packageName'] ?? null,
    description: hit['adtcore:description'] ?? null,
    uri: hit['adtcore:uri'] ?? null,
  };
}

/** The metaData block, flat and unprefixed; `*At` dates as ISO 8601. */
export function propertiesOf(metaData) {
  const entries = Object.entries(metaData ?? {}).filter(([k]) => !IDENTITY.has(k));
  const bare = (k) => k.replace(/^[A-Za-z]+:/, '');
  const count = new Map();
  for (const [k] of entries) count.set(bare(k), (count.get(bare(k)) ?? 0) + 1);
  const out = {};
  for (const [k, v] of entries) {
    const name = count.get(bare(k)) > 1 ? k : bare(k);
    out[name] = /At$/.test(name) ? isoOf(v) : v;
  }
  return out;
}

/** `#start=7,6;end=7,16` -> {line: 7, column: 6, endLine: 7, endColumn: 16}; null without a start. */
export function positionOf(href) {
  const m = /[#;]start=(\d+)(?:,(\d+))?(?:;end=(\d+)(?:,(\d+))?)?/.exec(String(href ?? ''));
  if (!m) return null;
  const n = (s) => (s === undefined ? undefined : Number(s));
  return {
    line: n(m[1]),
    ...(m[2] !== undefined ? { column: n(m[2]) } : {}),
    ...(m[3] !== undefined ? { endLine: n(m[3]) } : {}),
    ...(m[4] !== undefined ? { endColumn: n(m[4]) } : {}),
  };
}

const REL = 'http://www.sap.com/adt/relations/source/';
const POSITIONS = [
  ['definitionIdentifier', 'at'],
  ['implementationIdentifier', 'implementationAt'],
  ['definitionBlock', 'definitionBlock'],
  ['implementationBlock', 'implementationBlock'],
];

/** One outline element: its own fields, the positions decoded, the links that are not positions kept. */
function element(e) {
  const { links = [], children = [], ...own } = e ?? {};
  const out = { ...own };
  const other = [];
  for (const l of links) {
    const kind = String(l?.rel ?? '').startsWith(REL) ? String(l.rel).slice(REL.length) : null;
    const slot = POSITIONS.find(([k]) => k === kind)?.[1];
    const at = slot ? positionOf(l.href) : null;
    if (slot && at) out[slot] = at;
    else other.push({ rel: kind ?? l?.rel ?? null, href: l?.href ?? null });
  }
  if (other.length) out.links = other;
  if (children.length) out.children = children.map(element);
  return out;
}

/** The outline of a class or interface, positions as numbers. */
export const outlineOf = (elements) => (Array.isArray(elements) ? elements.map(element) : []);
