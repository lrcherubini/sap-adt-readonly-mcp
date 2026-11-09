// A service binding (SRVB/SVB) as the ADT describes it: the binding document and, for an OData
// binding, the detail of each service version. MEASURED 2026-11-09 (docs/adt-api-reference.md,
// the four "Service bindings" sections): 9 bindings in a broad round, 376 in a coverage round,
// 3 with two versions.
//
// What the measurements fixed, and this module follows:
//   * the binding document has ONE representation, servicebinding.v2+xml (v1 answers 406);
//   * the kind is `srvb:binding` (type ODATA + version V2|V4, or SQL with no version), never
//     which detail path answers: the detail answers 200 for either kind, and for a version the
//     binding does not hold;
//   * the service name, version and SRVD of the detail are read from the document, never derived
//     from the binding name (a V4 service is named after its SRVD; one is mixed case);
//   * `published` is PER VERSION. The root flag read "true" on a binding whose version 0001 was
//     unpublished and 0002 published, so the root is reported as what it is and each version's
//     state comes from its own detail;
//   * an unpublished version has an empty serviceUrl and an empty entity list. That is the
//     measured state of an unpublished service, not a failed read.

import { V4_SERVICE_PATH, namedGet } from './adt-get.mjs';
import { segmentFor } from './enhancement-elements.mjs';

export const DRIFT_CODE = 'SHAPE_DRIFT';

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
const firstTag = (xml, el) => (String(xml ?? '').match(new RegExp(`<${el}\\b([^>]*)>`)) ?? [])[1] ?? null;

