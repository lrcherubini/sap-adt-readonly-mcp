import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseServiceBinding,
  parseBindingDetail,
  detailKind,
  metadataRouteOf,
  readServiceBinding,
} from '../lib/service-binding.mjs';

// Replies measured 2026-11-09, anonymised (docs/adt-api-reference.md, "Service bindings").
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/service-binding/${name}`, import.meta.url), 'utf8');

test('a binding with two versions: each version carries its own release state and SRVD', () => {
  const b = parseServiceBinding(fixture('binding-v2-two-versions.xml'));
  assert.equal(b.name, 'ZDEMO_UI_FLIGHT_O2');
  assert.deepEqual([b.type, b.version, b.category, b.categoryText, b.contract], ['ODATA', 'V2', '0', 'UI', 'C1']);
  assert.equal(b.rootPublished, true);
  assert.deepEqual(b.versions, [
    { service: 'ZDEMO_UI_FLIGHT_O2', version: '0001', releaseState: 'NOT_RELEASED', serviceDefinition: 'ZDEMO_FLIGHT_A' },
    { service: 'ZDEMO_UI_FLIGHT_O2', version: '0002', releaseState: 'NOT_RELEASED', serviceDefinition: 'ZDEMO_FLIGHT_B' },
  ]);
  assert.deepEqual(b.drift, []);
  assert.equal(detailKind(b), 'V2');
});

test('a SQL binding has no version and no detail to read', () => {
  const b = parseServiceBinding(fixture('binding-sql.xml'));
  assert.deepEqual([b.type, b.version, b.category, b.contract], ['SQL', null, '1', 'C2']);
  assert.equal(detailKind(b), null);
  assert.deepEqual(b.drift, []);
});

test('a V4 binding: the service is named after its SRVD, not after the binding', () => {
  const b = parseServiceBinding(fixture('binding-v4-published.xml'));
  assert.equal(detailKind(b), 'V4');
  assert.equal(b.versions[0].service, 'ZDEMO_UI_CLSF');
  assert.notEqual(b.versions[0].service, b.name);
});

test('the detail: published versions list entity sets, an unpublished one lists nothing', () => {
  const off = parseBindingDetail(fixture('detail-v2-0001-unpublished.xml'));
  assert.deepEqual([off.published, off.created, off.serviceUrl, off.entitySets.length], [false, true, null, 0]);
  const on = parseBindingDetail(fixture('detail-v2-0002-published.xml'));
  assert.equal(on.published, true);
  assert.equal(on.version, '0002');
  assert.equal(on.serviceUrl, '/sap/opu/odata/sap/ZDEMO_UI_FLIGHT_O2;v=2');
  assert.ok(on.entitySets.length > 0);
  assert.ok(on.entitySets.some((e) => e.navigations.length > 0), 'a navigation names its target');
  assert.deepEqual(on.drift, []);
  const v4 = parseBindingDetail(fixture('detail-v4-published.xml'));
  assert.equal(v4.published, true);
  assert.equal(v4.serviceUrl, '/sap/opu/odata4/sap/zdemo_ui_clsf_o4/srvd/sap/zdemo_ui_clsf/0001/');
  assert.equal(v4.serviceUrlPrefix, '/sap/opu/odata4/sap/zdemo_ui_clsf_o4/srvd/');
  assert.equal(v4.annotationUrl, null);
  assert.ok(v4.entitySets.length > 0);
});

test('only a measured service URL form is mapped to a $metadata route; the others say why', () => {
  assert.deepEqual(metadataRouteOf('V2', '/sap/opu/odata/sap/ZDEMO_UI_O2'), { route: 'odataMetadata', service: 'ZDEMO_UI_O2' });
  assert.deepEqual(
    metadataRouteOf('V4', '/sap/opu/odata4/sap/zdemo_ui_clsf_o4/srvd/sap/zdemo_ui_clsf/0001/'),
    { route: 'odataMetadataV4', service: 'zdemo_ui_clsf_o4/srvd/sap/zdemo_ui_clsf/0001' }
  );
  assert.match(metadataRouteOf('V2', '/sap/opu/odata/sap/ZDEMO_UI_O2;v=2').why, /;v=N/);
  const ns = parseBindingDetail(fixture('detail-v2-namespaced-published.xml'));
  assert.match(metadataRouteOf('V2', ns.serviceUrl).why, /outside the sap namespace/);
  assert.match(metadataRouteOf('V2', null).why, /not published/);
  assert.equal(metadataRouteOf('V4', '/sap/opu/odata4/sap/x/other/sap/y/0001/').route, null);
});

test('an element outside the measured set is drift, not silently dropped', () => {
  const b = parseServiceBinding(fixture('binding-sql.xml').replace('</srvb:serviceBinding>', '<srvb:newThing/></srvb:serviceBinding>'));
  assert.deepEqual(b.drift, [{ node: 'srvb:newThing', count: 1, where: 'serviceBinding' }]);
});

// A transport that answers by URL, recording each request.
function transportOf(routes, sent = []) {
  return async (req) => {
    sent.push(req);
    for (const [re, body] of routes) {
      if (re.test(req.url)) {
        if (body instanceof Error) throw body;
        return { status: 200, body, headers: {} };
      }
    }
    throw Object.assign(new Error('not found'), { err: 404 });
  };
}

test('reading a two-version binding asks each version once, with that version and its own SRVD', async () => {
  const sent = [];
  const audit = [];
  const out = await readServiceBinding(
    transportOf([
      [/\/bindings\/zdemo_ui_flight_o2$/, fixture('binding-v2-two-versions.xml')],
      [/serviceversion=0001/, fixture('detail-v2-0001-unpublished.xml')],
      [/serviceversion=0002/, fixture('detail-v2-0002-published.xml')],
    ], sent),
    'ZDEMO_UI_FLIGHT_O2',
    { audit: (t, n) => audit.push(t) }
  );
  assert.equal(out.note, undefined);
  assert.deepEqual(sent.map((r) => r.method), ['GET', 'GET', 'GET']);
  // The exact URLs: the binding document in lower case, the detail in UPPER case (both measured).
  assert.deepEqual(sent.map((r) => r.url), [
    '/sap/bc/adt/businessservices/bindings/zdemo_ui_flight_o2',
    '/sap/bc/adt/businessservices/odatav2/ZDEMO_UI_FLIGHT_O2?servicename=ZDEMO_UI_FLIGHT_O2&serviceversion=0001&srvdname=ZDEMO_FLIGHT_A',
    '/sap/bc/adt/businessservices/odatav2/ZDEMO_UI_FLIGHT_O2?servicename=ZDEMO_UI_FLIGHT_O2&serviceversion=0002&srvdname=ZDEMO_FLIGHT_B',
  ]);
  const [v1, v2] = out.binding.versions;
  // The root says true; the versions disagree with each other -- both are reported as read.
  assert.equal(out.binding.rootPublished, true);
  assert.match(out.binding.rootPublishedNote, /does not speak for every version/);
  assert.deepEqual([v1.published, v2.published], [false, true]);
  assert.equal(v1.metadata.route, null);
  assert.match(v2.metadata.why, /;v=N/);
  assert.deepEqual(audit, ['ZDEMO_UI_FLIGHT_O2#binding', 'ZDEMO_UI_FLIGHT_O2#0001', 'ZDEMO_UI_FLIGHT_O2#0002']);
});

test('a V4 binding maps its published version to the odataMetadataV4 route', async () => {
  const out = await readServiceBinding(
    transportOf([
      [/\/bindings\/zdemo_ui_clsf_o4$/, fixture('binding-v4-published.xml')],
      [/\/odatav4\/ZDEMO_UI_CLSF_O4\?/, fixture('detail-v4-published.xml')],
    ]),
    'ZDEMO_UI_CLSF_O4'
  );
  assert.deepEqual(out.binding.versions[0].metadata, { route: 'odataMetadataV4', service: 'zdemo_ui_clsf_o4/srvd/sap/zdemo_ui_clsf/0001' });
});

test('a SQL binding reads the document only and says why there is no detail', async () => {
  const sent = [];
  const out = await readServiceBinding(transportOf([[/\/bindings\/zdemo_sql_service$/, fixture('binding-sql.xml')]], sent), 'ZDEMO_SQL_SERVICE');
  assert.equal(sent.length, 1);
  assert.match(out.binding.detailNote, /SQL binding has none/);
  assert.equal(out.binding.versions[0].published, undefined);
});

test('a failed read files BINDING_NOT_READ and never reads as unpublished', async () => {
  const gaps = [];
  const none = await readServiceBinding(transportOf([]), 'ZDEMO_UI_FLIGHT_O2', { gap: (g) => gaps.push(g) });
  assert.equal(none.binding, undefined);
  assert.match(none.note, /binding not read/);
  assert.equal(gaps[0].code, 'BINDING_NOT_READ');
  assert.match(gaps[0].impact, /NOT evidence that it is unpublished/);

  gaps.length = 0;
  const half = await readServiceBinding(
    transportOf([
      [/\/bindings\//, fixture('binding-v2-two-versions.xml')],
      [/serviceversion=0001/, Object.assign(new Error('server said no'), { err: 500 })],
      [/serviceversion=0002/, fixture('detail-v2-0002-published.xml')],
    ]),
    'ZDEMO_UI_FLIGHT_O2',
    { gap: (g) => gaps.push(g) }
  );
  const [v1, v2] = half.binding.versions;
  assert.equal(v1.published, null, 'unknown, not false');
  assert.match(v1.detailNote, /detail not read/);
  assert.equal(v2.published, true, 'the other version still stands');
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].detail, /version 0001/);
});

test('the not-found row (created="false") is unknown, never "unpublished"', async () => {
  // Measured: a lower-case path and a wrong version both answer 200 with this row.
  const notFound = fixture('detail-v2-0002-published.xml')
    .replace('odatav2:published="true"', 'odatav2:published="false"')
    .replace('odatav2:created="true"', 'odatav2:created="false"');
  const gaps = [];
  const out = await readServiceBinding(
    transportOf([
      [/\/bindings\//, fixture('binding-v2-two-versions.xml')],
      [/serviceversion=0001/, fixture('detail-v2-0001-unpublished.xml')],
      [/serviceversion=0002/, notFound],
    ]),
    'ZDEMO_UI_FLIGHT_O2',
    { gap: (g) => gaps.push(g) }
  );
  const [v1, v2] = out.binding.versions;
  assert.equal(v1.published, false, 'created="true" + published="false" is a real unpublished version');
  assert.equal(v2.published, null);
  assert.match(v2.detailNote, /not-found row/);
  assert.deepEqual(gaps.map((g) => g.code), ['BINDING_NOT_READ']);
});

test('a name the route cannot address is refused before any request', async () => {
  const sent = [];
  const out = await readServiceBinding(transportOf([], sent), 'A/B/C');
  assert.match(out.note, /not a name the binding route can address/);
  assert.equal(sent.length, 0);
});

test('a drifted reply is filed once as SHAPE_DRIFT and the fields read still stand', async () => {
  const gaps = [];
  const out = await readServiceBinding(
    transportOf([[/\/bindings\//, fixture('binding-sql.xml').replace('</srvb:serviceBinding>', '<srvb:newThing/></srvb:serviceBinding>')]]),
    'ZDEMO_SQL_SERVICE',
    { gap: (g) => gaps.push(g) }
  );
  assert.equal(out.binding.type, 'SQL');
  assert.deepEqual(gaps.map((g) => g.code), ['SHAPE_DRIFT']);
});
