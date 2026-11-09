// A deployed Fiori app checked against the LIVE $metadata of its services, V2 and V4.
//
// The shapes reproduce the measurement of 2026-11-09 (docs/adt-api-reference.md, "The UI5
// repository over the ADT") with demo names: the filestore feed with `%2f` ids, a manifest whose
// mainService is a V2 binding of another name than its service definition, a controller that
// reads with an escaped `"\$filter"` and a callback holding a regex literal, a callFunction with
// urlParameters -- every one of those broke a first pass of the extractor on the real app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFolderFeed,
  dataSourcesOf,
  odataModelsOf,
  parseServiceMetadata,
  manifestCitations,
  citationsOf,
  checkCitations,
  filesWorthReading,
} from '../lib/ui5-repository.mjs';
import { buildUrl, namedGet, TEMPLATES, routeAuthority, assertRouteTable, RouteViolation } from '../lib/adt-get.mjs';
import { runContractCheck } from '../tools/contract-check.mjs';
import { openJournal } from '../lib/journal.mjs';

const FEED = (entries) =>
  '<?xml version="1.0" encoding="utf-8"?><atom:feed xml:base="/sap/bc/adt/filestore/ui5-bsp/objects/" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<atom:author/><atom:id>ZUI5_DEMO_APP</atom:id><atom:title>ZUI5_DEMO_APP</atom:title>' +
  entries
    .map(([id, kind]) =>
      `<atom:entry><atom:category term="${kind}"/>` +
      (kind === 'file' ? `<atom:content afr:etag="20261030125200" type="application/octet-stream" src="./${id}/content" xmlns:afr="http://www.sap.com/adt/afr"/>` : '') +
      `<atom:id>${id}</atom:id><atom:title>${decodeURIComponent(id)}</atom:title></atom:entry>`
    )
    .join('') +
  '</atom:feed>';

const V2 =
  '<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">' +
  '<edmx:DataServices m:DataServiceVersion="2.0"><Schema Namespace="cds_zui_demo_monitor" xml:lang="pt" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">' +
  '<EntityType Name="MonitorType"><Key><PropertyRef Name="SalesOrder"/></Key><Property Name="SalesOrder" Type="Edm.String"/><Property Name="Customer" Type="Edm.String"/>' +
  '<NavigationProperty Name="to_Items" Relationship="x" FromRole="a" ToRole="b"/></EntityType>' +
  '<EntityType Name="DurationType"><Key><PropertyRef Name="Id"/></Key><Property Name="Id" Type="Edm.Guid"/><Property Name="SalesOrder" Type="Edm.String"/></EntityType>' +
  '<EntityType Name="SAP__CurrencyType"><Property Name="CurrencyCode" Type="Edm.String"/></EntityType>' +
  '<EntityContainer Name="cds_zui_demo_monitor_Entities" m:IsDefaultEntityContainer="true">' +
  '<EntitySet Name="Monitor" EntityType="cds_zui_demo_monitor.MonitorType"/><EntitySet Name="Duration" EntityType="cds_zui_demo_monitor.DurationType"/>' +
  '<EntitySet Name="SAP__Currencies" EntityType="cds_zui_demo_monitor.SAP__CurrencyType"/>' +
  '<FunctionImport Name="CheckDemo" ReturnType="cds_zui_demo_monitor.MonitorType" EntitySet="Monitor" m:HttpMethod="POST"><Parameter Name="SalesOrder" Type="Edm.String" Mode="In"/></FunctionImport>' +
  '</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>';

