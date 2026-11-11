// The reads behind the guard's members, written here one by one as abap-adt-api leaves
// (docs/security.md, "Removing abap-adt-api"). Each returns exactly the shape the library returned,
// so no tool changes when a member moves; each goes through the closed seams of lib/adt-get.mjs.
//
// Until the last member moves, `mixedApi` gives the tools one object: the members written here,
// and every other allowlisted member still delegated to the library. lib/guard.mjs wraps that
// object exactly as it wrapped the library.

import { derivedGet, namedGet, transportFor } from './adt-get.mjs';
import { parseObjectStructure } from './object-structure.mjs';
import { parseXml, childrenOf, typedAttrs } from './xml.mjs';
import { allowedMethods } from './guard.mjs';

/** The members that no longer come from the library. Grows by one member per cycle. */
export const OWN_READS = Object.freeze(['getObjectSource', 'objectStructure', 'searchObject', 'objectStructureElements']);

/**
 * The hits of a quick search, as the library returned them: every attribute of each
 * adtcore:objectReference, and the name split from a "NAME (description)" form some releases
 * send. Unlike the library, every value stays a string: a name or a description of digits is
 * not a number.
 */
export function parseSearchHits(xml) {
  return childrenOf(parseXml(xml), 'adtcore:objectReference').map((el) => {
    const hit = {};
    for (const [k, v] of Object.entries(el.attrs)) if (k !== 'xmlns' && !k.startsWith('xmlns:')) hit[k] = v;
    const r = /([^\s]*)\s*\((.*)\)/.exec(hit['adtcore:name'] ?? '');
    if (r) {
      hit['adtcore:name'] = r[1];
      if (!hit['adtcore:description']) hit['adtcore:description'] = r[2];
    }
    return hit;
  });
}

const parseBool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);

/** One element of an outline, recursively, in the library's shape (parseStructureElement). */
function outlineElement(el) {
  const a = typedAttrs(el);
  return {
    name: a['adtcore:name'] || '',
    type: a['adtcore:type'] || '',
    description: a['adtcore:description'],
    visibility: a.visibility,
    level: a.level,
    constant: parseBool(a.constant),
    constructor: parseBool(a.constructor),
    testmethod: parseBool(a.testmethod),
    redefinition: parseBool(a.redefinition),
    final: parseBool(a.final),
    links: childrenOf(el, 'atom:link').map(typedAttrs),
    children: childrenOf(el, 'abapsource:objectStructureElement').map(outlineElement),
  };
}

/** The children of the root abapsource:objectStructureElement, as the library returned them. */
export function parseOutline(xml) {
  const root = parseXml(xml);
  if (root.name !== 'abapsource:objectStructureElement') return [];
  return childrenOf(root, 'abapsource:objectStructureElement').map(outlineElement);
}

/** A source URI split into the object it belongs to and the relative part read under it. */
export function splitSourceUri(url) {
  const m = /^(\/sap\/bc\/adt\/.+?)\/(source\/main|includes\/[a-z]+)$/.exec(String(url ?? '').trim());
  if (!m) return null;
  return { object: m[1], href: m[2] };
}

/** The own reads, over the raw client of the session. */
export function ownReads(raw) {
  const transport = transportFor(raw);
  return {
    /** The source text, as the library returned it: a string. */
    async getObjectSource(url) {
      const parts = splitSourceUri(url);
      // derivedGet refuses what is not a source URI; this only finds the object it hangs off.
      const out = await derivedGet(transport, parts?.object ?? String(url ?? ''), parts?.href ?? String(url ?? ''), { kind: 'objectSource' });
      return out.body;
    },
    /** The quick search: major type only, as the library asked it. */
    async searchObject(query, objType, maxResults = 100) {
      const out = await namedGet(transport, 'repositorySearch', {
        query: String(query ?? ''),
        maxResults: String(maxResults),
        ...(objType ? { objectType: String(objType).replace(/\/.*$/, '').toUpperCase() } : {}),
      });
      return parseSearchHits(out.body);
    },
    /**
     * The outline of a class or an interface, as the library returned it. Unlike the library,
     * a failed read is thrown, never answered as `[]` (adt_object_info says it was not read).
     * Any other object has no outline: `[]`, as the library answered without asking.
     */
    async objectStructureElements(url, version) {
      const u = String(url ?? '').trim();
      if (!/\/oo\/(classes|interfaces)\//i.test(u)) return [];
      const out = await derivedGet(transport, u, 'objectstructure', {
        kind: 'objectOutline',
        query: { version: version || 'active', withShortDescriptions: 'true' },
      });
      return parseOutline(out.body);
    },
    /** The structure document, parsed as the library parsed it. */
    async objectStructure(url) {
      const out = await derivedGet(transport, url, url, { kind: 'objectDocument' });
      return parseObjectStructure(String(url).trim(), out.body);
    },
  };
}

/**
 * One object for the guard: an own member where one exists, the library's otherwise. A member
 * of the library is read lazily, bound to the library, so its getters keep working.
 */
export function mixedApi(library, own) {
  const api = Object.create(null);
  for (const name of allowedMethods()) {
    if (Object.hasOwn(own, name)) {
      api[name] = own[name];
      continue;
    }
    Object.defineProperty(api, name, {
      enumerable: true,
      get() {
        const value = library[name];
        return typeof value === 'function' ? value.bind(library) : value;
      },
    });
  }
  return api;
}
