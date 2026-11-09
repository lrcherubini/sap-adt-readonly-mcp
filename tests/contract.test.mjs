// The OData contract: the alias, what it generates, and who addresses it.
//
// The three fixture documents under tests/fixtures/contract/ reproduce the three shapes
// that exist in a measured workspace, each stripped to what decides something:
//
//   v4.edmx    A2X namespace, EntitySet = alias, EntityType = alias + Type
//   v2.edmx    cds_ namespace: a PARAMETERISED entity yields <alias>Set / <alias>Type AND
//              <alias> / <alias>Parameters; a plain one yields only <alias> / <alias>Type;
//              plus the SAP__ print infrastructure and an auto-added value help
//   sap.edmx   API_PRODUCT_SRV -- SAP's own, carrying names OUR services also generate
//
// The last one is the point of the whole attribution mechanism: A_ProductPlantType is a
// real name in two different contracts, and only the bundle that holds the file says
// which one is meant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEdmx, serviceOfNamespace, readConsumerFile, isConsumerFile } from '../lib/edmx.mjs';
import { checkContract, contractOf, namesOfExpose } from '../lib/contract.mjs';

const fixture = (name) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'contract', name), 'utf8');

const svc = (file, source) => ({ file, source });

// --- lib/edmx.mjs ------------------------------------------------------------

test('a V4 document yields its sets, types and the service behind the namespace', () => {
  const doc = parseEdmx(fixture('v4.edmx'), 'v4.edmx');
  assert.equal(doc.version, '4.0');
  assert.equal(doc.service, 'ZAPI_DEMO');
  assert.deepEqual(doc.entityTypes, ['A_ProductPlantType', 'ZA_ProductType']);
  assert.deepEqual(doc.entitySets, [
    { name: 'A_ProductPlant', type: 'A_ProductPlantType' },
    { name: 'ZA_Product', type: 'ZA_ProductType' },
  ]);
});

test('a V2 document is recognised by its schema even without an edmx Version of 4', () => {
  const doc = parseEdmx(fixture('v2.edmx'), 'v2.edmx');
  assert.equal(doc.service, 'ZUI_DEMO');
  assert.ok(doc.entityTypes.includes('ItemRatingParameters'));
  assert.ok(doc.entitySets.some((e) => e.name === 'ItemRatingSet'));
});

test('a SAP namespace is passed through, never mistaken for one of ours', () => {
  assert.equal(parseEdmx(fixture('sap.edmx')).service, 'API_PRODUCT_SRV');
  assert.equal(serviceOfNamespace('com.sap.gateway.srvd_f4.zi_demochannel.v0001'), 'ZI_DEMOCHANNEL');
  assert.equal(serviceOfNamespace('cds_zui_x'), 'ZUI_X');
  assert.equal(serviceOfNamespace('com.sap.gateway.default.iwbep.common.v0001').includes('.'), true);
});

// --- the alias contract ------------------------------------------------------

test('the alias generates the EntitySet verbatim and the EntityType with Type', () => {
  assert.deepEqual(namesOfExpose('ZA_DemoInvMapTP', 'DemoInventoryMapping'), {
    entitySet: 'DemoInventoryMapping',
    entityType: 'DemoInventoryMappingType',
    generated: [
      'DemoInventoryMapping',
      'DemoInventoryMappingType',
      'DemoInventoryMappingSet',
      'DemoInventoryMappingParameters',
    ],
  });
  // No alias: the entity name plays the alias's part.
  assert.equal(namesOfExpose('ZA_Product', null).entityType, 'ZA_ProductType');
});

test('contractOf reads every expose of every service', () => {
  const rows = contractOf([
    svc('a.srvdsrv', 'define service ZAPI_A {\n expose ZA_P;\n expose I_Q as A_Q;\n}'),
  ]);
  assert.deepEqual(
    rows.map((r) => `${r.service}:${r.entity}->${r.entitySet}`),
    ['ZAPI_A:ZA_P->ZA_P', 'ZAPI_A:I_Q->A_Q']
  );
});

test('the same entity under two aliases is reported as drift', () => {
  const out = checkContract({
    services: [
      svc('api.srvdsrv', 'define service ZAPI_M { expose ZI_Loc as AssortStorageLocation; }'),
      svc('ui.srvdsrv', 'define service ZUI_M { expose ZI_Loc as AssortStrLoc; }'),
    ],
  });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].code, 'ALIAS_DRIFT');
  assert.match(out.findings[0].context.aliases, /AssortStorageLocation, AssortStrLoc/);
});