const V4 =
  '<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>' +
  '<Schema Namespace="com.sap.gateway.srvd.zui_demo_travel.v0001" Alias="SAP__self" xmlns="http://docs.oasis-open.org/odata/ns/edm">' +
  '<EntityType Name="TravelType"><Key><PropertyRef Name="TravelID"/></Key><Property Name="TravelID" Type="Edm.String"/><Property Name="Status" Type="Edm.String"/>' +
  '<NavigationProperty Name="_Booking" Type="Collection(com.sap.gateway.srvd.zui_demo_travel.v0001.BookingType)"/></EntityType>' +
  '<EntityType Name="BookingType"><Key><PropertyRef Name="BookingID"/></Key><Property Name="BookingID" Type="Edm.String"/></EntityType>' +
  '<Action Name="acceptTravel" IsBound="true"><Parameter Name="_it" Type="com.sap.gateway.srvd.zui_demo_travel.v0001.TravelType"/><Parameter Name="Reason" Type="Edm.String"/></Action>' +
  '<Function Name="countOpen"><Parameter Name="Agency" Type="Edm.String"/><ReturnType Type="Edm.Int32"/></Function>' +
  '<EntityContainer Name="Container"><EntitySet Name="Travel" EntityType="com.sap.gateway.srvd.zui_demo_travel.v0001.TravelType"/>' +
  '<EntitySet Name="Booking" EntityType="com.sap.gateway.srvd.zui_demo_travel.v0001.BookingType"/>' +
  '<FunctionImport Name="countOpen" Function="com.sap.gateway.srvd.zui_demo_travel.v0001.countOpen"/></EntityContainer>' +
  '</Schema></edmx:DataServices></edmx:Edmx>';

const MANIFEST = {
  'sap.app': {
    id: 'demo.app',
    dataSources: {
      mainService: { uri: '/sap/opu/odata/sap/ZUI_DEMO_MONITOR_O2/', type: 'OData', settings: { localUri: 'localService/mainService/metadata.xml', odataVersion: '2.0' } },
      ZUI_DEMO_MONITOR_VAN: { uri: "/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/Annotations(TechnicalName='ZUI_DEMO_MONITOR_VAN',Version='0001')/$value/", type: 'ODataAnnotation' },
    },
  },
  'sap.ui5': {
    models: { '': { dataSource: 'mainService' }, duration: { type: 'sap.ui.model.json.JSONModel' } },
    extends: { extensions: { 'sap.ui.controllerExtensions': { x: { 'sap.ui.generic.app': { Monitor: { EntitySet: 'Monitor' } } } } } },
  },
  'sap.ui.generic.app': {
    pages: { 'ListReport|Monitor': { entitySet: 'Monitor', pages: { 'ObjectPage|Monitor': { entitySet: 'Monitor' } } } },
  },
};

const HANDLER = `sap.ui.define([], function () {
  return {
    check: function (oModel, sSalesOrder) {
      oModel.callFunction(
        "/CheckDemo",
        {
          method: "POST",
          urlParameters: {
            SalesOrder: sSalesOrder,
            Plant: "1000"
          },
          success: function () {}
        });
    },
    search: function (oODataModel, sSalesOrder) {
      var s = String(sSalesOrder).replace(/'/g, "''");
      oODataModel.read("/Duration", {
        urlParameters: {
          "\\$filter": "SalesOrder eq '" + s + "' and Plant eq '1'",
          "$top": "1"
        },
        success: function (oData) { var r = /'/g; }
      });
      oODataModel.read("/DurationOld");
      oODataModel.create("/Duration", {}, {});
    }
  };
});`;

// --- the feed and the manifest ------------------------------------------------------------------

test('a filestore folder feed lists files and folders by decoded path, files with their etag', () => {
  const entries = parseFolderFeed(FEED([['ZUI5_DEMO_APP%2fcontroller', 'folder'], ['ZUI5_DEMO_APP%2fmanifest.json', 'file']]));
  assert.deepEqual(entries, [
    { path: 'ZUI5_DEMO_APP/controller', kind: 'folder', etag: null },
    { path: 'ZUI5_DEMO_APP/manifest.json', kind: 'file', etag: '20261030125200' },
  ]);
  assert.deepEqual(parseFolderFeed('<atom:feed/>'), []);
});

