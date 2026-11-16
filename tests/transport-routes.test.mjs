// adt_transport_routes: the STMS domain and routes from the TMS tables, as measured on 2026-11-12
// (docs/adt-api-reference.md, "The transport routes of the STMS"), with invented system ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transportRoutesTool, chainOf } from '../tools/transport-routes.mjs';
import { contractErrors } from '../lib/completeness.mjs';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');

/** A data preview reply in the measured column-major shape, for the statement `sql`. */
function previewReply(sql, rows) {
  const columns = rows.length ? Object.keys(rows[0]) : ['VERSION'];
  const cols = columns
    .map(
      (c) =>
        `<dataPreview:columns><dataPreview:metadata dataPreview:name="${c}" dataPreview:type="C" dataPreview:description="${c}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>` +
        `<dataPreview:dataSet>${rows.map((r) => `<dataPreview:data>${xmlEscape(r[c] ?? '')}</dataPreview:data>`).join('')}</dataPreview:dataSet></dataPreview:columns>`
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `<dataPreview:totalRows>${rows.length}</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>` +
    `<dataPreview:executedQueryString>${xmlEscape(sql)} INTO TABLE @DATA(LT_RESULT) UP TO 200 ROWS .</dataPreview:executedQueryString>` +
    `<dataPreview:queryExecutionTime>1</dataPreview:queryExecutionTime>${cols}</dataPreview:tableData>`
  );
}

/** The measured landscape: one real system DEV, a virtual QAS, version 0002 active. */
const MEASURED = {
  TCEVERS: [
    { VERSION: '0001', ACTIVE: 'D', DELCASCADE: '', CHANGED: '20221206201731', ACTIVATION: '20221206201735', DEACTIVAT: '20221207203348', CONTROLER: '', CONVERS: '0001' },
    { VERSION: '0002', ACTIVE: 'A', DELCASCADE: '', CHANGED: '20221207203345', ACTIVATION: '20221207203348', DEACTIVAT: '00000000000000', CONTROLER: 'DEV', CONVERS: '0002' },
  ],
  TCETRAL: [{ VERSION: '0002', TRANSLAYER: 'SAP' }, { VERSION: '0002', TRANSLAYER: 'ZDEV' }],
  TCETRALT: [
    { VERSION: '0002', TRANSLAYER: '', SPRAS: 'E', CTEXT: 'Transport Layer for Local Developments (No Transport)' },
    { VERSION: '0002', TRANSLAYER: 'SAP', SPRAS: 'E', CTEXT: 'Transport Layer for SAP Standard Objects' },
    { VERSION: '0002', TRANSLAYER: 'ZDEV', SPRAS: 'E', CTEXT: 'Transport Layer ZDEV' },
  ],
  TCESYST: [
    { VERSION: '0002', SYSNAME: 'DEV', TRANSLAYER: 'ZDEV', DEVTYPE: '', FUNCRES: '' },
    { VERSION: '0002', SYSNAME: 'QAS', TRANSLAYER: '', DEVTYPE: 'A', FUNCRES: '' },
  ],
  TCESYSTT: [],
  TCERELE: [
    { VERSION: '0002', TRANSLAYER: 'SAP', INTSYS: 'DEV', CONSYS: 'QAS', ORICON: 'SAP' },
    { VERSION: '0002', TRANSLAYER: 'ZDEV', INTSYS: 'DEV', CONSYS: 'QAS', ORICON: 'QAS' },
  ],
  TCEDELI: [],
  TMSCDOM: [{ DOMNAM: 'DOMAIN_DEV', CICFG: '', DOMCTL: 'DEV', DOMBCK: '', DOMTXT: 'Transport domain DEV', AUTOACCEPT: '', DISTMODE: '', SINSON: '', SNCALLOW: '', EXTDOM: '' }],
  TMSCSYS: [
    { DOMNAM: 'DOMAIN_DEV', SYSNAM: 'DEV', SYSTXT: 'System DEV', SAPREL: '758', NFSGRP: 'GROUP_DEV', COMSYS: '', SYSTYP: 'R' },
    { DOMNAM: 'DOMAIN_DEV', SYSNAM: 'QAS', SYSTXT: 'Virtual', SAPREL: '758', NFSGRP: 'GROUP_DEV', COMSYS: 'DEV', SYSTYP: 'V' },
  ],
};

/** A session whose data preview answers from `tables`; a table named in `failing` answers 403. */
function sessionWith(tables, { failing = [] } = {}) {
  const sent = [];
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        const sql = String(opts.body);
        const table = /FROM (\S+)/.exec(sql)[1];
        sent.push(table);
        if (failing.includes(table)) throw Object.assign(new Error('no authorization'), { status: 403 });
        const version = /VERSION = '(\d{4})'/.exec(sql)?.[1];
        const rows = (tables[table] ?? []).filter((r) => !version || r.VERSION === version);
        return { status: 200, body: previewReply(sql, rows), headers: {} };
      },
    },
  };
  return { session: { raw }, sent };
}

