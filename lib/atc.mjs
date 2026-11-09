import { readFileSync } from 'node:fs';

// The ATC run: the second POST of this server, and the first that creates something on the
// server -- a worklist of check results, which is not a repository object, holds no lock and
// touches no transport. The decision, dated 2026-09-14, is in docs/security.md.
//
// MEASURED 2026-09-14, three runs on the development system:
//   POST /sap/bc/adt/atc/worklists?checkVariant=<v>  Accept text/plain -> 200, 32 hex chars
//     (the worklist id). ⚠️ A variant that does not exist ALSO gets an id (5b, 200): the
//     server validates nothing here, so the closed set of variants below is the fence.
//   POST /sap/bc/adt/atc/runs?worklistId=<id>  body <atc:run maximumVerdicts> + one
//     objectReference -> 200 in 3.7-5.1 s, 515 bytes: worklistId, worklistTimestamp and one
//     info FINDING_STATS "p1,p2,p3" (counts per priority: "0,6,6" = 12 findings).
//   GET /sap/bc/adt/atc/worklists/<id>  Accept application/atc.worklist.v1+xml (the 406
//     names only it; no Accept answers the same) -> 8-20 KB: objectSets (ALL, LAST_RUN),
//     objects/object (uri under /atc/objects/R3TR/<type>/<name>, type, name, package,
//     author), findings/finding with priority, checkId, checkTitle, checkClass, messageId,
//     messageTitle, location (source URI + #start=line,col), quickfixInfo, exemption*,
//     an atom:link to the finding's documentation, quickfixes flags and tags (the check's
//     attributes: APPLICATION_COMPONENT, REF_OBJ_NAME, REF_OBJ_TYPE, REF_PACKAGE, ...).
//     `includeExemptedFindings=true` answered the same body (no exemptions on the object).
//   The ATC verdicts feed did NOT show these runs afterwards (244-byte envelope): the feed
//   is for stored central runs; an ad-hoc run is read from its worklist only.

/**
 * Variants a run may name -- a closed list in two layers, like the customizing tables:
 *   - data/defaults/atc-variants.json: SAP's own `DEFAULT`, the same everywhere;
 *   - the installation's variants (typically the system check variant that
 *     `/sap/bc/adt/atc/customizing` names as systemCheckVariant: the governance run), added with
 *     `npm run config -- atc add` and installed at start by `installAtcVariants`.
 * `DEFAULT_VARIANT` is a live binding: importers see the installed default.
 */
export class AtcViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'AtcViolation';
  }
}

const VARIANT_NAME = /^[A-Z0-9_/]{1,30}$/;
const STANDARD_ATC = (() => {
  const doc = JSON.parse(readFileSync(new URL('../data/defaults/atc-variants.json', import.meta.url), 'utf8'));
  return { variants: doc.variants.map((v) => validateAtcVariant(v)), defaultVariant: String(doc.defaultVariant).toUpperCase() };
})();
export const ATC_VARIANTS = new Map(STANDARD_ATC.variants);
export let DEFAULT_VARIANT = STANDARD_ATC.defaultVariant;

/** Validate one variant entry `{ name, why }`; returns `[NAME, why]` or throws AtcViolation. */
export function validateAtcVariant(entry) {
  const name = String(entry?.name ?? '').trim().toUpperCase();
  if (!VARIANT_NAME.test(name)) throw new AtcViolation(`'${entry?.name}' is not a check variant name (A-Z 0-9 _ /, 1-30 chars).`);
  const why = String(entry?.why ?? '').trim();
  if (!why) throw new AtcViolation(`variant ${name}: 'why' is required -- what the run is for.`);
  return [name, why];
}

/**
 * Install the installation's variants and default. Replaces any previous install. The default
 * must be a listed variant, standard or installed -- otherwise every run would be refused.
 */
