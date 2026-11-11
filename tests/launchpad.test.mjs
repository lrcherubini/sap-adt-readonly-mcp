// adt_launchpad: the launchpad OData parser and the tool, against the
// bodies measured on the development system on 2026-10-02 (tests/fixtures/launchpad, no user in any of them).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parsePage,
  parseCatalogList,
  parseGroupList,
  parseFdm,
  intentsOf,
  catalogPageId,
  catalogOrigin,
  stripPersons,
  tileConfigurationOf,
  tileReferenceOf,
  odataBody,
} from '../lib/launchpad.mjs';
import { launchpadTool, KINDS } from '../tools/launchpad.mjs';
import { resetBudget } from '../lib/audit.mjs';
import { contractErrors } from '../lib/completeness.mjs';

const F = (name) => fs.readFileSync(new URL(`./fixtures/launchpad/${name}`, import.meta.url), 'utf8');
test('a catalog page: target mapping and tile normalized, the bag title wins, the intent counted', () => {
  const p = parsePage(F('page-catalog-ZDEMO_CAT.json'));
  assert.deepEqual(p.drift, []);
  assert.equal(p.page.isCatalog, true);
  assert.equal(p.page.isGroup, false);
  const tm = p.instances.find((i) => i.kind === 'targetMapping');
  assert.equal(tm.mapping.intent, 'SalesQuotation-display');
  assert.deepEqual(tm.mapping.application, { transaction: 'VA23' });
  assert.equal(tm.mapping.parameters.SalesQuotation.renameTo, 'VBAK-VBELN');
  assert.equal(tm.mapping.parameters.DynproOKCode.default, 'ENT2');
  const tile = p.instances.find((i) => i.kind === 'tile');
  assert.equal(tile.tile.title, 'Display Sales Quotations', 'the tileProperties bag, not the configuration (Display Sales Quotations)');
  assert.equal(tile.tile.intent, 'SalesQuotation-display');
  assert.deepEqual(intentsOf(p), [{ intent: 'SalesQuotation-display', targetMappings: 1, tiles: 1 }]);
  const accent = parsePage(F('page-catalog-accent.json'));
  assert.equal(accent.page.id, 'X-SAP-UI2-CATALOGPAGE:Café');
  assert.deepEqual(accent.instances.find((i) => i.kind === 'targetMapping').mapping.application, { transaction: 'ZDEMO_TCODE' });
});

test('a group: each tile is a reference to a catalog instance, in the order the layout gives', () => {
  const g = parsePage(F('page-group-ZDEMO_STOCK.json'));
  assert.equal(g.page.isGroup, true);
  assert.equal(g.page.order.length, 5);
  assert.equal(g.instances.length, 5);
  assert.ok(g.instances.every((i) => i.kind === 'tileReference' && i.catalog === 'X-SAP-UI2-CATALOGPAGE:ZDEMO_STOCK'));
  assert.equal(g.instances.find((i) => i.tile?.intent === 'Material-displayStockOverview').title, 'Stock');
  assert.deepEqual(tileReferenceOf('X-SAP-UI2-PAGE:X-SAP-UI2-CATALOGPAGE:ZDEMO_STOCK:006O07P9K7QLV2ZTSHZIYXJ3S'), {
    catalog: 'X-SAP-UI2-CATALOGPAGE:ZDEMO_STOCK',
    instance: '006O07P9K7QLV2ZTSHZIYXJ3S',
  });
  assert.equal(tileReferenceOf('X-SAP-UI2-CHIP:/UI2/ACTION'), null);
});

test('whose catalog: Z/Y, created in the client without a prefix, SAP changed in the client, SAP', () => {
  const rows = parseCatalogList(F('catalogs-cust.json'), 'client');
  const by = Object.fromEntries(rows.map((r) => [r.id, r.origin]));
  assert.equal(by['X-SAP-UI2-CATALOGPAGE:ZDEMO_CAT'], 'customer');
  assert.equal(by['X-SAP-UI2-CATALOGPAGE:TK11'], 'customer-no-prefix');
  assert.equal(by['X-SAP-UI2-CATALOGPAGE:Café'], 'customer-no-prefix');
  assert.equal(by['X-SAP-UI2-CATALOGPAGE:SAP_PRC_BC_PRC_OVP'], 'sap-changed');
  assert.equal(by['X-SAP-UI2-CATALOGPAGE:SAP_TC_FLP_COMMON'], 'sap');
  assert.ok(rows.some((r) => r.id.endsWith('​')), 'the zero-width space survives: it is part of the id');
  // A namespace is SAP's or an SAP partner's product: a Z after it does not make it the customer's.
  assert.equal(catalogOrigin({ domainId: '/UI2/ZDEMO_TEST', scope: 'CONFIGURATION' }), 'sap');
  // 14 of these on client 001 (2026-10-02): a lowercase z is still the customer's.
  assert.equal(catalogOrigin({ domainId: 'ZDEMO_TC_TRM_APPS', scope: 'CUSTOMIZING' }), 'customer');
  assert.equal(catalogOrigin({ domainId: '/UI2/C2GFLPPLUGIN', scope: 'CUSTOMIZING' }), 'sap-changed');
  assert.equal(catalogPageId('ZDEMO_CAT'), 'X-SAP-UI2-CATALOGPAGE:ZDEMO_CAT');
  assert.equal(catalogPageId('X-SAP-UI2-CATALOGPAGE:ZDEMO_CAT'), 'X-SAP-UI2-CATALOGPAGE:ZDEMO_CAT');
  const groups = parseGroupList(F('groups.json'));
  assert.equal(groups.find((g) => g.id === 'ZDEMO_STOCK').origin, 'customer');
});