test('the manifest names V2 and V4 services, each with the route of its $metadata; other forms are said', () => {
  const ds = dataSourcesOf({
    'sap.app': {
      dataSources: {
        v2: { uri: '/sap/opu/odata/sap/ZUI_DEMO_O2/', type: 'OData' },
        v4: { uri: '/sap/opu/odata4/sap/zui_demo_travel_o4/srvd/sap/zui_demo_travel/0001/', type: 'OData', settings: { odataVersion: '4.0' } },
        a2x: { uri: '/sap/opu/odata4/sap/zui_demo_api_o4/srvd_a2x/sap/zui_demo_api/0001/', type: 'OData', settings: { odataVersion: '4.0' } },
        versioned: { uri: '/sap/opu/odata/sap/ZUI_DEMO_O2;v=2/', type: 'OData' },
        nsV2: { uri: '/sap/opu/odata/DMO/UI_DEMO_V2/', type: 'OData' },
        nsV4: { uri: '/sap/opu/odata4/dmo/ui_demo_o4/srvd/dmo/ui_demo/0001/', type: 'OData', settings: { odataVersion: '4.0' } },
        matrix: { uri: '/sap/opu/odata/sap/ZUI_DEMO_O2;o=LOCAL/', type: 'OData' },
        f4: { uri: '/sap/opu/odata4/sap/zui_demo_vh_o4/srvd_f4/sap/zui_demo_vh/0001/', type: 'OData', settings: { odataVersion: '4.0' } },
        annotation: { uri: 'annotations/annotation.xml', type: 'ODataAnnotation' },
      },
    },
  });
  assert.deepEqual(ds.map((d) => [d.name, d.route, d.key]), [
    ['v2', 'odataMetadata', 'ZUI_DEMO_O2'],
    ['v4', 'odataMetadataV4', 'zui_demo_travel_o4/srvd/sap/zui_demo_travel/0001'],
    ['a2x', 'odataMetadataV4', 'zui_demo_api_o4/srvd_a2x/sap/zui_demo_api/0001'],
    ['versioned', 'odataMetadataV2Path', 'sap/ZUI_DEMO_O2;v=2'],
    ['nsV2', 'odataMetadataV2Path', 'DMO/UI_DEMO_V2'],
    ['nsV4', 'odataMetadataV4Path', 'dmo/ui_demo_o4/srvd/dmo/ui_demo/0001'],
    ['matrix', null, null],
    ['f4', null, null],
  ]);
  assert.equal(ds[5].srvd, 'UI_DEMO');
  assert.match(ds[6].unmeasured, /V2.*V4/, 'a system alias (;o=) is not measured: said, not read');
  assert.match(ds[7].unmeasured, /srvd_f4/, 'a service group not measured in a manifest is said, not read');
  assert.equal(ds[1].srvd, 'ZUI_DEMO_TRAVEL');
  assert.deepEqual([...odataModelsOf(MANIFEST)], [['', 'mainService']], 'a JSON model names no service');
});

test('the manifest cites the entity set of its pages once, and never through sap.app', () => {
  assert.deepEqual(manifestCitations('m.json', MANIFEST).map((c) => [c.kind, c.name]), [['entitySet', 'Monitor']]);
});

// --- the live metadata, both dialects ----------------------------------------------------------

test('V2 $metadata: sets, types with properties and navigations, function imports with parameters, the SRVD', () => {
  const md = parseServiceMetadata(V2);
  assert.equal(md.namespace, 'cds_zui_demo_monitor');
  assert.equal(md.srvd, 'ZUI_DEMO_MONITOR', 'the binding is named ZUI_DEMO_MONITOR_O2; the namespace names the definition');
  assert.equal(md.entitySets.get('Monitor'), 'MonitorType');
  assert.deepEqual([...md.entityTypes.get('MonitorType').properties], ['SalesOrder', 'Customer']);
  assert.deepEqual([...md.entityTypes.get('MonitorType').navigations], ['to_Items']);
  assert.deepEqual([...md.operations.get('CheckDemo').params], ['SalesOrder']);
});

test('V4 $metadata: the alias, bound actions without their binding parameter, imports borrow their parameters', () => {
  const md = parseServiceMetadata(V4);
  assert.equal(md.version, '4.0');
  assert.equal(md.alias, 'SAP__self');
  assert.equal(md.srvd, 'ZUI_DEMO_TRAVEL');
  assert.equal(md.entitySets.get('Travel'), 'TravelType');
  assert.deepEqual([...md.operations.get('acceptTravel').params], ['Reason']);
  assert.equal(md.operations.get('acceptTravel').bound, true);
  assert.deepEqual([...md.operations.get('countOpen').params], ['Agency']);
});

// --- what the app addresses ---------------------------------------------------------------------

