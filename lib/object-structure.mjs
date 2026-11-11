// The structure document of an object, and where its source lives -- what abap-adt-api's
// objectStructure, ADTClient.mainInclude and ADTClient.classIncludes did, in the same shapes.
//
// MEASURED 2026-11-10 (library-removal probe): GET <object uri> with Accept */* answers the
// object document (class `…oo.classes.v4+xml`, program `…programs.programs.v3+xml`, CDS
// `…ddlSource+xml`): one root element whose attributes are the metadata, its `atom:link`
// children, and for a class one `class:include` per include, each with its own links.

import { parseXml, childrenOf, typedAttrs } from './xml.mjs';

/**
 * `{objectUrl, metaData, links, includes?}` -- the library's shape: metadata attributes typed,
 * `adtcore:changedAt` / `adtcore:createdAt` as epoch milliseconds (0 when absent), `includes`
 * only for a class (a document whose root carries `class:visibility`).
 */
export function parseObjectStructure(objectUrl, xml) {
  const root = parseXml(xml);
  const metaData = typedAttrs(root);
  metaData['adtcore:changedAt'] = Date.parse(metaData['adtcore:changedAt']) || 0;
  metaData['adtcore:createdAt'] = Date.parse(metaData['adtcore:createdAt']) || 0;
  const links = childrenOf(root, 'atom:link').map(typedAttrs);
  if (metaData['class:visibility'] === undefined) return { objectUrl, metaData, links };
  const includes = childrenOf(root, 'class:include').map((i) => ({ ...typedAttrs(i), links: childrenOf(i, 'atom:link').map(typedAttrs) }));
  return { objectUrl, metaData, includes, links };
}

/** The library's followUrl: `./x` replaces the last segment, anything else hangs off the base. */
export function followUrl(base, extra) {
  let b = String(base);
  let e = String(extra);
  if (/^\.\//.test(e)) {
    b = b.replace(/[^/]*$/, '');
    e = e.replace(/^\.\//, '');
  } else e = e.replace(/^\//, '');
  return `${b.replace(/\/$/, '')}/${e}`;
}

const isClassStructure = (s) => s?.metaData?.['class:visibility'] !== undefined;

/** Where the main source of an object is (ADTClient.mainInclude, same rules, same default). */
export function mainInclude(structure, withDefault = true) {
  if (structure.metaData?.['adtcore:type'] === 'DEVC/K') return structure.objectUrl;
  if (isClassStructure(structure)) {
    const main = (structure.includes ?? []).find((x) => x['class:includeType'] === 'main');
    // CDS has no type on its plain-text link, as the library noted.
    const link = main && (main.links.find((x) => x.type === 'text/plain') || main.links.find((x) => !x.type));
    if (link) return followUrl(structure.objectUrl, link.href);
  } else {
    const source = structure.metaData?.['abapsource:sourceUri'];
    if (source) return followUrl(structure.objectUrl, source);
    const link = (structure.links ?? []).find((x) => x.type === 'text/plain');
    if (link) return followUrl(structure.objectUrl, link.href);
  }
  return withDefault ? followUrl(structure.objectUrl, '/source/main') : structure.objectUrl;
}

/** Include type -> source URI of each class include (ADTClient.classIncludes). */
export function classIncludes(structure) {
  const out = new Map();
  for (const i of structure.includes ?? []) {
    const link = i.links.find((x) => x.type === 'text/plain');
    if (link) out.set(i['class:includeType'], followUrl(structure.objectUrl, link.href));
  }
  return out;
}