test('FDM bodies lose their plumbing and every person-like key; a list keeps its __count', () => {
  const pages = parseFdm(F('fdm-pages.json'));
  assert.equal(pages.count, 408);
  assert.equal(pages.rows.length, 3);
  const page = parseFdm(F('fdm-page.json')).entity;
  assert.deepEqual(page.sections[0].viz, []);
  assert.ok(page.roles.some((r) => r.id === 'Z_DEMO_ADMINISTRATOR'));
  assert.ok(!JSON.stringify(page).includes('__metadata'));
  assert.deepEqual(stripPersons({ id: 'P', createdBy: 'X', modifiedByFullname: 'Y', viz: [{ id: 'v', username: 'U' }], link: { __deferred: { uri: 'u' } } }), { id: 'P', viz: [{ id: 'v' }] });
  assert.throws(() => odataBody('<html>502</html>'), /not JSON/);
  assert.throws(() => odataBody('{"error":{}}'), /no OData "d" node/);
});

test('a tile configuration that does not parse is drift with its text, never a silent empty tile', () => {
  assert.deepEqual(tileConfigurationOf(''), { value: null, drift: null });
  assert.match(tileConfigurationOf('{oops').drift.where, /^configuration: /);
  assert.match(tileConfigurationOf('{"tileConfiguration":"{bad"}').drift.where, /^tileConfiguration: /);
  assert.match(tileConfigurationOf('{"x":1}').drift.where, /no tileConfiguration/);
  const body = JSON.parse(F('page-catalog-ZDEMO_CAT.json'));
  body.d.PageChipInstances.results[0].configuration = '{"tileConfiguration":"{broken"}';
  const p = parsePage(JSON.stringify(body));
  assert.equal(p.drift.length, 1);
  assert.equal(p.instances[0].kind, 'targetMapping');
  assert.ok(!('mapping' in p.instances[0]));
});

// --- the tool ---------------------------------------------------------------------------------

const audit = [];
const gaps = [];
const cfg = { host: 'dev.example', client: '001', budget: { reads: 1000 }, auditSink: (l) => audit.push(JSON.parse(l)) };
const journal = { enabled: true, gap: (g) => gaps.push(g) };
const col = (name, values) =>
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
  (values.length ? `<dataPreview:dataSet>${values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join('')}</dataPreview:dataSet>` : '<dataPreview:dataSet/>') +
  '</dataPreview:columns>';
const preview = (sql, rows, columns) =>
  '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
  `<dataPreview:totalRows>${rows}</dataPreview:totalRows>` +
  `<dataPreview:executedQueryString>${sql.replace(/\s+/g, ' ')}   INTO     TABLE @DATA(LT_RESULT)   UP TO 5  ROWS   .</dataPreview:executedQueryString>` +
  Object.entries(columns).map(([n, v]) => col(n, v)).join('') +
  '</dataPreview:tableData>';

/** A session whose transport answers by URL; `posts` answer the data preview by table. */
function sessionWith(routes, posts = {}) {
  const sent = [];
  return {
    sent,
    session: {
      api: {},
      raw: {
        httpClient: {
          request: async (url, c) => {
            sent.push({ url, method: c.method, body: c.body });
            if (c.method === 'POST') {
              const table = /FROM (\S+)/.exec(c.body)[1];
              const a = posts[table];
              return { status: 200, body: preview(c.body, a.rows.length, a.columns(a.rows)), headers: {} };
            }
            const hit = Object.entries(routes).find(([k]) => url.includes(k));
            if (!hit) throw Object.assign(new Error('Not Found'), { err: 404 });
            const [, a] = hit;
            if (a.status) throw Object.assign(new Error('server said no'), { err: a.status });
            return { status: 200, body: a, headers: { 'content-type': 'application/json' } };
          },
        },
      },
    },
  };
}
const run = async (session, args) => JSON.parse((await launchpadTool(cfg, session, journal).handler(args)).content[0].text);

