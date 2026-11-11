// The reads behind the guard's members, written here one by one as abap-adt-api leaves
// (docs/security.md, "Removing abap-adt-api"). Each returns exactly the shape the library returned,
// so no tool changes when a member moves; each goes through the closed seams of lib/adt-get.mjs.
//
// Until the last member moves, `mixedApi` gives the tools one object: the members written here,
// and every other allowlisted member still delegated to the library. lib/guard.mjs wraps that
// object exactly as it wrapped the library.

import { derivedGet, transportFor } from './adt-get.mjs';
import { parseObjectStructure } from './object-structure.mjs';
import { allowedMethods } from './guard.mjs';

/** The members that no longer come from the library. Grows by one member per cycle. */
export const OWN_READS = Object.freeze(['getObjectSource', 'objectStructure']);

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
