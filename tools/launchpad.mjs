// adt_launchpad -- the Fiori launchpad content of the SAP system, read online.
//
// The question: "which tiles and target mappings does catalog X carry, which groups show them,
// which catalogs a role gets, and is the semantic object registered?" -- asked without opening the
// Launchpad Designer or the Launchpad App Manager. The routes are the SAP-standard ones of
// docs/security.md, "The Fiori launchpad -- 2026-10-02"; every shape is measured
// (docs/adt-api-reference.md). One `kind` per call, no default:
//
//   catalogs / catalog       PAGE_BUILDER_CUST (the client) or _CONF (cross-client) catalog list;
//                            one catalog with its tiles and target mappings, normalized
//   groups / group           the groups (Pages of /UI2/FLPD_CATALOG); one group's tiles
//   spaces / space           FDM spaces; one space with its pages
//   pages / page             FDM pages, 50 per call (the whole list overflows the header limit);
//                            one page with sections, roles and spaces
//   semobjs / semobj         /UI2/SEMOBJC + /UI2/SEMOBJCT (customer), /UI2/SEMOBJ (SAP), through
//                            the data preview of adt_customizing's allow-list
//   roleCatalogs             the catalogs FDM resolves for one role (FDM roleSet, SAP standard)
//
// What never comes back: a user name (lib/launchpad.mjs strips person keys from every FDM body),
// PAGE_BUILDER_PERS, AGR_USERS. Everything read is SAP standard: the /UI2 OData services and the
// data preview of the ADT -- no customer (Z) service. What the audit carries: the kind and the id or prefix, never a row.

import { record } from '../lib/audit.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { buildSelect, previewPost, parsePreview, assertRanAsSent, truncationOf, cutCodeOf } from '../lib/data-preview.mjs';
import { finish, page } from '../lib/completeness.mjs';

/** A local list paged, as the answer shows it, and its entry when cut (the next page re-reads). */
function paged(list, args, name, incomplete) {
  const p = page(list, { max: args.max, offset: args.offset, defaultMax: DEFAULT_MAX, ceiling: MAX_MAX });
  if (p.truncated) incomplete.push({ list: name, code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { offset: p.next.offset, costsCalls: 1 } });
  return { items: p.items, page: { total: p.total, returned: p.returned, offset: p.offset, limit: p.limit, ...(p.next ? { next: { offset: p.next.offset, costsCalls: 1 } } : {}) } };
}

/** The entries of an FDM read: a server next page not followed, and the navigations deferred. */
function fdmIncomplete(f, list) {
  const out = [];
  if (f.serverNext) out.push({ list, code: 'SERVER_PAGE_FULL', reason: 'the server answered a __next link: its paging on this route is not measured and not followed' });
  if (f.deferred?.length) out.push({ list: `${list}.navigations`, code: 'NOT_READ', count: f.deferred.length, reason: `deferred, not expanded: ${f.deferred.join(', ')}`.slice(0, 200) });
  return out;
}

/** The entries of a data preview read: its cut (no offset: narrowed by id or match) and its drift. */
function previewIncomplete(p, rowsAsked, list) {
  const out = [];
  const code = cutCodeOf(p, rowsAsked);
  if (code) out.push({ list, code, returned: p.rows.length, total: p.totalRows, narrowBy: ['id'] });
  if (p.drift.length || p.rowsLost) out.push({ list, code: 'PARSE_FAILED', count: p.drift.length + (p.rowsLost ?? 0), reason: 'see drift' });
  return out;
}
import { parseCatalogList, parseGroupList, parsePage, parseFdm, intentsOf, catalogPageId, stripPersons } from '../lib/launchpad.mjs';

const DRIFT_CODE = 'SHAPE_DRIFT';

export const KINDS = ['catalogs', 'catalog', 'groups', 'group', 'spaces', 'space', 'pages', 'page', 'semobjs', 'semobj', 'roleCatalogs'];
export const DEFAULT_MAX = 100;
export const MAX_MAX = 500;
const ORIGINS = ['customer', 'customer-no-prefix', 'sap-changed', 'sap'];

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

export class LaunchpadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LaunchpadRequestError';
  }
}