beforeEach(() => {
  audit.length = 0;
  gaps.length = 0;
  resetBudget();
});

test('adt_launchpad: one kind per call, refused before a socket when the kind or the arguments are wrong', async () => {
  const { session, sent } = sessionWith({});
  const tool = launchpadTool(cfg, session, journal);
  await assert.rejects(() => tool.handler({}), /kind is one of/);
  await assert.rejects(() => tool.handler({ kind: 'catalog' }), /needs 'id'/);
  await assert.rejects(() => tool.handler({ kind: 'catalogs', layer: 'tenant' }), /layer is/);
  await assert.rejects(() => tool.handler({ kind: 'catalogs', max: 501 }), /1 to 500/);
  // The kinds that needed a customer (Z) service are gone: this server reads SAP-standard services only.
  for (const gone of ['roles', 'role', 'roleLaunchpad']) await assert.rejects(() => tool.handler({ kind: gone }), /kind is one of/);
  // `intent` read an index a scan script wrote to disk; the scripts are gone, and so is the kind.
  await assert.rejects(() => tool.handler({ kind: 'intent', id: 'SalesOrder-display' }), /kind is one of/);
  await assert.rejects(() => tool.handler({ kind: 'roleCatalogs', name: 'Z X' }), (e) => e.name === 'RouteViolation');
  await assert.rejects(() => tool.handler({ kind: 'pages', skip: -1 }), /skip must be/);
  await assert.rejects(() => launchpadTool(cfg, { api: {} }, journal).handler({ kind: 'groups' }), /no raw client/);
  assert.equal(sent.length, 0);
  assert.deepEqual(gaps, [], 'a caller error is not a gap of the server');
  assert.ok(KINDS.includes('roleCatalogs') && !KINDS.includes('intent') && !KINDS.includes('roleLaunchpad'));
});

