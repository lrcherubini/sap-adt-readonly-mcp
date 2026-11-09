// A Fiori app as the system serves it, checked against the service it consumes TODAY.
//
// The question: "does this deployed app still address names its service publishes?" -- an entity
// set a controller reads, a function import it calls and the parameters it passes, a property in
// a $filter, an annotation Target, an entity set a Fiori elements page is built on. A rename on
// the ABAP side re-activates cleanly and the app breaks at runtime, in the browser, with no
// error anywhere on the system.
//
// TWO SOURCES, and which one is the reference is the whole design:
//
//   the app       read from the UI5 repository (lib/adt-get.mjs, routes ui5Folder / ui5File):
//                 the files someone WROTE -- controllers, utils, views, fragments, the local
//                 annotation file, the pages of the manifest.
//   the service   its LIVE $metadata (route odataMetadata): what the system publishes now.
//
// ⚠️ The $metadata an app keeps in its own repository (`localService/`) is NOT a source. It is a
// copy the generator wrote when the app was scaffolded; nothing refreshes it and the app never
// loads it at runtime (the measured app does not even deploy one). Checking an app against it
// would compare the app with its own past. It is skipped by folder name and by content.
//
// V2 and V4 alike: the $metadata route is chosen per data source (lib/adt-get.mjs, odataMetadata
// and odataMetadataV4), and the parser reads both CSDL dialects into one shape.
//
// WHAT IS CHECKED, and what is deliberately not -- every heuristic here errs toward NOT flagging:
//   checked     V4 `bindList("/Set")`, `bindContext("/Set(..)/<ns>.Action(...)")`,
//               `bindContext("<ns>.Action(...)", ctx)`;
//               V2 `callFunction("/X", { urlParameters: { P } })`; `.read/.create/.update/.remove
//               ("/Set")` and the properties named in that call's $filter / $select / $orderby
//               and the navigations in its $expand; `bindElement/bindObject/bindRows/bindItems
//               ("/Set")`; absolute bindings of an OData model in a view or fragment
//               (`{/Set}`, `{model>/Set}`); every `Annotations Target` of a local annotation
//               file and the first segment of each Path inside it; every `entitySet`/`EntitySet`
//               a manifest names outside `sap.app`.
//   not checked relative bindings (`{Prop}`: their context is decided at runtime), a payload
//               built in a variable, a Filter object, a path past its first navigation, a JSON
//               model (`{durationProcesso>/Loading}` names no service).
//   A reference holds when ANY OData service of the app publishes it: an app with two models
//   is never flagged for addressing the second one.

import { serviceOfNamespace } from './edmx.mjs';
import { V4_SERVICE_PATH } from './adt-get.mjs';

const attrs = (s) => Object.fromEntries([...String(s ?? '').matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
const lineAt = (text, index) => String(text).slice(0, index).split('\n').length;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One folder of the filestore (route ui5Folder): its entries, as paths inside the repository.
 * Measured shape: `<atom:entry>` with `<atom:category term="file|folder"/>`, the path in
 * `<atom:id>` with `%2f` for each slash, and `afr:etag` on files only.
 * @returns {{path:string, kind:'file'|'folder', etag:string|null}[]}
 */
export function parseFolderFeed(xml) {
  return [...String(xml ?? '').matchAll(/<atom:entry\b[\s\S]*?<\/atom:entry>/g)]
    .map(([e]) => {
      const id = /<atom:id>([^<]*)<\/atom:id>/.exec(e)?.[1] ?? '';
      // Byte by byte rather than decodeURIComponent, which throws on a stray `%`: a malformed id
      // stays readable (and then fails the route's own alphabet) instead of being dropped.
      const path = id.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return {
        path,
        kind: /<atom:category\s+term="([^"]+)"/.exec(e)?.[1] === 'folder' ? 'folder' : 'file',
        etag: /afr:etag="([^"]+)"/.exec(e)?.[1] ?? null,
      };
    })
    .filter((e) => e.path);
}

/**
 * The OData data sources of a manifest, each with the route that reads its $metadata.
 *
 *   V2  `/sap/opu/odata/sap/<SERVICE>/`                          -> route odataMetadata
 *   V4  `/sap/opu/odata4/sap/<binding>/srvd[_a2x]/sap/<srvd>/<nnnn>/` -> route odataMetadataV4
 *
 * Anything else (`;v=`, `;o=`, a namespace other than `sap`, a destination) comes back with
 * `route: null` and the reason -- the caller files it as a gap, never as "the app consumes nothing".
 * @returns {{name:string, uri:string, version:string, route:string|null, key:string|null, service:string|null, unmeasured?:string}[]}
 */