test('a controller: callFunction and its urlParameters, read with an escaped $filter, past a regex literal', () => {
  const c = citationsOf('ZUI5_DEMO_APP/utils/Handler-dbg.js', HANDLER);
  assert.deepEqual(
    c.map((x) => [x.kind, x.of ?? null, x.name]),
    [
      ['operation', null, 'CheckDemo'],
      ['operationParam', 'CheckDemo', 'SalesOrder'],
      ['operationParam', 'CheckDemo', 'Plant'],
      ['entitySet', null, 'Duration'],
      ['property', 'Duration', 'SalesOrder'],
      ['property', 'Duration', 'Plant'],
      ['entitySet', null, 'DurationOld'],
      ['entitySet', null, 'Duration'],
    ]
  );
  assert.ok(c.every((x) => x.line > 1));
});

test('V4 code: bindList, a bound action on a path, an import and a relative bound action', () => {
  const js =
    'm.bindList("/Travel"); m.bindContext("/Travel(\'1\')/com.sap.gateway.srvd.zui_demo_travel.v0001.acceptTravel(...)");' +
    'm.bindContext("/countOpen(...)"); m.bindContext("com.sap.gateway.srvd.zui_demo_travel.v0001.rejectTravel(...)", oCtx);';
  assert.deepEqual(
    citationsOf('a.js', js).map((x) => [x.kind, x.name]),
    [['entitySet', 'Travel'], ['entitySet', 'Travel'], ['operation', 'acceptTravel'], ['operation', 'countOpen'], ['operation', 'rejectTravel']]
  );
});

test('a view cites only absolute paths of an OData model: JSON models and relative bindings are not citations', () => {
  const xml = '<Table items="{/Monitor}"><Text text="{Customer}"/><Text text="{duration>/Loading}"/><Text text="{i18n>title}"/><List items="{path: \'/Duration\'}"/></Table>';
  assert.deepEqual(citationsOf('v.view.xml', xml, odataModelsOf(MANIFEST)).map((x) => x.name), ['Monitor', 'Duration']);
});

test('a local annotation file: targets through an alias, and the first segment of each path', () => {
  const xml =
    '<edmx:Edmx><edmx:Reference Uri="/sap/opu/odata/sap/ZUI_DEMO_MONITOR_O2/$metadata"><edmx:Include Namespace="cds_zui_demo_monitor" Alias="M"/></edmx:Reference>' +
    '<Annotations Target="M.MonitorType"><Annotation Term="UI.LineItem"><Collection><Record><PropertyValue Property="Value" Path="Customer"/></Record>' +
    '<Record><PropertyValue Property="Value" Path="to_Items/Qty"/></Record><Record><PropertyValue Property="Value" Path="Removed"/></Record></Collection></Annotation></Annotations>' +
    '<Annotations Target="cds_zui_demo_monitor.MonitorType/Vanished"/></edmx:Edmx>';
  const res = checkCitations(citationsOf('annotations/annotation.xml', xml), [{ service: 'ZUI_DEMO_MONITOR_O2', metadata: parseServiceMetadata(V2) }]);
  assert.deepEqual(
    res.map((r) => [r.citation.kind, r.citation.name, r.status]),
    [
      ['annotationTarget', null, 'holds'],
      ['annotationPath', 'Customer', 'holds'],
      ['annotationPath', 'to_Items', 'holds'],
      ['annotationPath', 'Removed', 'broken'],
      ['annotationTarget', 'Vanished', 'broken'],
    ]
  );
});

test('a copy of $metadata in the app is never read as use, whatever its name', () => {
  assert.deepEqual(citationsOf('ZUI5_DEMO_APP/localService/mainService/metadata.xml', V2), []);
  assert.deepEqual(citationsOf('ZUI5_DEMO_APP/model/whatever.xml', V2), []);
});

