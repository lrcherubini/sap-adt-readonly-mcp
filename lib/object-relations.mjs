// The objects one object uses: the IDE's Relation Explorer, context "Used Objects".
//
// MEASURED 2026-11-10 from the IDE's communication log (docs/adt-api-reference.md, "References
// going out of an object: the Relation Explorer"):
//
//   POST /sap/bc/adt/objectrelations/network
//     Content-Type application/vnd.sap.adt.objectrelations.request.v1+xml
//     Accept       application/vnd.sap.adt.objectrelations.response.network.v1+xml
//     body         <oro:request><oro:reference adtcore:name adtcore:type adtcore:uri/></oro:request>
//   -> 200: oro:activeContext ENV ("Used Objects", the server's default for a class), the
//      contexts it offers, oro:relation pairs (object1 the class, object2 a used object), and one
//      oro:objectReference per object (the class included) with type, name, package, description
//      and oro:packagePath, the package and its ancestors.
//
// A POST that reads. The body names one object and nothing else -- no source, no context -- and
// is built HERE from the URI, type and name the guarded search resolved. A class is the one
// family measured; anything else is refused before a socket opens.

export class ObjectRelationsViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'ObjectRelationsViolation';
  }
}

export const NETWORK_URL = '/sap/bc/adt/objectrelations/network';
export const NETWORK_REQUEST = 'application/vnd.sap.adt.objectrelations.request.v1+xml';
export const NETWORK_RESPONSE = 'application/vnd.sap.adt.objectrelations.response.network.v1+xml';

const CLASS_URI = /^\/sap\/bc\/adt\/oo\/classes\/[a-z0-9_%.-]{1,120}$/;
const CLASS_NAME = /^(?:\/[A-Z0-9_]{1,10}\/)?[A-Z0-9_]{1,30}$/;
const BUILT = Symbol('network request');

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The request body for one class, exactly the measured form. */
export function buildNetworkRequest({ uri, type, name }) {
  const u = String(uri ?? '').trim();
  const t = String(type ?? '').trim().toUpperCase();
  const n = String(name ?? '').trim().toUpperCase();
  if (t !== 'CLAS/OC') throw new ObjectRelationsViolation(`only a class (CLAS/OC) is measured; got '${type}'.`);
  if (!CLASS_URI.test(u)) throw new ObjectRelationsViolation(`'${uri}' is not the URI of a class (${CLASS_URI}).`);
  if (!CLASS_NAME.test(n)) throw new ObjectRelationsViolation(`'${name}' is not a class name (${CLASS_NAME}).`);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<oro:request xmlns:adtcore="http://www.sap.com/adt/core" xmlns:oro="http://www.sap.com/adt/objectrelations">' +
    `<oro:reference adtcore:name="${escapeAttr(n)}" adtcore:type="${t}" adtcore:uri="${escapeAttr(u)}"/>` +
    '</oro:request>';
  return Object.freeze({ [BUILT]: true, uri: u, type: t, name: n, xml });
}

/** The one POST. Takes the RAW client (the guarded one has no verb, by design). */
export async function networkPost(rawClient, built) {
  if (!built || built[BUILT] !== true) throw new ObjectRelationsViolation('networkPost needs a body built by buildNetworkRequest.');
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new ObjectRelationsViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  }
  let res;
  try {
    res = await http.request(NETWORK_URL, {
      method: 'POST',
      headers: { Accept: NETWORK_RESPONSE, 'Content-Type': NETWORK_REQUEST },
      body: built.xml,
    });
  } catch (e) {
    const status = e?.err ?? e?.status ?? e?.response?.status ?? null;
    const err = new Error(`ADT answered ${status ?? 'no readable status'} for the used objects: ${e?.message ?? e}`);
    err.status = status;
    err.url = NETWORK_URL;
    throw err;
  }
  const body = String(res?.body ?? '');
  return { status: Number(res?.status ?? 0), body, bytes: Buffer.byteLength(body, 'utf8') };
}

const ELEMENTS = new Set([
  'oro:networkResponse',
  'oro:activeContext',
  'oro:context',
  'oro:relation',
  'oro:object1',
  'oro:object2',
  'oro:objectReference',
  'oro:packagePath',
  'oro:packageReference',
  'atom:link',
]);

const attrsOf = (raw) => {
  const out = {};
  for (const m of String(raw ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/** The name as a reader writes it: a function module's padded `GROUP<blanks>MODULE` is the module. */
export const displayNameOf = (type, name) => {
  const n = String(name ?? '').trim();
  return type === 'FUGR/FF' ? n.split(/\s+/).pop() : n;
};

/** {activeContext, contexts, relations, objects, drift} from one reply. */
export function parseNetwork(xml) {
  const body = String(xml ?? '');
  const drift = [];
  for (const [, node] of body.matchAll(/<([\w]+:[\w]+)[\s/>]/g)) {
    if (!ELEMENTS.has(node) && !drift.some((d) => d.node === node)) drift.push({ node });
  }
  const activeContext = /<oro:activeContext>([^<]*)<\/oro:activeContext>/.exec(body)?.[1] ?? null;
  const contexts = [...body.matchAll(/<oro:context\s([^>]*?)\/?>/g)].map(([, raw]) => {
    const a = attrsOf(raw);
    return { id: a['oro:id'] ?? null, displayName: a['oro:displayName'] ?? null };
  });
  const relations = [...body.matchAll(/<oro:relation\s([^>]*)>([\s\S]*?)<\/oro:relation>/g)].map(([, raw, inner]) => {
    const a = attrsOf(raw);
    return {
      type: a['oro:relationType'] ?? null,
      state: a['oro:state'] ?? null,
      object1: unescapeXml(/<oro:object1>([^<]*)</.exec(inner)?.[1] ?? '') || null,
      object2: unescapeXml(/<oro:object2>([^<]*)</.exec(inner)?.[1] ?? '') || null,
    };
  });
  const objects = [];
  for (const [, raw, inner = ''] of body.matchAll(/<oro:objectReference\s([^>]*?)(?:\/>|>([\s\S]*?)<\/oro:objectReference>)/g)) {
    const a = attrsOf(raw);
    const type = a['adtcore:type'] ?? null;
    objects.push({
      uri: a['adtcore:uri'] ?? null,
      type,
      name: displayNameOf(type, a['adtcore:name']),
      ...(type === 'FUGR/FF' ? { group: String(a['adtcore:name'] ?? '').trim().split(/\s+/)[0] || null } : {}),
      package: a['adtcore:packageName'] || null,
      description: a['adtcore:description'] || null,
      exists: a['oro:exists'] === 'true' ? true : a['oro:exists'] === 'false' ? false : null,
      packagePath: [...inner.matchAll(/<oro:packageReference\s([^>]*?)\/?>/g)].map(([, p]) => attrsOf(p)['adtcore:name']).filter(Boolean),
    });
  }
  return { activeContext, contexts, relations, objects, drift };
}