test('cached metadata missing a current expose is stale, in one direction only', () => {
  const services = [
    svc('d.srvdsrv', 'define service ZAPI_DEMO {\n expose ZA_Product;\n expose I_X as A_ProductPlant;\n expose I_Y as I_ProductHierarchyText;\n}'),
  ];
  const metadata = [{ ...parseEdmx(fixture('v4.edmx'), 'v4.edmx'), scope: 's', repo: 'r' }];
  const out = checkContract({ services, metadata });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].code, 'EDMX_STALE');
  assert.match(out.findings[0].context.missingFromCache, /I_PRODUCTHIERARCHYTEXTTYPE/);
});

test('the V2 generated siblings are not reported as unaccounted', () => {
  // ItemRatingSet, ItemRatingParameters, SAP__CoverPage and the auto-added I_PlantType are
  // all produced by the gateway, not by an expose. A first pass reported them and turned
  // a healthy V2 service into four findings.
  const services = [
    svc('d.srvdsrv', 'define service ZUI_DEMO {\n expose ZC_A as ItemRating;\n expose ZC_B as PackSpec;\n}'),
  ];
  const metadata = [{ ...parseEdmx(fixture('v2.edmx'), 'v2.edmx'), scope: 's', repo: 'r' }];
  const out = checkContract({ services, metadata });
  assert.deepEqual(out.findings, [], 'nothing is missing from the cache');
});

// --- attribution -------------------------------------------------------------

const cited = (file, scope, tokens) => ({
  file,
  scope,
  repo: 'r',
  basename: path.basename(file),
  tokens: new Set(tokens),
});

test('a name is attributed by the metadata the SCOPE caches, not by how it looks', () => {
  // The measured case: our ZAPI_DEMO_ERP exposes I_ProductPlantBasic as A_ProductPlant, so
  // A_ProductPlantType is OUR name in the bundle that caches our metadata -- and SAP's in
  // the bundle next door that caches API_PRODUCT_SRV.
  const services = [
    svc('c.srvdsrv', 'define service ZAPI_DEMO { expose I_ProductPlantBasic as A_ProductPlant; }'),
  ];
  const metadata = [
    { ...parseEdmx(fixture('v4.edmx'), 'ours.edmx'), scope: 'live', repo: 'r' },
    { ...parseEdmx(fixture('sap.edmx'), 'sap.edmx'), scope: 'legacy', repo: 'r' },
  ];
  const consumers = [
    cited('live/mapping.mmap', 'live', ['A_ProductPlantType', 'Plant']),
    cited('legacy/mapping.mmap', 'legacy', ['A_ProductPlantType', 'A_ProductType']),
  ];
  const out = checkContract({ services, metadata, consumers });
  assert.equal(out.loadBearing.length, 1);
  assert.equal(out.loadBearing[0].entitySet, 'A_ProductPlant');
  assert.deepEqual(
    out.loadBearing[0].citedBy.map((c) => c.file),
    ['live/mapping.mmap'],
    'the legacy bundle cites SAP contract, not ours'
  );
  assert.equal(out.findings.filter((f) => f.code === 'CONSUMER_ORPHAN_TYPE').length, 0);
});

test('a name the cache has and no expose generates, cited by hand, is an orphan', () => {
  const services = [svc('c.srvdsrv', 'define service ZAPI_DEMO { expose ZA_Product; }')];
  const metadata = [{ ...parseEdmx(fixture('v4.edmx'), 'ours.edmx'), scope: 's', repo: 'r' }];
  const out = checkContract({
    services,
    metadata,
    consumers: [cited('s/src/mapping.mmap', 's', ['A_ProductPlantType'])],
  });
  const orphans = out.findings.filter((f) => f.code === 'CONSUMER_ORPHAN_TYPE');
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].subject, 'A_ProductPlantType');
  assert.match(orphans[0].effect, /arrives empty/);
});

test('a scaffold echo is not an orphan, and not a hand-written citation', () => {
  const services = [svc('c.srvdsrv', 'define service ZAPI_DEMO { expose ZA_Product; }')];
  const metadata = [{ ...parseEdmx(fixture('v4.edmx'), 'ours.edmx'), scope: 's', repo: 'r' }];
  const out = checkContract({
    services,
    metadata,
    consumers: [
      cited('s/webapp/manifest.json', 's', ['A_ProductPlantType', 'ZA_Product']),
      cited('s/webapp/localService/mock.json', 's', ['A_ProductPlantType']),
    ],
  });
  assert.equal(out.findings.filter((f) => f.code === 'CONSUMER_ORPHAN_TYPE').length, 0);
  assert.equal(out.loadBearing[0].handwrittenCitations, 0);
});