test('files: the debug source once, never maps, the preload bundle, i18n, localService, images or css', () => {
  const f = (p) => ({ path: `ZUI5_DEMO_APP/${p}`, kind: 'file' });
  const picked = filesWorthReading([
    f('Component.js'), f('Component-dbg.js'), f('Component-preload.js'), f('Component.js.map'),
    f('controller/Main.controller.js'), f('controller/Main-dbg.controller.js'), f('utils/Only.js'),
    f('i18n/i18n.properties'), f('localService/metadata.xml'), f('css/style.css'), f('images/a.png'),
    f('annotations/annotation.xml'), f('view/Main.view.xml'), f('manifest.json'),
  ]);
  assert.deepEqual(picked.map((p) => p.slice('ZUI5_DEMO_APP/'.length)).sort(), [
    'Component-dbg.js', 'annotations/annotation.xml', 'controller/Main-dbg.controller.js', 'utils/Only.js', 'view/Main.view.xml',
  ]);
});

// --- the check -----------------------------------------------------------------------------------

test('a reference holds in ANY service of the app; a missing set, operation, parameter or property is broken', () => {
  const services = [{ service: 'ZUI_DEMO_MONITOR_O2', metadata: parseServiceMetadata(V2) }];
  const res = checkCitations([...manifestCitations('m.json', MANIFEST), ...citationsOf('h.js', HANDLER)], services);
  const broken = res.filter((r) => r.status === 'broken').map((r) => r.reason);
  assert.equal(broken.length, 3);
  assert.match(broken[0], /'CheckDemo' of ZUI_DEMO_MONITOR_O2 has no parameter 'Plant' \(it takes: SalesOrder\)/);
  assert.match(broken[1], /entity set 'Duration' .* no property or navigation 'Plant'/);
  assert.match(broken[2], /no entity set 'DurationOld'/);
  // The same reference against two services: the second one carries it, so nothing breaks.
  const other = { service: 'ZUI_DEMO_OTHER', metadata: parseServiceMetadata(V2.replace('Name="Duration"', 'Name="DurationOld"')) };
  const two = checkCitations(citationsOf('h.js', 'm.read("/DurationOld")'), [...services, other]);
  assert.equal(two[0].status, 'holds');
  assert.equal(two[0].service, 'ZUI_DEMO_OTHER');
});

test('V4: a bound action and its parameters, an annotation on an action, through the schema alias', () => {
  const services = [{ service: 'ZUI_DEMO_TRAVEL_O4', metadata: parseServiceMetadata(V4) }];
  const ann = citationsOf('a.xml', '<x><Annotations Target="SAP__self.acceptTravel(SAP__self.TravelType)"/><Annotations Target="SAP__self.TravelType/Status"/><Annotations Target="SAP__self.Container/Travel"/></x>');
  const js = citationsOf('c.js', 'm.bindContext("/Travel(\'1\')/SAP__self.acceptTravel(...)"); m.bindContext("SAP__self.cancelTravel(...)", c);');
  const res = checkCitations([...ann, ...js], services);
  assert.deepEqual(res.map((r) => r.status), ['holds', 'holds', 'holds', 'holds', 'holds', 'broken']);
  assert.match(res[5].reason, /'cancelTravel'/);
});

test('an annotation on a namespace no service of the app has is unattributed, never broken', () => {
  const res = checkCitations(citationsOf('a.xml', '<Annotations Target="cds_zsap_other.XType/Y"/>'), [{ service: 'S', metadata: parseServiceMetadata(V2) }]);
  assert.equal(res[0].status, 'unattributed');
});

// --- the routes ----------------------------------------------------------------------------------

test('a file of an app is ONE path segment with its slashes encoded -- the measured form', () => {
  assert.equal(
    buildUrl('ui5File', { path: 'ZUI5_DEMO_APP/controller/Main-dbg.controller.js' }),
    '/sap/bc/adt/filestore/ui5-bsp/objects/ZUI5_DEMO_APP%2Fcontroller%2FMain-dbg.controller.js/content'
  );
  assert.equal(buildUrl('ui5Folder', { path: 'ZUI5_DEMO_APP' }), '/sap/bc/adt/filestore/ui5-bsp/objects/ZUI5_DEMO_APP/content');
  assert.equal(TEMPLATES.get('ui5File').accept, 'application/octet-stream');
  assert.equal(TEMPLATES.get('ui5Folder').accept, 'application/atom+xml');
});

