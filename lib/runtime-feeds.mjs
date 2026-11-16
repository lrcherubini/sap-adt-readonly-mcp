// The ADT monitoring feeds -- what the Eclipse Feed Reader reads -- as measured
// (measurement; docs/adt-api-reference.md, three sections starting at
// "/sap/bc/adt/feeds"). Three parsers and one generator, all on declared shapes:
//
//   parseFeedCatalog   /sap/bc/adt/feeds         -> the feeds offered, each with its filter
//                                                   attributes, operators, paging, variants
//   parseDumpFeed      /sap/bc/adt/runtime/dumps -> one entry per ST22 dump, the report
//                                                   parsed OUT OF atom:summary (html): the
//                                                   list IS the detail, there is no second GET
//   parseGatewayFeed   /sap/bc/adt/gw/errorlog   -> the envelope is measured, the entries are
//                                                   NOT (the log was empty): generic atom
//                                                   entries, flagged as unmeasured
//   buildFeedQuery     structured filters         -> the catalogue's own prefix grammar,
//                                                   `and ( equals ( user , X ) )`; never text
//
// Two measurements drive the code:
//  1. ⚠️ The links of a dump entry are `adt://` URIs (the IDE's scheme). Sent over HTTP the id
//     (`/vit/runtime/dumps/...`) answers 404 with every accept; the summary carries the
//     header, the analysis, the source extract and the call stack, so the detail is a parse.
//     Round 15 (step 2) found the HTTP twin of the `self` link: `/sap/bc/adt/runtime/dump/<key>`
//     answers `application/vnd.sap.adt.runtime.dump.v1+xml` (header, links, chapter index --
//     parseDumpResource) and `<key>/formatted` the whole ST22 report as text/plain, chosen
//     variables included. Both are read through derivedGet kinds, never assembled.
//  2. ⚠️ `$query` in the OData-looking infix form is 400 on every attribute. The grammar is
//     the one the catalogue ships in `queryVariant/@queryString`, prefix form; this module
//     generates it from `{attribute, op, value}` triples against the MEASURED attribute ids,
//     and lib/adt-get.mjs refuses anything else at the route. At most TWO clauses, in the
//     COMMA form `and ( c1 , c2 )`: two clauses side by side inside the `and` DUMPED the
//     server (measurement, step 1f: ASSERTION_FAILED in CL_ADT_FQL_QUERY); the comma form was
//     proved to FILTER on 2026-09-14 (round 17: 33 entries with one clause, 9 and 6 with a
//     second). The one-clause form filtered on 7 of 7 attributes tried.
//
// Undeclared elements and attributes are reported as `drift`, never dropped silently.

export const FEED_ACCEPT = 'application/atom+xml;type=feed';
export const DRIFT_CODE = 'SHAPE_DRIFT';

/** The feeds this server reads, keyed by the short name a caller uses. Hrefs as the catalogue published them (2026-09-12). */
export const FEEDS = new Map([
  ['dumps', { route: 'runtimeDumps', href: '/sap/bc/adt/runtime/dumps', title: 'ABAP Runtime Errors', entriesMeasured: true }],
  ['gateway', { route: 'gatewayErrors', href: '/sap/bc/adt/gw/errorlog', title: 'SAP Gateway Error Log', entriesMeasured: false }],
  ['atc', { route: 'atcVerdicts', href: '/sap/bc/adt/atc/feeds/verdicts', title: 'ATC Findings', entriesMeasured: false }],
]);

/** Attribute ids per feed, verbatim from the catalogue; a filter on any other id is refused here. */
export const FEED_ATTRIBUTES = new Map([
  ['dumps', ['package', 'packageHierarchy', 'packageResponsible', 'objectResponsible', 'responsible', 'objectName', 'component', 'user', 'runtimeError', 'exception', 'datetime']],
  ['gateway', ['username', 'namespace', 'service_name', 't100_msgid', 't100_msgno', 'error_component', 'error_package', 'remote_address', 'request_uri', 'request_id', 'opid', 'transaction_id', 'timestamp']],
  ['atc', ['priority', 'applicationComponent', 'objectName', 'package', 'contactPerson']],
]);
/** One-operand operators the catalogue lists; `between`/`notBetween` take two and are not generated (not measured). */
export const FEED_OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'greater', 'greaterOrEquals', 'less', 'lessOrEquals'];
const VALUE = /^[A-Za-z0-9_/.:*+-]{1,60}$/;
/**
 * Two, in the comma form only. Two clauses side by side dumped the server (2026-09-12, round
 * 15). The comma form the catalogue publishes -- `and ( c1 , c2 )` -- answered 200 without a
 * dump and, measured, FILTERS: user alone 33
 * entries, user + notContains objectName 9 (and no mention of the excluded program in the
 * body), user + datetime >= today 6. The catalogue's queryDepth is 2; three is unmeasured.
 */
