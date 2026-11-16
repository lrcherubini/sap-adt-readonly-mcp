// adt_runtime_errors -- what the Eclipse Feed Reader shows: ST22 dumps and the gateway log.
//
// The question: "what dumped, where, and on which line" -- asked from a terminal, with the IDE
// closed, by the person who has to read the stack. Measured (measurement;
// docs/adt-api-reference.md, the three feed sections). Three modes, none a default:
//
//   feeds: true                         the catalogue: which feeds exist, with the attributes a
//                                       filter may name -- one GET on `feedCatalog`
//   list: {feed, filters?, max?, skip?, report?}
//                                       the entries of ONE feed (`dumps` | `gateway`); `filters`
//                                       become the catalogue's own `$query`, GENERATED from
//                                       {attribute, op, value} and never taken as text;
//                                       `report: true` parses the whole ST22 report per entry
//   detail: {id, max?, full?}           ONE dump in full, by the `id` a list answer gave: the
//                                       list is re-read and the entry found by id (`max` bounds
//                                       how far it looks); then the dump RESOURCE behind the
//                                       entry's self link (header, links, chapter index; round
//                                       15) and, with `full: true`, the whole ST22 report as
//                                       text -- chosen variables included
//
// What the audit carries: the feed, the page and whether a filter was sent; for a dump, the
// timestamp+host+sequence of its key -- never the SAP user in it, never a title. What the
// answer carries: everything the feed says, including other people's user ids and names, since
// that is the question (whose dump). The journal carries FEED_NOT_READ (a failed read is NOT an
// empty log) and DUMP_NOT_READ (an id not among the entries read is NOT a dump that is gone).

import { record } from '../lib/audit.mjs';
import { namedGet, derivedGet, transportFor } from '../lib/adt-get.mjs';
import {
  FEEDS,
  FEED_ATTRIBUTES,
  FEED_OPERATORS,
  MAX_CLAUSES,
  DRIFT_CODE,
  buildFeedQuery,
  parseFeedCatalog,
  parseDumpFeed,
  groupDumps,
  parseGenericFeed,
  parseDumpResource,
  dumpPathOf,
  auditKeyOf,
} from '../lib/runtime-feeds.mjs';
import { finish } from '../lib/completeness.mjs';

/** The server's own "since" of a feed: the `from` of its self link (yyyymmddhhmmss), or null. */
const windowOf = (self) => {
  const from = /[?&]from=(\d{14})/.exec(String(self ?? ''))?.[1] ?? null;
  return { from, source: from ? 'the feed self link (?from=)' : 'the feed states none' };
};
const driftEntry = (list, drift) => (drift?.length ? [{ list, code: 'PARSE_FAILED', count: drift.length, reason: 'the reply carries what the measured shape does not describe: see drift' }] : []);

export const DEFAULT_MAX = 50;
export const MAX_MAX = 100;

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

const capOf = (v, fallback) => {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MAX) throw new Error(`max must be an integer from 1 to ${MAX_MAX}; got ${v}.`);
  return n;
};

/**
 * The audit subject of a dump: the key without the user in it (stamp+host, sequence). Accepts
 * the bare key or the adt:// id, whose last path segment is the key percent-encoded.
 */
export { auditKeyOf };

