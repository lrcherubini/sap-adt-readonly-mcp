// The sources of a package, read from the SAP system -- what replaces a local checkout.
//
// One listing per package (nodeContents, the call adt_package_tree makes), then one source read
// per object (getObjectSource), both through the guarded client. Every object that could not be
// read comes back in `notRead` with the reason, and every object past the cap in `skipped`: a
// scan that read less than the package holds says so, because fewer sources always reads as a
// cleaner package.
//
// The cost is real -- one call per object -- which is why there is a cap (default 100, at most
// 300), the reads count against the read budget like any other, progress is reported to the
// client, and a cancelled call stops between reads.

import { record } from './audit.mjs';

export const DEFAULT_MAX_OBJECTS = 100;
export const MAX_OBJECTS = 300;
const MAX_PACKAGES = 200;
const CONCURRENCY = 4;

/** Where the source of each readable type lives, when the node carries no OBJECT_URI. */
const COLLECTION = {
  'DDLS/DF': '/sap/bc/adt/ddic/ddl/sources/',
  'DDLX/EX': '/sap/bc/adt/ddic/ddlx/sources/',
  'SRVD/SRV': '/sap/bc/adt/ddic/srvd/sources/',
};
export const SOURCE_TYPES = Object.freeze(Object.keys(COLLECTION));

/** The URI of an object's main source. */
export function sourceUriOf(obj) {
  const base = obj.uri || (COLLECTION[obj.type] ? `${COLLECTION[obj.type]}${encodeURIComponent(String(obj.name).toLowerCase())}` : null);
  if (!base) return null;
  return /\/source\/main$/.test(base) ? base : `${base.replace(/\/$/, '')}/source/main`;
}

/** The cap a caller asked for, clamped: an integer 1..MAX_OBJECTS, default DEFAULT_MAX_OBJECTS. */
export const capOf = (value) => {
  const n = Number(value ?? DEFAULT_MAX_OBJECTS);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_OBJECTS) : DEFAULT_MAX_OBJECTS;
};

/**
 * Every object of `pkg` (and, with `recursive`, of its sub-packages), as the tree resource lists
 * them. Type folders (empty names) are dropped, as adt_package_tree does.
 * The packages a limit kept out are in `limits` (depth, the package cap, a cancel), by name.
 * @returns {Promise<{packages:string[], objects:{name,type,uri,package}[], notListed:{package,reason}[], limits:{depth:string[], packages:string[], cancelled:string[]}}>}
 */
export async function listPackage(api, pkg, { recursive = true, maxDepth = 4, signal } = {}) {
  const packages = [];
  const objects = [];
  const notListed = [];
  // The packages a limit kept out of the listing, by limit: never dropped in silence, because a
  // package not listed reads exactly like a package with nothing in it.
  const limits = { depth: [], packages: [], cancelled: [] };
  const seen = new Set();
  const walk = async (name, depth) => {
    if (seen.has(name)) return;
    if (depth > maxDepth) return void limits.depth.push(name);
    if (packages.length >= MAX_PACKAGES) return void limits.packages.push(name);
    if (signal?.aborted) return void limits.cancelled.push(name);
    seen.add(name);
    let node;
    try {
      node = await api.nodeContents('DEVC/K', name);
    } catch (e) {
      notListed.push({ package: name, reason: String(e?.message ?? e).slice(0, 200) });
      return;
    }
    packages.push(name);
    const rows = (node?.nodes ?? []).filter((n) => String(n.OBJECT_NAME ?? '').trim());
    for (const n of rows) {
      if (n.OBJECT_TYPE === 'DEVC/K') continue;
      objects.push({ name: String(n.OBJECT_NAME), type: n.OBJECT_TYPE, uri: n.OBJECT_URI || null, package: name });
    }
    if (recursive) {
      for (const sub of rows.filter((n) => n.OBJECT_TYPE === 'DEVC/K')) await walk(String(sub.OBJECT_NAME).toUpperCase(), depth + 1);
    }
  };
  await walk(String(pkg).toUpperCase(), 1);
  return { packages, objects, notListed, limits };
}

/**
 * Read the main source of each object, at most `max` of them, CONCURRENCY at a time.
 * `onRead(obj, text)` is optional; the texts are also returned.
 * @returns {Promise<{read:{...obj,text}[], notRead:{...obj,reason}[], skipped:object[], cancelled:boolean}>}
 */