export const MAX_CLAUSES = 2;

export class FeedQueryViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'FeedQueryViolation';
  }
}

/**
 * `and ( equals ( user , X ) , notContains ( objectName , Y ) )` -- the catalogue's grammar,
 * from structured clauses; the clauses are joined with ` , ` and NEVER side by side (that
 * form dumped the server). Refuses before any URL exists: an id outside the measured set, an
 * operator the catalogue does not list, a value outside the alphabet, an empty list.
 */
export function buildFeedQuery(feed, clauses) {
  const ids = FEED_ATTRIBUTES.get(feed);
  if (!ids) throw new FeedQueryViolation(`'${feed}' is not a feed this server reads (${[...FEED_ATTRIBUTES.keys()].join(', ')}).`);
  if (!Array.isArray(clauses) || !clauses.length) throw new FeedQueryViolation('a query needs at least one clause.');
  if (clauses.length > MAX_CLAUSES) throw new FeedQueryViolation(`at most ${MAX_CLAUSES} clauses: the catalogue's queryDepth is 2 and a deeper query is unmeasured; ask twice.`);
  const parts = clauses.map((c, i) => {
    const attribute = String(c?.attribute ?? '');
    const op = String(c?.op ?? 'equals');
    const value = String(c?.value ?? '').trim();
    if (!ids.includes(attribute)) throw new FeedQueryViolation(`clause ${i + 1}: '${attribute}' is not an attribute of the ${feed} feed (${ids.join(', ')}).`);
    if (!FEED_OPERATORS.includes(op)) throw new FeedQueryViolation(`clause ${i + 1}: '${op}' is not an operator of the feed (${FEED_OPERATORS.join(', ')}).`);
    if (!VALUE.test(value)) throw new FeedQueryViolation(`clause ${i + 1}: '${value}' has a character the query alphabet does not allow (${VALUE}).`);
    return `${op} ( ${attribute} , ${value} )`;
  });
  return `and ( ${parts.join(' , ')} )`;
}

// --- XML helpers (the same regex approach as lib/object-versions.mjs) ---------------------------

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
const firstText = (s, el) => {
  const m = new RegExp(`<${el}(?:\\s[^>]*)?>([^<]*)</${el}>`).exec(s);
  return m ? unescapeXml(m[1]) : null;
};
const firstTag = (s, el) => new RegExp(`<${el}(\\s[^>]*)?/?>`).exec(s)?.[1] ?? null;
const allTags = (s, el) => [...s.matchAll(new RegExp(`<${el}(\\s[^>]*?)?/?>`, 'g'))].map((m) => attrsOf(m[1]));
const blocks = (s, el) => [...s.matchAll(new RegExp(`<${el}(?:\\s[^>]*)?>([\\s\\S]*?)</${el}>`, 'g'))].map((m) => m[1]);
const splitEntries = (s) => [...s.matchAll(/<atom:entry(?:\s[^>]*)?>([\s\S]*?)<\/atom:entry>/g)].map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), body: m[1] }));

/** Elements seen in a chunk, against a declared set: the drift rows. */
function driftOf(chunk, declared, where) {
  const seen = new Map();
  for (const m of chunk.matchAll(/<([A-Za-z][\w:.-]*)[\s/>]/g)) {
    const el = m[1];
    if (!declared.has(el)) seen.set(el, (seen.get(el) ?? 0) + 1);
  }
  return [...seen].map(([node, count]) => ({ node, count, where }));
}

// --- the catalogue -----------------------------------------------------------------------------

