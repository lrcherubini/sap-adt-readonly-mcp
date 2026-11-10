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
import { packageSources, readSources, packageGaps, scopeOf, DEFAULT_MAX_OBJECTS, MAX_OBJECTS } from '../lib/package-sources.mjs';
import { progressOf } from '../lib/tool-meta.mjs';

export const DEFAULT_UPSTREAM = 20;
export const MAX_UPSTREAM = 60;
const LAYER = { 'DDLS/DF': 'ddls', 'DDLX/EX': 'ddlx' };
const TTL_MS = 10 * 60 * 1000;

/**
 * The index of one package, kept for ten minutes: a lookup per element is the normal way to use
 * this tool, and re-reading the package for each one would multiply its cost. `refresh: true`
 * rebuilds it; a change made in the system meanwhile is otherwise seen at the next rebuild.
 */
const cache = new Map();

/** Test seam: the next call rebuilds. Never called by the server. */
export function resetAnnotationIndexCache() {
  cache.clear();
}

async function indexFor(cfg, api, args, extra) {
  const pkg = String(args.package).toUpperCase();
  const recursive = args.recursive !== false;
  const upstreamCap = Math.min(Number.isInteger(args.upstream) ? args.upstream : DEFAULT_UPSTREAM, MAX_UPSTREAM);
  const key = `${pkg}|${recursive}|${args.maxObjects ?? ''}|${upstreamCap}`;
  const hit = cache.get(key);
  if (hit && !args.refresh && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };

  const progress = progressOf(extra);
  const read = await packageSources(api, pkg, {
    types: ['DDLS/DF', 'DDLX/EX'],
    recursive,
    max: args.maxObjects,
    cfg,
    tool: 'adt_annotation_scan',
    signal: extra.signal,
    progress,
  });
  const index = indexSources(read.read.map((o) => ({ file: `${o.package}/${o.name.toLowerCase()}.${LAYER[o.type]}`, repo: pkg, layer: LAYER[o.type], text: o.text })), emptyIndex());

  // Upstream, breadth first: the views the package selects from, then theirs, until the cap.
  // A name that is a table (no DDLS behind it) answers not-found -- expected, and listed apart
  // from a view that could not be read, which IS a hole in the chain.
  const upstream = { read: [], notRead: [], left: [] };
  let budget = upstreamCap;
  const tried = new Set();
  for (let round = 0; round < 8 && budget > 0 && !extra.signal?.aborted; round++) {
    const names = missingUpstream(index).filter((n) => !tried.has(n));
    if (!names.length) break;
    const batch = names.slice(0, budget);
    batch.forEach((n) => tried.add(n));
    upstream.left = names.slice(budget);
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
    upstream.notRead.push(...got.notRead.map((o) => ({ name: o.name, reason: o.reason })));
  }
  if (!budget) upstream.left = missingUpstream(index).filter((n) => !tried.has(n));

  const value = { pkg, read, index, upstream };
  cache.set(key, { at: Date.now(), value });
  return value;
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
      ...(upstream.notRead.length ? { notRead: upstream.notRead.slice(0, 50) } : {}),
      ...(upstream.left.length ? { notFollowed: upstream.left.length, note: 'raise `upstream` to follow further' } : {}),
    },
    ...(built.cached ? { cached: 'index from a scan in the last 10 minutes; refresh: true rebuilds it' } : {}),
    ...(index.unread.length ? { unreadSources: index.unread } : {}),
  });

  // --- lookup mode ---------------------------------------------------------------
  if (args.element) {
    const want = String(args.entity ?? '').toUpperCase();
    const names = want ? (index.entities.has(want) ? [want] : []) : [...index.entities.keys()];
    if (want && !names.length) {
      return {
        scope,
        mode: 'lookup',
        question: `${args.entity}.${args.element}`,
        entities: 0,
        reported: 0,
        rows: [],
        reminder:
          `No CDS entity named '${args.entity}' is in ${pkg} or upstream of it within the cap. ` +
          'adt_object_info answers where it lives; adt_annotation_chain reads its chain directly.',
      };
    }
    const max = Math.min(Number(args.max) || 200, 1000);
    const rows = [];
    for (const name of names) {
      const entity = index.entities.get(name);
      for (const r of reaching(index, name, args.element, { key: args.key })) {
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
        });
      }
      if (rows.length >= max) break;
    }
    return {
      scope,
      mode: 'lookup',
      question: `${args.entity ?? '*'}.${args.element}${args.key ? ` (${args.key}*)` : ''}`,
      entities: names.length,
      reported: Math.min(rows.length, max),
      ...(rows.length > max ? { truncated: rows.length - max } : {}),
      rows: rows.slice(0, max),
      reminder:
        'This is what the SOURCE says, layer by layer, with no winner picked -- it knows ' +
        'nothing about switches, kernel layers or IS_ACTIVE. adt_annotation_chain decides, ' +
        'at one ADT call. `depth` is how many propagating hops upstream the annotation was ' +
        'written; a deep row is matched on element NAME and is the weaker claim.',
    };
  }

  // --- detect mode ---------------------------------------------------------------
  const hits = detectHiddenWithRole(index);
  const max = Math.min(Number(args.max) || 200, 1000);
  const rows = hits.slice(0, max);
  if (journal?.enabled && !built.cached) {
    // `repo` is the scanned package: a later complete scan of it is what can retire the row.
    for (const row of rows) journal.finding({ ...findingForHidden(row), repo: pkg });
  }
  return {
    scope,
    mode: 'detect',
    detectors: ['hidden-with-ui-role'],
    armed: hits.filter((h) => h.state === 'ARMED').length,
    held: hits.filter((h) => h.state === 'HELD').length,
    reported: rows.length,
    ...(hits.length > rows.length ? { truncated: hits.length - rows.length } : {}),
    findings: rows,
    reminder:
      'ARMED = hidden upstream, given a display role downstream, nothing holding it: the ' +
      'field does not render and no error is raised. HELD = the same, with ' +
      '@Metadata.ignorePropagatedAnnotations: true holding the hide back -- not clean, ' +
      'armed-and-held: removing that line re-arms it. Every row is a suspicion read off ' +
      'the source; confirm with adt_annotation_chain, one ADT call each. `hiddenKey` says ' +
      'WHICH annotation hides it -- @UI.hidden and @Consumption.hidden both do, and they ' +
      'do not have the same remedy. Declared limits: a hide bound to a field ' +
      "(@UI.hidden: 'SomeFlag') is skipped as deliberate design, a hide reached over " +
      'more than one propagating hop is matched on element NAME (`depth` says which), and an ' +
      'upstream view is read for its inline annotations only -- its own DDLX is not looked up.',
  };
}