export function installAtcVariants(extra = [], defaultVariant) {
  const validated = extra.map(validateAtcVariant);
  ATC_VARIANTS.clear();
  for (const [n, why] of STANDARD_ATC.variants) ATC_VARIANTS.set(n, why);
  for (const [n, why] of validated) ATC_VARIANTS.set(n, why);
  const d = String(defaultVariant ?? STANDARD_ATC.defaultVariant).trim().toUpperCase();
  if (!ATC_VARIANTS.has(d)) {
    throw new AtcViolation(`the default variant ${d} is not a listed variant (${[...ATC_VARIANTS.keys()].join(', ')}).`);
  }
  DEFAULT_VARIANT = d;
  return ATC_VARIANTS;
}
export const MAX_VERDICTS = 100;
export const DEFAULT_VERDICTS = 100;
export const ATC_WORKLIST_ACCEPT = 'application/atc.worklist.v1+xml';
export const ATC_RUN_ACCEPT = 'application/xml';
export const WORKLIST_ID = /^[0-9A-F]{32}$/;
/** An ADT object URI and nothing else -- the same rule the objectProperties route enforces. */
export const OBJECT_URI = /^\/sap\/bc\/adt(?:\/(?!\.\.?(?:\/|$))[a-z0-9_%.~-]{1,120}){2,8}$/i;
export const DRIFT_CODE = 'SHAPE_DRIFT';

export function assertVariant(variant) {
  const v = String(variant ?? DEFAULT_VARIANT).trim().toUpperCase();
  if (!ATC_VARIANTS.has(v)) {
    throw new AtcViolation(
      `'${variant}' is not a check variant this server runs (${[...ATC_VARIANTS.keys()].join(', ')}). ` +
        'The server hands a worklist id to ANY name (measured), so the list here is the fence.'
    );
  }
  return v;
}

// The brand buildRunBody stamps on its result: atcPost sends nothing that was not built
// here, so a hand-written body -- even one carrying a valid URI -- never reaches the wire.
const BUILT = Symbol('atc.builtRunBody');

/** The run body, from a validated URI and a bounded count -- nothing else is interpolated. */
export function buildRunBody({ uri, maxVerdicts } = {}) {
  const u = String(uri ?? '').trim();
  if (!OBJECT_URI.test(u)) throw new AtcViolation(`'${uri}' is not an ADT object URI (absolute under /sap/bc/adt, no query, no fragment).`);
  const n = maxVerdicts === undefined ? DEFAULT_VERDICTS : Number(maxVerdicts);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VERDICTS) throw new AtcViolation(`maxFindings must be an integer from 1 to ${MAX_VERDICTS}.`);
  return Object.freeze({
    [BUILT]: true,
    uri: u,
    maxVerdicts: n,
    xml:
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<atc:run maximumVerdicts="${n}" xmlns:atc="http://www.sap.com/adt/atc">` +
      '<objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences>' +
      `<adtcore:objectReference adtcore:uri="${u.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>` +
      '</adtcore:objectReferences></objectSet></objectSets></atc:run>',
  });
}

const statusOf = (e) =>
  [e?.err, e?.status, e?.response?.status].map(Number).find((x) => Number.isInteger(x) && x >= 100) ?? null;

/**
 * The two POSTs, and only those. `kind` is 'worklist' (needs `variant`) or 'run' (needs
 * `worklistId` and a body built by buildRunBody). Takes the RAW client: the guarded one has
 * no verb, by design. Every argument is re-validated here, so a caller that bypasses the
 * tool still cannot name another path, another variant or another body.
 */