const CATALOG_ELEMENTS = new Set([
  'atom:feed', 'atom:author', 'atom:name', 'atom:contributor', 'atom:title', 'atom:updated',
  'atom:entry', 'atom:content', 'atom:id', 'atom:link', 'atom:published', 'atom:summary',
  'feed:extendedData', 'feed:refresh', 'feed:interval', 'feed:paging', 'feed:notification',
  'feed:operators', 'feed:operator', 'feed:label', 'feed:dataTypes', 'feed:dataType',
  'feed:attributes', 'feed:attribute', 'feed:queryIsObligatory', 'feed:queryDepth',
  'feed:queryVariants', 'feed:queryVariant',
]);

/** The feeds the system offers, each with what a query may say. */
export function parseFeedCatalog(xml) {
  const s = String(xml ?? '');
  const drift = driftOf(s, CATALOG_ELEMENTS, 'catalogue');
  const feeds = splitEntries(s).map(({ body }) => {
    const link = allTags(body, 'atom:link').find((l) => l.rel === 'alternate') ?? allTags(body, 'atom:link')[0] ?? {};
    const ext = blocks(body, 'feed:extendedData')[0] ?? '';
    const interval = attrsOf(firstTag(ext, 'feed:interval'));
    const paging = attrsOf(firstTag(ext, 'feed:paging'));
    const notification = attrsOf(firstTag(ext, 'feed:notification'));
    const operators = allTags(blocks(ext, 'feed:operators')[0] ?? '', 'feed:operator')
      .filter((o) => o.numberOfOperands)
      .map((o) => ({ id: o.id, operands: Number(o.numberOfOperands), kind: o.kind ?? null }));
    const attributes = blocks(ext, 'feed:attribute').map((a, i) => {
      const tag = [...ext.matchAll(/<feed:attribute(\s[^>]*)?>/g)][i]?.[1];
      return {
        id: attrsOf(tag).id ?? null,
        dataType: attrsOf(firstTag(a, 'feed:dataType')).id ?? null,
        label: firstText(a, 'feed:label'),
        operators: allTags(a, 'feed:operator').map((o) => o.id),
      };
    });
    return {
      title: firstText(body, 'atom:title'),
      href: link.href ?? firstText(body, 'atom:id'),
      accept: link.type ?? null,
      summary: firstText(body, 'atom:summary'),
      published: firstText(body, 'atom:published'),
      refresh: interval.value ? `${interval.value} ${interval.unit ?? ''}`.trim() : null,
      paging: paging.size ? { size: Number(paging.size), max: paging.max ? Number(paging.max) : null } : null,
      notification: notification.isEnabled === 'true',
      queryIsObligatory: firstText(ext, 'feed:queryIsObligatory') === 'true',
      queryDepth: Number(firstText(ext, 'feed:queryDepth') ?? 0) || null,
      operators,
      attributes,
      variants: allTags(ext, 'feed:queryVariant').map((v) => ({ query: v.queryString ?? null, title: v.title ?? null, isDefault: v.isDefault === 'true' })),
    };
  });
  return { title: firstText(s, 'atom:title'), updated: firstText(s, 'atom:updated'), feeds, drift };
}

// --- the dumps ---------------------------------------------------------------------------------

const DUMP_ELEMENTS = new Set([
  'atom:feed', 'atom:author', 'atom:name', 'atom:contributor', 'atom:icon', 'atom:link', 'atom:title',
  'atom:updated', 'atom:entry', 'atom:category', 'atom:id', 'atom:published', 'atom:summary',
]);
const DUMP_ENTRY_ATTRS = new Set(['xml:lang']);
const DUMP_LINK_ATTRS = new Set(['href', 'rel', 'type']);
const LABEL_ERROR = 'ABAP runtime error';
const LABEL_PROGRAM = 'Terminated ABAP program';