const cfg = { system: 'DEV', budget: { reads: 1000 }, auditSink: () => {} };
const run = async (session, args = {}, journal) => JSON.parse((await transportRoutesTool(cfg, session, journal).handler(args)).content[0].text);

test('the measured landscape: the active version, its layers, systems, consolidation and the chain of each layer', async () => {
  const { session, sent } = sessionWith(MEASURED);
  const out = await run(session);
  assert.deepEqual(contractErrors(out), []);
  assert.equal(out.complete, true);
  assert.equal(out.version, '0002', 'the one row with ACTIVE = A');
  assert.deepEqual(out.versions.map((v) => [v.version, v.active, v.deactivated]), [['0001', false, '2022-12-07T20:33:48'], ['0002', true, null]]);
  assert.deepEqual(out.layers.map((l) => l.layer), ['SAP', 'ZDEV'], 'the text of a blank layer is not a layer');
  assert.deepEqual(out.layers[1].texts, { E: 'Transport Layer ZDEV' });
  const dev = out.systems.find((s) => s.sid === 'DEV');
  assert.deepEqual(
    { type: dev.type, layer: dev.developmentLayer, release: dev.release, here: dev.isThisSystem },
    { type: 'real', layer: 'ZDEV', release: '758', here: true }
  );
  assert.equal(out.systems.find((s) => s.sid === 'QAS').type, 'virtual');
  assert.equal(out.systems.find((s) => s.sid === 'QAS').communicationSystem, 'DEV');
  assert.deepEqual(out.consolidation[1], { layer: 'ZDEV', from: 'DEV', to: 'QAS', oricon: 'QAS' });
  assert.deepEqual(out.delivery, [], 'two systems need no delivery route: read, and empty');
  assert.deepEqual(out.chains.map((c) => [c.layer, c.systems]), [['SAP', ['DEV', 'QAS']], ['ZDEV', ['DEV', 'QAS']]]);
  assert.deepEqual(out.domain, [{ name: 'DOMAIN_DEV', text: 'Transport domain DEV', controller: 'DEV', backupController: null }]);
  assert.equal(sent.length, 9, 'versions, six tables of the version, the domain and its systems');
});

test('a chain follows every active delivery route from the consolidation target, each system once', () => {
  const delivery = [
    { from: 'QAS', fromClient: null, to: 'PRD', inactive: false },
    { from: 'QAS', fromClient: null, to: 'TRN', inactive: false },
    { from: 'PRD', fromClient: null, to: 'QAS', inactive: false },
    { from: 'QAS', fromClient: null, to: 'OLD', inactive: true },
  ];
  const chain = chainOf({ layer: 'ZDEV', from: 'DEV', to: 'QAS' }, delivery);
  assert.deepEqual(chain.systems, ['DEV', 'QAS', 'PRD', 'TRN']);
  assert.equal(chain.deliveries.length, 3, 'the loop back to QAS is listed and not followed twice');
});

test('a table that could not be read is NOT_READ and filed, never an empty route', async () => {
  const gaps = [];
  const { session } = sessionWith(MEASURED, { failing: ['TCERELE'] });
  const out = await run(session, {}, { gap: (g) => gaps.push(g) });
  assert.equal(out.complete, false);
  assert.deepEqual(contractErrors(out), []);
  assert.deepEqual(out.incomplete.map((i) => [i.list, i.code]), [['consolidation', 'NOT_READ']]);
  assert.deepEqual(out.consolidation, []);
  assert.equal(out.notRead[0].table, 'TCERELE');
  assert.equal(gaps[0].code, 'TRANSPORT_ROUTES_NOT_READ');
});

test('no active version, or several, is not guessed: the answer asks for `version`', async () => {
  const none = { ...MEASURED, TCEVERS: MEASURED.TCEVERS.map((v) => ({ ...v, ACTIVE: 'D' })) };
  const out = await run(sessionWith(none).session);
  assert.equal(out.version, null);
  assert.match(out.incomplete.find((i) => i.list === 'routes').reason, /0 configuration versions are marked active/);
  assert.deepEqual(out.consolidation, []);
  const older = await run(sessionWith(MEASURED).session, { version: '0001' });
  assert.equal(older.version, '0001');
  assert.deepEqual(older.layers, [], 'version 0001 holds no rows in this fixture');
  await assert.rejects(() => run(sessionWith(MEASURED).session, { version: '0009' }), /does not exist here. Versions: 0001, 0002/);
  await assert.rejects(() => transportRoutesTool(cfg, {}).handler({}), /no raw client/);
});
