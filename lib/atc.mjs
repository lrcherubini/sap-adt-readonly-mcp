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
// MEASURED 2026-11-09, nine runs on a second system: the server IGNORES maximumVerdicts (5
//   and 100 gave the same 49 findings), so the cap on what is listed is the client's;
//   `noExemption` is a new finding attribute; `checkClass` and `tags` may be absent.

/**
 * Variants a run may name -- a closed list in two layers, like the customizing tables:
 *   - data/defaults/atc-variants.json: SAP's own `DEFAULT`, the same everywhere;
 *   - the installation's variants (a development-practice run, say), added with
 *     `npm run config -- atc add` and installed at start by `installAtcVariants`;
 *   - the system's own check variant, read from `/sap/bc/adt/atc/customizing` at start and
 *     admitted by `installSystemVariant` -- never typed into the store.
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
  explicitDefault = defaultVariant !== undefined && defaultVariant !== null && String(defaultVariant).trim() !== '';
  const d = String(explicitDefault ? defaultVariant : STANDARD_ATC.defaultVariant).trim().toUpperCase();
  if (!ATC_VARIANTS.has(d)) {
    throw new AtcViolation(`the default variant ${d} is not a listed variant (${[...ATC_VARIANTS.keys()].join(', ')}).`);
  }
  DEFAULT_VARIANT = d;
  return ATC_VARIANTS;
}

// Whether the store named the default (`atc.defaultVariant`). If it did not, the system's own
// check variant becomes the default when it is read.
let explicitDefault = false;

export const SYSTEM_VARIANT_WHY = 'the system check variant (systemCheckVariant of /sap/bc/adt/atc/customizing, read at start)';

/**
 * Admit the system's own check variant, read from `atc/customizing` at start, so that nobody has
 * to type it into the store or keep its description current. It joins the closed set under the
 * same name rule as any other entry. It becomes the default unless the store named one. An empty
 * name (the system has none) changes nothing. Returns `{ installed, defaultVariant, explicitDefault }`.
 */
export function installSystemVariant(name) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!n) return { installed: null, defaultVariant: DEFAULT_VARIANT, explicitDefault };
  if (!VARIANT_NAME.test(n)) throw new AtcViolation(`systemCheckVariant '${name}' is not a check variant name (A-Z 0-9 _ /, 1-30 chars).`);
  const listed = ATC_VARIANTS.get(n);
  if (n !== STANDARD_ATC.defaultVariant) ATC_VARIANTS.set(n, listed ? `${listed} -- also ${SYSTEM_VARIANT_WHY}` : SYSTEM_VARIANT_WHY);
  if (!explicitDefault) DEFAULT_VARIANT = n;
  return { installed: n, defaultVariant: DEFAULT_VARIANT, explicitDefault };
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
  return stampRunBody(u, maxVerdicts);
}

/**
 * A package name the run body may carry: the customer alphabet, no namespace and no `$`.
 * MEASURED 2026-11-10 from the IDE's log: a package is checked as ONE object reference, the
 * virtual-folders URI with `selection=package%3a<PKG>` (`docs/adt-api-reference.md`, "Backlog
 * reads"). A namespaced or local (`$`) package was not measured, so it is refused.
 */
export const PACKAGE_NAME = /^[A-Z][A-Z0-9_]{0,29}$/;
const PACKAGE_SET_URI = /^\/sap\/bc\/adt\/repository\/informationsystem\/virtualfolders\?selection=package%3a[A-Z][A-Z0-9_]{0,29}$/;

/** The run body for every object of one package, as the IDE sends it. */
export function buildPackageRunBody({ packageName, maxVerdicts } = {}) {
  const p = String(packageName ?? '').trim().toUpperCase();
  if (!PACKAGE_NAME.test(p)) {
    throw new AtcViolation(`'${packageName}' is not a package the ATC run is measured on (${PACKAGE_NAME}; namespaces and $ packages are not).`);
  }
  return stampRunBody(`/sap/bc/adt/repository/informationsystem/virtualfolders?selection=package%3a${p}`, maxVerdicts);
}