/** Plain text of an HTML fragment: tags out, entities decoded, whitespace folded. */
const htmlText = (h) =>
  unescapeXml(
    String(h ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h4)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

/**
 * The sections of the ST22 report by the `id` of their `<h4>` (measured): the heading text is in
 * the system's language, the id is not. OVERVIEW is the table of contents, links to the others.
 */
const SECTIONS = new Map([
  ['HEADERX', 'header'],
  ['WHATHAPPENED', 'whatHappened'],
  ['ERROR', 'errorAnalysis'],
  ['TERMINATION', 'whereTerminated'],
  ['SOURCE', 'sourceExtract'],
  ['STACK', 'stack'],
]);

/**
 * The dump report out of `atom:summary` (type=html): header fields, the three analysis texts,
 * the source extract with the failing line marked, and the call stack with the ADT position
 * each frame links to. Sections the measured summary does not have are drift. The header is a
 * list of `{label, value}` as the system wrote them, in its language.
 */
export function parseDumpSummary(html) {
  const h = unescapeXml(html);
  const out = { header: [], whatHappened: null, errorAnalysis: null, whereTerminated: null, sourceExtract: [], stack: [], drift: [] };
  const heads = [...h.matchAll(/<h4([^>]*)>([^<]*)<\/h4>/g)];
  for (const [i, m] of heads.entries()) {
    const id = /\bid="([^"]*)"/.exec(m[1])?.[1] ?? null;
    const key = SECTIONS.get(id);
    const chunk = h.slice(m.index + m[0].length, heads[i + 1]?.index ?? h.length);
    if (id === 'OVERVIEW') continue;
    if (!key) {
      out.drift.push({ node: 'h4', count: 1, where: id ?? unescapeXml(m[2]).trim() });
      continue;
    }
    if (key === 'header') {
      for (const row of blocks(chunk, 'tr')) {
        const cells = blocks(row, 'td').map(htmlText);
        if (cells.length >= 2) out.header.push({ label: cells[0].replace(/\s+/g, ' ').trim(), value: cells.slice(1).join(' ').trim() });
        // A row with a cell but no value is not a header field: counted, never dropped in silence.
        else if (cells.length === 1) out.drift.push({ node: 'header row', count: 1, where: 'one cell, no value' });
      }
    } else if (key === 'sourceExtract') {
      // Two columns: `span.linenumber` per line (the failing one holds `>>` instead of its
      // number) and `div.sourceline` per line (`highlight` on the failing one). Paired by
      // position; the marked line's number is the previous one plus one.
      const nums = [...chunk.matchAll(/<span class="linenumber">([\s\S]*?)<\/span>/g)].map((m) => htmlText(m[1]));
      const code = [...chunk.matchAll(/<div[^>]*class="sourceline[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => unescapeXml(m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')));
      const n = Math.min(nums.length, code.length);
      let last = null;
      for (let k = 0; k < n; k++) {
        const marked = nums[k].includes('>>');
        const line = marked ? (last === null ? null : last + 1) : Number(nums[k].replace(/[^0-9]/g, '')) || null;
        last = line ?? last;
        out.sourceExtract.push({ line, marked, code: code[k].replace(/\s+$/, '') });
      }
      if (nums.length !== code.length) out.drift.push({ node: 'sourceExtract', count: Math.abs(nums.length - code.length), where: 'line numbers and source lines disagree' });
    } else if (key === 'stack') {
      const rows = blocks(chunk, 'tr');
      for (const row of rows) {
        const cells = blocks(row, 'td');
        if (!cells.length) continue; // the header row is <th>
        if (cells.length < 5) {
          out.drift.push({ node: 'stack row', count: 1, where: `${cells.length} cells, not 5` });
          continue;
        }
        const href = /href="([^"]*)"/.exec(cells[0])?.[1] ?? null;
        out.stack.push({
          no: Number(htmlText(cells[0])) || null,
          event: htmlText(cells[1]),
          program: htmlText(cells[2]),
          include: htmlText(cells[3]),
          line: Number(htmlText(cells[4])) || null,
          uri: href ? unescapeXml(href).replace(/^adt:\/\/[^/]+/, '') : null,
        });
      }
    } else {
      out[key] = htmlText(chunk);
    }
  }
  return out;
}

/**
 * The ST22 list. `withReport: false` keeps the entries light (identity, error, program,
 * user, time, links); `true` parses the report out of each summary.
 */