// The element sets of every measured reply. Anything else is drift: reported, never guessed at.
const BINDING_ELEMENTS = new Set([
  'srvb:serviceBinding', 'srvb:services', 'srvb:content', 'srvb:serviceDefinition', 'srvb:bindingTypeData',
  'srvb:binding', 'srvb:implementation', 'adtcore:packageRef', 'adtcore:content', 'atom:link',
]);
const DETAIL_ELEMENTS = new Set([
  'odatav2:serviceList', 'odatav2:services', 'odatav4:serviceGroup', 'odatav4:services', 'atom:link',
  'serviceInfo:serviceInformation', 'serviceInfo:collection', 'serviceInfo:navigation',
]);
function driftOf(xml, known, where) {
  const seen = new Map();
  for (const m of String(xml ?? '').matchAll(/<([A-Za-z][\w]*:[\w]+)\b/g)) {
    if (!known.has(m[1])) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return [...seen].map(([node, count]) => ({ node, count, where }));
}

/** The Accept of the detail, as the IDE's "Fetch binding type information" job sends it. */
const ideAccept = (kind) =>
  [1, 2, 3].map((n) => `application/vnd.sap.adt.businessservices.${kind}.v${n}+xml`).join(', ');
export const BINDING_ACCEPT = 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml';
export const DETAIL_ACCEPT = Object.freeze({ V2: ideAccept('odatav2'), V4: ideAccept('odatav4') });

const CATEGORY = { 0: 'UI', 1: 'Web API' };

/**
 * The binding document. `versions` is one row per service version, in document order.
 * @returns {{name:string|null, type:string|null, version:string|null, category:string|null,
 *   categoryText:string|null, contract:string|null, releaseSupported:boolean|null,
 *   rootPublished:boolean|null, versions:Array<object>, drift:Array<object>}}
 */
export function parseServiceBinding(xml) {
  const s = String(xml ?? '');
  const root = attrsOf(firstTag(s, 'srvb:serviceBinding'));
  const bind = attrsOf(firstTag(s, 'srvb:binding'));
  const bool = (v) => (v === 'true' ? true : v === 'false' ? false : null);
  const versions = [];
  for (const [, sa, inner] of s.matchAll(/<srvb:services\b([^>]*)>([\s\S]*?)<\/srvb:services>/g)) {
    const service = attrsOf(sa)['srvb:name'] ?? null;
    for (const [, ca, ci] of inner.matchAll(/<srvb:content\b([^>]*)>([\s\S]*?)<\/srvb:content>/g)) {
      const c = attrsOf(ca);
      const d = attrsOf(firstTag(ci, 'srvb:serviceDefinition'));
      versions.push({
        service,
        version: c['srvb:version'] ?? null,
        releaseState: c['srvb:releaseState'] ?? null,
        serviceDefinition: d['adtcore:name'] ?? null,
      });
    }
  }
  const category = bind['srvb:category'] ?? null;
  return {
    name: root['adtcore:name'] ?? null,
    type: bind['srvb:type'] ?? null,
    version: bind['srvb:version'] ?? null,
    category,
    categoryText: CATEGORY[category] ?? null,
    contract: root['srvb:contract'] ?? null,
    releaseSupported: bool(root['srvb:releaseSupported']),
    rootPublished: bool(root['srvb:published']),
    versions,
    drift: driftOf(s, BINDING_ELEMENTS, 'serviceBinding'),
  };
}

/** 'V2' | 'V4' for an OData binding, null for anything else (SQL has no detail to read). */
export function detailKind(binding) {
  if (binding?.type !== 'ODATA') return null;
  return binding.version === 'V2' || binding.version === 'V4' ? binding.version : null;
}

/** The detail of ONE service version: its own publication state and entity sets. */
export function parseBindingDetail(xml) {
  const s = String(xml ?? '');
  const row = attrsOf(firstTag(s, 'odatav[24]:services'));
  const group = attrsOf(firstTag(s, 'odatav4:serviceGroup'));
  const pick = (k) => row[`odatav2:${k}`] ?? row[`odatav4:${k}`] ?? null;
  const published = pick('published') ?? group['odatav4:published'] ?? null;
  const entitySets = [];
  for (const m of s.matchAll(/<serviceInfo:collection\b([^>]*?)(\/>|>([\s\S]*?)<\/serviceInfo:collection>)/g)) {
    const a = attrsOf(m[1]);
    const navigations = [...String(m[3] ?? '').matchAll(/<serviceInfo:navigation\b([^>]*)>/g)].map(([, n]) => {
      const na = attrsOf(n);
      return { name: na['serviceInfo:name'] ?? null, target: na['serviceInfo:target'] ?? null };
    });
    entitySets.push({
      name: a['serviceInfo:name'] ?? null,
      isRoot: a['serviceInfo:isRoot'] === 'true',
      isLeading: a['serviceInfo:isLeading'] === 'true',
      navigations,
    });
  }
  return {
    service: pick('serviceId'),
    version: pick('serviceVersion'),
    published: published === 'true' ? true : published === 'false' ? false : null,
    created: pick('created') === 'true' ? true : pick('created') === 'false' ? false : null,
    serviceUrl: pick('serviceUrl') || null,
    annotationUrl: pick('annotationUrl') || null,
    ...(group['odatav4:serviceUrlPrefix'] !== undefined ? { serviceUrlPrefix: group['odatav4:serviceUrlPrefix'] || null } : {}),
    entitySets,
    drift: driftOf(s, DETAIL_ELEMENTS, 'bindingDetail'),
  };
}

const V2_URL = /^\/sap\/opu\/odata\/sap\/([A-Z][A-Z0-9_]{0,39})\/?$/;
const V4_ROOT = '/sap/opu/odata4/sap/';

/**
 * Which `$metadata` route of this server reads the service a published version names, or why
 * none does. Only the forms those routes measured are mapped: a V2 service of the `sap`
 * namespace at version 1, and a V4 service path of the measured shape. A V2 version above 1
 * (`;v=2`) and a namespaced service are real, measured serviceUrls that no route admits yet.
 */
export function metadataRouteOf(kind, serviceUrl) {
  const url = String(serviceUrl ?? '');
  if (!url) return { route: null, why: 'this version is not published: it has no service URL' };
  if (kind === 'V2') {
    const m = url.match(V2_URL);
    if (m) return { route: 'odataMetadata', service: m[1] };
    if (/;v=\d+/.test(url)) return { route: null, why: 'a V2 service version above 1 (;v=N): the odataMetadata route has not measured that form' };
    return { route: null, why: 'a V2 service outside the sap namespace: the odataMetadata route has not measured that form' };
  }
  if (kind === 'V4' && url.startsWith(V4_ROOT)) {
    const service = url.slice(V4_ROOT.length).replace(/\/$/, '');
    if (V4_SERVICE_PATH.test(service)) return { route: 'odataMetadataV4', service };
  }
  return { route: null, why: `a ${kind ?? 'service'} URL of a form the $metadata routes have not measured` };
}

const ROOT_PUBLISHED_NOTE =
  'the binding-level flag. Measured "true" on a binding whose version 0001 was unpublished and ' +
  '0002 published: it does not speak for every version. The state of each version is ' +
  'versions[].published, read from its detail';

/**
 * Read one binding and, for an OData binding, the detail of each of its versions.
 *
 * `transport` is the bound GET seam (adt-get transportFor). `gap` files a journal row and
 * `audit` records one read; both are injected so this stays testable without a server. A failed
 * read never becomes an answer: the document failing returns `note` and files BINDING_NOT_READ;
 * one version failing keeps the others and leaves that version's `published` unknown (null),
 * never false.
 */
export async function readServiceBinding(transport, name, { gap = () => {}, audit = () => {} } = {}) {
  const segment = segmentFor(name);
  if (!segment) return { note: `binding not read: '${name}' is not a name the binding route can address` };
  let doc;
  try {
    const out = await namedGet(transport, 'serviceBinding', { binding: segment });
    audit(`${name}#binding`, out.bytes);
    doc = parseServiceBinding(out.body);
  } catch (e) {
    gap({
      code: 'BINDING_NOT_READ',
      subject: name,
      detail: `HTTP ${e?.status ?? '?'} on the binding document`,
      impact: 'the binding exists; its kind, versions and publication state could not be read -- NOT evidence that it is unpublished',
      fallback: 'the Service Binding editor in the ADT, or /IWFND/MAINT_SERVICE (V2) and /IWFND/V4_ADMIN (V4)',
    });
    return { note: `binding not read: ${e?.name ?? 'Error'}: ${e?.message ?? e}` };
  }
  const drift = [...doc.drift];
  const kind = detailKind(doc);
  const versions = [];
  for (const v of doc.versions) {
    const row = { ...v };
    if (kind) {
      try {
        const out = await namedGet(transport, `serviceBindingDetail${kind}`, {
          binding: segment,
          servicename: v.service,
          serviceversion: v.version,
          srvdname: v.serviceDefinition,
        });
        audit(`${name}#${v.version}`, out.bytes);
        const d = parseBindingDetail(out.body);
        drift.push(...d.drift);
        Object.assign(row, {
          published: d.published,
          created: d.created,
          serviceUrl: d.serviceUrl,
          annotationUrl: d.annotationUrl,
          ...(d.serviceUrlPrefix !== undefined ? { serviceUrlPrefix: d.serviceUrlPrefix } : {}),
          entitySets: d.entitySets,
          metadata: metadataRouteOf(kind, d.serviceUrl),
        });
      } catch (e) {
        gap({
          code: 'BINDING_NOT_READ',
          subject: name,
          detail: `HTTP ${e?.status ?? '?'} on the ${kind} detail of version ${v.version}`,
          impact: 'this version exists; whether it is published and which entity sets it exposes is unknown -- NOT "unpublished"',
          fallback: kind === 'V2' ? '/IWFND/MAINT_SERVICE' : '/IWFND/V4_ADMIN',
        });
        Object.assign(row, { published: null, detailNote: `detail not read: ${e?.name ?? 'Error'}: ${e?.message ?? e}` });
      }
    }
    versions.push(row);
  }
  if (drift.length) {
    gap({
      code: DRIFT_CODE,
      subject: name,
      detail: drift.map((d) => `${d.where}: ${d.node} x${d.count}`).join('; '),
      impact: 'the fields read stand; the measured shape of the binding or its detail has aged',
      fallback: 're-measure (docs/adt-api-reference.md, the "Service bindings" sections)',
    });
  }
  return {
    binding: {
      type: doc.type,
      version: doc.version,
      category: doc.category,
      categoryText: doc.categoryText,
      contract: doc.contract,
      releaseSupported: doc.releaseSupported,
      rootPublished: doc.rootPublished,
      rootPublishedNote: ROOT_PUBLISHED_NOTE,
      versions,
      ...(kind ? {} : { detailNote: `no detail read: a ${doc.type ?? 'non-OData'} binding has none (only OData V2 and V4 do)` }),
    },
  };
}