export function runtimeErrorsTool(cfg, session, journal) {
  const gap = (g) => journal?.enabled && journal.gap(g);

  async function read(route, params, subject, fallback) {
    const transport = transportFor(session.raw);
    try {
      return await namedGet(transport, route, params);
    } catch (e) {
      // A RouteViolation never reached the network: a caller error, not an ADT gap.
      if (e?.name !== 'RouteViolation') {
        gap({
          code: 'FEED_NOT_READ',
          subject,
          detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? route}: ${e?.message}`,
          impact: 'nothing was read from this feed -- this is NOT an empty log and NOT zero dumps',
          fallback,
        });
      }
      throw e;
    }
  }

  const driftGap = (subject, drift) =>
    drift.length &&
    gap({
      code: DRIFT_CODE,
      subject,
      detail: drift.slice(0, 12).map((d) => `${d.attribute ? `${d.node}/@${d.attribute}` : d.node} x${d.count}${d.where ? ` (${d.where})` : ''}`).join('; '),
      impact: 'the entries stand; the measured shape of the feed has aged and the parser may be dropping something',
      fallback: 'compare with the Feed Reader in Eclipse ADT; re-measure (docs/adt-api-reference.md)',
    });

  async function catalogue() {
    const out = await read('feedCatalog', {}, 'feed catalogue', 'the Feed Reader view in Eclipse ADT lists the same feeds');
    record(cfg, 'adt_runtime_errors', 'feeds', out.bytes);
    const parsed = parseFeedCatalog(out.body);
    driftGap('feed catalogue', parsed.drift);
    return asText(finish({
      mode: 'feeds',
      rule: 'a feed is read only through the hrefs this catalogue publishes; a $query is generated from its attributes, never typed',
      readable: [...FEEDS].map(([name, f]) => ({ name, href: f.href, entriesMeasured: f.entriesMeasured })),
      title: parsed.title,
      updated: parsed.updated,
      feeds: parsed.feeds,
      ...(parsed.drift.length ? { drift: parsed.drift } : {}),
    }, driftEntry('feeds', parsed.drift)));
  }

  // The dump resource and, on request, the formatted report -- both through derivedGet
  // kinds on the path of the entry's own self link. A failure leaves the summary-based
  // detail standing and says what was not read; it never reads as "no such chapter".
  async function resourceOf(hit, key, full) {
    const path = dumpPathOf(hit.links?.self);
    const formattedPart = { asked: full === true, read: false };
    if (!path) return { resourcePart: { read: false }, formattedPart, resourceNote: 'the entry publishes no /runtime/dump/ self link; the resource was not asked' };
    const transport = transportFor(session.raw);
    const out = { resourcePart: { read: false }, formattedPart };
    try {
      const r = await derivedGet(transport, path, path, { kind: 'runtimeDump' });
      record(cfg, 'adt_runtime_errors', `dump ${key} resource`, r.bytes);
      out.resource = parseDumpResource(r.body);
      out.resourcePart = { read: true };
      driftGap(`dump resource`, out.resource.drift);
    } catch (e) {
      gap({
        code: 'DUMP_NOT_READ',
        subject: key,
        detail: `HTTP ${e?.status ?? '?'} on the dump resource: ${e?.message}`,
        impact: 'the entry stands (summary parsed); the chapter index and links were not read',
        fallback: 'ST22 by date, time and user',
      });
      out.resourceNote = `dump resource not read: ${e?.message}`;
    }
    if (full === true) {
      try {
        const t = await derivedGet(transport, path, 'formatted', { kind: 'runtimeDumpText' });
        record(cfg, 'adt_runtime_errors', `dump ${key} formatted`, t.bytes);
        out.formatted = t.body;
        formattedPart.read = true;
      } catch (e) {
        gap({
          code: 'DUMP_NOT_READ',
          subject: key,
          detail: `HTTP ${e?.status ?? '?'} on the formatted report: ${e?.message}`,
          impact: 'the full report (with the chosen variables) was not read; the summary stands',
          fallback: 'ST22 by date, time and user',
        });
        out.formattedNote = `formatted report not read: ${e?.message}`;
      }
    }
    return out;
  }

  async function list({ feed, filters, max, skip, report } = {}, { pickId, full } = {}) {
    const spec = FEEDS.get(String(feed ?? ''));
    if (!spec) throw new Error(`list.feed must be one of ${[...FEEDS.keys()].join(', ')}; got '${feed}'.`);
    const top = capOf(max, DEFAULT_MAX);
    const params = { $top: String(top) };
    if (skip !== undefined && skip !== null) {
      const n = Number(skip);
      if (!Number.isInteger(n) || n < 0 || n > 99999) throw new Error(`skip must be an integer from 0 to 99999; got ${skip}.`);
      if (n > 0) params.$skip = String(n);
    }
    let query = null;
    if (filters !== undefined && filters !== null) {
      // Refused here, then again by the route's regex: two statements of one rule.
      query = buildFeedQuery(feed, filters);
      params.$query = query;
    }
    const subject = `${feed} top=${top}${params.$skip ? ` skip=${params.$skip}` : ''}${query ? ' filtered' : ''}`;
    const out = await read(spec.route, params, `${feed} feed`, 'the Feed Reader in Eclipse ADT, or ST22 / /IWFND/ERROR_LOG in the SAP GUI');
    record(cfg, 'adt_runtime_errors', pickId ? `dump ${auditKeyOf(pickId)}` : subject, out.bytes);

    const parsed = feed === 'dumps' ? parseDumpFeed(out.body, { withReport: report === true || Boolean(pickId) }) : parseGenericFeed(out.body);
    driftGap(`${feed} feed`, parsed.drift);

    if (pickId) {
      const wanted = String(pickId).trim();
      const hit = parsed.entries.find((e) => e.id === wanted || e.key === wanted);
      if (!hit) {
        gap({
          code: 'DUMP_NOT_READ',
          subject: auditKeyOf(wanted),
          detail: `not among the ${parsed.entries.length} entries the ${feed} feed answered (top=${top})`,
          impact: 'the dump was not read -- this is NOT evidence that it was deleted from ST22',
          fallback: 'raise max, or open the dump in ST22 by its date, time and user',
        });
        throw new Error(`dump '${wanted}' is not among the ${parsed.entries.length} entries read (max=${top}). Raise max, or list first and pass the id it answers.`);
      }
      const more = await resourceOf(hit, auditKeyOf(hit.key ?? wanted), full);
      const incomplete = [...driftEntry('entry', [...parsed.drift, ...(hit.report?.drift ?? []), ...(more.resource?.drift ?? [])])];
      if (!more.resourcePart.read) incomplete.push({ list: 'resource', code: 'NOT_READ', reason: more.resourceNote ?? 'not read' });
      if (more.formattedPart.asked && !more.formattedPart.read) incomplete.push({ list: 'formatted', code: 'NOT_READ', reason: more.formattedNote ?? 'not read' });
      return asText(finish({
        mode: 'detail',
        rule:
          'the report is parsed out of the entry itself; the dump resource is read at the HTTP twin of ' +
          'the entry\'s self link (never assembled), and the formatted report only on full: true',
        searched: parsed.entries.length,
        entry: hit,
        ...more,
        ...(parsed.drift.length ? { drift: parsed.drift } : {}),
      }, incomplete));
    }

    // The server pages ($top/$skip) and gives no total: a full page may have more behind it,
    // so it is SERVER_PAGE_FULL with the next skip, never a hedge.
    const skipped = Number(params.$skip ?? 0);
    const pageFull = parsed.entries.length >= top;
    const next = pageFull ? { skip: skipped + parsed.entries.length } : null;
    const reportDrift = parsed.entries.flatMap((e) => e.report?.drift ?? []);
    const incomplete = [...driftEntry('entries', [...parsed.drift, ...reportDrift])];
    if (pageFull) incomplete.push({ list: 'entries', code: 'SERVER_PAGE_FULL', returned: parsed.entries.length, total: null, next });
    return asText(finish({
      mode: 'list',
      feed,
      rule: 'released by the server as-is; $top pages, $query filters, nothing is read beyond this page',
      query,
      page: { top, skip: skipped, returned: parsed.entries.length, truncated: pageFull, ...(next ? { next } : {}) },
      count: parsed.entries.length,
      serverWindow: windowOf(parsed.self),
      ...(parsed.self ? { self: parsed.self } : {}),
      ...(parsed.measured === false ? { entriesMeasured: false } : {}),
      ...(feed === 'dumps'
        ? {
            groups: groupDumps(parsed.entries),
            groupedBy: report === true ? 'runtime error, program and the marked line, on this page only' : 'runtime error and program, on this page only (report: true adds the line)',
          }
        : {}),
      entries: parsed.entries,
      ...(parsed.drift.length ? { drift: parsed.drift } : {}),
    }, incomplete));
  }

  return {
    definition: {
      name: 'adt_runtime_errors',
      description:
        'ST22 dumps, the gateway error log and ATC findings, as the Feed Reader shows them. One ' +
        'mode per call: `feeds: true` (feeds and their filter attributes), `list` (one page of ' +
        `one feed, up to ${MAX_CLAUSES} filters ANDed; dump attributes: ` +
        `${FEED_ATTRIBUTES.get('dumps').join(', ')}), or \`detail: {id}\` (one dump: analysis, ` +
        'source extract, call stack; `full: true` adds the whole report). `report: true` on a ' +
        'list is ~17 KB per dump. Dump lists add `groups`. Gateway ' +
        'and ATC entries are not yet measured.',
      inputSchema: {
        type: 'object',
        properties: {
          feeds: { type: 'boolean', description: 'true: the catalogue of feeds and their filter attributes' },
          list: {
            type: 'object',
            properties: {
              feed: { type: 'string', enum: [...FEEDS.keys()] },
              filters: {
                type: 'array',
                maxItems: MAX_CLAUSES,
                items: {
                  type: 'object',
                  properties: {
                    attribute: { type: 'string', description: 'an attribute id of the feed (see feeds: true)' },
                    op: { type: 'string', enum: FEED_OPERATORS, description: 'default equals' },
                    value: { type: 'string', description: 'letters, digits, _ / . : * + - (max 60)' },
                  },
                  required: ['attribute', 'value'],
                },
              },
              max: { type: 'integer', description: `entries per page, 1..${MAX_MAX} (default ${DEFAULT_MAX})` },
              skip: { type: 'integer', description: 'entries to skip ($skip)' },
              report: { type: 'boolean', description: 'dumps only: include the parsed ST22 report per entry' },
            },
            required: ['feed'],
          },
          detail: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'the entry id (or key) a list answered' },
              max: { type: 'integer', description: `how many entries to search, 1..${MAX_MAX} (default ${DEFAULT_MAX})` },
              full: { type: 'boolean', description: 'also read the whole formatted ST22 report (text, chosen variables included)' },
            },
            required: ['id'],
          },
        },
      },
    },
    async handler(args = {}) {
      const wantsFeeds = args.feeds === true;
      const wantsList = args.list !== undefined && args.list !== null;
      const wantsDetail = args.detail !== undefined && args.detail !== null;
      if ([wantsFeeds, wantsList, wantsDetail].filter(Boolean).length > 1) {
        throw new Error('adt_runtime_errors takes `feeds` OR `list` OR `detail`, never two. Ask twice.');
      }
      if (!wantsFeeds && !wantsList && !wantsDetail) {
        throw new Error(
          'adt_runtime_errors has no default mode. Pass `feeds: true` for the catalogue, ' +
            '`list: {feed: "dumps"}` for one page of dumps, or `detail: {id}` for one dump in full.'
        );
      }
      if (!session?.raw) throw new Error('this session has no raw client: the feeds cannot be read.');
      if (wantsFeeds) return catalogue();
      if (wantsList) return list(args.list);
      const id = String(args.detail.id ?? '').trim();
      if (!id) throw new Error('detail.id is required: the id (or key) a list answered.');
      return list({ feed: 'dumps', max: args.detail.max }, { pickId: id, full: args.detail.full === true });
    },
  };
}
