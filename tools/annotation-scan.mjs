// adt_annotation_scan -- which annotations reach a CDS element, read off the sources of a package.
//
// The sources come from the system: the DDLS and DDLX of the package (one call per object,
// lib/package-sources.mjs), then -- within a cap -- the upstream views they select from, so a
// hide written in a STANDARD view is seen too, which no checkout could ever show.
//
// It exists for one reason: `adt_annotation_chain` gives the VERDICT, and costs one ADT
// call per element. A package with hundreds of elements cannot be swept that way. So this
// answers the cheap half -- who wrote what, and where -- and ranks which elements deserve the
// call that decides.
//
// TWO MODES, and the difference is the honesty of the claim:
//
//   lookup  (`element` given)  -- "these annotations reach this element, from these
//           layers". A listing. It picks no winner, because the source cannot: two
//           `annotate entity` layers that disagree are both shown.
//   detect  (no `element`)     -- runs the detectors and turns each hit into a finding.
//           Every one is a SUSPICION: a switch, a kernel layer or an IS_ACTIVE flag can
//           silence a contribution that reads as live in the source.
//
// What it deliberately does NOT do is judge by name. Any annotation may be written inline
// in the DDLS -- the DDLX object is technically optional, even though creating it is the
// right practice -- so the index carries every key it finds, from both layers.

import { indexSources, emptyIndex, missingUpstream, reaching } from '../lib/annotation-index.mjs';
import { detectHiddenWithRole, findingForHidden } from '../lib/annotation-detectors.mjs';
import { packageSources, readSources, packageGaps, packageIncomplete, scopeOf, DEFAULT_MAX_OBJECTS, MAX_OBJECTS } from '../lib/package-sources.mjs';
import { progressOf } from '../lib/tool-meta.mjs';
import { finish, page } from '../lib/completeness.mjs';
import { invalidArguments } from '../lib/tool-error.mjs';

export const DEFAULT_UPSTREAM = 20;
export const MAX_UPSTREAM = 60;
/** Upstream hops followed at most: a chain deeper than this is declared, not cut in silence. */
export const UPSTREAM_ROUNDS = 8;
/** Rows (lookup) or findings (detect) in one answer; `rowsOffset` pages the rest. */
export const ROWS_CEILING = 1000;
const LAYER = { 'DDLS/DF': 'ddls', 'DDLX/EX': 'ddlx' };
const TTL_MS = 10 * 60 * 1000;

/**
 * The index of one package, kept for ten minutes: a lookup per element is the normal way to use
 * this tool, and re-reading the package for each one would multiply its cost. `refresh: true`
 * rebuilds it; a change made in the system meanwhile is otherwise seen at the next rebuild.
 */
const cache = new Map();
/** Indexes kept at once. Each holds the parsed sources of a package: the newest ones stay. */
export const MAX_INDEXES = 8;

/**
 * Store one index, and drop what the store no longer owes anybody: every entry past its
 * lifetime, then the oldest ones beyond the cap. The lifetime used to be checked only when an
 * entry was read, so an index nobody asked for again stayed for as long as the process ran.
 */
export function keepIndex(store, key, value, { now = Date.now(), ttl = TTL_MS, max = MAX_INDEXES } = {}) {
  for (const [k, entry] of store) if (now - entry.at >= ttl) store.delete(k);
  // Deleted first, so a rebuilt index moves to the end: the Map's order is oldest first.
  store.delete(key);
  store.set(key, { at: now, value });
  while (store.size > max) store.delete(store.keys().next().value);
}

/** Test seam: the next call rebuilds. Never called by the server. */
export function resetAnnotationIndexCache() {
  cache.clear();
}

