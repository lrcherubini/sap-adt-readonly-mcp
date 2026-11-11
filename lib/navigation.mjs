// Go to definition: where the symbol at one position of a class's source is defined.
//
// MEASURED 2026-11-10 from the IDE's communication log (F3 on a method call; docs/
// adt-api-reference.md, "Backlog reads"):
//
//   POST /sap/bc/adt/navigation/target?uri=<source URI#start=<line>,<col>, percent-encoded>&filter=definition
//     Content-Type text/plain   Accept application/xml
//     body          the whole main source of the object named in `uri`
//   -> 200 application/xml: one adtcore:objectReference, the target's source URI with the
//      position of the definition (`…/source/main#start=10,18`)
//
// A POST that reads. What keeps it narrow (decision in docs/security.md):
//   - the path and the filter are fixed here; the object is a class, its main source, the one
//     family measured;
//   - the body is the STORED active source the server has just been read through the guarded
//     client, never text from the caller: `buildNavigationRequest` takes the text and the tool
//     hands it only what `getObjectSource` answered;
//   - the position is two bounded integers.
// Nothing is left on the server: the IDE sends the same request on every F3.

export class NavigationViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'NavigationViolation';
  }
}

export const NAVIGATION_PATH = '/sap/bc/adt/navigation/target';
const SOURCE_URI = /^\/sap\/bc\/adt\/oo\/classes\/[a-z0-9_%.-]{1,120}\/source\/main$/;
const BUILT = Symbol('navigation request');
const MAX_LINE = 100000;
const MAX_COLUMN = 10000;

/** The request for one position of one class's stored main source. */
export function buildNavigationRequest({ sourceUri, line, column, storedSource }) {
  const u = String(sourceUri ?? '').trim();
  if (!SOURCE_URI.test(u)) throw new NavigationViolation(`'${sourceUri}' is not the main source of a class (${SOURCE_URI}).`);
  const l = Number(line);
  const c = Number(column);
  if (!Number.isInteger(l) || l < 1 || l > MAX_LINE) throw new NavigationViolation(`line must be an integer from 1 to ${MAX_LINE}; got ${line}.`);
  if (!Number.isInteger(c) || c < 0 || c > MAX_COLUMN) throw new NavigationViolation(`column must be an integer from 0 to ${MAX_COLUMN}; got ${column}.`);
  const text = String(storedSource ?? '');
  if (!text.trim()) throw new NavigationViolation('the stored source is empty: there is nothing to navigate in.');
  const lines = text.split(/\r?\n/).length;
  if (l > lines) throw new NavigationViolation(`line ${l} is past the end of the stored source (${lines} lines).`);
  const url = `${NAVIGATION_PATH}?uri=${encodeURIComponent(`${u}#start=${l},${c}`)}&filter=definition`;
  return Object.freeze({ [BUILT]: true, url, sourceUri: u, line: l, column: c, body: text });
}

/** The one POST. Takes the RAW client (the guarded one has no verb, by design). */
export async function navigationPost(rawClient, built) {
  if (!built || built[BUILT] !== true) throw new NavigationViolation('navigationPost needs a request built by buildNavigationRequest.');
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new NavigationViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  }
  let res;
  try {
    res = await http.request(built.url, {
      method: 'POST',
      headers: { Accept: 'application/xml', 'Content-Type': 'text/plain' },
      body: built.body,
    });
  } catch (e) {
    const status = e?.err ?? e?.status ?? e?.response?.status ?? null;
    const err = new Error(`ADT answered ${status ?? 'no readable status'} for go to definition: ${e?.message ?? e}`);
    err.status = status;
    err.url = NAVIGATION_PATH;
    throw err;
  }
  const body = String(res?.body ?? '');
  return { status: Number(res?.status ?? 0), body, bytes: Buffer.byteLength(body, 'utf8') };
}

const ELEMENTS = new Set(['adtcore:objectReference']);

/** The target the server named: `{uri, objectUri, line, column}`, or null when it named none. */
export function parseNavigationTarget(xml) {
  const body = String(xml ?? '');
  const drift = [];
  for (const [, name] of body.matchAll(/<([\w]+:[\w]+)[\s/>]/g)) {
    if (!ELEMENTS.has(name) && !drift.some((d) => d.node === name)) drift.push({ node: name });
  }
  // Every reference the reply names, not only the first: two targets are an ambiguity the
  // caller must see, never one picked in silence.
  const targets = [...body.matchAll(/<adtcore:objectReference\s[^>]*?adtcore:uri="([^"]+)"/g)].map((ref) => {
    const uri = ref[1].replace(/&amp;/g, '&');
    const pos = /#start=(\d+),(\d+)/.exec(uri);
    const path = uri.replace(/#.*$/, '');
    return {
      uri,
      sourceUri: path,
      // The object the source belongs to: the URI up to its /source or /includes part.
      objectUri: path.replace(/\/(?:source|includes)\/.*$/, ''),
      line: pos ? Number(pos[1]) : null,
      column: pos ? Number(pos[2]) : null,
    };
  });
  return { target: targets[0] ?? null, targets, drift };
}