export async function atcPost(rawClient, kind, args = {}) {
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') throw new AtcViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  let url;
  let headers;
  let body = '';
  if (kind === 'worklist') {
    const v = assertVariant(args.variant);
    url = `/sap/bc/adt/atc/worklists?checkVariant=${v}`;
    headers = { Accept: 'text/plain', 'Content-Type': 'text/plain' };
  } else if (kind === 'run') {
    const id = String(args.worklistId ?? '').trim();
    if (!WORKLIST_ID.test(id)) throw new AtcViolation(`'${args.worklistId}' is not a worklist id (32 hex characters, as the server hands them out).`);
    const built = args.body;
    if (!built || built[BUILT] !== true || typeof built.xml !== 'string' || !OBJECT_URI.test(built.uri ?? '')) throw new AtcViolation('atcPost run needs a body built by buildRunBody.');
    url = `/sap/bc/adt/atc/runs?worklistId=${id}`;
    headers = { Accept: ATC_RUN_ACCEPT, 'Content-Type': 'application/xml' };
    body = built.xml;
  } else {
    throw new AtcViolation(`'${kind}' is not an ATC POST this server sends (worklist, run).`);
  }
  const t0 = Date.now();
  let res;
  try {
    res = await http.request(url, { method: 'POST', headers, body });
  } catch (e) {
    const status = statusOf(e);
    const err = new Error(`ADT answered ${status ?? 'no readable status'} for the ATC ${kind}: ${e?.localizedMessage || e?.message || e}`);
    err.status = status;
    err.url = url;
    err.cause = e;
    throw err;
  }
  const text = String(res?.body ?? '');
  return { kind, url, status: Number(res?.status ?? 0), contentType: res?.headers?.['content-type'] ?? null, body: text, bytes: Buffer.byteLength(text, 'utf8'), ms: Date.now() - t0 };
}

