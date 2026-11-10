// The outline of a class: its components and where each one sits in which include, and the
// slice of one method's implementation. MEASURED 2026-11-10 on a class with 21 global methods,
// an implemented interface and a local class (docs/adt-api-reference.md, "The outline of a
// class"):
//
//   GET <class>/objectstructure?version=active|inactive&withShortDescriptions=true
//   -> 200 application/vnd.sap.adt.objectstructure.v2+xml, nested abapsource:objectStructureElement
//
// Each element carries `adtcore:type` (CLAS/OM a global method, `INTF~NAME` for an interface
// method; CLAS/OLD a local class's method, `clif_name` naming that class; CLAS/OA attributes,
// CLAS/OT types, CLAS/OB interface components, CLAS/OCL a local class, CLAS/OCX the text
// elements) and up to four links -- definitionIdentifier, implementationIdentifier,
// definitionBlock, implementationBlock -- as `./<include>#start=<l>,<c>;end=<l>,<c>`, relative to
// the class. Global components point into `./source/main`, local ones into
// `./includes/implementations`. Lines are 1-based, in the include of the SAME version: the
// outline and the source are read in one version, or the lines do not match.

const REL = 'http://www.sap.com/adt/relations/source/';
const INCLUDES = new Set(['source/main', 'includes/implementations', 'includes/definitions', 'includes/testclasses', 'includes/macros']);

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const attrsOf = (raw) => {
  const out = {};
  for (const m of String(raw ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/** `./source/main#start=99,2;end=119,11` -> {include, start: {line, column}, end: {...}}, or null. */
export function parsePosition(href) {
  const m = String(href ?? '').match(/^\.\/([a-z/]+)#start=(\d+),(\d+);end=(\d+),(\d+)$/);
  if (!m || !INCLUDES.has(m[1])) return null;
  return {
    include: m[1],
    start: { line: Number(m[2]), column: Number(m[3]) },
    end: { line: Number(m[4]), column: Number(m[5]) },
  };
}

/**
 * Every component of the outline, flat, in document order. `parent` is the name of the element
 * that contains it (the class itself, or a local class). Links that are not a measured position
 * (the text elements' absolute URI) are kept as `href` only.
 */
export function parseClassComponents(xml) {
  const out = [];
  const stack = [];
  for (const m of String(xml ?? '').matchAll(/<(\/?)(abapsource:objectStructureElement|atom:link)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, raw, self] = m;
    if (tag === 'abapsource:objectStructureElement') {
      if (closing) {
        stack.pop();
        continue;
      }
      const a = attrsOf(raw);
      const el = {
        type: a['adtcore:type'] ?? null,
        name: a['adtcore:name'] ?? null,
        parent: stack.length ? stack[stack.length - 1].name : null,
        clif: a.clif_name ?? null,
        visibility: a.visibility ?? null,
        level: a.level ?? null,
        description: a.description ?? null,
        ...(a.constructor === 'true' ? { constructor: true } : {}),
        positions: {},
      };
      out.push(el);
      if (self !== '/') stack.push(el);
      continue;
    }
    // atom:link: belongs to the innermost open element.
    const owner = stack[stack.length - 1];
    if (!owner || closing) continue;
    const a = attrsOf(raw);
    const rel = String(a.rel ?? '');
    if (!rel.startsWith(REL)) continue;
    const kind = rel.slice(REL.length);
    const pos = parsePosition(a.href);
    owner.positions[kind] = pos ?? { href: a.href ?? null };
  }
  return out;
}

/**
 * The method a caller names: `NAME`, `INTF~NAME`, or `LOCAL_CLASS->NAME` for a method of a local
 * class. Case-insensitive. Returns {method, candidates} -- `method` null when none or several
 * match, with the names that would have matched.
 */
export function findMethod(components, wanted) {
  const w = String(wanted ?? '').trim().toUpperCase();
  const methods = components.filter((c) => c.type === 'CLAS/OM' || c.type === 'CLAS/OLD');
  const arrow = w.indexOf('->');
  const matches =
    arrow >= 0
      ? methods.filter((c) => String(c.clif ?? c.parent ?? '').toUpperCase() === w.slice(0, arrow) && String(c.name).toUpperCase() === w.slice(arrow + 2))
      : methods.filter((c) => String(c.name).toUpperCase() === w);
  // A bare name that is a global method and a local one (CONSTRUCTOR) means the global one.
  const global = matches.filter((c) => c.type === 'CLAS/OM');
  const pick = matches.length === 1 ? matches : global.length === 1 ? global : [];
  return {
    method: pick[0] ?? null,
    candidates: (pick.length ? pick : matches).map(label),
    known: methods.map(label),
  };
}

/** How a method is named back: `NAME`, or `LOCAL_CLASS->NAME` for a method of a local class. */
export const methodLabel = (c) => (c.type === 'CLAS/OLD' ? `${c.clif ?? c.parent}->${c.name}` : c.name);
const label = methodLabel;

/** Lines start..end (1-based, inclusive) of a source, or null when the source is shorter. */
export function sliceLines(source, start, end) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (start < 1 || end < start || end > lines.length) return null;
  return lines.slice(start - 1, end).join('\n');
}