export function annotationScanTool(cfg, api, journal) {
  return {
    definition: {
      name: 'adt_annotation_scan',
      description:
        'Annotations of a package\'s CDS (DDLS + DDLX + upstream views), per layer. With ' +
        '`element`: every annotation reaching it. Without: elements whose layers contradict. ' +
        'One call per source: keep the package small. Index kept 10 minutes.',
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
          max: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max rows reported (default 200)' },
          maxObjects: { type: 'integer', minimum: 1, maximum: MAX_OBJECTS, description: `Max package sources read, one ADT call each (default ${DEFAULT_MAX_OBJECTS})` },
          upstream: { type: 'integer', minimum: 0, maximum: MAX_UPSTREAM, description: `Max upstream views read to follow a chain (default ${DEFAULT_UPSTREAM}; 0 = none)` },
          refresh: { type: 'boolean', description: 'Rebuild the index even if one from the last 10 minutes exists' },
        },
        required: ['package'],
      },
    },
    async handler(args = {}, extra = {}) {
      if (args.key && !args.element) {
        throw new Error('`key` filters a lookup: pass `element` too, or drop `key` to run the detectors.');
      }
      if (args.entity && !args.element) {
        throw new Error('`entity` narrows a lookup: pass `element` too, or scan a smaller package.');
      }
      const out = await runAnnotationScan(cfg, api, args, journal, extra);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  };
}