export function parseDumpFeed(xml, { withReport = true } = {}) {
  const s = String(xml ?? '');
  const drift = driftOf(s.replace(/<atom:summary[^>]*>[\s\S]*?<\/atom:summary>/g, ''), DUMP_ELEMENTS, 'feed');
  const head = s.slice(0, s.indexOf('<atom:entry') >= 0 ? s.indexOf('<atom:entry') : s.length);
  const selfLink = allTags(head, 'atom:link').find((l) => l.rel === 'self')?.href ?? null;
  const entries = splitEntries(s).map(({ tag, body }, i) => {
    for (const a of Object.keys(attrsOf(tag))) if (!DUMP_ENTRY_ATTRS.has(a)) drift.push({ node: 'atom:entry', attribute: a, count: 1, where: `entry ${i + 1}` });
    const links = allTags(body, 'atom:link');
    for (const l of links) for (const a of Object.keys(l)) if (!DUMP_LINK_ATTRS.has(a)) drift.push({ node: 'atom:link', attribute: a, count: 1, where: `entry ${i + 1}` });
    // The labels are in the system's language; the measured order is the error, then the
    // program (every entry, English and German). An English label wins; else two categories are
    // read by position; else nothing is guessed, and the categories ride on the entry as sent.
    const categories = allTags(body, 'atom:category').map((c) => ({ term: c.term ?? null, label: c.label ?? null }));
    const labelled = categories.some((c) => c.label === LABEL_ERROR || c.label === LABEL_PROGRAM);
    const byPosition = !labelled && categories.length === 2;
    const runtimeError = byPosition ? categories[0].term : categories.find((c) => c.label === LABEL_ERROR)?.term ?? null;
    const program = byPosition ? categories[1].term : categories.find((c) => c.label === LABEL_PROGRAM)?.term ?? null;
    const unread = !byPosition && categories.length > 0 && (runtimeError === null || program === null);
    if (unread) drift.push({ node: 'atom:category', count: categories.length, where: `entry ${i + 1}: not the measured error and program` });
    const authorTag = firstTag(body, 'atom:author');
    const id = firstText(body, 'atom:id');
    const summaryHtml = /<atom:summary[^>]*>([\s\S]*?)<\/atom:summary>/.exec(body)?.[1] ?? '';
    const summaryType = attrsOf(firstTag(body, 'atom:summary')).type ?? null;
    if (summaryType !== 'html') drift.push({ node: 'atom:summary', attribute: 'type', count: 1, where: `entry ${i + 1}: ${summaryType}` });
    const entry = {
      id,
      key: id ? decodeURIComponent(id.slice(id.lastIndexOf('/') + 1)).replace(/\s+/g, ' ').trim() : null,
      title: firstText(body, 'atom:title'),
      runtimeError,
      program,
      ...(unread ? { categories } : {}),
      user: firstText(body, 'atom:name'),
      userFullName: attrsOf(authorTag).FullName ?? null,
      published: firstText(body, 'atom:published'),
      links: {
        gui: links.find((l) => l.rel === 'alternate')?.href ?? null,
        self: links.find((l) => l.rel === 'self')?.href ?? null,
      },
    };
    if (withReport) {
      const report = parseDumpSummary(summaryHtml);
      for (const d of report.drift) drift.push({ ...d, where: `entry ${i + 1}: ${d.where}` });
      delete report.drift;
      entry.report = report;
    }
    return entry;
  });
  return { title: firstText(head, 'atom:title'), updated: firstText(head, 'atom:updated'), self: selfLink, entries, drift };
}

/**
 * The dumps of one page, grouped: the same runtime error in the same program is one row with a
 * count, the first and last time and the ids. The light entry carries no line, so the line is
 * part of the key only when the report was parsed (the marked line of the source extract).
 * Local work on the page read -- it says nothing about the dumps the page did not hold.
 * Largest group first, then the most recent.
 */
export function groupDumps(entries) {
  const groups = new Map();
  for (const e of entries ?? []) {
    const withLine = Boolean(e.report);
    const line = withLine ? e.report.sourceExtract?.find((l) => l.marked)?.line ?? null : undefined;
    const key = JSON.stringify([e.runtimeError, e.program, line ?? null]);
    let g = groups.get(key);
    if (!g) {
      g = { runtimeError: e.runtimeError, program: e.program, ...(withLine ? { line } : {}), count: 0, first: null, last: null, ids: [] };
      groups.set(key, g);
    }
    g.count += 1;
    if (e.published && (g.first === null || e.published < g.first)) g.first = e.published;
    if (e.published && (g.last === null || e.published > g.last)) g.last = e.published;
    g.ids.push(e.id);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || String(b.last ?? '').localeCompare(String(a.last ?? '')));
}

// --- the gateway log ---------------------------------------------------------------------------

const GATEWAY_ELEMENTS = new Set(['atom:feed', 'atom:icon', 'atom:title']);