const need = (v, name, kind) => {
  if (v === undefined || v === null || String(v).trim() === '') throw new LaunchpadRequestError(`kind=${kind} needs '${name}'.`);
  return String(v).trim();
};
const capOf = (v) => {
  if (v === undefined || v === null) return DEFAULT_MAX;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MAX) throw new LaunchpadRequestError(`max must be an integer from 1 to ${MAX_MAX}; got ${v}.`);
  return n;
};
const matcher = (match) => {
  if (!match) return () => true;
  const m = String(match).toLowerCase();
  return (...fields) => fields.some((f) => String(f ?? '').toLowerCase().includes(m));
};

export function launchpadTool(cfg, session, journal) {
  const gap = (g) => journal?.enabled && journal.gap(g);
  const driftGap = (subject, drift) =>
    drift?.length &&
    gap({
      code: DRIFT_CODE,
      subject,
      detail: drift.slice(0, 12).map((d) => `${d.node}${d.where ? ` (${d.where})` : ''}${d.count ? ` x${d.count}` : ''}`).join('; '),
      impact: 'the answer stands; the measured shape has aged and the parser may be dropping something',
      fallback: 'compare with the Launchpad Designer / PFCG; re-measure (docs/adt-api-reference.md)',
    });

  async function get(route, params, subject) {
    if (!session?.raw) throw new LaunchpadRequestError('this session has no raw client: the launchpad routes cannot be asked.');
    let out;
    try {
      out = await namedGet(transportFor(session.raw), route, params);
      return out;
    } catch (e) {
      if (e?.name !== 'RouteViolation') {
        gap({
          code: 'LAUNCHPAD_NOT_READ',
          subject,
          detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? route}: ${e?.message}`,
          impact: 'no statement about this launchpad object -- a failed read is NOT an empty catalog',
          fallback: 'the Launchpad Designer (/UI2/FLPD_CUST) or the Launchpad App Manager (/UI2/FLPCM_CUST)',
        });
      }
      throw e;
    } finally {
      record(cfg, 'adt_launchpad', subject, out?.bytes ?? 0);
    }
  }

  const json = (body, subject) => {
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`${subject}: the role service answered something that is not JSON (${e.message}); nothing was interpreted`);
    }
  };

  async function preview(table, fields, where, rows) {
    const built = buildSelect({ table, fields, where, rows });
    if (!session?.raw) throw new LaunchpadRequestError('this session has no raw client: the data preview cannot be asked.');
    let out;
    try {
      out = await previewPost(session.raw, built.sql, built.rows);
    } catch (e) {
      if (e?.name !== 'SelectViolation') {
        gap({
          code: 'LAUNCHPAD_NOT_READ',
          subject: table,
          detail: `HTTP ${e?.status ?? '?'}: ${e?.message}`,
          impact: `no statement about ${table} -- a failed read is NOT an unregistered semantic object`,
          fallback: 'SM30 /UI2/V_SEMOBJC in the SAP GUI',
        });
      }
      throw e;
    } finally {
      record(cfg, 'adt_launchpad', `${table} rows<=${built.rows}`, out?.bytes ?? 0);
    }
    const parsed = parsePreview(out.body);
    assertRanAsSent(built.sql, parsed.executedQuery);
    driftGap(`${table} data preview`, parsed.drift);
    return parsed;
  }

  const handlers = {
    async catalogs(args) {
      const { layer = 'client', origin, match, max } = args;
      if (!['client', 'cross-client'].includes(layer)) throw new LaunchpadRequestError(`layer is 'client' or 'cross-client'; got ${layer}.`);
      if (origin !== undefined && origin !== 'all' && !ORIGINS.includes(origin)) throw new LaunchpadRequestError(`origin is one of ${ORIGINS.join(', ')} or all.`);
      capOf(max);
      const incomplete = [];
      const out = await get(layer === 'client' ? 'flpCatalogsCust' : 'flpCatalogsConf', {}, `catalogs ${layer}`);
      const all = parseCatalogList(out.body, layer);
      const byOrigin = Object.fromEntries(ORIGINS.map((o) => [o, all.filter((r) => r.origin === o).length]));
      const wanted = origin === 'all' ? () => true : origin ? (r) => r.origin === origin : (r) => r.origin !== 'sap';
      const hit = matcher(match);
      const rows = all.filter((r) => wanted(r) && hit(r.id, r.title));
      const p = paged(rows, args, 'catalogs', incomplete);
      return { total: all.length, byOrigin, matched: rows.length, catalogsPage: p.page, catalogs: p.items, incomplete };
    },
    async catalog({ id }) {
      const page = catalogPageId(need(id, 'id', 'catalog'));
      const out = await get('flpPage', { id: page }, `catalog ${page}`);
      const parsed = parsePage(out.body);
      driftGap(`catalog ${page}`, parsed.drift);
      return { ...parsed, intents: intentsOf(parsed), incomplete: parsed.drift?.length ? [{ list: 'catalog', code: 'PARSE_FAILED', count: parsed.drift.length, reason: 'see drift' }] : [] };
    },
    async groups(args) {
      const { origin, match, max } = args;
      capOf(max);
      const incomplete = [];
      const out = await get('flpGroups', {}, 'groups');
      const all = parseGroupList(out.body);
      const hit = matcher(match);
      const rows = all.filter((r) => (origin === 'all' ? true : origin ? r.origin === origin : r.origin !== 'sap') && hit(r.id, r.title));
      const p = paged(rows, args, 'groups', incomplete);
      return { total: all.length, matched: rows.length, groupsPage: p.page, groups: p.items, incomplete };
    },
    async group({ id }) {
      const g = need(id, 'id', 'group');
      const out = await get('flpPage', { id: g }, `group ${g}`);
      const parsed = parsePage(out.body);
      driftGap(`group ${g}`, parsed.drift);
      return { ...parsed, intents: intentsOf(parsed), incomplete: parsed.drift?.length ? [{ list: 'group', code: 'PARSE_FAILED', count: parsed.drift.length, reason: 'see drift' }] : [] };
    },
    async spaces(args) {
      capOf(args.max);
      const out = await get('fdmSpaces', {}, 'spaces');
      const f = parseFdm(out.body);
      const { rows } = f;
      const incomplete = fdmIncomplete(f, 'spaces');
      const hit = matcher(args.match);
      const found = rows.filter((r) => hit(r.id, r.title, r.description));
      const p = paged(found, args, 'spaces', incomplete);
      return { total: rows.length, customer: rows.filter((r) => /^[ZY]/.test(r.id)).length, matched: found.length, spacesPage: p.page, spaces: p.items, incomplete };
    },
    async space({ id }) {
      const s = need(id, 'id', 'space');
      const out = await get('fdmSpace', { id: s }, `space ${s}`);
      const f = parseFdm(out.body);
      return { ...f, incomplete: fdmIncomplete(f, 'space') };
    },
    async pages({ skip = 0 }) {
      const n = Number(skip);
      if (!Number.isInteger(n) || n < 0) throw new LaunchpadRequestError(`skip must be an integer >= 0; got ${skip}.`);
      const out = await get('fdmPages', { $top: '50', ...(n ? { $skip: String(n) } : {}) }, `pages skip=${n}`);
      const f = parseFdm(out.body);
      const { count, rows } = f;
      const incomplete = fdmIncomplete(f, 'pages');
      // The server pages (50 per call); with a count the next skip is exact, without one a full
      // page may have more behind it.
      const more = count !== null ? n + rows.length < count : rows.length >= 50;
      const next = more ? { skip: n + rows.length } : null;
      if (more) incomplete.push({ list: 'pages', code: count !== null ? 'CAP_REACHED' : 'SERVER_PAGE_FULL', returned: rows.length, total: count, next });
      return { total: count, skip: n, returned: rows.length, ...(next ? { next } : {}), pages: rows, incomplete };
    },
    async page({ id }) {
      const p = need(id, 'id', 'page');
      const out = await get('fdmPage', { id: p }, `page ${p}`);
      const f = parseFdm(out.body);
      return { ...f, incomplete: fdmIncomplete(f, 'page') };
    },
    async semobjs(args) {
      const { match, max } = args;
      capOf(max);
      const so = await preview('/UI2/SEMOBJC', ['SEM_OBJ'], [], 200);
      const tx = await preview('/UI2/SEMOBJCT', ['LANGUAGE', 'SEM_OBJ', 'SEM_OBJ_NAME', 'SEM_OBJ_TEXT'], [], 200);
      const incomplete = [...previewIncomplete(so, 200, 'semanticObjects'), ...previewIncomplete(tx, 200, 'texts')];
      const texts = new Map();
      for (const t of tx.rows) if (!texts.has(t.SEM_OBJ) || t.LANGUAGE === 'P') texts.set(t.SEM_OBJ, { name: t.SEM_OBJ_NAME, text: t.SEM_OBJ_TEXT, language: t.LANGUAGE });
      const hit = matcher(match);
      const rows = so.rows.map((r) => ({ semanticObject: r.SEM_OBJ, prefixZ: /^[ZY]/.test(r.SEM_OBJ), ...(texts.get(r.SEM_OBJ) ?? {}) })).filter((r) => hit(r.semanticObject, r.name, r.text));
      const p = paged(rows, args, 'semanticObjects', incomplete);
      return {
        layer: 'cross-client',
        total: so.totalRows,
        read: { semanticObjects: so.rows.length, texts: tx.rows.length, truncated: truncationOf(so, 200) || truncationOf(tx, 200), ...(truncationOf(so, 200) || truncationOf(tx, 200) ? { narrowBy: ['id'] } : {}) },
        matched: rows.length,
        semanticObjectsPage: p.page,
        semanticObjects: p.items,
        incomplete,
      };
    },
    async semobj({ id }) {
      const s = need(id, 'id', 'semobj');
      const c = await preview('/UI2/SEMOBJC', ['SEM_OBJ'], [{ field: 'SEM_OBJ', op: '=', value: s }], 5);
      const t = c.rows.length ? await preview('/UI2/SEMOBJCT', ['LANGUAGE', 'SEM_OBJ_NAME', 'SEM_OBJ_TEXT'], [{ field: 'SEM_OBJ', op: '=', value: s }], 20) : { rows: [], totalRows: 0, drift: [] };
      const sap = await preview('/UI2/SEMOBJ', ['SEM_OBJ', 'AKH_COMP', 'STATUS'], [{ field: 'SEM_OBJ', op: '=', value: s }], 5);
      const incomplete = [...previewIncomplete(c, 5, 'customer'), ...previewIncomplete(t, 20, 'texts'), ...previewIncomplete(sap, 5, 'sap')];
      return {
        incomplete,
        semanticObject: s,
        registered: c.rows.length ? 'customer' : sap.rows.length ? 'sap' : 'none',
        ...(c.rows.length ? { texts: t.rows.map((r) => ({ language: r.LANGUAGE, name: r.SEM_OBJ_NAME, text: r.SEM_OBJ_TEXT })) } : {}),
        ...(sap.rows.length ? { sap: { component: sap.rows[0].AKH_COMP, status: sap.rows[0].STATUS } } : {}),
        note: 'case matters: the semantic object is compared as typed (the launchpad compares it the same way)',
      };
    },
    async roleCatalogs({ name }) {
      const r = need(name, 'name', 'roleCatalogs');
      const out = await get('fdmRoleCatalogs', { role: r }, `roleCatalogs ${r}`);
      const f = parseFdm(out.body);
      return { ...f, incomplete: fdmIncomplete(f, 'roleCatalogs') };
    },
  };

  return {
    definition: {
      name: 'adt_launchpad',
      description:
        'The Fiori launchpad via the standard /UI2 OData services. One `kind` per call: ' +
        'catalogs {layer, origin (default all but sap), match, max} / catalog {id} (tiles, target ' +
        'mappings, intents); groups / group {id}; spaces / space {id}; pages {skip} / page {id}; ' +
        'semobjs / semobj {id}; roleCatalogs {name} (catalogs of a PFCG role). 1-3 calls.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS },
          id: { type: 'string', description: 'catalog (bare or X-SAP-UI2-CATALOGPAGE:<id>), group, space, page or semobj id' },
          name: { type: 'string', description: 'a PFCG role name (roleCatalogs)' },
          layer: { type: 'string', enum: ['client', 'cross-client'] },
          origin: { type: 'string', enum: [...ORIGINS, 'all'] },
          match: { type: 'string', description: 'case-insensitive substring of id or title (lists)' },
          max: { type: 'integer', description: `lists: 1..${MAX_MAX} per page, default ${DEFAULT_MAX}` },
          offset: { type: 'integer', minimum: 0, description: 'lists: first entry of the page: `next.offset` of the previous answer' },
          skip: { type: 'integer', description: 'pages: entries to skip (50 per call)' },
        },
        required: ['kind'],
      },
    },
    async handler(args = {}) {
      const { kind } = args;
      if (!KINDS.includes(kind)) throw new LaunchpadRequestError(`kind is one of ${KINDS.join(', ')}; got ${kind}.`);
      const { incomplete = [], ...answer } = await handlers[kind](args);
      return asText(finish({ kind, ...answer }, incomplete));
    },
  };
}
