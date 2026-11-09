// adt_clean_core_scan -- what the Z views of a package actually consume, and at which Clean Core
// level.
//
// The question this closes: "does any CDS of this package read something that is not released,
// and what does SAP say to use instead?" Today that is answered by looking at a name and
// guessing -- `I_Address` LOOKS released, and is absent from both catalogues; `MARA` is
// obviously a table but the successor list is not obvious at all; a `deprecated` view
// looks like debt and is not.
//
// Both halves are first-hand: the CDS sources are read from the system (one call per DDLS,
// lib/package-sources.mjs), the release state comes from SAP's catalogue in the state directory
// (npm run sync:catalog). No local checkout is involved.
//
// Two answers this tool refuses to blur:
//
//   * "Level C because notToBeReleased" and "Level C because absent from both
//     catalogues" are both C, and the report says which one came out -- the second has
//     no successor to migrate to, so the remediation is a different piece of work.
//   * Level B is REPORTED, never recommended. A classic API is an acceptable bridge in
//     Standard ABAP and is still not a Level A answer.

import { loadCatalog, catalogStatus, catalogMissingGap, CatalogMissing, VIEWER } from '../lib/catalog.mjs';
import { dataSourcesFrom, definitionOf } from '../lib/datasources.mjs';
import { classify, findingFor, levelRank } from '../lib/clean-core.mjs';
import { packageSources, packageGaps, scopeOf, DEFAULT_MAX_OBJECTS, MAX_OBJECTS } from '../lib/package-sources.mjs';
import { progressOf } from '../lib/tool-meta.mjs';

/** Built once per process: 24,707 rows parsed per call would be the tool's whole cost. */
let cached = null;
function catalogFor(cfg, journal) {
  const status = catalogStatus(cfg.paths?.catalog ?? null, { release: cfg.catalogRelease ?? null });
  if (!status.installed) {
    if (journal?.enabled) journal.gap(catalogMissingGap(status));
    throw new CatalogMissing(status);
  }
  if (!cached || cached.file !== cfg.paths.catalog) {
    cached = { file: cfg.paths.catalog, catalog: loadCatalog(cfg.paths.catalog) };
  }
  return { catalog: cached.catalog, status };
}

/** The data sources each read DDLS consumes, cited as `<package>/<DDLS>:<line>`. */
export function hitsOf(sources, pkg) {
  const hits = [];
  for (const o of sources) {
    const def = definitionOf(o.text);
    const file = `${o.package}/${o.name.toLowerCase()}.ddls`;
    for (const h of dataSourcesFrom(o.text, file)) hits.push({ ...h, repo: pkg, consumer: def.name, consumerKind: def.kind });
  }
  return hits;
}

/**
 * Run the scan. Exported apart from the tool definition so tests drive it with a fake ADT
 * client and without the MCP envelope.
 */