async function indexFor(cfg, api, args, extra) {
  const pkg = String(args.package).toUpperCase();
  const recursive = args.recursive !== false;
  const upstreamCap = Math.min(Number.isInteger(args.upstream) ? args.upstream : DEFAULT_UPSTREAM, MAX_UPSTREAM);
  const key = `${pkg}|${recursive}|${args.maxObjects ?? ''}|${args.offset ?? 0}|${upstreamCap}`;
  const hit = cache.get(key);
  if (hit && !args.refresh && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true, ageSeconds: Math.round((Date.now() - hit.at) / 1000) };

  const progress = progressOf(extra);
  const read = await packageSources(api, pkg, {
    types: ['DDLS/DF', 'DDLX/EX'],
    recursive,
    max: args.maxObjects,
    offset: args.offset,
    cfg,
    tool: 'adt_annotation_scan',
    signal: extra.signal,
    progress,
  });
  const index = indexSources(read.read.map((o) => ({ file: `${o.package}/${o.name.toLowerCase()}.${LAYER[o.type]}`, repo: pkg, layer: LAYER[o.type], text: o.text })), emptyIndex());

  // Upstream, breadth first: the views the package selects from, then theirs, until the cap.
  // A name that is a table (no DDLS behind it) answers 404 -- expected, and listed apart from a
  // view that could not be read, which IS a hole in the chain.
  const upstream = { read: [], notFound: [], notRead: [], left: [], rounds: 0, stoppedBy: null };
  let budget = upstreamCap;
  const tried = new Set();
  for (let round = 0; round < UPSTREAM_ROUNDS && budget > 0 && !extra.signal?.aborted; round++) {
    const names = missingUpstream(index).filter((n) => !tried.has(n));
    if (!names.length) break;
    upstream.rounds = round + 1;
    const batch = names.slice(0, budget);
    batch.forEach((n) => tried.add(n));
    budget -= batch.length;
    const got = await readSources(api, batch.map((name) => ({ name, type: 'DDLS/DF', uri: null, package: '(upstream)' })), {
      cfg,
      tool: 'adt_annotation_scan',
      max: batch.length,
      signal: extra.signal,
      progress,
    });
    indexSources(got.read.map((o) => ({ file: `upstream/${o.name.toLowerCase()}.ddls`, repo: '(upstream)', layer: 'ddls', text: o.text })), index);
    upstream.read.push(...got.read.map((o) => o.name));
    for (const o of got.notRead) {
      if (o.status === 404) upstream.notFound.push(o.name);
      else upstream.notRead.push({ name: o.name, reason: o.reason });
    }
    upstream.notRead.push(...got.skipped.map((o) => ({ name: o.name, reason: 'cancelled' })));
  }
  // What is still unread, whatever stopped the walk: the budget, the hop cap, or a cancel.
  upstream.left = missingUpstream(index).filter((n) => !tried.has(n));
  if (upstream.left.length) upstream.stoppedBy = extra.signal?.aborted ? 'cancelled' : budget <= 0 ? 'budget' : 'rounds';

  const value = { pkg, read, index, upstream };
  keepIndex(cache, key, value);
  return value;
}

const STOPPED = { cancelled: 'CANCELLED', budget: 'BUDGET_REACHED', rounds: 'DEPTH_LIMIT' };

/** The upstream cut of the whole package: what a detect run, which reads every element, lacks. */
function upstreamIncomplete(upstream) {
  const out = [];
  if (upstream.notRead.length) out.push({ list: 'upstream', code: 'NOT_READ', count: upstream.notRead.length, reason: 'see scope.upstream.notRead' });
  if (upstream.left.length) {
    const code = STOPPED[upstream.stoppedBy];
    out.push({ list: 'upstream', code, count: upstream.left.length, ...(code === 'BUDGET_REACHED' ? { narrowBy: ['upstream'] } : {}) });
  }
  return out;
}

/**
 * The views of one element's chain that were not read, sorted into why. A name that answered 404
 * is a table: nothing above it to read, so it is no gap. A name in neither list was never asked
 * for (the walk is in the index, so this means the hop cap of the index walk itself).
 */
function chainOf(gaps, upstream) {
  const notFound = new Set(upstream.notFound.map((n) => n.toUpperCase()));
  const notRead = new Map(upstream.notRead.map((o) => [o.name.toUpperCase(), o.reason]));
  const left = new Set(upstream.left.map((n) => n.toUpperCase()));
  const byName = new Map();
  for (const g of gaps) {
    if (g.reason === 'not indexed' && notFound.has(g.name)) continue;
    const why = g.reason === 'depth' ? 'depth' : notRead.has(g.name) ? 'notRead' : left.has(g.name) ? upstream.stoppedBy ?? 'budget' : 'depth';
    if (!byName.has(g.name)) byName.set(g.name, { name: g.name, element: g.element, depth: g.depth, why });
  }
  const list = [...byName.values()].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  const of = (why) => list.filter((g) => g.why === why).map((g) => g.name);
  const incomplete = [];
  const unread = of('notRead');
  if (unread.length) incomplete.push({ list: 'chain', code: 'NOT_READ', count: unread.length, views: unread, reason: 'see scope.upstream.notRead' });
  for (const why of ['budget', 'cancelled', 'rounds']) {
    const views = of(why);
    if (views.length) incomplete.push({ list: 'chain', code: STOPPED[why], count: views.length, views, ...(why === 'budget' ? { narrowBy: ['upstream'] } : {}) });
  }
  const deep = of('depth');
  if (deep.length) incomplete.push({ list: 'chain', code: 'DEPTH_LIMIT', count: deep.length, views: deep });
  return { incomplete, notRead: list.map(({ why, ...g }) => ({ ...g, reason: why })) };
}

