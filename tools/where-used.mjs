// adt_where_used: who uses an object, paged, with the code of each row when asked.
//
// Built by buildTools (tools/index.mjs), which wraps it in the schema check and the journal.

import { finish, page } from '../lib/completeness.mjs';
import { record } from '../lib/audit.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { ToolError } from '../lib/tool-error.mjs';
import { asText } from './common.mjs';

// Z*, Y* and /NAMESPACE/ objects are ours; anything else is SAP standard.
const CUSTOM_NAMESPACE = /^([ZY]|\/)/;

/** Where-used rows per page: the snippets of a page are one POST, which takes at most 500 identifiers. */
const WHERE_USED_CEILING = 500;

export function whereUsedTool(cfg, session, journal, { resolveOpts } = {}) {
  const api = session.api;

  return {
    definition: {
      name: 'adt_where_used',
      description:
        'Who uses this object, according to the system (ADT usage references).',
      inputSchema: {
        type: 'object',
        properties: {
          objectName: { type: 'string' },
          objectType: { type: 'string' },
          snippets: {
            type: 'boolean',
            description: 'Also fetch the calling code snippet of the rows of this page (slower)',
          },
          max: { type: 'integer', minimum: 1, maximum: WHERE_USED_CEILING, description: `Rows per page (default 100, at most ${WHERE_USED_CEILING})` },
          offset: { type: 'integer', minimum: 0, description: 'First row of the page: `next.offset` of the previous answer' },
          allowStandard: {
            type: 'boolean',
            description:
              'Required for a non-Z/Y object: such a search is expensive for the system.',
          },
        },
        required: ['objectName'],
      },
    },
    async handler({ objectName, objectType, snippets, allowStandard, max, offset }) {
      if (!CUSTOM_NAMESPACE.test(objectName) && !allowStandard) {
        throw new ToolError(
          `'${objectName}' is an SAP standard object. Where-used on standard objects is the ` +
            'most expensive call this server can make against the SAP system -- pass allowStandard: true ' +
            'if you really need it.',
          {
            code: 'STANDARD_OBJECT',
            next: { tool: 'adt_where_used', arguments: { objectName, ...(objectType ? { objectType } : {}), ...(max ? { max } : {}), allowStandard: true } },
          }
        );
      }
      const { hit, warning, foundBy } = await resolveObject(api, objectName, objectType, 'metadata', resolveOpts);
      const refs = await api.usageReferences(hit['adtcore:uri']);
      // The whole list is in the reply; the answer pages it, and the snippets are asked for the
      // rows of the page only (the next page asks the where-used again: `next.costsCalls`).
      const p = page(refs, { max, offset, defaultMax: 100, ceiling: WHERE_USED_CEILING });
      const rows = p.items.map((r) => ({
        name: r['adtcore:name'],
        type: r['adtcore:type'],
        package: r.packageRef?.['adtcore:name'],
        responsible: r['adtcore:responsible'],
        usage: r.usageInformation,
        uri: r.uri,
      }));
      const incomplete = [];
      if (p.truncated) incomplete.push({ list: 'rows', code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { ...p.next, costsCalls: 1 } });
      let snippetPart = { asked: false };
      let code = [];
      if (snippets) {
        const askable = p.items.filter((r) => r.objectIdentifier);
        const notAskable = p.items.length - askable.length;
        if (askable.length) {
          const fetched = await api.usageReferenceSnippets(askable);
          code = fetched.flatMap((s) =>
            // `at` is the position of the use (uri, start, end, and the component's type and
            // name); the snippet object carries its identifier, which ties it to its row.
            (s.snippets ?? []).map((x) => ({
              objectIdentifier: s.objectIdentifier,
              at: x.uri,
              content: x.content,
            }))
          );
        }
        snippetPart = { asked: true, rowsAsked: askable.length, count: code.length, ...(notAskable ? { rowsWithoutIdentifier: notAskable } : {}) };
      }
      record(cfg, 'adt_where_used', hit['adtcore:name'], rows.length);
      return asText(
        finish(
          {
            object: hit['adtcore:name'],
            foundBy,
            ...(warning ? { warning } : {}),
            callers: p.total,
            returned: p.returned,
            offset: p.offset,
            limit: p.limit,
            truncated: p.truncated,
            ...(p.next ? { next: { ...p.next, costsCalls: 1 } } : {}),
            rows,
            snippetsPart: snippetPart,
            snippets: code,
          },
          incomplete
        )
      );
    },
  };
}