export async function runCleanCoreScan(cfg, api, args = {}, journal = null, extra = {}) {
  const pkg = String(args.package).toUpperCase();
  const { catalog, status: catalogInfo } = catalogFor(cfg, journal);
  const read = await packageSources(api, pkg, {
    types: ['DDLS/DF'],
    recursive: args.recursive !== false,
    only: args.entity,
    max: args.maxObjects,
    cfg,
    tool: 'adt_clean_core_scan',
    signal: extra.signal,
    progress: progressOf(extra),
  });
  const hits = hitsOf(read.read, pkg);
  const minLevel = args.minLevel ?? 'B';
  const { results, counts } = classify(hits, catalog, { minLevel });
  // Standard names that neither catalogue knows. They are already reported as Level C
  // findings (that IS the rule), but the fact that no release STATEMENT exists for them
  // is a limit of the catalogues, not of the code -- a different thing, and the one a
  // catalogue refresh would fix.
  const absent = results.filter((r) => r.inCatalog === false).map((r) => r.name);

  // Where each name is read from. A finding without its citations is not actionable,
  // and one name is usually read by several views.
  const where = new Map();
  for (const h of hits) {
    const key = String(h.name).toUpperCase();
    if (!where.has(key)) where.set(key, []);
    where.get(key).push({ file: h.file, line: h.line, kind: h.kind, consumer: h.consumer });
  }

  const max = Math.min(Number(args.max) || 200, 1000);
  const rows = results.slice(0, max).map((r) => {
    const at = where.get(r.name.toUpperCase()) ?? [];
    if (journal?.enabled) {
      // One finding per consumed name, citing its first reader. `repo` is the scanned package:
      // a later complete scan of the same package is what can retire it (lib/report.mjs).
      const f = findingFor(r, { repo: pkg, file: at[0]?.file, line: at[0]?.line, kind: at[0]?.kind, consumer: at[0]?.consumer });
      if (f) journal.finding({ ...f, context: { ...f.context, readBy: at.length } });
    }
    return {
      name: r.name,
      level: r.level,
      state: r.state,
      objectType: r.objectType,
      inCatalog: r.inCatalog,
      why: r.why,
      useInstead: r.successors.length ? r.successors : r.successorConcept ? [r.successorConcept] : [],
      readBy: at.length,
      at: at.slice(0, 5).map((a) => `${a.file}:${a.line} (${a.kind}, in ${a.consumer ?? '?'})`),
    };
  });

  if (journal?.enabled) {
    for (const g of packageGaps('adt_clean_core_scan', pkg, read)) journal.gap(g);
    if (catalog.note) {
      journal.gap({
        code: 'CATALOG_PARTIAL',
        subject: 'objectClassifications_SAP.json',
        detail: catalog.note,
        impact:
          'entities that exist only in the classification catalogue are reported as ' +
          'unknown, which reads as absent-from-both (Level C) and is not the same thing',
        fallback: 'npm run sync:catalog, then run the scan again',
      });
    }
    if (absent.length) {
      // ONE aggregated gap, not one per name: 155 identical lines would bury the
      // stream, and the actionable unit is the catalogue, not the individual name.
      journal.gap({
        code: 'CATALOG_MISS',
        subject: 'names absent from both catalogues',
        detail: `${absent.length}: ${absent.slice(0, 12).join(', ')}${absent.length > 12 ? ', …' : ''}`,
        impact:
          'no release statement exists for these, so Level C here means "internal ' +
          'unclassified" and names no successor to migrate to',
        fallback: `check one by one in SAP's viewer (${VIEWER}), or refresh the catalogue`,
      });
    }
  }

  return {
    scope: scopeOf(pkg, read, {
      recursive: args.recursive !== false,
      references: hits.length,
      ...(args.entity ? { entityFilter: args.entity } : {}),
      minLevel,
      catalog: catalogInfo,
      ...(catalog.note ? { catalogueNote: catalog.note } : {}),
    }),
    // A/B/C/D over DISTINCT standard names; `custom` is the Z/Y names, which carry no
    // level of their own -- the level is about what they consume.
    levels: counts,
    reported: rows.length,
    ...(results.length > rows.length ? { truncated: results.length - rows.length } : {}),
    findings: rows,
    reminder:
      'Level B is reported, not recommended. Two different C answers exist: a catalogued ' +
      'notToBeReleased (a successor is named) and absent from both catalogues (internal ' +
      `unclassified, no successor). Cross-check any single object in SAP's viewer (${VIEWER}). ` +
      'scope.complete false means some objects were not read: absent here is not absent there.',
  };
}

export function cleanCoreScanTool(cfg, api, journal) {
  return {
    definition: {
      name: 'adt_clean_core_scan',
      description:
        'Clean Core scan of one package: reads its CDS sources from the system (one call per DDLS), ' +
        'and classifies every entity, table and function they read as A/B/C/D against SAP\'s two ' +
        'release catalogues, with the released successor SAP names. Needs the catalogue ' +
        '(npm run sync:catalog). Answers what it could not read (scope.complete).',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package to scan, e.g. ZDEMO_SALES' },
          recursive: { type: 'boolean', description: 'Include sub-packages (default true)' },
          entity: { type: 'string', description: 'Only the CDS entity with this name, e.g. ZI_DemoAssortment (one read)' },
          minLevel: {
            type: 'string',
            enum: ['A', 'B', 'C', 'D'],
            description: 'Report levels at or worse than this. Default B (everything not A).',
          },
          max: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max distinct names reported (default 200)' },
          maxObjects: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_OBJECTS,
            description: `Max CDS sources read, one ADT call each (default ${DEFAULT_MAX_OBJECTS})`,
          },
        },
        required: ['package'],
      },
    },
    async handler(args = {}, extra = {}) {
      if (args.minLevel && levelRank(args.minLevel) < 0) {
        throw new Error(`minLevel must be one of A, B, C, D -- got '${args.minLevel}'`);
      }
      const out = await runCleanCoreScan(cfg, api, args, journal, extra);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  };
}