/** Limits of THIS SERVER for one run: to the gaps stream, never to findings. */
function journalGaps(built, journal) {
  if (!journal?.enabled || built.cached) return;
  for (const g of packageGaps('adt_annotation_scan', built.pkg, built.read)) journal.gap(g);
  for (const u of built.index.unread) {
    // The source plainly declares elements and the parser returned none of them. Saying
    // "no annotations" here would be a confident lie; this says "I could not read it".
    journal.gap({
      code: 'CDS_PARSE_EMPTY',
      subject: u.entity ?? u.file,
      detail: `${u.file} declares ${u.declares} element(s) and parsed to zero`,
      impact:
        'every annotation of every element in this source is missing from the index, and ' +
        'adt_value_help reads the same parser: it answers "no semantic signal" for it',
      fallback: 'read the source with adt_read_source, or check the source in the IDE',
    });
  }
}

/**
 * Run the scan. Exported apart from the tool definition so tests drive it with a fake ADT
 * client and without the MCP envelope.
 */
export async function runAnnotationScan(cfg, api, args = {}, journal = null, extra = {}) {
  const built = await indexFor(cfg, api, args, extra);
  journalGaps(built, journal);
  const { index, read, upstream, pkg } = built;

  const scope = scopeOf(pkg, read, {
    recursive: args.recursive !== false,
    entities: index.entities.size,
    upstream: {
      read: upstream.read.length,
      notFound: upstream.notFound,
      notRead: upstream.notRead,
      notFollowed: upstream.left,
      rounds: upstream.rounds,
      roundCap: UPSTREAM_ROUNDS,
      stoppedBy: upstream.stoppedBy,
    },
    cached: Boolean(built.cached),
    ...(built.cached ? { ageSeconds: built.ageSeconds } : {}),
    ...(index.unread.length ? { unreadSources: index.unread } : {}),
  });
  // The scope's own `complete` is the package read; the answer's `complete` is everything.
  // A lookup is about one element, so the upstream cut counts only where it touches its chain.
  const incomplete = packageIncomplete(read);
  if (!args.element) incomplete.push(...upstreamIncomplete(upstream));
  if (index.unread.length) incomplete.push({ list: 'sources', code: 'PARSE_FAILED', count: index.unread.length, reason: 'see scope.unreadSources' });
  const paged = (list) => {
    const p = page(list, { max: args.max, offset: args.rowsOffset, defaultMax: 200, ceiling: ROWS_CEILING });
    if (p.truncated) incomplete.push({ list: args.element ? 'rows' : 'findings', code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { rowsOffset: p.next.offset } });
    return p;
  };
  const pageOf = (p) => ({ total: p.total, returned: p.returned, offset: p.offset, limit: p.limit, ...(p.next ? { next: { rowsOffset: p.next.offset } } : {}) });

  // --- lookup mode ---------------------------------------------------------------
  if (args.element) {
    const want = String(args.entity ?? '').toUpperCase();
    const names = want ? (index.entities.has(want) ? [want] : []) : [...index.entities.keys()];
    if (want && !names.length) {
      return finish({
        scope,
        mode: 'lookup',
        question: `${args.entity}.${args.element}`,
        entities: 0,
        reported: 0,
        rows: [],
        reminder:
          `No CDS entity named '${args.entity}' is in ${pkg} or upstream of it within the cap. ` +
          'adt_object_info answers where it lives; adt_annotation_chain reads its chain directly.',
        // The entity itself may be past the upstream cut, so here the whole cut counts.
      }, [...incomplete, ...upstreamIncomplete(upstream)]);
    }
    const rows = [];
    const gaps = [];
    for (const name of names) {
      const entity = index.entities.get(name);
      for (const r of reaching(index, name, args.element, { key: args.key, gaps })) {
        rows.push({
          entity: entity.name,
          element: r.element,
          annotation: r.key,
          value: r.value,
          layer: r.layer,
          writtenBy: r.from,
          depth: r.depth,
          file: r.file,
          line: r.line,
          ...(r.unreachable ? { unreachable: r.unreachable } : {}),
          ...(r.heldBy ? { heldBy: r.heldBy } : {}),
          ...(r.unverified ? { unverified: r.unverified } : {}),
        });
      }
    }
    const chain = chainOf(gaps, upstream);
    incomplete.push(...chain.incomplete);
    const p = paged(rows);
    const count = (field) => rows.filter((r) => r[field]).length;
    return finish({
      scope,
      mode: 'lookup',
      question: `${args.entity ?? '*'}.${args.element}${args.key ? ` (${args.key}*)` : ''}`,
      entities: names.length,
      // Whether every view the element passes through was read. The package-level upstream cut
      // stays in `scope.upstream`; only the views of this chain decide `complete` here.
      chainComplete: chain.incomplete.length === 0,
      ...(chain.notRead.length ? { chainNotRead: chain.notRead } : {}),
      // Over every row, not the page: how many of them the source says can reach the element.
      reaching: rows.length - count('unreachable') - count('heldBy') - count('unverified'),
      unreachable: count('unreachable'),
      held: count('heldBy'),
      unverified: count('unverified'),
      reported: p.returned,
      rowsPage: pageOf(p),
      rows: p.items,
    }, incomplete);
  }

  // --- detect mode ---------------------------------------------------------------
  const hits = detectHiddenWithRole(index);
  const p = paged(hits);
  const rows = p.items;
  if (journal?.enabled && !built.cached) {
    // `repo` is the scanned package: a later complete scan of it is what can retire the row.
    for (const row of rows) journal.finding({ ...findingForHidden(row), repo: pkg });
  }
  return finish({
    scope,
    mode: 'detect',
    detectors: ['hidden-with-ui-role'],
    armed: hits.filter((h) => h.state === 'ARMED').length,
    held: hits.filter((h) => h.state === 'HELD').length,
    reported: rows.length,
    findingsPage: pageOf(p),
    findings: rows,
  }, incomplete);
}