test('an app path cannot walk out, name a namespaced app, carry a query or go past eight levels', () => {
  for (const bad of ['zui5_demo_app', 'ZUI5_DEMO_APP/../X', '/NS/APP', 'ZUI5_DEMO_APP/a?b', 'ZUI5_DEMO_APP//x', 'ZUI5_DEMO_APP/a b', `ZUI5_DEMO_APP${'/a'.repeat(9)}`, 'ZUI5_DEMO_APP/%2e%2e']) {
    assert.throws(() => buildUrl('ui5File', { path: bad }), RouteViolation, bad);
  }
  assert.throws(() => buildUrl('ui5File', { path: 'ZUI5_DEMO_APP', sap: 'x' }), RouteViolation);
});

test('$metadata of ONE service and nothing else of it: V2 under /sap/opu/odata/sap, V4 by its parts', () => {
  assert.equal(buildUrl('odataMetadata', { service: 'ZUI_DEMO_MONITOR_O2' }), '/sap/opu/odata/sap/ZUI_DEMO_MONITOR_O2/$metadata');
  assert.equal(
    buildUrl('odataMetadataV4', { service: 'zui_demo_travel_o4/srvd/sap/zui_demo_travel/0001' }),
    '/sap/opu/odata4/sap/zui_demo_travel_o4/srvd/sap/zui_demo_travel/0001/$metadata'
  );
  for (const bad of ['ZUI_DEMO/Monitor', 'ZUI_DEMO;v=2', "ZUI_DEMO/Monitor('1')", 'ZUI_DEMO/$batch', 'zui demo']) {
    assert.throws(() => buildUrl('odataMetadata', { service: bad }), RouteViolation, bad);
  }
  for (const bad of ['zui_x/srvd/sap/zui_x', 'zui_x/srvd/sap/zui_x/0001/Travel', 'zui_x/../sap/zui_x/0001', 'zui_x/srvd/iwbep/zui_x/0001', 'ZUI_X/srvd/sap/zui_x/0001', 'zui_x/srvd_f4/sap/zui_x/0001']) {
    assert.throws(() => buildUrl('odataMetadataV4', { service: bad }), RouteViolation, bad);
  }
  assert.equal(routeAuthority('/sap/opu/odata/sap'), 'metadata');
  assert.equal(routeAuthority('/sap/opu/odata4/sap'), 'metadata');
  assert.equal(routeAuthority('/sap/opu/odata/sap/ZUI_DEMO/Monitor'), null, 'an entity set of a customer service is under no authority');
});

test('a metadata route must name one service and read /$metadata; a multi-part segment is for metadata only', () => {
  const one = (spec) => new Map([['x', { params: [], required: [], ...spec }]]);
  assert.throws(() => assertRouteTable(one({ path: '/sap/opu/odata/sap' })), /names one service/);
  assert.throws(() => assertRouteTable(one({ path: '/sap/opu/odata/sap', segment: { name: 's', pattern: /^x$/ }, suffix: '/Monitor' })), /names one service/);
  assert.throws(
    () => assertRouteTable(one({ path: '/sap/bc/adt/feeds', segment: { name: 's', pattern: /^x$/, style: 'pathParts' } })),
    /multi-part segment belongs to a metadata route/
  );
});

test('the $metadata read is a GET with the one Accept, and both versions are measured', async () => {
  const asked = [];
  await namedGet(async (r) => (asked.push(r), { status: 200, body: V2, headers: {} }), 'odataMetadata', { service: 'ZUI_DEMO_MONITOR_O2' });
  assert.equal(asked[0].method, 'GET');
  assert.deepEqual({ ...asked[0].headers }, { Accept: 'application/xml' });
  assert.equal(TEMPLATES.get('odataMetadata').shapeObserved, true);
  assert.equal(TEMPLATES.get('odataMetadataV4').shapeObserved, true);
});

// --- the tool, end to end ------------------------------------------------------------------------

