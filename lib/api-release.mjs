// The API release state of one object, as the system holds it: per contract, released or not,
// usable in key-user apps or in cloud development, and the successors SAP names. MEASURED
// 2026-11-10 on a Z class, a released SAP class, a namespaced class, a CDS view, an interface, a
// table, a data element, a function module and an object that does not exist
// (docs/adt-api-reference.md, "The API release state of one object"):
//
//   GET /sap/bc/adt/apireleases/<object URI, percent-encoded>      Accept: */*
//   -> 200 application/vnd.sap.adt.apirelease.v10+xml, 1.9-7 KB
//
// ⚠️ An object with no contract and an object that DOES NOT EXIST answer the same: 200, no
// contract element. The caller asks only after the object was resolved; an empty list means "no
// API release contract", never "not found".
// ⚠️ `ars:status` appears twice per contract: the contract's own state first, then once per
// allowed transition inside `ars:stateTransitions`. Only the first one is the state.
// `ars:behaviour` describes what the CALLER may do to a contract (a write) and is not read.

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
const bool = (v) => (v === 'true' ? true : v === 'false' ? false : null);

/** The object families measured: the only URIs the route is asked for. */
export const API_RELEASE_OBJECT =
  /^\/sap\/bc\/adt\/(oo\/classes|oo\/interfaces|ddic\/ddl\/sources|ddic\/tables|ddic\/dataelements|functions\/groups\/[a-z0-9_%]{1,40}\/fmodules)\/[a-z0-9_%.]{1,120}$/;

/** {object, contracts: [...], anyReleased, drift} from one reply. */
export function parseApiRelease(xml) {
  const text = String(xml ?? '');
  const drift = [];
  const root = text.match(/<ars:apiRelease\b/);
  if (!root) drift.push({ node: 'ars:apiRelease', attribute: null, where: 'root missing' });
  const obj = attrsOf(text.match(/<ars:releasableObject\b([^>]*)\/?>/)?.[1]);
  const contracts = [];
  // A contract element carries ars:contract; the ones inside ars:behaviour do not.
  for (const m of text.matchAll(/<ars:(c[0-9])Release\b([^>]*\bars:contract="[^"]*"[^>]*)>([\s\S]*?)<\/ars:\1Release>/g)) {
    const a = attrsOf(m[2]);
    const body = m[3];
    const own = body.split('<ars:stateTransitions')[0];
    const status = attrsOf(own.match(/<ars:status\b([^>]*)\/?>/)?.[1]);
    const successors = [...body.matchAll(/<ars:successor\b([^>]*)\/?>/g)].map(([, raw]) => {
      const s = attrsOf(raw);
      return { name: s['adtcore:name'] ?? null, type: s['adtcore:type'] ?? null, uri: s['adtcore:uri'] ?? null };
    });
    if (!status['ars:state']) drift.push({ node: `ars:${m[1]}Release`, attribute: 'ars:status', where: 'no state' });
    contracts.push({
      contract: a['ars:contract'] ?? m[1].toUpperCase(),
      state: status['ars:state'] ?? null,
      stateText: status['ars:stateDescription'] ?? null,
      useInKeyUserApps: bool(a['ars:useInKeyUserApps']),
      useInCloudDevelopment: bool(a['ars:useInSAPCloudPlatform']),
      successors,
      successorConcept: unescapeXml(body.match(/<ars:successorConceptName>([^<]*)</)?.[1] ?? '') || null,
      changedAt: a['adtcore:changedAt'] ?? null,
      changedBy: a['adtcore:changedBy'] ?? null,
    });
  }
  const catalog = attrsOf(text.match(/<ars:apiCatalogData\b([^>]*)>/)?.[1]);
  return {
    object: { name: obj['adtcore:name'] ?? null, type: obj['adtcore:type'] ?? null, uri: obj['adtcore:uri'] ?? null },
    contracts,
    anyReleased: bool(catalog['ars:isAnyContractReleased']) ?? contracts.some((c) => c.state === 'RELEASED'),
    drift,
  };
}