export async function readSources(api, objects, { cfg, tool, max = DEFAULT_MAX_OBJECTS, signal, progress = () => {} } = {}) {
  const todo = objects.slice(0, max);
  const skipped = objects.slice(max);
  const read = [];
  const notRead = [];
  let next = 0;
  let done = 0;
  let cancelled = false;
  const worker = async () => {
    while (next < todo.length) {
      if (signal?.aborted) {
        cancelled = true;
        return;
      }
      const obj = todo[next++];
      const uri = sourceUriOf(obj);
      try {
        if (!uri) throw new Error(`no source URI for type ${obj.type}`);
        const text = await api.getObjectSource(uri);
        if (cfg) record(cfg, tool ?? 'package-sources', `${obj.type} ${obj.name}`, String(text ?? '').length);
        if (!String(text ?? '').trim()) notRead.push({ ...obj, reason: 'the system answered an empty source' });
        else read.push({ ...obj, text: String(text) });
      } catch (e) {
        notRead.push({ ...obj, reason: String(e?.message ?? e).slice(0, 200), status: Number.isInteger(e?.status) ? e.status : null });
      }
      done++;
      progress(done, todo.length, `${obj.type} ${obj.name}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, todo.length)) }, worker));
  if (cancelled) skipped.unshift(...todo.slice(next));
  // Completion order is not object order; the answer is sorted so two runs read alike.
  const byName = (a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`);
  return { read: read.sort(byName), notRead: notRead.sort(byName), skipped, cancelled };
}

/**
 * The sources of the given types in a package: list, filter, read. `only` narrows to one object
 * name before anything is read (an entity filter costs one read, not the whole package). A
 * `listing` already made by `listPackage` for the same package is used instead of a second one.
 */
export async function packageSources(api, pkg, { types = SOURCE_TYPES, recursive = true, only = null, max, offset = 0, cfg, tool, signal, progress, listing: given = null } = {}) {
  const listing = given ?? (await listPackage(api, pkg, { recursive, signal }));
  const want = new Set(types);
  const onlyName = only ? String(only).toUpperCase() : null;
  const candidates = listing.objects
    .filter((o) => want.has(o.type))
    .filter((o) => !onlyName || o.name.toUpperCase() === onlyName)
    .sort((a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`));
  // A page of the candidates: `offset` starts after the ones a previous call read, so the next
  // page costs only its own reads. The order is the sort above, the same on every call.
  const from = Number.isInteger(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
  const sources = await readSources(api, candidates.slice(from), { cfg, tool, max: capOf(max), signal, progress });
  const end = from + sources.read.length + sources.notRead.length;
  const next = sources.skipped.length && !sources.cancelled ? { offset: end } : null;
  return { ...listing, candidates: candidates.length, offset: from, next, ...sources };
}

/**
 * The `incomplete` entries of a package read (lib/completeness.mjs): objects not read, packages
 * not listed, the cap (with the next page), a cancel, and the listing limits.
 */
export function packageIncomplete(result) {
  const out = [];
  if (result.notRead?.length) out.push({ list: 'objects', code: 'NOT_READ', count: result.notRead.length, reason: 'see scope.notRead' });
  if (result.notListed?.length) out.push({ list: 'packages', code: 'NOT_READ', count: result.notListed.length, reason: 'see scope.notListed' });
  if (result.skipped?.length) {
    out.push(
      result.cancelled
        ? { list: 'objects', code: 'CANCELLED', count: result.skipped.length }
        : { list: 'objects', code: 'CAP_REACHED', returned: result.read.length + result.notRead.length, total: result.candidates, next: result.next }
    );
  }
  const l = result.limits ?? {};
  if (l.depth?.length) out.push({ list: 'packages', code: 'DEPTH_LIMIT', count: l.depth.length, packages: l.depth });
  if (l.packages?.length) out.push({ list: 'packages', code: 'CAP_REACHED', count: l.packages.length, packages: l.packages, narrowBy: ['package'] });
  if (l.cancelled?.length) out.push({ list: 'packages', code: 'CANCELLED', count: l.cancelled.length, packages: l.cancelled });
  return out;
}

/** The gaps a package read files: objects not read, packages not listed, the cap reached. */
export function packageGaps(tool, pkg, result) {
  const gaps = [];
  for (const o of result.notRead) {
    gaps.push({
      code: 'SOURCE_NOT_READ',
      subject: `${o.type} ${o.name}`,
      detail: o.reason,
      impact: `${tool} saw nothing of this object: the counts for ${pkg} are a floor, not a total`,
      fallback: 'adt_read_source on the object, then run the scan again',
    });
  }
  for (const p of result.notListed) {
    gaps.push({
      code: 'SOURCE_NOT_READ',
      subject: `DEVC/K ${p.package}`,
      detail: `package not listed: ${p.reason}`,
      impact: `nothing in ${p.package} was scanned`,
      fallback: 'adt_package_tree on the package, then run the scan again',
    });
  }
  if (result.skipped.length) {
    gaps.push({
      code: 'SCAN_AT_CAP',
      subject: `${tool} ${pkg}`,
      detail: `${result.skipped.length} of ${result.candidates} object(s) not read${result.cancelled ? ' (cancelled)' : ' (maxObjects reached)'}`,
      impact: 'the answer covers part of the package: absent here is not absent there',
      fallback: 'raise maxObjects (at most 300), or scan a sub-package',
    });
  }
  return gaps;
}

/** The scope block every package scan answers with. */
export const scopeOf = (pkg, result, extra = {}) => ({
  package: String(pkg).toUpperCase(),
  packages: result.packages.length,
  objects: result.candidates,
  read: result.read.length,
  ...(result.notRead.length ? { notRead: result.notRead.map((o) => ({ object: `${o.type} ${o.name}`, reason: o.reason })) } : {}),
  ...(result.notListed.length ? { notListed: result.notListed } : {}),
  ...(result.skipped.length ? { skipped: result.skipped.length, cancelled: result.cancelled } : {}),
  ...(result.offset ? { offset: result.offset } : {}),
  ...(result.next ? { next: result.next } : {}),
  ...(listingLimited(result) ? { notWalked: result.limits } : {}),
  ...extra,
});

const listingLimited = (result) => Boolean(result.limits && (result.limits.depth.length || result.limits.packages.length || result.limits.cancelled.length));
