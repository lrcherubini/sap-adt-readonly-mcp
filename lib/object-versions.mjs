// WHICH TRANSPORTS carry one object -- the version history the ADT publishes as an Atom feed.
//
// The transport organizer answers "which objects moved in this request". The reverse
// question -- "which requests carried this object, ever" -- is answered by the object's
// version feed: version history is written when a request is RELEASED, so reading it
// creates nothing, and every entry names the request it was written by.
//
// MEASURED 2026-09-10 on ZCL_DEMO_EXPENSE_SYNC (five feeds), ZDEMO_EXPENSE_RPT and
// ZDEMO_PROFILE, 239 entries in all, cross-checked against a fact measured the day before
// (the class was carried by DEVK900110 and DEVK900104 -- both are in its feed). Three
// measurements are load-bearing, and each one produces a WRONG answer with no error at all
// if ignored -- docs/adt-api-reference.md, "Three ways this resource will lie":
//
//  1. ⚠️ THE PATH IS PUBLISHED, NEVER CONSTRUCTED. `objectStructure` publishes
//     `atom:link rel=".../relations/versions"`, and its shape depends on the type: a class
//     carries FIVE (`includes/{definitions,implementations,macros,testclasses,main}/
//     versions`, none on the object itself), a program one (`source/main/versions`), a
//     domain one (`versions`). A URL assembled from a convention is wrong for two of the
//     three. `versionLinks` reads the hrefs the server sent and nothing else.
//
//  2. ⚠️ A CLASS KEEPS FIVE INDEPENDENT HISTORIES. Three of the five includes named ONE
//     real request where the class had been carried by three. Asking one include is a
//     silent undercount; `unionByTransport` takes the union over every feed and keeps,
//     per transport, which feeds named it.
//
//  3. ⚠️ THE FEED IS DOMINATED BY TRANSPORTS OF COPIES: 45 distinct numbers in the class
//     feed, 3 real. The discriminator is the server's own `atom:entry/@adtcore:
//     isTestTransport="true"` -- NEVER the "CP - " prefix that happens to start those
//     titles, which is one developer's habit. `splitCopies` reads the attribute only.
//
// And one more shape: version `00000` is the ACTIVE version. It carries a transport link
// only while the object sits in an OPEN request (that link is the "who holds it now"
// answer); otherwise it comes back with no `atom:title`, no `atom:link`, and once with an
// empty `<atom:author/>`. An entry without a link is therefore not a defect of the feed.
//
// THE LIBRARY'S OWN `revisions()` IS NOT USED: its projection stores the transport number
// as `version`, drops the real version (`atom:id`) and never reads `isTestTransport`. The
// feed is read as raw XML through `derivedGet` (lib/adt-get.mjs), under the object only.
//
// A BOUNDARY THIS FEED OPENS AND THIS MODULE DOES NOT CROSS: `atom:content/@src` is the
// URI of an OLD VERSION's content. This module carries it as a string; lib/source-versions.mjs
// follows it for adt_read_source, as the derived kind `versionContent` (docs/security.md).

export const VERSIONS_REL = 'http://www.sap.com/adt/relations/versions';
export const TRANSPORT_REL = 'http://www.sap.com/adt/relations/transport/request';
export const TRANSPORT_LINK_TYPE = 'application/vnd.sap.adt.transportrequests.v1+xml';
export const ACTIVE_VERSION = '00000';

/** Every element and attribute seen in the 239 measured entries. Anything else is drift. */
const DECLARED_ELEMENT = new Set([
  'atom:feed',
  'atom:entry',
  'atom:title',
  'atom:updated',
  'atom:author',
  'atom:name',
  'atom:content',
  'atom:id',
  'atom:link',
]);
const DECLARED_ATTR = new Map([
  ['atom:feed', new Set(['xmlns:atom', 'xmlns:adtcore'])],
  ['atom:entry', new Set(['adtcore:isTestTransport'])],
  ['atom:content', new Set(['type', 'src'])],
  ['atom:link', new Set(['adtcore:name', 'href', 'rel', 'type', 'title'])],
]);