test('a scope that caches no metadata is inconclusive, never a defect', () => {
  const out = checkContract({
    services: [svc('c.srvdsrv', 'define service ZAPI_DEMO { expose ZA_Product; }')],
    metadata: [],
    consumers: [cited('unknown/x.mmap', 'unknown', ['ZA_ProductType'])],
  });
  assert.deepEqual(out.findings, []);
  assert.equal(out.gaps.length, 1);
  assert.equal(out.gaps[0].code, 'EXPOSURE_INCONCLUSIVE');
});

// --- one consumer file, as the system will serve it -------------------------------

test('a consumer file is metadata or use, and a payload sample is never opened', () => {
  const meta = readConsumerFile('webapp/localService/metadata.xml', fixture('v4.edmx'), 'app');
  assert.equal(meta.metadata.service, 'ZAPI_DEMO');
  const use = readConsumerFile('webapp/annotations/annotation.xml', '<Annotations Target="cds_zapi_demo.ZA_ProductType/Name"/>', 'app');
  assert.ok(use.consumer.tokens.has('ZA_ProductType'));
  // Personal data can live in integration samples. Reading one is the failure this
  // exclusion exists to make impossible -- by extension, before any content rule.
  assert.equal(readConsumerFile('x/payload.sample', '<Cpf>12345678901</Cpf>', 'app'), null);
  assert.equal(isConsumerFile('package-lock.json'), false);
  assert.equal(isConsumerFile('webapp/manifest.json'), true);
});

test('a metadata document under a non-metadata filename is still metadata', () => {
  const r = readConsumerFile('webapp/localService/mainService/ZUI_DEMO_VAN.xml', fixture('v2.edmx'), 'app');
  assert.ok(r.metadata, 'read as evidence, not as an independent citation');
  assert.equal(r.consumer, undefined);
});

// --- the check, end to end: the SRVD read from the system ----------------------------

import { runContractCheck, contractCheckTool } from '../tools/contract-check.mjs';
import { openJournal } from '../lib/journal.mjs';

const SRVD = 'define service ZAPI_DEMO {\n  expose ZA_Product;\n  expose I_X as A_ProductPlant;\n  expose I_Y as I_ProductHierarchyText;\n  expose I_X as A_ProductPlantAgain;\n}';
const apiWith = (source, asked = []) => ({
  getObjectSource: async (uri) => {
    asked.push(uri);
    if (source === null) throw new Error('404 not found');
    return source;
  },
});
const cfg = (sink) => ({ auditSink: () => {}, journalSink: sink, budget: { reads: 100 }, paths: {} });

test('the contract of one service is read from the system and lists every alias with its generated names', async () => {
  const asked = [];
  const out = await runContractCheck(cfg(), apiWith(SRVD, asked), { service: 'zapi_demo' });
  assert.deepEqual(asked, ['/sap/bc/adt/ddic/srvd/sources/zapi_demo/source/main']);
  assert.equal(out.service, 'ZAPI_DEMO');
  assert.equal(out.scope.exposes, 4);
  const product = out.contract.find((c) => c.entitySet === 'ZA_Product');
  assert.equal(product.entityType, 'ZA_ProductType');
  assert.deepEqual(product.alsoGenerated, ['ZA_ProductSet', 'ZA_ProductParameters']);
  assert.match(out.scope.consumers.fiori, /NOT READ/, 'no alias is claimed unused');
  assert.match(out.scope.consumers.cpi, /out of scope/);
  assert.deepEqual(out.findings.map((f) => f.code), ['ALIAS_DRIFT'], 'I_X under two aliases');
});

test('a service definition that does not read is refused with a gap, never "it exposes nothing"', async () => {
  const lines = [];
  const c = cfg((stream, record) => lines.push({ stream, ...record }));
  await assert.rejects(() => runContractCheck(c, apiWith(null), { service: 'ZAPI_GONE' }, openJournal(c)), /was not read/);
  assert.equal(lines.find((l) => l.stream === 'gaps')?.code, 'SOURCE_NOT_READ');
  await assert.rejects(() => contractCheckTool(cfg(), apiWith(SRVD), null).handler({ service: 'not a name!' }), /service definition name/);
});

test('findings reach the journal under registered codes', async () => {
  const lines = [];
  const c = cfg((stream, record) => lines.push({ stream, ...record }));
  await runContractCheck(c, apiWith(SRVD), { service: 'ZAPI_DEMO' }, openJournal(c));
  const findings = lines.filter((l) => l.stream === 'findings');
  assert.deepEqual(findings.map((l) => l.code), ['ALIAS_DRIFT']);
  assert.equal(findings[0].severity, 'medium');
});
