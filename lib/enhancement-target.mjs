// The object an enhancement implementation (ENHO) enhances, read out of the atom link the
// ADT publishes on the ENHO itself, so every tool decodes the href the same way -- four shapes were measured on the
// DEV (2026-09-11), and a fifth would be reported as `?`, never guessed at.
//
//   /sap/bc/adt/programs/programs/sapfv45l/enhancements/options?...   -> PROG SAPFV45L
//   /sap/bc/adt/functions/groups/%2fscwm%2fto_whr/enhancements/...    -> FUGR /SCWM/TO_WHR
//   /sap/bc/adt/oo/classes/cl_foo/enhancements/...                    -> CLAS CL_FOO
//   /sap/bc/adt/enhancements/enhoxhb/oid_sapfv45p/enhancements/...    -> ENHO OID_SAPFV45P
//
// The fourth is a customer enhancement stacked ON TOP of an enhancement the SAP delivered
// (measured: ZIM_DEMO_DELETE_ITEM over OID_SAPFV45P). It gets its own kind because
// the content route is different: reading an ENHO's own URI returns empty source, so the
// code an ENHO implants is read from the enhanced object's side (adt_read_source with
// enhancements: true), never from the ENHO.
//
// ⚠️ THE URI IS KEPT PERCENT-ENCODED. A namespaced object arrives as
// `/functions/groups/%2fscwm%2fto_whr` precisely BECAUSE its name contains slashes --
// decoding it produces `/functions/groups//scwm/to_whr`, a double slash that addresses a
// different resource and fails. Measured the hard way: 12 of the 14 objects that produced
// no dump on the first full sweep were namespaced, and all 12 were this bug, not a SAP
// limit. Only the display NAME is decoded.

/** The link relation, matched by suffix: the ADT publishes it under a long IRI. */
export const REL_ENHANCED = 'enhancementOptionsOfEnhancedObject';

const KIND_BY_PATH = { 'programs/programs': 'PROG', 'functions/groups': 'FUGR', 'oo/classes': 'CLAS' };

/** `{ uri, kind, name }` of the enhanced object behind one href; `kind: '?'` for a shape not measured. */
export function parseEnhancedObject(href) {
  const uri = String(href).split('?')[0].replace(/\/enhancements\/options$/, '');
  const m = uri.match(
    /^\/sap\/bc\/adt\/(programs\/programs|functions\/groups|oo\/classes|enhancements\/enhoxh[a-z]*)\/(.+)$/
  );
  const dec = (s) => decodeURIComponent(s).toUpperCase();
  if (!m) return { uri, kind: '?', name: dec(uri.split('/').pop()) };
  const kind = m[1].startsWith('enhancements/') ? 'ENHO' : KIND_BY_PATH[m[1]];
  return { uri, kind, name: dec(m[2]) };
}

/**
 * The enhanced object of an ENHO, from its object structure -- or null when the structure
 * publishes no such link. Measured: every ENHO/XHB (BAdI implementation) lands on null,
 * which is correct and not a failure: a BAdI implementation implements a SPOT, not an
 * object, and which spot is a different question (answered from the ENHO body: `badi`).
 */
export function enhancedObjectOf(structure) {
  const link = (structure?.links ?? []).find((l) => String(l.rel).endsWith(REL_ENHANCED));
  return link ? parseEnhancedObject(link.href) : null;
}

// --- the BAdI implementation body (ENHO/XHB) ----------------------------------------------
//
// MEASURED 2026-09-12 (measurement; docs/adt-api-reference.md). `objectStructure` of an
// XHB carries no spot; the raw object (`GET <uri>`, `application/vnd.sap.adt.enh.enhoxhb.v4+xml`)
// has it twice: `enho:usages` (the referenced objects, USEO = used, EXTO = extended) and
// `enho:badiImplementation` (spot, BAdI definition, implementing class). The same regex
// approach as lib/runtime-feeds.mjs; the element set is declared and the rest is drift.

const XHB_ELEMENTS = new Set([
  'enho:objectData', 'atom:link', 'adtcore:packageRef', 'enho:contentCommon', 'enho:usages',
  'enhcore:referencedObject', 'enhcore:objectReference', 'enhcore:mainObjectReference',
  'enho:contentSpecific', 'enho:badiTechnology', 'enho:badiImplementations',
  'enho:badiImplementation', 'enho:enhancementSpot', 'enho:badiDefinition', 'enho:implementingClass',
]);

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
const firstTag = (s, el) => new RegExp(`<${el}(\\s[^>]*)?/?>`).exec(s)?.[1] ?? null;
const blocks = (s, el) => [...s.matchAll(new RegExp(`<${el}(\\s[^>]*)?>([\\s\\S]*?)</${el}>`, 'g'))].map((m) => ({ attrs: attrsOf(m[1]), body: m[2] }));
const ref = (tag) => {
  const a = attrsOf(tag);
  return tag === null ? null : { name: a['adtcore:name'] ?? null, type: a['adtcore:type'] ?? null, uri: a['adtcore:uri'] ?? null };
};

/** Spot, BAdI, implementing class and referenced objects of one ENHO/XHB body. */
export function parseEnhoXhb(xml) {
  const s = String(xml ?? '');
  const drift = [];
  const seen = new Map();
  for (const m of s.matchAll(/<([A-Za-z][\w:.-]*)[\s/>]/g)) {
    if (!XHB_ELEMENTS.has(m[1])) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  for (const [node, count] of seen) drift.push({ node, count, where: 'enhoxhb' });
  const head = attrsOf(firstTag(s, 'enho:objectData'));
  const common = attrsOf(firstTag(s, 'enho:contentCommon'));
  const usages = blocks(s, 'enhcore:referencedObject').map(({ attrs, body }) => ({
    usage: attrs['enhcore:element_usage'] ?? null,
    ...ref(firstTag(body, 'enhcore:objectReference')),
  }));
  const implementations = blocks(s, 'enho:badiImplementation').map(({ attrs, body }) => ({
    name: attrs['enho:name'] ?? null,
    shortText: attrs['enho:shortText'] ?? null,
    active: attrs['enho:active'] === 'true',
    default: attrs['enho:default'] === 'true',
    example: attrs['enho:example'] === 'true',
    customizingLock: attrs['enho:customizingLock'] ?? null,
    runtimeBehavior: attrs['enho:runtimeBehaviorShorttext'] ?? null,
    spot: ref(firstTag(body, 'enho:enhancementSpot')),
    badi: ref(firstTag(body, 'enho:badiDefinition')),
    implementingClass: ref(firstTag(body, 'enho:implementingClass')),
  }));
  return {
    name: head['adtcore:name'] ?? null,
    type: head['adtcore:type'] ?? null,
    description: head['adtcore:description'] ?? null,
    package: attrsOf(firstTag(s, 'adtcore:packageRef'))['adtcore:name'] ?? null,
    toolType: common['enho:toolType'] ?? null,
    switchSupported: common['enho:switchSupported'] === 'true',
    usages,
    implementations,
    drift,
  };
}
