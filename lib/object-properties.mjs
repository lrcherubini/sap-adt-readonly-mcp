// The repository properties of one object -- the read a class enhancement survives.
//
// MEASURED 2026-09-14 (measurement, step 1c) on the three ENHO/XH of the system: a flat
// list of <opr:property facet="…" name="…"> under one <opr:object>, ~2.8 KB. The PACKAGE
// facet repeats once per ancestor, root first (YDEMO_ROOT, YDEMO_BASIS, ZDEMO_PKG); every other facet
// appears once (SOURCETYPE twice, both UNDEFINED). Owner is the object's responsible
// user: it is part of the answer, and it never reaches the audit or the journal.

/** Facets read on the measured replies; anything else is drift, never a guess. */
const FACETS = new Set([
  'SOURCETYPE', 'APPL', 'PACKAGE', 'GROUP', 'TYPE', 'OWNER', 'API', 'LANGUAGE', 'SYSTEM',
  'VERSION', 'DOCU', 'CREATED', 'MONTH', 'DATE', 'COMP',
]);
const ELEMENTS = new Set(['opr:objectProperties', 'opr:object', 'opr:property', 'atom:link']);

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const attrsOf = (tag) => {
  const out = {};
  for (const m of String(tag ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/**
 * @param {string} xml the objproperties.result.v1 body
 * @returns {{object:{name:string|null,type:string|null,package:string|null,text:string|null},
 *   packagePath:string[], parentPackage:string|null, owner:string|null, apiState:string|null,
 *   language:string|null, version:string|null, created:string|null, component:string|null,
 *   applicationComponent:string|null, properties:Array<{facet:string,name:string,text:string|null}>,
 *   drift:Array<{node:string,count:number,where:string}>}}
 */
export function parseObjectProperties(xml) {
  const s = String(xml ?? '');
  const drift = [];
  const seen = new Map();
  for (const m of s.matchAll(/<([A-Za-z][\w:.-]*)[\s/>]/g)) {
    if (m[1] === '?xml') continue;
    if (!ELEMENTS.has(m[1])) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  for (const [node, count] of seen) drift.push({ node, count, where: 'objectProperties' });

  const head = attrsOf(/<opr:object(\s[^>]*)?>/.exec(s)?.[1]);
  const properties = [...s.matchAll(/<opr:property(\s[^>]*)?\/?>/g)].map((m) => {
    const a = attrsOf(m[1]);
    return { facet: a.facet ?? '?', name: a.name ?? null, text: a.text ?? a.displayName ?? null };
  });
  const unknownFacets = new Map();
  for (const p of properties) if (!FACETS.has(p.facet)) unknownFacets.set(p.facet, (unknownFacets.get(p.facet) ?? 0) + 1);
  for (const [facet, count] of unknownFacets) drift.push({ node: `facet ${facet}`, count, where: 'objectProperties' });

  const one = (facet) => properties.find((p) => p.facet === facet)?.name ?? null;
  const packagePath = properties.filter((p) => p.facet === 'PACKAGE').map((p) => p.name).filter(Boolean);
  const own = head.package ?? packagePath.at(-1) ?? null;
  const ownIdx = own ? packagePath.lastIndexOf(own) : -1;
  return {
    object: { name: head.name ?? null, type: head.type ?? null, package: own, text: head.text ?? null },
    packagePath,
    parentPackage: ownIdx > 0 ? packagePath[ownIdx - 1] : null,
    owner: one('OWNER'),
    apiState: one('API'),
    language: one('LANGUAGE'),
    version: one('VERSION'),
    created: one('DATE'),
    component: one('COMP'),
    applicationComponent: (() => {
      const v = one('APPL');
      return v && v !== '-' ? v : null;
    })(),
    properties,
    drift,
  };
}

/** ENHO/XH: class enhancement (CLASENH) or function-module interface enhancement (FUGRENH). */
export const isClasenh = (type) => String(type ?? '').toUpperCase() === 'ENHO/XH';

/** Where the code of an ENHO/XH really is -- the sentence every tool repeats. */
export const CLASENH_WHERE =
  'the methods, attributes and parameters it adds are in SE19 (or SE24/SE37 on the enhanced ' +
  'object) and in abapGit as <enho>.enho.xml + <enho>.enho.em_<method>.abap; the ADT has no ' +
  'resource for them and /enhancements/enhoxh/<x> dumps the server';

/** File the one gap for an ENHO/XH: nothing structural was read, by design, not by failure. */
export function clasenhGap(journal, name, detail) {
  journal?.gap?.({
    code: 'CLASENH_NOT_IN_ADT',
    subject: name,
    detail,
    impact: 'nothing structural was read: what the enhancement adds to the standard object is not visible through the ADT',
    fallback: CLASENH_WHERE,
  });
}