export function dataSourcesOf(manifest) {
  const out = [];
  for (const [name, d] of Object.entries(manifest?.['sap.app']?.dataSources ?? {})) {
    if ((d?.type ?? 'OData') !== 'OData') continue; // annotation sources: local files are read as files
    const uri = String(d?.uri ?? '');
    const v2 = /^\/sap\/opu\/odata\/sap\/([A-Za-z][A-Za-z0-9_]{0,39})\/?$/.exec(uri);
    const v4 = /^\/sap\/opu\/odata4\/sap\/(.+?)\/?$/.exec(uri);
    const v4path = v4 ? v4[1].toLowerCase() : null;
    const version = String(d?.settings?.odataVersion ?? (v4 ? '4.0' : '2.0'));
    if (v2 && version.startsWith('2')) {
      out.push({ name, uri, version, route: 'odataMetadata', key: v2[1].toUpperCase(), service: v2[1].toUpperCase() });
    } else if (v4path && V4_SERVICE_PATH.test(v4path) && version.startsWith('4')) {
      const [, binding, , srvd] = V4_SERVICE_PATH.exec(v4path);
      out.push({ name, uri, version, route: 'odataMetadataV4', key: v4path, service: binding.toUpperCase(), srvd: srvd.toUpperCase() });
    } else {
      out.push({
        name, uri, version, route: null, key: null, service: null,
        unmeasured: `OData ${version} at '${uri}': the forms read are /sap/opu/odata/sap/<SERVICE>/ (V2) and /sap/opu/odata4/sap/<binding>/{srvd,srvd_a2x}/sap/<srvd>/<nnnn>/ (V4)`,
      });
    }
  }
  return out;
}

/** Model name -> data source name, for the models backed by an OData data source ('' is the default model). */
export function odataModelsOf(manifest) {
  const sources = new Set(dataSourcesOf(manifest).map((d) => d.name));
  // A data source can be reached through a model whose name the manifest does not list (an app
  // with no models block uses its mainService as the default model).
  if (!Object.keys(manifest?.['sap.ui5']?.models ?? {}).length && sources.size) return new Map([['', [...sources][0]]]);
  const out = new Map();
  for (const [model, m] of Object.entries(manifest?.['sap.ui5']?.models ?? {})) {
    if (m?.dataSource && sources.has(m.dataSource)) out.set(model, m.dataSource);
  }
  return out;
}

/**
 * The live $metadata of one service, V2 or V4, as much of it as a reference can address.
 * The FIRST Schema is the service's own (the rest are vocabularies), as in lib/edmx.mjs.
 *
 * Operations are one map for both versions: a V2 `FunctionImport` (its parameters), a V4
 * `Action` / `Function` (its parameters minus the binding one, `IsBound="true"` -> the first) and a
 * V4 `ActionImport` / `FunctionImport` (the parameters of the operation it points at).
 */