test('adt_launchpad catalog: a bare id gains the prefix, one GET, the audit names the catalog', async () => {
  const { session, sent } = sessionWith({ "Pages('X-SAP-UI2-CATALOGPAGE%3AZDEMO_CAT')": F('page-catalog-ZDEMO_CAT.json') });
  const out = await run(session, { kind: 'catalog', id: 'ZDEMO_CAT' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'GET');
  assert.deepEqual(out.intents, [{ intent: 'SalesQuotation-display', targetMappings: 1, tiles: 1 }]);
  assert.equal(audit.length, 1);
  assert.match(audit[0].subject ?? JSON.stringify(audit[0]), /catalog X-SAP-UI2-CATALOGPAGE:ZDEMO_CAT/);
});

test('adt_launchpad lists: the customer catalogs by default, counts by origin, match and max', async () => {
  const { session } = sessionWith({ 'PAGE_BUILDER_CUST/Catalogs': F('catalogs-cust.json'), 'PAGE_BUILDER_CUST/Pages?': F('groups.json') });
  const all = await run(session, { kind: 'catalogs' });
  assert.equal(all.total, 9);
  assert.ok(all.catalogs.every((c) => c.origin !== 'sap'));
  assert.equal(all.byOrigin.customer, 2);
  const one = await run(session, { kind: 'catalogs', match: 'demo_cat', max: 1 });
  assert.deepEqual(one.catalogs.map((c) => c.id), ['X-SAP-UI2-CATALOGPAGE:ZDEMO_CAT']);
  const sap = await run(session, { kind: 'catalogs', origin: 'sap' });
  assert.ok(sap.catalogs.every((c) => c.origin === 'sap'));
  const groups = await run(session, { kind: 'groups', origin: 'all' });
  assert.equal(groups.total, 4);
  // Two pages of a list are the list once.
  const first = await run(session, { kind: 'groups', origin: 'all', max: 2 });
  assert.deepEqual(contractErrors(first), []);
  assert.equal(first.complete, false);
  const second = await run(session, { kind: 'groups', origin: 'all', max: 2, offset: first.groupsPage.next.offset });
  assert.deepEqual([...first.groups, ...second.groups].map((g) => g.id), groups.groups.map((g) => g.id));
});

test('an FDM body with __next or deferred navigations says so: not followed, not expanded', () => {
  const f = parseFdm(JSON.stringify({ d: { __next: 'x?$skiptoken=2', results: [{ id: 'ZDEMO_SP', pages: { __deferred: { uri: 'x' } } }] } }));
  assert.equal(f.serverNext, true);
  assert.deepEqual(f.deferred, ['pages']);
  assert.equal(f.rows[0].pages, undefined);
});

test('adt_launchpad FDM: a space, a page, 50 pages at a time with the next offset', async () => {
  const { session } = sessionWith({
    "spaceSet('SAP_FIN_SP_JVA_ACCOUNTANT')": F('fdm-space.json'),
    "pageSet('SAP_BASIS_PG_UI_FLP')": F('fdm-page.json'),
    pagesMasterSet: F('fdm-pages.json'),
    spacesMasterSet: F('fdm-spaces.json'),
    "roleSet('ZS%3ADEMO.ROLE_C')": F('fdm-role-catalogs.json'),
  });
  const space = await run(session, { kind: 'space', id: 'SAP_FIN_SP_JVA_ACCOUNTANT' });
  assert.equal(space.entity.pages.length, 5);
  const page = await run(session, { kind: 'page', id: 'SAP_BASIS_PG_UI_FLP' });
  assert.equal(page.entity.id, 'SAP_BASIS_PG_UI_FLP');
  const pages = await run(session, { kind: 'pages' });
  assert.equal(pages.total, 408);
  assert.deepEqual(pages.next, { skip: 3 });
  assert.deepEqual(contractErrors(pages), []);
  assert.deepEqual(pages.incomplete.find((i) => i.list === 'pages').next, { skip: 3 });
  assert.deepEqual(contractErrors(space), []);
  const spaces = await run(session, { kind: 'spaces' });
  assert.equal(spaces.customer, 0);
  const rc = await run(session, { kind: 'roleCatalogs', name: 'ZS:DEMO.ROLE_C' });
  assert.equal(rc.rows.length, 3);
});

test('adt_launchpad semobj: customer, SAP or none, from the allow-listed tables; semobjs with texts', async () => {
  const rowsOf = (rows) => (cols) => Object.fromEntries(cols.map((c) => [c, rows.map((r) => r[c])]));
  const posts = (c, sap) => ({
    '/UI2/SEMOBJC': { rows: c, columns: (r) => rowsOf(r)(['SEM_OBJ']) },
    '/UI2/SEMOBJCT': { rows: c.map((x) => ({ LANGUAGE: 'E', SEM_OBJ: x.SEM_OBJ, SEM_OBJ_NAME: x.SEM_OBJ, SEM_OBJ_TEXT: `text ${x.SEM_OBJ}` })), columns: (r) => rowsOf(r)(['LANGUAGE', 'SEM_OBJ', 'SEM_OBJ_NAME', 'SEM_OBJ_TEXT']) },
    '/UI2/SEMOBJ': { rows: sap, columns: (r) => rowsOf(r)(['SEM_OBJ', 'AKH_COMP', 'STATUS']) },
  });
  let s = sessionWith({}, posts([{ SEM_OBJ: 'EmployeeDemo' }], []));
  const c = await run(s.session, { kind: 'semobj', id: 'EmployeeDemo' });
  assert.equal(c.registered, 'customer');
  assert.equal(c.texts[0].text, 'text EmployeeDemo');
  assert.ok(s.sent.every((x) => x.method === 'POST' && /datapreview\/freestyle/.test(x.url)));
  s = sessionWith({}, posts([], [{ SEM_OBJ: 'SalesOrder', AKH_COMP: 'SD-SLS', STATUS: '' }]));
  assert.equal((await run(s.session, { kind: 'semobj', id: 'SalesOrder' })).registered, 'sap');
  s = sessionWith({}, posts([], []));
  assert.equal((await run(s.session, { kind: 'semobj', id: 'OutletsOrder' })).registered, 'none');
  s = sessionWith({}, posts([{ SEM_OBJ: 'DemoPlm' }, { SEM_OBJ: 'ZDEMO_LOGS' }], []));
  const list = await run(s.session, { kind: 'semobjs', match: 'demoplm' });
  assert.deepEqual(list.semanticObjects.map((x) => x.semanticObject), ['DemoPlm']);
  assert.equal(list.semanticObjects[0].prefixZ, false);
  assert.deepEqual(contractErrors(list), []);
  assert.deepEqual(contractErrors(c), []);
});

test('adt_launchpad: a failed read is a LAUNCHPAD_NOT_READ gap, never an empty answer', async () => {
  const { session } = sessionWith({ "Pages('ZNOPE')": { status: 404 } });
  await assert.rejects(() => run(session, { kind: 'group', id: 'ZNOPE' }), /404/);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].code, 'LAUNCHPAD_NOT_READ');
  assert.match(gaps[0].impact, /NOT an empty catalog/);
});

