// The syntax check run: the check the editor runs after every save, on what the system stores.
// MEASURED 2026-11-10 on one class and four programs (docs/adt-api-reference.md, "Old versions,
// the inactive version and the syntax check run"; decision in docs/security.md):
//
//   POST /sap/bc/adt/checkruns?reporters=abapCheckRun
//     Content-Type application/vnd.sap.adt.checkobjects+xml
//     Accept       application/vnd.sap.adt.checkmessages+xml
//     body         one chkrun:checkObject: the object URI and the version, NO source artifact
//   -> 200, 0.3-0.5 KB: one chkrun:checkReport (status, statusText in the logon language) and,
//      when the source has findings, chkrun:checkMessage with uri#start=<line>,<col>, type, text.
//   No Location, no run id, no follow-up resource; the session stays stateless.
//
// The fourth POST of this server. Like the other three it goes through the raw transport with a
// fixed path and a body built HERE from one validated object URI and a version from a closed
// list: no source text, no other path, no other reporter can be sent.
//
// ⚠️ A check of `inactive` on an object with no inactive version checks an EMPTY source and
// reports an error that is not in the program (measured: "The REPORT/PROGRAM statement is
// missing" at line 1). The tool asks the object document first; this module only builds and
// sends what it is given.

export class SyntaxCheckViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'SyntaxCheckViolation';
  }
}

export const CHECK_RUN_URL = '/sap/bc/adt/checkruns?reporters=abapCheckRun';
export const CHECK_OBJECTS = 'application/vnd.sap.adt.checkobjects+xml';
export const CHECK_MESSAGES = 'application/vnd.sap.adt.checkmessages+xml';
export const CHECK_VERSIONS = Object.freeze(['active', 'inactive']);
export const DRIFT_CODE = 'SHAPE_DRIFT';

/** A class or a program: the two families measured. Lower case, as the server hands them out. */
const OBJECT_URI = /^\/sap\/bc\/adt\/(oo\/classes|programs\/programs)\/[a-z0-9_%.-]{1,120}$/;
const BUILT = Symbol('syntax-check body');

/** The request body for one object and one version, exactly the measured form. */
export function buildCheckBody(uri, version) {
  const u = String(uri ?? '').trim();
  if (!OBJECT_URI.test(u)) {
    throw new SyntaxCheckViolation(`'${uri}' is not the URI of a class or a program (${OBJECT_URI}).`);
  }
  if (!CHECK_VERSIONS.includes(version)) {
    throw new SyntaxCheckViolation(`version is ${CHECK_VERSIONS.join(' or ')}; got '${version}'.`);
  }
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" ' +
    'xmlns:adtcore="http://www.sap.com/adt/core">' +
    `<chkrun:checkObject adtcore:uri="${u}" chkrun:version="${version}"/>` +
    '</chkrun:checkObjectList>';
  return Object.freeze({ [BUILT]: true, uri: u, version, xml });
}

/** The one POST. Takes the RAW client (the guarded one has no verb, by design). */
export async function checkRunPost(rawClient, built) {
  if (!built || built[BUILT] !== true) throw new SyntaxCheckViolation('checkRunPost needs a body built by buildCheckBody.');
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new SyntaxCheckViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  }
  let res;
  try {
    res = await http.request(CHECK_RUN_URL, {
      method: 'POST',
      headers: { Accept: CHECK_MESSAGES, 'Content-Type': CHECK_OBJECTS },
      body: built.xml,
    });
  } catch (e) {
    const status = e?.err ?? e?.status ?? e?.response?.status ?? null;
    const err = new Error(`ADT answered ${status ?? 'no readable status'} for the syntax check: ${e?.message ?? e}`);
    err.status = status;
    err.url = CHECK_RUN_URL;
    throw err;
  }
  const body = String(res?.body ?? '');
  return { status: Number(res?.status ?? 0), body, bytes: Buffer.byteLength(body, 'utf8') };
}

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
const attrsOf = (raw) => {
  const out = {};
  for (const m of String(raw ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

const DECLARED = new Map([
  ['chkrun:checkRunReports', new Set(['xmlns:chkrun'])],
  ['chkrun:checkReport', new Set(['chkrun:reporter', 'chkrun:triggeringUri', 'chkrun:status', 'chkrun:statusText'])],
  ['chkrun:checkMessageList', new Set()],
  ['chkrun:checkMessage', new Set(['chkrun:uri', 'chkrun:type', 'chkrun:shortText'])],
  // Inside a message that has a quickfix (MEASURED 2026-11-10, an unknown field):
  // <atom:link href="art.syntax:GTU" rel="http://www.sap.com/adt/categories/quickfixes"/>.
  // Reported as the message's `quickfix`, never followed: applying a quickfix is a write.
  ['atom:link', new Set(['href', 'rel'])],
]);

const QUICKFIX_REL = 'http://www.sap.com/adt/categories/quickfixes';

/**
 * The reports of one check run. Each message keeps its URI, the include it points at, the line
 * and column of `#start=`, its type and its text. Anything undeclared is reported in `drift`,
 * never dropped in silence. `statusText` is kept as it came (it is in the logon language) and
 * never interpreted: `status` is what the answer reads.
 */
export function parseCheckRun(xml) {
  const reports = [];
  const drift = [];
  let current = null;
  let message = null;
  for (const m of String(xml ?? '').matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, rawAttrs] = m;
    if (closing && tag === 'chkrun:checkMessage') message = null;
    if (closing || tag.startsWith('?')) continue;
    if (tag === 'xml') continue;
    const declared = DECLARED.get(tag);
    if (!declared) {
      drift.push({ node: tag, attribute: null });
      continue;
    }
    const attrs = attrsOf(rawAttrs);
    for (const a of Object.keys(attrs)) {
      if (!declared.has(a) && !a.startsWith('xmlns')) drift.push({ node: tag, attribute: a });
    }
    if (tag === 'chkrun:checkReport') {
      current = {
        reporter: attrs['chkrun:reporter'] ?? null,
        triggeringUri: attrs['chkrun:triggeringUri'] ?? null,
        status: attrs['chkrun:status'] ?? null,
        statusText: attrs['chkrun:statusText'] ?? null,
        messages: [],
      };
      reports.push(current);
    } else if (tag === 'chkrun:checkMessage') {
      const uri = attrs['chkrun:uri'] ?? '';
      const at = uri.match(/^([^#]*)#start=(\d+),(\d+)/);
      message = {
        type: attrs['chkrun:type'] ?? null,
        text: attrs['chkrun:shortText'] ?? null,
        uri: at ? at[1] : uri || null,
        line: at ? Number(at[2]) : null,
        column: at ? Number(at[3]) : null,
      };
      if (current) current.messages.push(message);
      else drift.push({ node: 'chkrun:checkMessage', attribute: null, where: 'outside a checkReport' });
      if (m[4] === '/') message = null;
    } else if (tag === 'atom:link') {
      if (message && attrs.rel === QUICKFIX_REL) message.quickfix = attrs.href ?? true;
      else drift.push({ node: 'atom:link', attribute: 'rel', where: message ? attrs.rel ?? null : 'outside a message' });
    }
  }
  return { reports, drift };
}

/** Messages by type, e.g. {E: 1, W: 2}. */
export function countByType(messages) {
  const out = {};
  for (const m of messages) out[m.type ?? '?'] = (out[m.type ?? '?'] ?? 0) + 1;
  return out;
}
