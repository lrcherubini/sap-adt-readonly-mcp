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

/** Where-used users per page: the snippets of a page are one POST, which takes at most 500 identifiers. */
const WHERE_USED_CEILING = 500;

const isFolder = (r) => r['adtcore:type'] === 'DEVC/K';
const isPlace = (r) => String(r.uri ?? '').includes('#');
const usageOf = (u) => (u ? String(u).split(/[,\s]+/).filter(Boolean) : []);

/**
 * The flat reply as users: every object row that is not a package folder, with the place rows
 * whose parentUri is that object as its `uses`. A place whose object row is missing still
 * belongs to a user, named by its parent URI, so no use is dropped. `raw` (the rows of the
 * user) is what the snippet request takes; it never reaches the answer.
 */
export function usersOf(refs, ownUri) {
  const own = String(ownUri ?? '').toLowerCase();
  const users = new Map();
  const userOf = (uri, row = null) => {
    let u = users.get(uri);
    if (!u) {
      u = {
        name: row?.['adtcore:name'] ?? null,
        type: row?.['adtcore:type'] ?? null,
        package: row?.packageRef?.['adtcore:name'] ?? null,
        responsible: row?.['adtcore:responsible'] ?? null,
        uri,
        self: String(uri).toLowerCase() === own,
        uses: [],
        raw: [],
      };
      users.set(uri, u);
    }
    return u;
  };
  for (const r of refs ?? []) {
    if (isFolder(r)) continue;
    if (isPlace(r)) {
      const u = userOf(r.parentUri ?? String(r.uri).split('#')[0]);
      u.uses.push({
        at: r['adtcore:name'] ?? null,
        ...(r['adtcore:type'] ? { type: r['adtcore:type'] } : {}),
        usage: usageOf(r.usageInformation),
        uri: r.uri,
        // What ties a snippet (snippets: true) to this place.
        ...(r.objectIdentifier ? { objectIdentifier: r.objectIdentifier } : {}),
      });
      u.raw.push(r);
      continue;
    }
    const u = userOf(r.uri, r);
    // A row read after its places fills in what the places could not say.
    Object.assign(u, { name: r['adtcore:name'] ?? u.name, type: r['adtcore:type'] ?? u.type, package: r.packageRef?.['adtcore:name'] ?? u.package, responsible: r['adtcore:responsible'] ?? u.responsible });
    if (r.usageInformation) u.usage = usageOf(r.usageInformation);
    if (r.objectIdentifier) u.objectIdentifier = r.objectIdentifier;
    u.raw.unshift(r);
  }
  return [...users.values()];
}

export function whereUsedTool(cfg, session, journal, { resolveOpts } = {}) {
  const api = session.api;

  return {
    definition: {
      name: 'adt_where_used',
      description:
        'Who uses this object, according to the system (ADT usage references): one entry per ' +
        'using object with the places of the use inside it (`uses`: section or method, usage ' +
        'grade). The object itself is listed with `self: true` when its own code names it, and ' +
        'is not counted in `callers`.',
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
      // The reply is a tree, flattened (measured, docs/adt-api-reference.md): package folders,
      // under each the objects that use this one, under each object the places of the use
      // (a section, a method) with `usageInformation`. Grouped back here: one user per object,
      // its uses inside it, the folders out. The object itself is a user of itself when its own
      // code names it: kept, marked `self`, never counted as a caller.
      const users = usersOf(refs, hit['adtcore:uri']);
      const callers = users.filter((u) => !u.self).length;
      // The whole list is in the reply; the answer pages it by user, and the snippets are asked
      // for the rows of the page only (the next page asks the where-used again: `costsCalls`).
      const p = page(users, { max, offset, defaultMax: 100, ceiling: WHERE_USED_CEILING });
      const incomplete = [];
      if (p.truncated) incomplete.push({ list: 'users', code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { ...p.next, costsCalls: 1 } });
      const pageRows = p.items.flatMap((u) => u.raw);
      let snippetPart = { asked: false };
      let code = [];
      if (snippets) {
        const askable = pageRows.filter((r) => r.objectIdentifier);
        const notAskable = pageRows.length - askable.length;
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
      record(cfg, 'adt_where_used', hit['adtcore:name'], p.returned);
      return asText(
        finish(
          {
            object: hit['adtcore:name'],
            foundBy,
            ...(warning ? { warning } : {}),
            callers,
            page: { returned: p.returned, offset: p.offset, limit: p.limit, ...(p.next ? { next: { ...p.next, costsCalls: 1 } } : {}) },
            users: p.items.map(({ raw: _raw, ...u }) => u),
            snippetsPart: snippetPart,
            snippets: code,
          },
          incomplete
        )
      );
    },
  };
}