export function annotationScanTool(cfg, api, journal) {
  return {
    definition: {
      name: 'adt_annotation_scan',
      description:
        'Annotations of a package\'s CDS (DDLS + DDLX + upstream views), per layer. With ' +
        '`element`: every annotation written for it; an upstream row that cannot reach it says ' +
        'why (unreachable: a parameter; heldBy: ignorePropagatedAnnotations; unverified: an ' +
        'expression). Without: elements whose layers contradict. ' +
        'One call per source: keep the package small. Index kept 10 minutes. A row is what the ' +
        'SOURCE says, never a verdict: adt_annotation_chain confirms it (ARMED: hidden upstream, ' +
        'given a display role downstream; HELD: the same, held by ignorePropagatedAnnotations).',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package whose CDS sources are read, e.g. ZDEMO_SALES' },
          recursive: { type: 'boolean', description: 'Include sub-packages (default true)' },
          entity: { type: 'string', description: 'CDS entity name. With `element` only.' },
          element: {
            type: 'string',
            description: 'Element name, e.g. Plant: lookup mode.',
          },
          key: {
            type: 'string',
            description: 'Key prefix, e.g. "UI." (case-insensitive). With `element` only.',
          },
          max: { type: 'integer', minimum: 1, maximum: ROWS_CEILING, description: `Rows (lookup) or findings (detect) per page (default 200, at most ${ROWS_CEILING})` },
          rowsOffset: { type: 'integer', minimum: 0, description: 'First row or finding of the page: `next.rowsOffset` of the previous answer' },
          offset: { type: 'integer', minimum: 0, description: 'First package source to read, in name order: `scope.next.offset` of the previous answer' },
          maxObjects: { type: 'integer', minimum: 1, maximum: MAX_OBJECTS, description: `Max package sources read, one ADT call each (default ${DEFAULT_MAX_OBJECTS})` },
          upstream: { type: 'integer', minimum: 0, maximum: MAX_UPSTREAM, description: `Max upstream views read to follow a chain (default ${DEFAULT_UPSTREAM}; 0 = none)` },
          refresh: { type: 'boolean', description: 'Rebuild the index even if one from the last 10 minutes exists' },
        },
        required: ['package'],
      },
    },
    async handler(args = {}, extra = {}) {
      if (args.key && !args.element) {
        throw invalidArguments('`key` filters a lookup: pass `element` too, or drop `key` to run the detectors.');
      }
      if (args.entity && !args.element) {
        throw invalidArguments('`entity` narrows a lookup: pass `element` too, or scan a smaller package.');
      }
      const out = await runAnnotationScan(cfg, api, args, journal, extra);
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  };
}
