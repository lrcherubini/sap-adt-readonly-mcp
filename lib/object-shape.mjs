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

/**
 * The object an ADT URI names, for the collections this server reads: `{name, type}` from the
 * path alone, or null for a path not in the list (the URI is still in the answer). A function
 * module is named by its module, not its group.
 */
const OBJECT_PATHS = [
  [/^\/sap\/bc\/adt\/functions\/groups\/[^/]+\/fmodules\/([^/?#]+)/i, 'FUGR/FF'],
  [/^\/sap\/bc\/adt\/functions\/groups\/([^/?#]+)/i, 'FUGR/F'],
  [/^\/sap\/bc\/adt\/oo\/classes\/([^/?#]+)/i, 'CLAS/OC'],
  [/^\/sap\/bc\/adt\/oo\/interfaces\/([^/?#]+)/i, 'INTF/OI'],
  [/^\/sap\/bc\/adt\/programs\/programs\/([^/?#]+)/i, 'PROG/P'],
  [/^\/sap\/bc\/adt\/programs\/includes\/([^/?#]+)/i, 'PROG/I'],
  [/^\/sap\/bc\/adt\/ddic\/ddl\/sources\/([^/?#]+)/i, 'DDLS/DF'],
  [/^\/sap\/bc\/adt\/ddic\/tables\/([^/?#]+)/i, 'TABL/DT'],
  [/^\/sap\/bc\/adt\/ddic\/structures\/([^/?#]+)/i, 'TABL/DS'],
  [/^\/sap\/bc\/adt\/ddic\/dataelements\/([^/?#]+)/i, 'DTEL/DE'],
  [/^\/sap\/bc\/adt\/ddic\/domains\/([^/?#]+)/i, 'DOMA/DD'],
  [/^\/sap\/bc\/adt\/bo\/behaviordefinitions\/([^/?#]+)/i, 'BDEF/BDO'],
];

export function objectOfUri(uri) {
  const s = String(uri ?? '').replace(/^adt:\/\/[^/]+/, '');
  for (const [re, type] of OBJECT_PATHS) {
    const m = re.exec(s);
    // Byte escapes only (`%2f` of a /NAMESPACE/): object names are ASCII, and a malformed escape
    // stays as it came rather than failing the whole answer.
    if (m) return { name: m[1].replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).toUpperCase(), type };
  }
  return null;
}

/** The outline of a class or interface, positions as numbers. */
export const outlineOf = (elements) => (Array.isArray(elements) ? elements.map(element) : []);
