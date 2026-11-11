// The repository reads that are POSTs: what abap-adt-api sent for nodeContents, findObjectPath,
// usageReferences and usageReferenceSnippets, now sent from here (docs/security.md, "Removing
// abap-adt-api"). MEASURED 2026-11-10 (library-removal probe; docs/adt-api-reference.md, "The
// logon on the wire, and the reads behind the guard's members"): each answers 200 and reads.
//
// Like every POST of this server: a fixed path, a query built HERE from validated values, a body
// that is either absent or built here, and a brand that proves it. Nothing a caller types becomes
// a path, a parameter name or markup.

import { XmlError } from './xml.mjs';

export class RepositoryPostViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'RepositoryPostViolation';
  }
}

const BUILT = Symbol('repository POST');
const brand = (request) => Object.freeze({ [BUILT]: true, ...request });

/** A package name: the customer alphabet, a namespace, `$` for local packages. */
const PACKAGE = /^(?:\/[A-Z0-9_]{1,10}\/)?[A-Z0-9_$]{1,30}$/;

/**
 * The package tree request (nodeContents): one package's direct contents, with short
 * descriptions, no body -- the parameters in the library's order.
 */
export function nodeStructureRequest(parentType, parentName) {
  if (parentType !== 'DEVC/K') throw new RepositoryPostViolation(`only a package (DEVC/K) is listed; got '${parentType}'.`);
  const name = String(parentName ?? '').trim().toUpperCase();
  if (!PACKAGE.test(name)) throw new RepositoryPostViolation(`'${parentName}' is not a package name (${PACKAGE}).`);
  return brand({
    what: 'nodestructure',
    url: `/sap/bc/adt/repository/nodestructure?parent_type=${encodeURIComponent('DEVC/K')}&withShortDescriptions=true&parent_name=${encodeURIComponent(name)}`,
    headers: { Accept: '*/*' },
  });
}

/** An ADT object URI and nothing else: no query, no fragment, no dot-segments. */
const OBJECT_URI = /^(?!.*\.\.)(?!.*\/\/)\/sap\/bc\/adt\/[a-z0-9_%.\/-]{3,250}$/i;

/** The node path request (findObjectPath): where an object sits, root first. No body. */
export function nodePathRequest(objectUrl) {
  const uri = String(objectUrl ?? '').trim();
  if (!OBJECT_URI.test(uri)) throw new RepositoryPostViolation(`'${objectUrl}' is not an ADT object URI.`);
  return brand({ what: 'nodepath', url: `/sap/bc/adt/repository/nodepath?uri=${encodeURIComponent(uri)}`, headers: { Accept: '*/*' } });
}

/** The steps of a node path reply, root first, in the library's shape: the attributes of each. */
export function parseNodePath(root) {
  // Another document is not "no path": it is a reply this parser does not know.
  if (root?.name !== 'projectexplorer:nodepath') throw new XmlError(`the node path answered <${root?.name}>, not projectexplorer:nodepath`);
  const refs = root.children.find((c) => c.name === 'projectexplorer:objectLinkReferences');
  return (refs?.children ?? [])
    .filter((c) => c.name === 'objectLinkReference')
    .map((c) => Object.fromEntries(Object.entries(c.attrs).filter(([k]) => k !== 'xmlns' && !k.startsWith('xmlns:'))));
}

const XML_TEXT = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const USAGE_HEADERS = Object.freeze({ 'Content-Type': 'application/*', Accept: 'application/*' });

/** The where-used request (usageReferences): one object URI, the library's constant body. */
export function usageReferencesRequest(objectUrl) {
  const uri = String(objectUrl ?? '').trim();
  if (!OBJECT_URI.test(uri)) throw new RepositoryPostViolation(`'${objectUrl}' is not an ADT object URI.`);
  return brand({
    what: 'usageReferences',
    url: `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(uri)}`,
    headers: USAGE_HEADERS,
    body:
      '<?xml version="1.0" encoding="ASCII"?>\n  <usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">\n' +
      '    <usagereferences:affectedObjects/>\n  </usagereferences:usageReferenceRequest>',
  });
}

/**
 * The snippets request (usageReferenceSnippets): the object identifiers a where-used reply
 * handed out, each escaped into the library's body. Nothing else travels; at most 500 of them.
 */
export function usageSnippetsRequest(references) {
  const ids = (Array.isArray(references) ? references : []).map((r) => r?.objectIdentifier).filter(Boolean);
  if (!ids.length) throw new RepositoryPostViolation('usageReferenceSnippets needs the object identifiers of a where-used reply.');
  if (ids.length > 500 || ids.some((id) => typeof id !== 'string' || id.length > 1000)) {
    throw new RepositoryPostViolation('the object identifiers are not the ones a where-used reply hands out.');
  }
  const nodes = ids.map((id) => `<usagereferences:objectIdentifier optional="false">${XML_TEXT(id)}</usagereferences:objectIdentifier>`).join('');
  return brand({
    what: 'usageSnippets',
    url: '/sap/bc/adt/repository/informationsystem/usageSnippets',
    headers: USAGE_HEADERS,
    body:
      '<?xml version="1.0" encoding="UTF-8"?>\n  <usagereferences:usageSnippetRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">\n  <usagereferences:objectIdentifiers>\n  ' +
      nodes +
      '\n  </usagereferences:objectIdentifiers>\n  <usagereferences:affectedObjects/>\n</usagereferences:usageSnippetRequest>',
  });
}

