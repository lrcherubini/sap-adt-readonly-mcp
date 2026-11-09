// Virtual folders: the IDE's project tree, one POST that reads. MEASURED 2026-11-09
// (docs/adt-api-reference.md, "Virtual folders"; decision in docs/security.md):
//
//   POST /sap/bc/adt/repository/informationsystem/virtualfolders/contents
//     Content-Type application/vnd.sap.adt.repository.virtualfolders.request.v1+xml
//     Accept       application/vnd.sap.adt.repository.virtualfolders.result.v1+xml
//     body         <vfs:virtualFoldersRequest objectSearchPattern="*"> with a package preselected
//   -> 200, ~3 KB: objectCount, and one vfs:virtualFolder per sub-package with its description
//      (`text`), the objects below it (`counter`) and its URI; the package's own objects come back
//      as a folder named `..<PACKAGE>`. The counters add up to objectCount (measured).
//
// Why it exists: the tree resource adt_package_tree reads sends its descriptions MISALIGNED by one
// row (measured), so `describe: true` used to cost one search per sub-package. This answers every
// sub-package's description and object count in one call. It creates nothing, locks nothing.
//
// The third POST of this server. Like the other two it goes through the raw transport with a fixed
// path and a body built HERE from one validated package name: a caller cannot name another path,
// another body or another facet.

export class VirtualFoldersViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'VirtualFoldersViolation';
  }
}

export const VIRTUAL_FOLDERS_URL = '/sap/bc/adt/repository/informationsystem/virtualfolders/contents';
export const VIRTUAL_FOLDERS_REQUEST = 'application/vnd.sap.adt.repository.virtualfolders.request.v1+xml';
export const VIRTUAL_FOLDERS_RESULT = 'application/vnd.sap.adt.repository.virtualfolders.result.v1+xml';
export const DRIFT_CODE = 'SHAPE_DRIFT';

/** A package name: letters, digits, `_`, an optional namespace, `$` for local packages. */
const PACKAGE = /^(?:\/[A-Z0-9_]{1,10}\/)?[A-Z0-9_$]{1,30}$/;

/** The request body for one package, exactly the measured form. */
export function buildVirtualFoldersBody(pkg) {
  const name = String(pkg ?? '').trim().toUpperCase();
  if (!PACKAGE.test(name)) throw new VirtualFoldersViolation(`'${pkg}' is not a package name (${PACKAGE}).`);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<vfs:virtualFoldersRequest xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders" objectSearchPattern="*">' +
    `<vfs:preselection facet="package"><vfs:value>${name}</vfs:value></vfs:preselection>` +
    '<vfs:facetorder><vfs:facet>package</vfs:facet><vfs:facet>group</vfs:facet><vfs:facet>type</vfs:facet></vfs:facetorder>' +
    '</vfs:virtualFoldersRequest>'
  );
}

/** The one POST. Takes the RAW client (the guarded one has no verb, by design). */
export async function virtualFoldersPost(rawClient, pkg) {
  const body = buildVirtualFoldersBody(pkg);
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new VirtualFoldersViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  }
  let res;
  try {
    res = await http.request(VIRTUAL_FOLDERS_URL, {
      method: 'POST',
      headers: { Accept: VIRTUAL_FOLDERS_RESULT, 'Content-Type': VIRTUAL_FOLDERS_REQUEST },
      body,
    });
  } catch (e) {
    const status = [e?.err, e?.status, e?.response?.status].map(Number).find((x) => Number.isInteger(x) && x >= 100) ?? null;
    const err = new Error(`ADT answered ${status ?? 'no readable status'} for the virtual folders of ${pkg}: ${e?.localizedMessage || e?.message || e}`);
    err.status = status;
    throw err;
  }
  const text = String(res?.body ?? '');
  return { status: Number(res?.status ?? 0), body: text, bytes: Buffer.byteLength(text, 'utf8') };
}

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
const ELEMENTS = new Set(['vfs:virtualFoldersResult', 'vfs:preselectionInfo', 'vfs:virtualFolder', 'atom:link']);

/**
 * The reply: the total, the package's own objects, and each sub-package with its description and
 * the objects below it. A folder of another facet is kept in `others`, never folded into packages.
 */
export function parseVirtualFolders(xml) {
  const s = String(xml ?? '');
  const root = attrsOf((s.match(/<vfs:virtualFoldersResult\b([^>]*)>/) ?? [])[1]);
  const subPackages = [];
  const others = [];
  let directObjects = null;
  for (const [, tag] of s.matchAll(/<vfs:virtualFolder\b([^>]*)>/g)) {
    const a = attrsOf(tag);
    const counter = a.counter === undefined ? null : Number(a.counter);
    if (a.facet !== 'PACKAGE') {
      others.push({ facet: a.facet ?? null, name: a.name ?? null, counter });
    } else if (String(a.name ?? '').startsWith('..')) {
      directObjects = counter;
    } else {
      subPackages.push({ name: a.name ?? null, description: a.text ?? null, objectsBelow: counter, uri: a.uri ?? null });
    }
  }
  const seen = new Map();
  for (const m of s.matchAll(/<([A-Za-z][\w]*:[\w]+)\b/g)) {
    if (!ELEMENTS.has(m[1])) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return {
    objectCount: root.objectCount === undefined ? null : Number(root.objectCount),
    directObjects,
    subPackages,
    others,
    drift: [...seen].map(([node, count]) => ({ node, count, where: 'virtualFolders' })),
  };
}