function stampRunBody(u, maxVerdicts) {
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
    if (!built || built[BUILT] !== true || typeof built.xml !== 'string' || !(OBJECT_URI.test(built.uri ?? '') || PACKAGE_SET_URI.test(built.uri ?? ''))) {
      throw new AtcViolation('atcPost run needs a body built by buildRunBody or buildPackageRunBody.');
    }
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

/**
 * The customizing body (measured 2026-09-12, 2026-11-09): `<properties><property name value/>`.
 * Returns every property and the system check variant, upper-cased, or null when there is none.
 */
export function parseCustomizing(xml) {
  const properties = {};
  for (const m of String(xml ?? '').matchAll(/<property\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    if (a.name !== undefined) properties[a.name] = a.value ?? null;
  }
  const v = String(properties.systemCheckVariant ?? '').trim().toUpperCase();
  return { properties, systemCheckVariant: v || null };
}

/** The reply of POST runs: worklist id, timestamp, infos (FINDING_STATS "p1,p2,p3"). */
export function parseRunReply(xml) {
  const s = String(xml ?? '');
  const id = /<atcworklist:worklistId>([^<]*)</.exec(s)?.[1] ?? null;
  const timestamp = /<atcworklist:worklistTimestamp>([^<]*)</.exec(s)?.[1] ?? null;
  const infos = [...s.matchAll(/<atcinfo:info[^>]*>\s*<atcinfo:type>([^<]*)<\/atcinfo:type>\s*<atcinfo:description>([^<]*)<\/atcinfo:description>/g)].map((m) => ({ type: m[1], description: unescapeXml(m[2]) }));
  const stats = infos.find((i) => i.type === 'FINDING_STATS');
  // Three integers, or the stats are not read: a value that is not a number never becomes 0.
  const parts = (stats?.description ?? '').split(',').map((n) => n.trim());
  const statsRead = Boolean(stats) && parts.length === 3 && parts.every((n) => /^\d+$/.test(n));
  return {
    worklistId: id,
    timestamp,
    infos,
    byPriority: statsRead ? { 1: Number(parts[0]), 2: Number(parts[1]), 3: Number(parts[2]) } : null,
    statsState: !stats ? 'absent' : statsRead ? 'read' : 'unparsed',
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
  // MEASURED 2026-11-09: "true" on every finding without an exemption; its meaning on an
  // exempted finding is not measured, so it is passed through as read, never interpreted.
  'atcfinding:noExemption',
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
  // An object without findings may come self-closed: its tag ends the object, and it never
  // swallows the next object's findings.
  for (const om of s.matchAll(/<atcobject:object(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/atcobject:object>)/g)) {
    const a = attrsOf(om[1]);
    const object = {
      name: a['adtcore:name'] ?? null,
      type: a['adtcore:type'] ?? null,
      package: a['adtcore:packageName'] ?? null,
      uri: a['adtcore:uri'] ?? null,
      author: a['atcobject:author'] ?? null,
      findings: [],
    };
    for (const fm of String(om[2] ?? '').matchAll(/<atcfinding:finding(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/atcfinding:finding>)/g)) {
      const f = attrsOf(fm[1]);
      for (const k of Object.keys(f)) if (!FINDING_ATTRS.has(k)) unknownAttrs.set(k, (unknownAttrs.get(k) ?? 0) + 1);
      const inner = fm[2] ?? '';
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
        noExemption: f['atcfinding:noExemption'] === undefined ? null : f['atcfinding:noExemption'] === 'true',
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

// --- the check variant ---------------------------------------------------------------------

/** Every element of the 18 variants measured 2026-11-09; anything else is drift. */
const CHECK_VARIANT_ELEMENTS = new Set([
  'chkv:checkvariant', 'chkv:content', 'chkv:name', 'chkv:referencedVariant', 'chkv:remoteEnabled',
  'chkvcheck:check', 'chkvcheck:parameterValueXml', 'chko:checkObject', 'chko:content', 'chko:category',
  'chko:implementingClass', 'chko:remoteEnabled', 'chkoParameter:parameters', 'chkoParameter:parameter',
  'chkoParameter:parameterName', 'chkoParameter:parameterTechnicalId', 'chkoParameter:parameterDescription',
  'chkoParameter:parameterModifiable', 'abapsource:syntaxConfiguration', 'abapsource:language',
  'abapsource:version', 'adtcore:packageRef', 'atom:link',
]);

/**
 * A check variant created in the ADT (CHKV): its checks, each with the parameter values the
 * variant sets (`parameterValueXml` is JSON, measured on every check of 18 variants). A text that
 * does not parse is kept raw with a note, never dropped. `referencedVariant` is returned as read:
 * none of the 18 named one, so what a reference adds to the check list is not measured.
 */
export function parseCheckVariant(xml) {
  const s = String(xml ?? '');
  const text = (el) => {
    const m = s.match(new RegExp(`<${el}>([^<]*)</${el}>`));
    return m ? unescapeXml(m[1]) : null;
  };
  const checks = [];
  for (const [, inner] of s.matchAll(/<chkvcheck:check\b[^>]*>([\s\S]*?)<\/chkvcheck:check>/g)) {
    const check = attrsOf((inner.match(/<chko:checkObject\b([^>]*)>/) ?? [])[1])['adtcore:name'] ?? null;
    const raw = unescapeXml((inner.match(/<chkvcheck:parameterValueXml>([\s\S]*?)<\/chkvcheck:parameterValueXml>/) ?? [])[1] ?? '');
    let parameters = [];
    let parametersNote;
    if (raw.trim()) {
      try {
        parameters = JSON.parse(raw).parameters ?? [];
      } catch (e) {
        parametersNote = `parameters not parsed (${e.message}); raw text kept`;
      }
    }
    checks.push({ check, parameters, ...(parametersNote ? { parametersNote, parametersRaw: raw } : {}) });
  }
  const seen = new Map();
  for (const m of s.matchAll(/<([A-Za-z][\w]*:[\w]+)\b/g)) {
    if (!CHECK_VARIANT_ELEMENTS.has(m[1])) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return {
    name: text('chkv:name'),
    remoteEnabled: text('chkv:remoteEnabled') === 'true',
    referencedVariant: text('chkv:referencedVariant') || null,
    checks,
    drift: [...seen].map(([node, count]) => ({ node, count, where: 'checkvariant' })),
  };
}

/**
 * Said when the ADT has no representation of a variant the ATC just ran: SAP documents that a
 * check variant created in transaction SCI "cannot be displayed or edited in ADT" (ADT user
 * guide, "Editing ATC Check Variants"); measured as a 404 on DEFAULT and a system variant.
 */
export const SCI_VARIANT_NOTE =
  'a check variant created in transaction SCI: the ADT does not publish its check list (SAP ' +
  'documentation; the resource answers 404). The run above used it normally. Its checks are in ' +
  'transaction SCI.';