export function parseServiceMetadata(xml) {
  const src = String(xml ?? '');
  const schema = /<Schema\b([^>]*)>/.exec(src);
  const namespace = schema ? attrs(schema[1]).Namespace ?? null : null;
  const alias = schema ? attrs(schema[1]).Alias ?? null : null;
  const version = /<edmx:Edmx\b[^>]*\sVersion="([^"]+)"/.exec(src)?.[1] ?? null;
  const entityTypes = new Map();
  for (const m of src.matchAll(/<EntityType\b([^>]*)>([\s\S]*?)<\/EntityType>/g)) {
    const name = attrs(m[1]).Name;
    if (!name) continue;
    entityTypes.set(name, {
      properties: new Set([...m[2].matchAll(/<Property\b([^>]*)\/?>/g)].map((p) => attrs(p[1]).Name).filter(Boolean)),
      navigations: new Set([...m[2].matchAll(/<NavigationProperty\b([^>]*)\/?>/g)].map((p) => attrs(p[1]).Name).filter(Boolean)),
    });
  }
  const entitySets = new Map();
  for (const m of src.matchAll(/<EntitySet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Name) entitySets.set(a.Name, String(a.EntityType ?? '').split('.').pop() || null);
  }
  const paramsOf = (body) => [...String(body ?? '').matchAll(/<Parameter\b([^>]*)\/?>/g)].map((p) => attrs(p[1]).Name).filter(Boolean);
  const operations = new Map();
  // V4 operations first: an import names one of them and takes its parameters.
  for (const m of src.matchAll(/<(Action|Function)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const a = attrs(m[2]);
    if (!a.Name) continue;
    const params = paramsOf(m[3]);
    if (a.IsBound === 'true') params.shift();
    const prev = operations.get(a.Name);
    // Overloads (one bound per entity type) share a name: their parameters are united.
    operations.set(a.Name, { kind: m[1], params: new Set([...(prev?.params ?? []), ...params]), bound: a.IsBound === 'true' });
  }
  for (const m of src.matchAll(/<(ActionImport|FunctionImport)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const a = attrs(m[2]);
    if (!a.Name) continue;
    const target = String(a.Action ?? a.Function ?? '').split('.').pop();
    const op = target ? operations.get(target) : null;
    operations.set(a.Name, {
      kind: m[1],
      // V2 FunctionImport carries its parameters inline; a V4 import borrows them from its operation.
      params: op ? op.params : new Set(paramsOf(m[3])),
      method: a['m:HttpMethod'] ?? null,
    });
  }
  const containers = new Set([...src.matchAll(/<EntityContainer\b([^>]*)>/g)].map((m) => attrs(m[1]).Name).filter(Boolean));
  return {
    version,
    namespace,
    alias,
    // The service DEFINITION behind the binding: `cds_<srvd>` in V2, `com.sap.gateway.srvd*.<srvd>.vNNNN`
    // in V4 (lib/edmx.mjs). This is what ties an app that names a binding to the contract of a
    // service definition.
    srvd: namespace ? serviceOfNamespace(namespace) : null,
    entityTypes,
    entitySets,
    operations,
    containers,
  };
}

// --- what a file of the app addresses ---------------------------------------------------------

/** Names before an OData comparison operator, in a $filter string. */
const filterProps = (s) => [...String(s).matchAll(/(?:^|[\s(,])([A-Za-z_][A-Za-z0-9_]*)\s+(?:eq|ne|gt|ge|lt|le)\s/g)].map((m) => m[1]);
const listProps = (s) => String(s).split(',').map((x) => x.trim().split(/\s+/)[0].split('/')[0]).filter((x) => IDENT.test(x));

/** The `{ ... }` object literal that starts at `open` (an index of `{`), or '' -- strings are skipped. */
function objectAt(text, open) {
  if (text[open] !== '{') return '';
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length && i < open + 4000; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return '';
}

/**
 * The value of `key:` inside an object literal: an object literal as written, or -- for an
 * expression -- the text of its string literals joined by a blank. `"A eq '" + s + "' and B eq 1"`
 * reads as `A eq '  ' and B eq 1`: the names stay, the variables drop out.
 */
function member(obj, key) {
  // `"\$filter"` (an escaped dollar, measured in a deployed app) is the same key as `"$filter"`.
  const k = new RegExp(`["']?${key.replace(/\$/g, '\\\\?\\$')}["']?\\s*:\\s*`).exec(obj);
  if (!k) return null;
  const at = k.index + k[0].length;
  if (obj[at] === '{') return objectAt(obj, at);
  // The expression runs to the next comma or closing brace outside quotes and brackets.
  let depth = 0;
  let quote = null;
  let end = at;
  for (; end < obj.length; end++) {
    const c = obj[end];
    if (quote) {
      if (c === '\\') end++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth-- === 0) break; }
    else if (c === ',' && depth === 0) break;
  }
  const literals = [...obj.slice(at, end).matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((s) => s[2]);
  return literals.length ? literals.join(' ') : null;
}

/**
 * The `urlParameters: { ... }` literal of the call that starts at `from`, or null.
 *
 * Looked up directly instead of parsing the whole options object: the object also holds the
 * `success`/`error` callbacks, and a regex literal in one of them (`/'/g`, measured) defeats a
 * scanner that tracks quotes. It must come before the next call of the model, so it cannot be
 * borrowed from the call below.
 */
function urlParametersAfter(text, from) {
  const window = text.slice(from, from + 600);
  const next = window.search(/\.(read|create|update|remove|callFunction)\(/);
  const scope = next >= 0 ? window.slice(0, next) : window;
  const k = /["']?urlParameters["']?\s*:\s*\{/.exec(scope);
  if (!k) return null;
  const obj = objectAt(text, from + k.index + k[0].length - 1);
  return obj || null;
}

/** The top-level keys of an object literal (nested literals are not descended into). */
function keysOf(obj) {
  const body = String(obj).slice(1, -1);
  let flat = '';
  let depth = 0;
  for (const c of body) {
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 0) flat += c;
  }
  return [...flat.matchAll(/(?:^|,)\s*["']?([A-Za-z_$][\w$]*)["']?\s*:/g)].map((m) => m[1]);
}

function jsCitations(file, text) {
  const out = [];
  const at = (index, c) => out.push({ file, line: lineAt(text, index), ...c });
  // V2: callFunction("/Import", { urlParameters: { P: .. } })
  for (const m of text.matchAll(/\.callFunction\(\s*(["'`])\/([A-Za-z_][\w]*)\1\s*(,\s*)?/g)) {
    at(m.index, { kind: 'operation', name: m[2] });
    const params = m[3] ? urlParametersAfter(text, m.index + m[0].length) : null;
    if (params) for (const p of keysOf(params)) at(m.index, { kind: 'operationParam', of: m[2], name: p });
  }
  // V4: bindList("/Set"), bindContext("/Set(..)/ns.Action(...)") or bindContext("/ActionImport(...)").
  // A literal path only; the first segment is a set or an import, a qualified segment an operation.
  // The path may carry a key in the other quote (`"/Travel('1')/..."`), so only its own quote ends it.
  for (const m of text.matchAll(/\.(bindList|bindContext)\(\s*(["'`])(\/(?:(?!\2)[^\n])*)\2/g)) {
    const segs = m[3].slice(1).split('/').map((s) => s.replace(/\(.*$/, ''));
    if (!IDENT.test(segs[0] ?? '')) continue;
    if (m[1] === 'bindContext' && /\(\.\.\.\)$/.test(m[3]) && segs.length === 1) at(m.index, { kind: 'operation', name: segs[0] });
    else at(m.index, { kind: 'entitySet', name: segs[0], via: m[1] });
    const op = segs.slice(1).find((s) => /^[A-Za-z_][\w.]*\.[A-Za-z_]\w*$/.test(s));
    if (op) at(m.index, { kind: 'operation', name: op.split('.').pop() });
  }
  // V4, bound to a context the code holds: bindContext("<ns>.Action(...)", oContext).
  for (const m of text.matchAll(/\.bindContext\(\s*(["'`])(?:[A-Za-z_][\w.]*\.)([A-Za-z_]\w*)\(\.\.\.\)\1/g)) {
    at(m.index, { kind: 'operation', name: m[2] });
  }
  for (const m of text.matchAll(/\.(read|create|update|remove)\(\s*(["'`])\/([A-Za-z_][\w]*)/g)) {
    const set = m[3];
    at(m.index, { kind: 'entitySet', name: set, via: m[1] });
    // The call's own options: `read(path, {urlParameters})`, `create(path, data, {..})`.
    const params = urlParametersAfter(text, m.index + m[0].length);
    if (!params) continue;
    const props = [
      ...filterProps(member(params, '$filter') ?? ''),
      ...listProps(member(params, '$select') ?? ''),
      ...listProps(member(params, '$orderby') ?? ''),
    ];
    for (const p of new Set(props)) at(m.index, { kind: 'property', of: set, name: p });
    for (const n of new Set(listProps(member(params, '$expand') ?? ''))) at(m.index, { kind: 'property', of: set, name: n });
  }
  for (const m of text.matchAll(/\.(?:bindElement|bindObject|bindRows|bindItems)\(\s*(?:\{\s*path\s*:\s*)?(["'`])\/([A-Za-z_][\w]*)/g)) {
    at(m.index, { kind: 'entitySet', name: m[2], via: 'binding' });
  }
  return out;
}

function viewCitations(file, text, odataModels) {
  const out = [];
  // `{/Set}`, `{model>/Set}`, `{path: '/Set'}`, `{path: 'model>/Set'}` -- an ABSOLUTE path only.
  for (const m of text.matchAll(/\{\s*(?:path\s*:\s*['"])?(?:([A-Za-z_][\w]*)>)?\/([A-Za-z_][\w]*)/g)) {
    if (!odataModels.has(m[1] ?? '')) continue; // a JSON or resource model names no service
    out.push({ file, line: lineAt(text, m.index), kind: 'entitySet', name: m[2], via: 'binding' });
  }
  return out;
}

function annotationCitations(file, text) {
  const out = [];
  const alias = new Map();
  for (const m of text.matchAll(/<(?:edmx:)?Include\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Namespace && a.Alias) alias.set(a.Alias, a.Namespace);
  }
  for (const m of text.matchAll(/<Annotations\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Annotations>)/g)) {
    const target = attrs(m[1]).Target;
    const body = m[2] ?? '';
    const t = /^([A-Za-z_][\w.]*)\.([A-Za-z_]\w*)(?:\/([A-Za-z_]\w*))?/.exec(String(target ?? ''));
    if (!t) continue;
    const namespace = alias.get(t[1]) ?? t[1];
    const line = lineAt(text, m.index);
    out.push({ file, line, kind: 'annotationTarget', namespace, type: t[2], name: t[3] ?? null });
    // Paths inside, relative to the target's type: first segment only.
    const paths = [
      ...[...body.matchAll(/\s(?:Path|PropertyPath|NavigationPropertyPath)="([^"]+)"/g)].map((p) => p[1]),
      ...[...body.matchAll(/<(?:Path|PropertyPath|NavigationPropertyPath)>([^<]+)</g)].map((p) => p[1]),
    ];
    for (const p of new Set(paths.map((x) => x.trim().split('/')[0]))) {
      if (IDENT.test(p)) out.push({ file, line, kind: 'annotationPath', namespace, type: t[2], name: p });
    }
  }
  return out;
}

/** Every `entitySet` / `EntitySet` / `contextPath` value the manifest names outside sap.app. */
export function manifestCitations(file, manifest) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'sap.app') continue;
      if (/^(entitySet|EntitySet)$/.test(k) && typeof v === 'string' && IDENT.test(v)) out.push({ file, line: null, kind: 'entitySet', name: v, via: 'manifest' });
      else if (k === 'contextPath' && typeof v === 'string' && /^\/[A-Za-z_]\w*$/.test(v)) out.push({ file, line: null, kind: 'entitySet', name: v.slice(1), via: 'manifest' });
      else walk(v);
    }
  };
  walk(manifest);
  // A Fiori elements manifest names the same set in its page, its sub-page and its extensions.
  return out.filter((c, i) => out.findIndex((d) => d.name === c.name) === i);
}

/** A copy of $metadata (a scaffold mock, a cached edmx): evidence of the past, never read as use. */
export const isMetadataCopy = (file, text) =>
  /(^|\/)localService(\/|$)/i.test(file) || /\.edmx$/i.test(file) || /<(?:edmx:)?Edmx[\s>]/.test(String(text).slice(0, 4000)) && /<EntityType\b/.test(String(text));

/**
 * What one file of the app addresses.
 * @param {Map<string,string>} odataModels from odataModelsOf
 */
export function citationsOf(file, text, odataModels = new Map([['', 'mainService']])) {
  const src = String(text ?? '');
  if (isMetadataCopy(file, src)) return [];
  if (/\.js$/i.test(file)) return jsCitations(file, src);
  if (/\.xml$/i.test(file)) {
    return /<Annotations\b/.test(src) ? annotationCitations(file, src) : viewCitations(file, src, odataModels);
  }
  return [];
}

/**
 * Which files of the app tree carry hand-written references, and which to skip.
 *
 * A file deployed in both forms (`X-dbg.js` and `X.js`, `X-dbg.controller.js` and
 * `X.controller.js`) is read once, from the debug source. Never read: source maps, the preload
 * bundle (it repeats every module), i18n `.properties` (texts, and never-read in lib/edmx.mjs too),
 * anything under localService/test/images/css.
 */
export function filesWorthReading(entries) {
  const files = entries.filter((e) => e.kind === 'file').map((e) => e.path);
  const have = new Set(files);
  return files.filter((f) => {
    if (/(^|\/)(localService|test|images|img|css|i18n)(\/|$)/i.test(f)) return false;
    if (/\.map$|(^|\/)Component-preload\.js$|(^|\/)manifest\.json$/i.test(f)) return false;
    if (/\.js$/i.test(f) && !/-dbg\./.test(f)) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      const dot = base.indexOf('.');
      const dbg = f.slice(0, f.length - base.length) + base.slice(0, dot) + '-dbg' + base.slice(dot);
      if (have.has(dbg)) return false;
    }
    return /\.(js|xml)$/i.test(f);
  });
}

/** Folders worth walking into (the same exclusions as filesWorthReading). */
export const folderWorthWalking = (path) => !/(^|\/)(localService|test|images|img|css|i18n|resources)$/i.test(path);

// --- the check ---------------------------------------------------------------------------------

/**
 * Check each citation against the live metadata of the app's services.
 *
 * @param {object[]} citations from citationsOf / manifestCitations
 * @param {{service:string, metadata:ReturnType<typeof parseServiceMetadata>}[]} services
 * @returns {{citation:object, status:'holds'|'broken'|'unattributed', service?:string, reason?:string}[]}
 */
export function checkCitations(citations, services) {
  const results = [];
  const holds = (c, svc) => results.push({ citation: c, status: 'holds', service: svc.service, srvd: svc.metadata.srvd });
  const broken = (c, reason) => results.push({ citation: c, status: 'broken', reason });
  const typeOfSet = (svc, set) => svc.metadata.entityTypes.get(svc.metadata.entitySets.get(set));
  for (const c of citations) {
    if (c.kind === 'entitySet') {
      const svc = services.find((s) => s.metadata.entitySets.has(c.name));
      svc ? holds(c, svc) : broken(c, `no entity set '${c.name}' in ${names(services)}`);
    } else if (c.kind === 'operation') {
      const svc = services.find((s) => s.metadata.operations.has(c.name));
      svc ? holds(c, svc) : broken(c, `no function import, action or function '${c.name}' in ${names(services)}`);
    } else if (c.kind === 'operationParam') {
      const svc = services.find((s) => s.metadata.operations.has(c.of));
      if (!svc) continue; // the operation itself is already reported
      const op = svc.metadata.operations.get(c.of);
      op.params.has(c.name) ? holds(c, svc) : broken(c, `'${c.of}' of ${svc.service} has no parameter '${c.name}' (it takes: ${[...op.params].join(', ') || 'none'})`);
    } else if (c.kind === 'property') {
      const svc = services.find((s) => s.metadata.entitySets.has(c.of));
      if (!svc) continue; // the entity set is already reported
      const type = typeOfSet(svc, c.of);
      if (!type) continue;
      type.properties.has(c.name) || type.navigations.has(c.name)
        ? holds(c, svc)
        : broken(c, `entity set '${c.of}' of ${svc.service} has no property or navigation '${c.name}'`);
    } else if (c.kind === 'annotationTarget' || c.kind === 'annotationPath') {
      const own = services.filter((s) => s.metadata.namespace === c.namespace || (s.metadata.alias && s.metadata.alias === c.namespace));
      if (!own.length) {
        results.push({ citation: c, status: 'unattributed', reason: `namespace '${c.namespace}' is not the namespace of any service of this app` });
        continue;
      }
      const svc = own[0];
      const md = svc.metadata;
      if (md.containers.has(c.type)) {
        // `<ns>.<Container>/<Set>`
        if (c.kind === 'annotationPath' || !c.name) holds(c, svc);
        else md.entitySets.has(c.name) ? holds(c, svc) : broken(c, `no entity set '${c.name}' in ${svc.service}`);
        continue;
      }
      // `<ns>.<Action>(<ns>.<Type>)` and its parameters: a V4 annotation on an operation.
      if (md.operations.has(c.type)) {
        if (c.kind === 'annotationPath' || !c.name || md.operations.get(c.type).params.has(c.name)) holds(c, svc);
        else broken(c, `'${c.type}' of ${svc.service} has no parameter '${c.name}'`);
        continue;
      }
      const type = md.entityTypes.get(c.type);
      if (!type) {
        if (c.kind === 'annotationTarget') broken(c, `no entity type, container or operation '${c.type}' in ${svc.service}`);
        continue;
      }
      if (!c.name) holds(c, svc);
      else if (type.properties.has(c.name) || type.navigations.has(c.name)) holds(c, svc);
      else broken(c, `entity type '${c.type}' of ${svc.service} has no property or navigation '${c.name}'`);
    }
  }
  return results;
}

const names = (services) => (services.length ? services.map((s) => s.service).join(', ') : 'no service of this app');
