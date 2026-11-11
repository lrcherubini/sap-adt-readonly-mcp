// The repository reads that are POSTs: what abap-adt-api sent for nodeContents, findObjectPath,
// usageReferences and usageReferenceSnippets, now sent from here (docs/security.md, "Removing
// abap-adt-api"). MEASURED 2026-11-10 (library-removal probe; docs/adt-api-reference.md, "The
// logon on the wire, and the reads behind the guard's members"): each answers 200 and reads.
//
// Like every POST of this server: a fixed path, a query built HERE from validated values, a body
// that is either absent or built here, and a brand that proves it. Nothing a caller types becomes
// a path, a parameter name or markup.

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