const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const attrsOf = (chunk) => {
  const out = {};
  for (const m of String(chunk ?? '').matchAll(ATTR)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/**
 * The hrefs `objectStructure` published with `rel = .../relations/versions`, on the object
 * and on each of its includes -- in the order the server sent them. `where` is the include
 * name for a class (`definitions`, `main`, ...) and `object` for everything else.
 */
export function versionLinks(structure) {
  const out = [];
  const take = (links, where) => {
    for (const l of Array.isArray(links) ? links : []) {
      if (l?.rel === VERSIONS_REL && typeof l.href === 'string' && l.href.trim()) {
        out.push({ where, href: l.href.trim() });
      }
    }
  };
  take(structure?.links, 'object');
  for (const inc of Array.isArray(structure?.includes) ? structure.includes : []) {
    take(inc?.links, String(inc?.['class:includeType'] ?? inc?.['adtcore:name'] ?? 'include'));
  }
  return out;
}

/**
 * Parse one `application/atom+xml;type=feed` document into version entries.
 *
 * Every entry keeps the version number (`atom:id`), when, who, the transport the server
 * linked (number + the CTS href it pre-assembled), the server's `isTestTransport`, the
 * transport's description (`atom:title` -- it IS the transport's, not a version title) and
 * the content URI as a string. Undeclared elements and attributes are reported in `drift`,
 * never dropped in silence.
 */
export function parseVersionFeed(xml) {
  const text = String(xml ?? '');
  const drift = [];
  const seen = new Map(); // drift key -> row, so one undeclared thing counts once
  const note = (row) => {
    const k = `${row.node}|${row.attribute ?? ''}`;
    const had = seen.get(k);
    if (had) had.count += 1;
    else {
      const r = { ...row, count: 1 };
      seen.set(k, r);
      drift.push(r);
    }
  };

  let feedTitle = null;
  let feedUpdated = null;
  const entries = [];
  let current = null;
  let inAuthor = false;
  const stack = [];

  const textAfter = (index) => {
    const close = text.indexOf('<', index);
    return unescapeXml(text.slice(index, close < 0 ? text.length : close)).trim();
  };

  for (const m of text.matchAll(TAG)) {
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (closing) {
      const popped = stack.pop();
      if (popped === 'atom:entry') {
        entries.push(current);
        current = null;
      }
      if (popped === 'atom:author') inAuthor = false;
      continue;
    }
    const self = selfClosing === '/';
    const attrs = attrsOf(rawAttrs);
    if (!DECLARED_ELEMENT.has(tag)) {
      note({ node: tag, attribute: null, where: current ? `version ${current.id ?? '?'}` : 'feed' });
      if (!self) stack.push(tag);
      continue;
    }
    const declared = DECLARED_ATTR.get(tag) ?? new Set();
    for (const a of Object.keys(attrs)) {
      if (!declared.has(a)) note({ node: tag, attribute: a, where: current ? `version ${current.id ?? '?'}` : 'feed' });
    }
    const after = m.index + m[0].length;

    switch (tag) {
      case 'atom:entry':
        current = {
          id: null,
          updated: null,
          author: null,
          title: null,
          contentSrc: null,
          contentType: null,
          transport: null,
          isTestTransport: attrs['adtcore:isTestTransport'] === 'true',
          links: 0,
        };
        break;
      case 'atom:author':
        inAuthor = true;
        break;
      case 'atom:name':
        if (current && inAuthor) current.author = textAfter(after) || null;
        break;
      case 'atom:id':
        if (current) current.id = textAfter(after);
        break;
      case 'atom:updated':
        if (current) current.updated = textAfter(after);
        else feedUpdated = textAfter(after);
        break;
      case 'atom:title':
        if (current) current.title = textAfter(after);
        else feedTitle = textAfter(after);
        break;
      case 'atom:content':
        if (current) {
          current.contentSrc = attrs.src ?? null;
          current.contentType = attrs.type ?? null;
        }
        break;
      case 'atom:link':
        if (current) {
          current.links += 1;
          if (attrs.rel !== TRANSPORT_REL) {
            note({ node: 'atom:link', attribute: 'rel', where: `version ${current.id ?? '?'}: ${attrs.rel}` });
          } else if (attrs.type === TRANSPORT_LINK_TYPE || !current.transport) {
            // The CTS-typed link is the one kept; the sapgui one names the same number.
            current.transport = {
              number: attrs['adtcore:name'] ?? null,
              href: attrs.type === TRANSPORT_LINK_TYPE ? (attrs.href ?? null) : null,
            };
          }
          if (attrs['adtcore:name'] && current.transport?.number && attrs['adtcore:name'] !== current.transport.number) {
            note({
              node: 'atom:link',
              attribute: 'adtcore:name',
              where: `version ${current.id ?? '?'}: two links name different transports`,
            });
          }
        }
        break;
      default:
        break;
    }
    if (!self) stack.push(tag);
  }
  if (current) entries.push(current); // an unterminated entry is still an entry, and the drift below says the document was odd
  if (stack.length) note({ node: stack[stack.length - 1], attribute: null, where: 'document not well-formed: unclosed element' });

  return { feedTitle, feedUpdated, entries, drift };
}

/**
 * The version history of one object across every feed the server published for it:
 * one row per transport, with the version numbers and feeds that named it. `copies` and
 * `transports` are split on `adtcore:isTestTransport` only; `activeVersion` is version
 * 00000 of each feed, and `holder` its transport where one is linked.
 */
export function unionByTransport(feeds) {
  const byNumber = new Map();
  const noLink = [];
  const active = [];
  for (const f of feeds) {
    for (const e of f.entries ?? []) {
      if (e.id === ACTIVE_VERSION) {
        active.push({ where: f.where, updated: e.updated, author: e.author, holder: e.transport?.number ?? null });
      }
      if (!e.transport?.number) {
        noLink.push({ where: f.where, version: e.id, updated: e.updated });
        continue;
      }
      const n = e.transport.number;
      const row = byNumber.get(n) ?? {
        number: n,
        href: e.transport.href,
        isTestTransport: e.isTestTransport,
        desc: e.title,
        authors: new Set(),
        versions: [],
        feeds: new Set(),
        first: e.updated,
        last: e.updated,
      };
      if (!row.href && e.transport.href) row.href = e.transport.href;
      if (e.author) row.authors.add(e.author);
      row.versions.push({ where: f.where, version: e.id, updated: e.updated });
      row.feeds.add(f.where);
      if (e.updated && (!row.first || e.updated < row.first)) row.first = e.updated;
      if (e.updated && (!row.last || e.updated > row.last)) row.last = e.updated;
      if (row.isTestTransport !== e.isTestTransport) row.mixedFlag = true;
      byNumber.set(n, row);
    }
  }
  const rows = [...byNumber.values()]
    .map((r) => ({
      number: r.number,
      href: r.href,
      isTestTransport: r.isTestTransport,
      ...(r.mixedFlag ? { mixedFlag: true } : {}),
      desc: r.desc,
      authors: [...r.authors].sort(),
      feeds: [...r.feeds],
      versions: r.versions,
      first: r.first,
      last: r.last,
    }))
    .sort((a, b) => String(b.last ?? '').localeCompare(String(a.last ?? '')) || a.number.localeCompare(b.number));
  return {
    transports: rows.filter((r) => !r.isTestTransport),
    copies: rows.filter((r) => r.isTestTransport),
    activeVersion: active,
    withoutLink: noLink,
  };
}
