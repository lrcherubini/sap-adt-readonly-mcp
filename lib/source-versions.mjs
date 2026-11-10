// A stored version of a source, and the comparison of two of them.
//
// MEASURED 2026-11-10 on one class and four programs (docs/adt-api-reference.md, "Old
// versions, the inactive version and the syntax check run"). Three facts shape this module, and
// each one gives a WRONG answer with no error if ignored:
//
//  1. ⚠️ `?version=inactive` ANSWERS THE ACTIVE SOURCE, 200, WHEN THERE IS NO INACTIVE VERSION.
//     The only signal is the object document read with `?version=inactive`: its root
//     `adtcore:version` says `inactive` exactly when one exists. So `inactive` costs that read
//     first, and an answer without one says so instead of passing the active source off.
//  2. ⚠️ THE CONTENT URL OF A VERSION IS PUBLISHED, NEVER BUILT. Its stamp is the feed's (the
//     last change), not the version's; a version is chosen by `atom:id` and its URL is the
//     entry's `atom:content/@src`.
//  3. ⚠️ VERSION 00000 IS THE ACTIVE ONE, REGENERATED. Its text differs from `source/main` (the
//     class implementation header comes back upper-cased), so an old version is compared with
//     00000, never with `source/main`, or the diff reports a change nobody made.
//
// Every read goes through `derivedGet` (lib/adt-get.mjs) with a kind held to classes and
// programs; nothing here touches the client library.

import { derivedGet } from './adt-get.mjs';
import { versionLinks, parseVersionFeed, ACTIVE_VERSION } from './object-versions.mjs';
import { lineDiff } from './line-diff.mjs';

/** What `version` and `compareTo` accept: the two stored states, or a number from the feed. */
export const VERSION_PATTERN = '^(active|inactive|[0-9]{5})$';
const VERSION_RX = new RegExp(VERSION_PATTERN);

/** A version that could not be read, with the gap it files. */
export class VersionNotRead extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'VersionNotRead';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** The root `adtcore:version` of an object document, or null. */
export function documentVersion(xml) {
  const root = String(xml ?? '').match(/<(?!\?)[\w:.-]+\b([^>]*)>/);
  const m = root?.[1].match(/\badtcore:version="([^"]*)"/);
  return m ? m[1] : null;
}

/** The version feed for this include: `main` (or the named include) of a class, the object's own otherwise. */
export function feedLinkFor(structure, include) {
  const links = versionLinks(structure);
  const wanted = include ?? 'main';
  return links.find((l) => l.where === wanted) ?? links.find((l) => l.where === 'object') ?? null;
}

/**
 * Read one stored version. `read(kind, href, query?)` performs the derived GET under the object
 * and records it (the caller binds transport, object URI and audit). Returns
 * {version, source, label, exists, entry?}; `exists: false` means an inactive version was asked
 * and the object has none (no source is returned then).
 */
export async function readVersion({ read, structure, sourceUrl, include, version }) {
  if (!VERSION_RX.test(String(version))) {
    throw new VersionNotRead(`'${version}' is not a version: active, inactive or a number from the feed (00000).`, null);
  }
  if (version === 'active' || version === 'inactive') {
    if (version === 'inactive') {
      const doc = await read('objectVersion', null, { version: 'inactive' });
      const said = documentVersion(doc.body);
      if (said !== 'inactive') {
        return { version, exists: false, source: null, label: `inactive (none: the object document says ${said ?? 'nothing'})` };
      }
    }
    const out = await read('sourceVersion', sourceUrl, { version });
    return { version, exists: true, source: out.body, label: `${version} (stored)` };
  }
  const link = feedLinkFor(structure, include);
  if (!link) {
    throw new VersionNotRead(
      `the object publishes no version feed for ${include ?? 'main'}; version ${version} cannot be asked.`,
      'NO_VERSION_FEED',
    );
  }
  const feed = await read('versions', link.href);
  const { entries } = parseVersionFeed(feed.body);
  const entry = entries.find((e) => e.id === version);
  if (!entry || !entry.contentSrc) {
    throw new VersionNotRead(
      `version ${version} is not in the feed of ${include ?? 'main'} (it lists ${entries.map((e) => e.id).join(', ') || 'none'}).`,
      'VERSION_NOT_IN_FEED',
      { listed: entries.map((e) => e.id) },
    );
  }
  const out = await read('versionContent', entry.contentSrc);
  const by = [entry.transport?.number, entry.author, entry.updated].filter(Boolean).join(', ');
  return {
    version,
    exists: true,
    source: out.body,
    label: `${version}${version === ACTIVE_VERSION ? ' (active, from the version history)' : ''}${by ? ` -- ${by}` : ''}`,
    entry: { id: entry.id, transport: entry.transport?.number ?? null, author: entry.author, updated: entry.updated },
  };
}

/**
 * Compare two versions. An `active` side facing a numbered one is read as 00000, the same
 * regenerated text the numbered one is (fact 3 above), and the answer says so.
 */
export async function compareVersions(ctx, version, compareTo, diffOpts = {}) {
  if (version === compareTo) throw new VersionNotRead(`version and compareTo are both '${version}': nothing to compare.`, null);
  const numbered = (v) => /^[0-9]{5}$/.test(String(v));
  const notes = [];
  const side = (v, other) => {
    if (v === 'active' && numbered(other)) {
      notes.push(`'active' read as ${ACTIVE_VERSION} from the version history, so both sides come from the same generator`);
      return ACTIVE_VERSION;
    }
    return v;
  };
  const from = side(compareTo, version);
  const to = side(version, compareTo);
  if (from === to) throw new VersionNotRead(`'${compareTo}' and '${version}' are the same version (${from}).`, null);
  const a = await readVersion({ ...ctx, version: from });
  const b = await readVersion({ ...ctx, version: to });
  const missing = [a, b].filter((x) => !x.exists);
  if (missing.length) {
    return { from: a, to: b, diff: null, notes: [...notes, 'the object has no inactive version: there is nothing to compare'] };
  }
  const diff = lineDiff(a.source, b.source, { ...diffOpts, fromLabel: a.label, toLabel: b.label });
  return { from: a, to: b, diff, notes };
}

/** Bind a `read` for one object: the derived GET under it, one audit line per call. */
export function readerFor(transport, objectUri, onRead) {
  return async (kind, href, query) => {
    let out;
    try {
      out = await derivedGet(transport, objectUri, href ?? objectUri, { kind, ...(query ? { query } : {}) });
      return out;
    } finally {
      onRead?.(kind, out);
    }
  };
}