/**
 * A feed whose ENVELOPE is measured and whose entries are not -- the gateway error log
 * (2026-09-12: 264 bytes, zero entries) and the ATC verdicts feed (round 15: 244 bytes, zero
 * entries). Entries are parsed generically -- title, id, published, updated, author,
 * categories, links, summary as text, and the list of every element seen -- and flagged
 * `measured: false`: whoever reads a non-empty one first transcribes the shape into the
 * dossier and promotes this parser.
 */
export function parseGenericFeed(xml) {
  const s = String(xml ?? '');
  const head = s.slice(0, s.indexOf('<atom:entry') >= 0 ? s.indexOf('<atom:entry') : s.length);
  const drift = driftOf(head, GATEWAY_ELEMENTS, 'feed');
  const entries = splitEntries(s).map(({ body }) => ({
    id: firstText(body, 'atom:id'),
    title: firstText(body, 'atom:title'),
    published: firstText(body, 'atom:published'),
    updated: firstText(body, 'atom:updated'),
    author: firstText(body, 'atom:name'),
    categories: allTags(body, 'atom:category').map((c) => ({ term: c.term ?? null, label: c.label ?? null })),
    links: allTags(body, 'atom:link').map((l) => ({ href: l.href ?? null, rel: l.rel ?? null, type: l.type ?? null })),
    summary: htmlText(/<atom:summary[^>]*>([\s\S]*?)<\/atom:summary>/.exec(body)?.[1] ?? '') || null,
    elements: [...new Set([...body.matchAll(/<([A-Za-z][\w:.-]*)[\s/>]/g)].map((m) => m[1]))],
  }));
  return { title: firstText(head, 'atom:title'), entries, measured: false, drift };
}
export const parseGatewayFeed = parseGenericFeed;

// --- the dump resource -------------------------------------------------------------

const DUMP_RESOURCE_ELEMENTS = new Set(['dump:dump', 'dump:links', 'dump:link', 'dump:chapters', 'dump:chapter']);

/**
 * The HTTP path of a dump from the `adt://<SID>/sap/bc/adt/runtime/dump/<key>` self link of
 * its entry -- the scheme and system dropped, nothing else touched (the key stays percent-
 * encoded: its blanks are part of the ST22 key). null for any other link.
 */
export function dumpPathOf(link) {
  const m = /^(?:adt:\/\/[A-Za-z0-9_]+)?(\/sap\/bc\/adt\/runtime\/dump\/[A-Za-z0-9_%.-]{1,160})$/.exec(String(link ?? '').trim());
  return m ? m[1] : null;
}

/**
 * `application/vnd.sap.adt.runtime.dump.v1+xml`: the dump's header attributes, its links
 * (formatted/unformatted text, summary html, termination position, GUI, self) and the chapter
 * index -- each chapter with the LINE where it starts in the formatted report, so a reader of
 * `/formatted` can jump to "Chosen variables" without a second request.
 */
export function parseDumpResource(xml) {
  const s = String(xml ?? '');
  const drift = driftOf(s, DUMP_RESOURCE_ELEMENTS, 'dump');
  const head = attrsOf(firstTag(s, 'dump:dump'));
  const links = allTags(s, 'dump:link').map((l) => ({ relation: l.relation ?? null, uri: l.uri ?? null, contentType: l.contentType ?? null }));
  const chapters = allTags(s, 'dump:chapter')
    .map((c) => ({
      name: c.name ?? null,
      title: c.title ?? null,
      category: c.category ?? null,
      line: Number(c.line ?? NaN),
      order: Number(c.chapterOrder ?? NaN),
    }))
    .sort((a, b) => a.order - b.order);
  return {
    title: head.title ?? null,
    error: head.error ?? null,
    exception: head.exception || null,
    author: head.author ?? null,
    terminatedProgram: head.terminatedProgram ?? null,
    serverInstance: head.serverInstance ?? null,
    datetime: head.datetime ?? null,
    language: head.language ?? null,
    links,
    chapters,
    drift,
  };
}

// --- the audit key -----------------------------------------------------------------------------

export const auditKeyOf = (key) => {
  // The id percent-encodes the key's spaces (%20); an ill-formed escape is left as it is.
  const tail = String(key ?? '').trim().split('/').pop().replace(/%[0-9A-Fa-f]{2}/g, (h) => String.fromCharCode(parseInt(h.slice(1), 16)));
  const parts = tail.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]}` : parts[0];
};