const toInt = (x) => (x && /^\s*[+-]?\d*\s*$/.test(x) ? Number.parseInt(x, 10) : 0);

/** A reference URI split as the library split it: uri, context, start/end, type and name. */
export function splitReferenceUri(url, matches) {
  const m = /([^#?]*)(?:\?context=([^#]*))?(?:#(.*))/.exec(String(url ?? ''));
  const [uri, context, hash] = m ? m.slice(1) : [];
  const out = { uri, context };
  if (hash) {
    for (const p of hash.split(';')) {
      const [name, value] = p.split('=');
      if (name === 'start' || name === 'end') {
        const [line, column] = String(value).split(',');
        if (line) out[name] = { line: toInt(line), column: toInt(column) };
      } else if (name === 'type' || name === 'name') out[name] = decodeURIComponent(value);
    }
  }
  const mm = /(\d+)-(\d+)/.exec(String(matches ?? ''));
  const [start, end] = mm ? mm.slice(1) : [];
  if (!out.start) out.start = { line: 0, column: toInt(start) };
  if (!out.start.column) out.start.column = toInt(start);
  if (!out.end) out.end = { line: out.start.line, column: toInt(end) || out.start.column };
  return out;
}

const attrsOf = (el) => {
  const out = {};
  for (const [k, v] of Object.entries(el?.attrs ?? {})) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
    out[k] = v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
};
const child = (el, name) => el?.children?.find((c) => c.name === name);
const kids = (el, name) => (el?.children ?? []).filter((c) => c.name === name);

/** The where-used rows, in the library's shape (the type taken from the URI when absent). */
export function parseUsageReferences(root) {
  if (root?.name !== 'usageReferences:usageReferenceResult') throw new XmlError(`the where-used answered <${root?.name}>, not usageReferences:usageReferenceResult`);
  return kids(child(root, 'usageReferences:referencedObjects'), 'usageReferences:referencedObject').map((r) => {
    const adtObject = child(r, 'usageReferences:adtObject');
    const reference = {
      ...attrsOf(r),
      ...attrsOf(adtObject),
      packageRef: attrsOf(child(adtObject, 'adtcore:packageRef')),
      objectIdentifier: child(r, 'objectIdentifier')?.text || '',
    };
    if (!reference['adtcore:type']) reference['adtcore:type'] = splitReferenceUri(reference.uri, '').type;
    return reference;
  });
}

/** The snippets reply, in the library's shape: per object identifier, its snippets. */
export function parseUsageSnippets(root) {
  if (root?.name !== 'usageReferences:usageSnippetResult') throw new XmlError(`the snippets answered <${root?.name}>, not usageReferences:usageSnippetResult`);
  return kids(child(root, 'usageReferences:codeSnippetObjects'), 'usageReferences:codeSnippetObject').map((o) => ({
    objectIdentifier: child(o, 'objectIdentifier')?.text,
    snippets: kids(child(o, 'usageReferences:codeSnippets'), 'usageReferences:codeSnippet').map((s) => ({
      uri: splitReferenceUri(s.attrs.uri, s.attrs.matches),
      matches: s.attrs.matches,
      content: child(s, 'content')?.text,
      description: child(s, 'description')?.text,
    })),
  }));
}

/** The one POST. Takes the RAW client (the guarded one has no verb, by design). */
export async function repositoryPost(rawClient, built) {
  if (!built || built[BUILT] !== true) throw new RepositoryPostViolation('repositoryPost needs a request built in lib/repository-posts.mjs.');
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new RepositoryPostViolation('the ADT session exposes no HTTP transport (no raw client in this session).');
  }
  return http.request(built.url, { method: 'POST', headers: { ...built.headers }, ...(built.body !== undefined ? { body: built.body } : {}) });
}

const textOf = (el, name) => el.children.find((c) => c.name === name)?.text;

/**
 * The tree reply (`asx:abap` > DATA > TREE_CONTENT > SEU_ADT_REPOSITORY_OBJ_NODE rows) in the
 * library's shape: `{nodes, categories, objectTypes}`, every field of a row as text. Unlike the
 * library, a value of digits stays text (a name `0001` is not `1`).
 */
export function parseNodeStructure(root) {
  if (root?.name !== 'asx:abap') throw new XmlError(`the package tree answered <${root?.name}>, not asx:abap`);
  const data = root?.children?.find((c) => c.name === 'asx:values')?.children?.find((c) => c.name === 'DATA');
  if (!data) return { categories: [], nodes: [], objectTypes: [] };
  const rows = (wrapper, row) =>
    (data.children.find((c) => c.name === wrapper)?.children ?? [])
      .filter((c) => c.name === row)
      .map((r) => Object.fromEntries(r.children.map((f) => [f.name, f.text])));
  const nodes = rows('TREE_CONTENT', 'SEU_ADT_REPOSITORY_OBJ_NODE').map((n) => ({ ...n, OBJECT_NAME: n.OBJECT_NAME ?? '', TECH_NAME: n.TECH_NAME ?? '', DESCRIPTION: n.DESCRIPTION || '' }));
  const categories = rows('CATEGORIES', 'SEU_ADT_OBJECT_CATEGORY_INFO');
  const objectTypes = rows('OBJECT_TYPES', 'SEU_ADT_OBJECT_TYPE_INFO').map((o) =>
    o.OBJECT_TYPE_LABEL === '<no type text>' && o.OBJECT_TYPE === 'FUGR/I' ? { ...o, OBJECT_TYPE_LABEL: 'Includes' } : o
  );
  return { categories, nodes, objectTypes };
}