// --- parsers ------------------------------------------------------------------------------

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
const attrsOf = (tag) => {
  const out = {};
  for (const m of String(tag ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/** The reply of POST runs: worklist id, timestamp, infos (FINDING_STATS "p1,p2,p3"). */
export function parseRunReply(xml) {
  const s = String(xml ?? '');
  const id = /<atcworklist:worklistId>([^<]*)</.exec(s)?.[1] ?? null;
  const timestamp = /<atcworklist:worklistTimestamp>([^<]*)</.exec(s)?.[1] ?? null;
  const infos = [...s.matchAll(/<atcinfo:info[^>]*>\s*<atcinfo:type>([^<]*)<\/atcinfo:type>\s*<atcinfo:description>([^<]*)<\/atcinfo:description>/g)].map((m) => ({ type: m[1], description: unescapeXml(m[2]) }));
  const stats = infos.find((i) => i.type === 'FINDING_STATS');
  const [p1, p2, p3] = (stats?.description ?? '').split(',').map((n) => Number(n));
  return {
    worklistId: id,
    timestamp,
    infos,
    byPriority: stats ? { 1: p1 ?? 0, 2: p2 ?? 0, 3: p3 ?? 0 } : null,
  };
}

const WORKLIST_ELEMENTS = new Set([
  'atcworklist:worklist', 'atcworklist:objectSets', 'atcworklist:objectSet', 'atcworklist:objects', 'atcworklist:infos',
  'atcobject:object', 'atcobject:findings',
  'atcfinding:finding', 'atcfinding:quickfixes', 'atcfinding:tags', 'atcfinding:tag',
  'atom:link',
]);
const FINDING_ATTRS = new Set([
  'adtcore:uri', 'atcfinding:location', 'atcfinding:processor', 'atcfinding:lastChangedBy', 'atcfinding:priority',
  'atcfinding:checkId', 'atcfinding:checkTitle', 'atcfinding:checkClass', 'atcfinding:messageId', 'atcfinding:messageTitle',
  'atcfinding:exemptionApproval', 'atcfinding:exemptionKind', 'atcfinding:checksum', 'atcfinding:quickfixInfo', 'xmlns:atcfinding',
]);

const locationOf = (loc) => {
  if (!loc) return null;
  const [uriPart, frag] = String(loc).split('#');
  const [path, query] = uriPart.split('?');
  const start = /start=(\d+)(?:,(\d+))?/.exec(frag ?? '');
  const ctx = /context=([^&]+)/.exec(query ?? '');
  return {
    uri: path,
    context: ctx ? decodeURIComponent(ctx[1]) : null,
    line: start ? Number(start[1]) : null,
    column: start?.[2] !== undefined ? Number(start[2]) : null,
  };
};

/**
 * The worklist body -> `{ id, usedObjectSet, objectSetIsComplete, objectSets, objects, findings, drift }`.
 * `findings` is the flat list across objects; each carries its object. Elements and finding
 * attributes outside the measured set are reported in `drift`, never dropped in silence.
 */
export function parseWorklist(xml) {
  const s = String(xml ?? '');
  const drift = [];
  const seen = new Map();
  for (const m of s.matchAll(/<([A-Za-z][\w:.-]*)[\s/>]/g)) {
    if (m[1] === '?xml') continue;
    if (!WORKLIST_ELEMENTS.has(m[1])) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  for (const [node, count] of seen) drift.push({ node, count, where: 'worklist' });

  const head = attrsOf(/<atcworklist:worklist(\s[^>]*)?>/.exec(s)?.[1]);
  const objectSets = [...s.matchAll(/<atcworklist:objectSet(\s[^>]*)?\/?>/g)].map((m) => {
    const a = attrsOf(m[1]);
    return { name: a['atcworklist:name'] ?? null, title: a['atcworklist:title'] ?? null, kind: a['atcworklist:kind'] ?? null };
  });

  const objects = [];
  const unknownAttrs = new Map();
  for (const om of s.matchAll(/<atcobject:object(\s[^>]*)?>([\s\S]*?)<\/atcobject:object>/g)) {
    const a = attrsOf(om[1]);
    const object = {
      name: a['adtcore:name'] ?? null,
      type: a['adtcore:type'] ?? null,
      package: a['adtcore:packageName'] ?? null,
      uri: a['adtcore:uri'] ?? null,
      author: a['atcobject:author'] ?? null,
      findings: [],
    };
    for (const fm of om[2].matchAll(/<atcfinding:finding(\s[^>]*)?>([\s\S]*?)<\/atcfinding:finding>/g)) {
      const f = attrsOf(fm[1]);
      for (const k of Object.keys(f)) if (!FINDING_ATTRS.has(k)) unknownAttrs.set(k, (unknownAttrs.get(k) ?? 0) + 1);
      const inner = fm[2];
      const doc = /<atom:link[^>]*rel="http:\/\/www\.sap\.com\/adt\/relations\/documentation"[^>]*href="([^"]*)"|<atom:link[^>]*href="([^"]*)"[^>]*rel="http:\/\/www\.sap\.com\/adt\/relations\/documentation"/.exec(inner);
      const qf = attrsOf(/<atcfinding:quickfixes(\s[^>]*)?\/?>/.exec(inner)?.[1]);
      const tags = {};
      for (const t of inner.matchAll(/<atcfinding:tag(\s[^>]*)?\/?>/g)) {
        const ta = attrsOf(t[1]);
        if (ta['atcfinding:name']) tags[ta['atcfinding:name']] = ta['atcfinding:value'] ?? null;
      }
      object.findings.push({
        priority: f['atcfinding:priority'] !== undefined ? Number(f['atcfinding:priority']) : null,
        checkId: f['atcfinding:checkId'] ?? null,
        checkTitle: f['atcfinding:checkTitle'] ?? null,
        checkClass: f['atcfinding:checkClass'] ?? null,
        messageId: f['atcfinding:messageId'] ?? null,
        messageTitle: f['atcfinding:messageTitle'] ?? null,
        location: locationOf(f['atcfinding:location']),
        exemption: f['atcfinding:exemptionKind'] || null,
        quickfixInfo: f['atcfinding:quickfixInfo'] ?? null,
        quickfixes: { manual: qf['atcfinding:manual'] === 'true', automatic: qf['atcfinding:automatic'] === 'true', pseudo: qf['atcfinding:pseudo'] === 'true' },
        documentation: doc ? (doc[1] ?? doc[2]) : null,
        tags,
        uri: f['adtcore:uri'] ?? null,
      });
    }
    objects.push(object);
  }
  for (const [attr, count] of unknownAttrs) drift.push({ node: `finding/@${attr}`, count, where: 'worklist' });

  const findings = objects.flatMap((o) => o.findings.map((f) => ({ object: o.name, objectType: o.type, ...f })));
  const byPriority = { 1: 0, 2: 0, 3: 0 };
  for (const f of findings) if (f.priority in byPriority) byPriority[f.priority]++;
  return {
    id: head['atcworklist:id'] ?? null,
    usedObjectSet: head['atcworklist:usedObjectSet'] ?? null,
    objectSetIsComplete: head['atcworklist:objectSetIsComplete'] === 'true',
    objectSets,
    objects,
    findings,
    byPriority,
    drift,
  };
}