const SRVD = 'define service ZUI_DEMO_MONITOR {\n  expose ZI_DemoMonitor as Monitor;\n  expose ZI_DemoDuration as Duration;\n  expose ZI_DemoNothing as Nothing;\n}';
const APP_FILES = {
  'ZUI5_DEMO_APP/manifest.json': JSON.stringify(MANIFEST),
  'ZUI5_DEMO_APP/utils/Handler-dbg.js': HANDLER,
  'ZUI5_DEMO_APP/utils/Handler.js': 'minified, never read',
};
const APP_FOLDERS = {
  ZUI5_DEMO_APP: FEED([['ZUI5_DEMO_APP%2fmanifest.json', 'file'], ['ZUI5_DEMO_APP%2futils', 'folder'], ['ZUI5_DEMO_APP%2flocalService', 'folder']]),
  'ZUI5_DEMO_APP/utils': FEED([['ZUI5_DEMO_APP%2futils%2fHandler-dbg.js', 'file'], ['ZUI5_DEMO_APP%2futils%2fHandler.js', 'file']]),
};

function fakeSystem({ metadata = V2 } = {}) {
  const asked = [];
  const transport = async ({ url, method, headers }) => {
    asked.push({ url, method, accept: headers.Accept });
    const m = /^\/sap\/bc\/adt\/filestore\/ui5-bsp\/objects\/([^/]+)\/content$/.exec(url);
    if (m) {
      const p = decodeURIComponent(m[1]);
      const body = headers.Accept === 'application/atom+xml' ? APP_FOLDERS[p] : APP_FILES[p];
      if (body === undefined) throw Object.assign(new Error(`Resource ${p} does not exist`), { err: 404 });
      return { status: 200, body, headers: {} };
    }
    if (url === '/sap/opu/odata/sap/ZUI_DEMO_MONITOR_O2/$metadata') {
      if (metadata === null) throw Object.assign(new Error('Forbidden'), { err: 403 });
      return { status: 200, body: metadata, headers: { 'content-type': 'application/xml' } };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { asked, transport };
}
const api = { getObjectSource: async () => SRVD };
const cfg = (sink = () => {}) => ({ auditSink: () => {}, journalSink: sink, budget: { reads: 1000 }, paths: {} });

test('with apps: the app is read, checked against the live service, and the aliases it cites are named', async () => {
  const { asked, transport } = fakeSystem();
  const lines = [];
  const c = cfg((stream, rec) => lines.push({ stream, ...rec }));
  const out = await runContractCheck(c, api, { service: 'ZUI_DEMO_MONITOR', apps: ['zui5_demo_app'] }, openJournal(c), transport);

  assert.ok(asked.every((a) => a.method === 'GET'));
  assert.ok(!asked.some((a) => /localService|Handler\.js/.test(a.url)), 'neither the scaffold copy nor the minified twin is read');
  assert.match(out.scope.consumers.fiori, /^READ: 1 app/);
  const [app] = out.apps;
  assert.equal(app.read, true);
  assert.deepEqual(app.services[0], {
    dataSource: 'mainService', uri: '/sap/opu/odata/sap/ZUI_DEMO_MONITOR_O2/', version: '2.0',
    service: 'ZUI_DEMO_MONITOR_O2', srvd: 'ZUI_DEMO_MONITOR', odata: '1.0', entitySets: 3, operations: 1,
  });
  assert.equal(app.broken, 3);
  assert.deepEqual(out.findings.map((f) => f.code), ['UI5_REFERENCE_BROKEN', 'UI5_REFERENCE_BROKEN', 'UI5_REFERENCE_BROKEN']);
  assert.deepEqual(out.findings.map((f) => f.subject), ['CheckDemo.Plant', 'Duration.Plant', 'DurationOld']);

  const cited = Object.fromEntries(out.contract.map((r) => [r.entitySet, r.citedBy.map((x) => x.file)]));
  assert.deepEqual(cited.Monitor, ['ZUI5_DEMO_APP/manifest.json']);
  assert.deepEqual(cited.Duration, ['ZUI5_DEMO_APP/utils/Handler-dbg.js']);
  assert.deepEqual(cited.Nothing, [], 'cited by no NAMED app -- the answer does not claim more');

  const findings = lines.filter((l) => l.stream === 'findings');
  assert.equal(findings.length, 3);
  assert.equal(findings[0].severity, 'high');
  // The app path has no localService folder in the feed walk beyond the root listing.
  assert.ok(app.notRead.length === 0, JSON.stringify(app.notRead));
});

test('a service whose $metadata does not read is a gap, and its references are NOT reported as fine', async () => {
  const { transport } = fakeSystem({ metadata: null });
  const lines = [];
  const c = cfg((stream, rec) => lines.push({ stream, ...rec }));
  const out = await runContractCheck(c, api, { service: 'ZUI_DEMO_MONITOR', apps: ['ZUI5_DEMO_APP'] }, openJournal(c), transport);
  assert.equal(out.apps[0].holds, 0);
  assert.equal(out.apps[0].broken, 0);
  assert.match(out.apps[0].services[0].metadata, /^NOT READ/);
  assert.ok(out.apps[0].notRead.some((n) => /were NOT checked/.test(n)));
  assert.equal(lines.find((l) => l.stream === 'gaps')?.code, 'UI5_APP_NOT_READ');
});

test('an app that does not exist is a gap, not an empty app', async () => {
  const { transport } = fakeSystem();
  const lines = [];
  const c = cfg((stream, rec) => lines.push({ stream, ...rec }));
  const out = await runContractCheck(c, api, { service: 'ZUI_DEMO_MONITOR', apps: ['ZUI5_DEMO_GONE'] }, openJournal(c), transport);
  assert.equal(out.apps[0].read, false);
  assert.match(out.apps[0].notRead[0], /manifest\.json.*does not exist/);
  assert.equal(lines.find((l) => l.stream === 'gaps')?.code, 'UI5_APP_NOT_READ');
});

test('a V4 data source is read by its parts, and the app is checked against it', async () => {
  const uri = '/sap/opu/odata4/sap/zui_demo_travel_o4/srvd/sap/zui_demo_travel/0001/';
  const v4manifest = { 'sap.app': { dataSources: { mainService: { uri, type: 'OData', settings: { odataVersion: '4.0' } } } } };
  const asked = [];
  const transport = async ({ url, method, headers }) => {
    asked.push({ url, method, accept: headers.Accept });
    if (url.endsWith('manifest.json/content')) return { status: 200, body: JSON.stringify(v4manifest), headers: {} };
    if (headers.Accept === 'application/atom+xml') return { status: 200, body: FEED([]), headers: {} };
    if (url === `${uri}$metadata`) return { status: 200, body: V4, headers: { 'content-type': 'application/xml' } };
    throw new Error(`unexpected ${url}`);
  };
  const out = await runContractCheck(cfg(), api, { service: 'ZUI_DEMO_MONITOR', apps: ['ZUI5_DEMO_V4'] }, null, transport);
  const md = asked.filter((a) => a.url.includes('/odata4/'));
  assert.deepEqual(md, [{ url: `${uri}$metadata`, method: 'GET', accept: 'application/xml' }]);
  assert.deepEqual(out.apps[0].services[0], {
    dataSource: 'mainService', uri, version: '4.0',
    service: 'ZUI_DEMO_TRAVEL_O4', srvd: 'ZUI_DEMO_TRAVEL', odata: '4.0', entitySets: 2, operations: 2,
  });
  assert.ok(!out.apps[0].notRead.some((n) => /not measured|were NOT checked/.test(n)), JSON.stringify(out.apps[0].notRead));
});

test('apps are names, at most ten, and need a session that can reach the repository', async () => {
  await assert.rejects(() => runContractCheck(cfg(), api, { service: 'ZUI_DEMO_MONITOR', apps: ['../X'] }, null, async () => ({})), /apps must be names/);
  await assert.rejects(() => runContractCheck(cfg(), api, { service: 'ZUI_DEMO_MONITOR', apps: Array.from({ length: 11 }, (_, i) => `ZDEMO${i}`) }, null, async () => ({})), /at most 10/);
  await assert.rejects(() => runContractCheck(cfg(), api, { service: 'ZUI_DEMO_MONITOR', apps: ['ZUI5_DEMO_APP'] }, null, null), /no raw client/);
  const out = await runContractCheck(cfg(), api, { service: 'ZUI_DEMO_MONITOR' }, null, null);
  assert.equal(out.apps, undefined, 'without apps the answer is the provider side only, as before');
  assert.match(out.scope.consumers.fiori, /NOT READ/);
});
