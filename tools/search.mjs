// adt_search: which objects match a name pattern, through the quick search, and the legacy
// objects (SLG0, SCI) the ADT does not publish.
//
// Built by buildTools (tools/index.mjs), which wraps it in the schema check and the journal.

import { finish } from '../lib/completeness.mjs';
import { record } from '../lib/audit.mjs';
import { FACET_ONLY_TYPES } from '../lib/resolve.mjs';
import { legacyKindOf, readLegacyObjects } from '../lib/legacy-objects.mjs';
import { asText } from './common.mjs';

/** The quick search takes maxResults up to three digits (the route's own alphabet). */
const SEARCH_CEILING = 999;

export function searchTool(cfg, session, journal, { facetSearch } = {}) {
  const api = session.api;

  return {
    definition: {
      name: 'adt_search',
      description:
        'Find repository objects by name or pattern (e.g. "ZCL_SD*"): name, type, package, ' +
        'URI. For APLO and CHKV it also returns `legacy`: objects created in SLG0/SCI, which ' +
        'the ADT does not list.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Name or pattern, e.g. ZCL_SD* or I_SalesDocument',
          },
          objectType: {
            type: 'string',
            description: 'ADT type filter, e.g. CLAS/OC, DDLS/DF, TABL/DT, PROG/P',
          },
          max: {
            type: 'integer',
            minimum: 1,
            maximum: SEARCH_CEILING,
            description: `Hits asked of the search (default 50, at most ${SEARCH_CEILING}); the search has no paging`,
          },
        },
        required: ['query'],
      },
    },
    async handler({ query, objectType, max }) {
      const limit = max === undefined || max === null ? 50 : Number(max);
      const facet = objectType ? String(objectType).toUpperCase() : undefined;
      const incomplete = [];
      const facetOnly = FACET_ONLY_TYPES.has(facet);
      let hits = facetOnly ? [] : await api.searchObject(query, objectType, limit);
      let byFacet = false;
      if (!facetOnly) record(cfg, 'adt_search', query, hits.length);
      // A full page is "more may exist": the quick search has no paging and no total
      // (measured: ENHO/XHH answered 182 of a 200 cap). Counted on the reply, before the facet
      // filter below, because it is the reply that is cut.
      const pageFull = hits.length >= limit;
      // The library form asks the MAJOR type, so a facet's siblings share the page: they are
      // left out of the answer and counted.
      let outsideFacet = 0;
      if (facet?.includes('/') && !facetOnly) {
        const kept = hits.filter((h) => String(h['adtcore:type'] ?? '').toUpperCase() === facet);
        outsideFacet = hits.length - kept.length;
        hits = kept;
      }
      // Empty with a facet is a question, not a verdict (measured): ask once more with the
      // facet whole. The reply then carries no description, and the answer says so.
      const retryable = facet?.includes('/') && /^[A-Z0-9_/&$%.+#-]{1,40}\*?$/i.test(String(query));
      let facetRetry = { asked: false, reason: hits.length ? 'the first search answered' : !facet?.includes('/') ? 'no facet asked' : !retryable ? 'the query is not a name or a name with a trailing *' : 'no raw client in this session' };
      if (!hits.length && retryable && facetSearch) {
        hits = await facetSearch(query, facet, limit);
        byFacet = hits.length > 0;
        facetRetry = { asked: true, found: hits.length };
      }
      if (facetOnly && !facetSearch) {
        incomplete.push({ list: 'hits', code: 'NOT_READ', reason: `${facet} answers only through the whole-facet route, and this session has no raw client` });
      }
      // APLO and CHKV have a second kind the ADT never lists (SLG0 / SCI): read it from its
      // tables, so an ADT-only answer is not taken for the whole set (lib/legacy-objects.mjs).
      const legacyKind = legacyKindOf(facet);
      let legacy;
      if (legacyKind) {
        legacy = session.raw
          ? await readLegacyObjects(session.raw, legacyKind, query, {
              language: cfg?.language,
              gap: (row) => journal?.gap?.(row),
              audit: (target, n) => record(cfg, 'adt_search', target, n),
            })
          : { objects: [], complete: false, incomplete: { code: 'NOT_READ', reason: 'no raw client in this session' } };
        if (!legacy.complete) incomplete.push({ list: 'legacy.objects', ...legacy.incomplete });
      }
      if (pageFull) {
        journal?.gap?.({
          code: 'SEARCH_AT_CAP',
          subject: `${query}${objectType ? ` (${objectType})` : ''}`,
          detail: `the quick search returned ${limit} hits for a limit of ${limit}`,
          impact: 'the list may be cut: anything the search ranked below the cap is missing',
          fallback: `narrow the query (a longer prefix, an objectType) or raise max up to ${SEARCH_CEILING}`,
        });
        incomplete.push({
          list: 'hits',
          code: 'SERVER_PAGE_FULL',
          returned: limit,
          total: null,
          narrowBy: limit < SEARCH_CEILING ? ['query', 'objectType', 'max'] : ['query', 'objectType'],
        });
      }
      return asText(
        finish(
          {
            count: hits.length,
            limit,
            ...(outsideFacet ? { outsideFacet } : {}),
            // Why an empty list was not asked again is part of reading it; on a list that
            // answered, the second ask had nothing to add.
            ...(facetRetry.asked || !hits.length ? { facetRetry } : {}),
            ...(byFacet
              ? {
                  foundBy: 'facet',
                  descriptions: false,
                  note: 'answered by the quick search with the WHOLE facet; that reply carries no description (measured)',
                }
              : {}),
            // MEASURED 2026-09-12: the information system does not index every object that exists
            // (RV64A953 answers 0 hits by name while its URI reads). The list is complete for the
            // index; the by-name tools also try the direct URI and say foundBy: "uri".
            source: 'quick search index',
            ...(legacy ? { legacy } : {}),
            hits: hits.map((h) => ({
              name: h['adtcore:name'],
              type: h['adtcore:type'],
              package: h['adtcore:packageName'],
              description: h['adtcore:description'],
              uri: h['adtcore:uri'],
            })),
          },
          incomplete
        )
      );
    },
  };
}
