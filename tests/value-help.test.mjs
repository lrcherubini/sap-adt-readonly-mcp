// adt_value_help end to end, with a doubled ADT client.
//
// Every scenario asserts BOTH the answer and the calls that produced it, because half
// the design is about NOT calling the system: a candidate the catalogue already rejects
// must cost zero round trips, and `precedent` must be opt-in.
//
// The doubles reply with the shapes measured on the system (docs/adt-api-reference.md):
// ddicElement children carrying elementProps with a lower-case ddicDataElement,
// getDataElementProperties returning {metaData, properties} with typeName and
// defaultComponentName, getDomainProperties returning valueInformation.valueTableRef.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyseValueHelp,
  loadSources,
  rankCandidates,
} from '../tools/value-help.mjs';
import { loadCatalog } from '../lib/catalog.mjs';
import { resolveDataElement } from '../lib/ddic.mjs';
import { noDefs } from '../lib/annotation-defs.mjs';
import { contractErrors } from '../lib/completeness.mjs';
import { checkExposure } from '../lib/srvd-check.mjs';
import { candidateNames, conceptsFor, semanticsFromAnnotations } from '../lib/vh-candidates.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures');
const read = (...p) => fs.readFileSync(path.join(FIX, ...p), 'utf8');

const catalog = loadCatalog(path.join(FIX, 'catalog-mini.json'));
// The annotation definitions the doubled system serves (its DDLA, as annotationDefinitions() returns it).
const DDLA = read('annotation-defs.ddla.txt');
const sources = { catalog };

// --- the doubled system ------------------------------------------------------------

const FIELD = (name, de, extra = {}) => ({
  name,
  type: 'STOB/DOF',
  properties: { elementProps: { ddicDataElement: de, ddicDataType: 'char', ddicLength: 4, ...extra } },
});

const DTEL = {
  werks_d: { typeName: 'WERKS', defaultComponentName: 'PLANT', searchHelp: 'H_T001W_C' },
  lgort_d: { typeName: 'LGORT_D', defaultComponentName: 'STORAGE_LOCATION' },
  zdemo_de_mvgr1: { typeName: 'MVGR1', defaultComponentName: 'PRC_GROUP1' },
  bukrs: { typeName: 'BUKRS', defaultComponentName: 'COMPANY_CODE' },
  // ⚠️ Measured on the system, and NOT what it looks like: MEINS states BASEUOM, not
  // UNIT_OF_MEASURE. The double used to say UNIT_OF_MEASURE -- an invented value that
  // also happened to hide the gap this fixture now reproduces, because UNITOFMEASURE
  // reaches I_UnitOfMeasureStdVH by name and BASEUOM reaches nothing.
  meins: { typeName: 'MEINS', defaultComponentName: 'BASEUOM' },
  xfeld: { typeName: 'XFELD', defaultComponentName: 'FLAG' },
  kalsm_d: { typeName: 'KALSM', defaultComponentName: 'FUNCNL_LOC_CAT' },
  // Measured live on the system (ZC_DemoItemRating/ProductType).
  producttype: { typeName: 'MTART', defaultComponentName: 'MATLTYPE' },
};
// `datatype` is the domain's DDIC built-in type, read back as
// properties.typeInformation.datatype.
//
// ⚠️ The SHAPE is from the client's typings (api/objectcontents.d.ts:21-25); it has NOT
// been observed on the system yet. The VALUES here are the
// DDIC definitions of these domains, not measurements. Keeping them apart matters --
// the last invented value in this file (defaultComponentName UNIT_OF_MEASURE for MEINS)
// both was wrong and hid the gap the tool exists to close.
const DOMAIN = {
  WERKS: { valueTableRef: 'T001W', datatype: 'CHAR' },
  LGORT_D: { valueTableRef: 'T001L', datatype: 'CHAR' },
  MVGR1: { valueTableRef: 'TVM1', datatype: 'CHAR' },
  BUKRS: { valueTableRef: 'T001', datatype: 'CHAR' },
  MEINS: { valueTableRef: 'T006', datatype: 'UNIT' },
  XFELD: { fixValues: [{ low: 'X' }, { low: '' }], datatype: 'CHAR' },
  KALSM: { valueTableRef: 'T685', datatype: 'CHAR' },
  MTART: { valueTableRef: 'T134', datatype: 'CHAR' },
};

const SOURCES = {
  I_PLANTSTDVH: read('i_plantstdvh.asddls'),
  I_PLANT: "@ObjectModel.usageType.serviceQuality: #A\ndefine view entity I_Plant as select from t001w {}",
  I_STORAGELOCATION:
    '@ObjectModel.representativeKey: \'StorageLocation\'\n' +
    '@ObjectModel.dataCategory: #VALUE_HELP\n@Search.searchable: true\n' +
    'define view I_StorageLocation as select from t001l {}',
  I_COMPANYCODEVH: `
    @ObjectModel: {
      dataCategory: #VALUE_HELP,
      representativeKey: 'CompanyCode',
      modelingPattern: #VALUE_HELP_PROVIDER,
      supportedCapabilities: [#VALUE_HELP_PROVIDER, #SEARCHABLE_ENTITY]
    }
    @Search.searchable: true
    define view entity I_CompanyCodeVH as select from I_CompanyCode {}`,
  I_UNITOFMEASURESTDVH:
    "@ObjectModel.dataCategory: #VALUE_HELP\n@ObjectModel.representativeKey: 'UnitOfMeasure'\n" +
    '@Search.searchable: true\ndefine view I_UnitOfMeasureStdVH as select from t006 {}',
  // The concept view the active search reaches through T006. It is NOT a value help --
  // no dataCategory, no representativeKey -- which is the point: it is a name, and the
  // pipeline still has to tier it (C) and prefer the StdVH.
  I_UNITOFMEASURE:
    '@ObjectModel.usageType: { serviceQuality: #A, sizeCategory: #S, dataClass: #MASTER }\n' +
    'define view entity I_UnitOfMeasure as select from t006 {}',
  I_CUSTOMER_VH:
    "@ObjectModel.dataCategory: #VALUE_HELP\n@ObjectModel.representativeKey: 'Customer'\n" +
    '@ObjectModel.supportedCapabilities: [#VALUE_HELP_PROVIDER]\n' +
    'define view entity I_Customer_VH as select from kna1 {}',
  // Both tier A, both released: the exact concept and the broader one. This pair is
  // what the live run got wrong.
  I_PRODUCTTYPE:
    "@ObjectModel.dataCategory: #VALUE_HELP\n@ObjectModel.representativeKey: 'ProductType'\n" +
    '@ObjectModel.supportedCapabilities: [#VALUE_HELP_PROVIDER]\n@Search.searchable: true\n' +
    'define view entity I_ProductType as select from t134 {}',
  I_PRODUCTSTDVH:
    "@ObjectModel.dataCategory: #VALUE_HELP\n@ObjectModel.representativeKey: 'Product'\n" +
    '@ObjectModel.supportedCapabilities: [#VALUE_HELP_PROVIDER]\n@Search.searchable: true\n' +
    'define view entity I_ProductStdVH as select from I_Product {}',
  I_FACTORYCALENDARVALUEHELP:
    "@ObjectModel.dataCategory: #VALUE_HELP\n@ObjectModel.representativeKey: 'FactoryCalendar'\n" +
    '@Search.searchable: true\ndefine view entity I_FactoryCalendarValueHelp as select from tfacd {}',
};

/** A double that counts every call and can be told to fail. */
function fakeApi(over = {}) {
  const calls = [];
  const api = {
    calls,
    async ddicElement(entity) {
      calls.push(['ddicElement', entity]);
      const tree = over.tree?.[entity.toUpperCase()];
      if (!tree) throw new Error(`no double for ${entity}`);
      return { name: entity, children: tree };
    },
    async getDataElementProperties(url) {
      const name = url.split('/').pop();
      calls.push(['getDataElementProperties', name]);
      if (!DTEL[name]) throw new Error(`data element ${name} not found`);
      return { metaData: { name }, properties: DTEL[name] };
    },
    async getDomainProperties(url) {
      const name = url.split('/').pop().toUpperCase();
      calls.push(['getDomainProperties', name]);
      const row = over.domains?.[name] ?? DOMAIN[name];
      if (!row) throw new Error(`domain ${name} not found`);
      const { datatype, ...valueInformation } = row;
      return {
        metaData: { name },
        properties: {
          valueInformation,
          ...(datatype ? { typeInformation: { datatype, length: 3, decimals: 0 } } : {}),
        },
      };
    },
    // The objectType is recorded because the active search's whole cost argument rests
    // on it: measured on the system, `I_UNITOFMEASURE*` filtered to DDLS/DF is 13 rows and
    // 3.2 KB, against 15,963 rows and 3.4 MB for the where-used it replaces.
    async searchObject(name, objectType) {
      calls.push(['searchObject', name, objectType]);
      const known = { ...SOURCES, ...(over.extraObjects ?? {}) };
      const hit = (n) => ({
        'adtcore:name': n,
        'adtcore:type': 'DDLS/DF',
        'adtcore:packageName': 'TEST',
        'adtcore:uri': `/sap/bc/adt/ddic/ddl/sources/${n.toLowerCase()}`,
      });
      const key = name.toUpperCase();
      if (over.tables?.[key]) {
        return [
          {
            'adtcore:name': key,
            'adtcore:type': 'TABL/DT',
            'adtcore:packageName': 'SAP',
            'adtcore:uri': `/sap/bc/adt/ddic/tables/${key.toLowerCase()}`,
          },
        ];
      }
      if (key.endsWith('*')) {
        const prefix = key.slice(0, -1);
        return Object.keys(known)
          .filter((k) => k.startsWith(prefix))
          .sort()
          .map(hit);
      }
      return key in known ? [hit(name)] : [];
    },
    async objectStructure(uri) {
      calls.push(['objectStructure', uri]);
      return { objectUrl: uri };
    },
    async getObjectSource(url) {
      calls.push(['getObjectSource', url]);
      const name = url.split('/').filter(Boolean).slice(-3)[0].toUpperCase();
      const src = SOURCES[name] ?? over.extraObjects?.[name];
      if (!src) throw new Error(`no source for ${name}`);
      return src;
    },
    async annotationDefinitions() {
      calls.push(['annotationDefinitions']);
      if (over.ddlaFails) throw new Error('not available');
      return over.ddla ?? DDLA;
    },
    async usageReferences(uri) {
      calls.push(['usageReferences', uri]);
      return over.usage ?? [];
    },
    ...over.methods,
  };
  return api;
}

const countOf = (api, method) => api.calls.filter((c) => c[0] === method).length;
/** Calls of `method` about anything but the analysed entity itself (its own source is always read). */
const countOther = (api, method, self) =>
  api.calls.filter((c) => c[0] === method && !String(c[1] ?? '').toLowerCase().includes(self.toLowerCase())).length;
const fieldOf = (result, name) => result.fields.find((f) => f.field === name);

const PLANT_TREE = { ZC_TEST: [FIELD('Plant', 'werks_d')] };

// --- scenarios ---------------------------------------------------------------------

test('1: a Plant field is answered with I_PlantStdVH and the element it states', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'Plant');
  assert.equal(f.status, 'recommended');
  assert.equal(f.recommended, 'I_PLANTSTDVH');
  assert.equal(f.tier, 'A');
  assert.match(f.annotation, /entity: \{ name: 'I_PLANTSTDVH', element: 'Plant' \}/);
  assert.match(f.elementSource, /representativeKey/);
  assert.equal(f.domain, 'WERKS');
  assert.equal(f.valueTable, 'T001W');
});

test('2 and 3: a non-released candidate is eliminated offline, costing no ADT call', async () => {
  // I_PlantVH is ABSENT from the PCE 2023 catalogue and I_FUNCNLLOCCATSTDVH is in it as
  // notToBeReleasedStable. Neither may be read, let alone recommended.
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('FuncnlLocCat', 'kalsm_d')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'FuncnlLocCat');
  assert.equal(f.status, 'no recommendation');
  const rejected = f.candidates.find((c) => c.name === 'I_FUNCNLLOCCATSTDVH');
  assert.equal(rejected.tier, 'C');
  assert.match(rejected.reasons[0], /notToBeReleasedStable/);
  assert.equal(countOther(api, 'getObjectSource', 'zc_test'), 0, 'never read: rejected before the call');
  assert.ok(!f.candidates.some((c) => c.name === 'I_PLANTVH'));
});

test('4 and 5: the underscore variant and the ValueHelp name are recognised', async () => {
  const api = fakeApi({
    tree: {
      ZC_TEST: [
        { name: 'Customer', type: 'STOB/DOF', properties: { elementProps: { ddicDataElement: null } } },
      ],
    },
  });
  const customer = await analyseValueHelp(api, sources, {
    entity: 'ZC_Test',
    field: 'Customer',
    validate: false,
  });
  assert.equal(fieldOf(customer, 'Customer').recommended, 'I_CUSTOMER_VH');

  const api2 = fakeApi({ tree: { ZC_TEST: [{ name: 'FactoryCalendar', type: 'STOB/DOF', properties: { elementProps: {} } }] } });
  const cal = await analyseValueHelp(api2, sources, { entity: 'ZC_Test', validate: false });
  assert.equal(fieldOf(cal, 'FactoryCalendar').recommended, 'I_FACTORYCALENDARVALUEHELP');
});

test('6: a released value help with no #VALUE_HELP_PROVIDER is offered as tier B', async () => {
  // The field is named UnitOfMeasure, not BaseUnit, so the element name alone reaches
  // the entity offline: this scenario is about the TIER, and must not depend on the
  // active search. BaseUnit is the same value help reached the hard way -- test 35.
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('UnitOfMeasure', 'meins')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'UnitOfMeasure');
  assert.equal(f.recommended, 'I_UNITOFMEASURESTDVH');
  assert.equal(f.tier, 'B', 'offered with its reason, not hidden');
  assert.equal(f.status, 'recommended');
  assert.equal(countOf(api, 'usageReferences'), 0, 'name matching sufficed: no active search');
});

test('7: a field that already has a binding is reported covered, not duplicated', async () => {
  // The entity's own source, as the system returns it, already binds P_Plant.
  const api = fakeApi({
    tree: { ZC_DEMOITEMRATING: [FIELD('P_Plant', 'werks_d')] },
    extraObjects: { ZC_DEMOITEMRATING: read('precedent', 'zdemo_item_rating', 'zc_demoitemrating.ddls.asddls') },
  });
  const r = await analyseValueHelp(api, sources, {
    entity: 'ZC_DemoItemRating',
    validate: false,
  });
  const f = fieldOf(r, 'P_Plant');
  assert.equal(f.status, 'already covered');
  assert.equal(f.boundTo, 'I_Plant');
  assert.match(f.at, /ZC_DemoItemRating:\d+/);
  assert.equal(countOther(api, 'getObjectSource', 'zc_demoitemrating'), 0, 'no candidate is verified for a bound field');
});

test('8: no candidate at all proposes a named own view, and invents nothing', async () => {
  const api = fakeApi({
    tree: { ZC_TEST: [FIELD('MaterialGroup1', 'zdemo_de_mvgr1')] },
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'MaterialGroup1');
  assert.equal(f.status, 'no candidate');
  assert.equal(f.domain, 'MVGR1', 'the Z data element matched nothing; the domain is the signal');
  // Name matching failed AND the system was asked. Both are reported, with the value
  // table named -- the reader has to be able to see that the dead end is a real dead
  // end and not a step that was skipped.
  assert.match(f.reason, /asking the system directly found none either/);
  assert.match(f.reason, /TVM1/);
  assert.ok(f.activeSearch.some((s) => s.route === 'repository search'));
  assert.ok(f.activeSearch.some((s) => s.route === 'value table where-used'));
  assert.equal(f.proposal.name, 'ZI_MaterialGroup1VH');
  assert.match(f.proposal.text, /@Metadata\.ignorePropagatedAnnotations: true/);
  // ⚠️ The regression this pins: the proposal used to write `I_MaterialGroup1` as the
  // source -- an entity that exists nowhere -- inside a block shaped to be pasted.
  assert.match(f.proposal.text, /from <released source entity>/);
  assert.ok(!/from I_MaterialGroup1/.test(f.proposal.text), 'never names an unverified source');
  assert.match(f.proposal.notes[0], /placeholder ON PURPOSE/);
  assert.ok(!f.recommended);
});

test('8b: deepSearch: false keeps the run offline and says so', async () => {
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('MaterialGroup1', 'zdemo_de_mvgr1')] } });
  const r = await analyseValueHelp(api, sources, {
    entity: 'ZC_Test',
    validate: false,
    deepSearch: false,
  });
  const f = fieldOf(r, 'MaterialGroup1');
  assert.equal(f.status, 'no candidate');
  assert.equal(f.activeSearch, undefined);
  assert.match(f.reason, /active search was switched off/);
  assert.equal(countOther(api, 'searchObject', 'zc_test'), 0, 'no repository search');
  assert.equal(countOf(api, 'usageReferences'), 0, 'no where-used');
});

// --- the active search: when the VDM calls the concept something else ---------------

const T006_USAGE = [
  // The shape of a real where-used reply, in the proportion measured on T006: mostly
  // things that are not CDS at all, then CDS that is not released, then one released
  // VDM view. 15,963 rows came back live; 57 were DDLS/DF; exactly one was released.
  { 'adtcore:name': 'CL_UOM_SOMETHING', 'adtcore:type': 'CLAS/OC', usageInformation: 'gradeDirect' },
  { 'adtcore:name': 'T006_MAINTAIN', 'adtcore:type': 'PROG/P', usageInformation: 'gradeDirect' },
  { 'adtcore:name': '/DMBE/I_UNITOFMEASURE', 'adtcore:type': 'DDLS/DF', usageInformation: 'gradeDirect' },
  { 'adtcore:name': 'SEPMRA_I_QUANTITYUNIT', 'adtcore:type': 'DDLS/DF', usageInformation: 'gradeDirect' },
  { 'adtcore:name': 'I_UNITOFMEASURE', 'adtcore:type': 'DDLS/DF', usageInformation: 'gradeDirect' },
];

test('35: a concept the VDM renames is reached through its value table, not by guessing', async () => {
  // The question that opened the cycle, in its hardest form. BaseUnit / MEINS yields
  // BASEUOM (measured: that IS what the data element states), MEINS and BASEUNIT, and
  // NONE of them names anything in the catalogue -- the VDM calls it UnitOfMeasure. The
  // answer, I_UnitOfMeasureStdVH, is unreachable by any amount of string work.
  //
  // The semantic type now answers this exact field first and for free (test 34), so the
  // domain here is given WITHOUT its datatype on purpose. That is not an artificial
  // case: it is every field whose domain type is plain CHAR, and it is also the state
  // this code is in if the release words `typeInformation.datatype` differently from
  // the client's typings -- which has not been observed yet. This test is what keeps
  // the fallback honest.
  const api = fakeApi({
    tree: { ZC_TEST: [FIELD('BaseUnit', 'meins')] },
    domains: { MEINS: { valueTableRef: 'T006' } },
    tables: { T006: true },
    usage: T006_USAGE,
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'BaseUnit');

  assert.equal(f.status, 'recommended');
  assert.equal(f.recommended, 'I_UNITOFMEASURESTDVH');
  assert.equal(f.tier, 'B');
  assert.equal(f.matchedConcept.concept, 'UNITOFMEASURE');
  assert.match(f.matchedConcept.from, /value table T006/);

  // The route is on the record, both hops, in order and with what each one cost.
  const routes = f.activeSearch.map((s) => s.route);
  assert.deepEqual(routes, [
    'repository search', // BASEUOM  -- nothing
    'repository search', // MEINS    -- nothing
    'value table where-used', // T006 -> I_UnitOfMeasure
    'repository search', // I_UNITOFMEASURE* -> the StdVH
  ]);
  const hop = f.activeSearch.find((s) => s.route === 'value table where-used');
  assert.equal(hop.concept, 'I_UNITOFMEASURE');
  assert.match(hop.cite, /where-used on T006/);
  // Other applications' models read the same table and must never outrank the VDM view.
  assert.equal(hop.views[0].name, 'I_UNITOFMEASURE');

  // The expensive hop runs only after the cheap one came back empty.
  const searches = api.calls.filter((c) => c[0] === 'searchObject' && c[1].endsWith('*'));
  assert.ok(searches.every((c) => c[2] === 'DDLS/DF'), 'the search is type-filtered, as in ADT');
  assert.deepEqual(
    searches.map((c) => c[1]),
    ['I_BASEUOM*', 'C_BASEUOM*', 'I_MEINS*', 'C_MEINS*', 'I_UNITOFMEASURE*', 'C_UNITOFMEASURE*']
  );
  assert.equal(countOf(api, 'usageReferences'), 1, 'the value table is asked once, and last');
});

test('35b: what the active search finds still has to pass the release gate', async () => {
  // The system returns names; the catalogue decides. I_UnitOfMeasure comes back from the
  // where-used and is released, so it becomes a candidate -- and is tiered C, because it
  // is a business view, not a value help. Being expensively found buys no privilege.
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('BaseUnit', 'meins')] }, tables: { T006: true }, usage: T006_USAGE });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const c = fieldOf(r, 'BaseUnit').candidates.find((x) => x.name === 'I_UNITOFMEASURE');
  assert.ok(c, 'the concept view is shown, not hidden behind the winner');
  assert.equal(c.tier, 'C');
  // Nothing from another namespace or from demo content ever became a candidate.
  const names = fieldOf(r, 'BaseUnit').candidates.map((x) => x.name);
  assert.ok(!names.some((n) => n.startsWith('/') || n.startsWith('SEPMRA')));
});

test('35c: the where-used hop degrades honestly when nothing released reads the table', async () => {
  // Domain without its datatype, for the reason spelled out in test 35.
  const api = fakeApi({
    tree: { ZC_TEST: [FIELD('BaseUnit', 'meins')] },
    domains: { MEINS: { valueTableRef: 'T006' } },
    tables: { T006: true },
    usage: [{ 'adtcore:name': '/DMBE/I_UNITOFMEASURE', 'adtcore:type': 'DDLS/DF', usageInformation: 'gradeDirect' }],
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'BaseUnit');
  assert.equal(f.status, 'no candidate');
  const hop = f.activeSearch.find((s) => s.route === 'value table where-used');
  assert.equal(hop.ok, false);
  assert.match(hop.reason, /none\s+of those is released/);
  assert.match(f.proposal.text, /from <released source entity>/);
  assert.match(f.proposal.notes[0], /placeholder ON PURPOSE/);
});

test('9: every candidate is revealed, not just the winner', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const names = fieldOf(r, 'Plant').candidates.map((c) => c.name);
  assert.deepEqual(names, ['I_PLANTSTDVH', 'I_PLANT']);
  assert.ok(fieldOf(r, 'Plant').candidates.every((c) => c.tier));
});

test('14: precedent is opt-in -- no usageReferences unless asked', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  assert.equal(countOf(api, 'usageReferences'), 0);
});

test('15: with precedent on, a 1,531-row where-used never reaches the output', async () => {
  const usage = Array.from({ length: 1531 }, (_, i) => ({
    'adtcore:name': i === 0 ? 'C_Consumer' : `PKG${i}`,
    'adtcore:type': i === 0 ? 'DDLS/DF' : 'DEVC/K',
    usageInformation: 'gradeDirect,includeProductive',
  }));
  const api = fakeApi({
    tree: { ZC_TEST: [FIELD('Plant', 'werks_d')] },
    usage,
    extraObjects: {
      C_CONSUMER:
        "define view entity C_Consumer as select from x {\n" +
        "  @Consumption.valueHelpDefinition: [{ entity: { name: 'I_PLANTSTDVH', element: 'Plant' }," +
        " additionalBinding: [{ localElement: 'CompanyCode', element: 'CompanyCode', usage: #FILTER }] }]\n" +
        '  key Plant\n}',
    },
  });
  const r = await analyseValueHelp(api, sources, {
    entity: 'ZC_Test',
    precedent: true,
    validate: false,
  });
  const f = fieldOf(r, 'Plant');
  assert.equal(countOf(api, 'usageReferences'), 1);
  assert.match(f.annotation, /additionalBinding/, 'the binding came from a real consumer');
  assert.match(f.emissionNotes.join(' '), /C_Consumer/);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('PKG500'), 'the raw where-used list is never returned');
  assert.ok(text.length < 20000, text.length);
});

test('13: with no precedent anywhere, no binding is written and the reason is given', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'Plant');
  assert.ok(!/additionalBinding/.test(f.annotation));
  assert.match(f.emissionNotes.join(' '), /depends on the fields of the consuming view/);
});

test('19: with no annotation definitions the block is emitted, marked NOT VALIDATED', async () => {
  const api = fakeApi({ tree: PLANT_TREE, ddlaFails: true });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test' });
  const f = fieldOf(r, 'Plant');
  assert.ok(f.annotation, 'the answer is still given');
  assert.match(f.warnings.join(' '), /NOT VALIDATED/);
  assert.match(r.sources.annotationDefinitions, /unavailable.*NOT validated/);
  assert.ok(noDefs('x').available === false);
});

test('the definitions are read from the system when they are available', async () => {
  const api = fakeApi({
    tree: PLANT_TREE,
    ddla: `@Scope:[#ELEMENT]
      annotation Consumption {
        @API.state: [#RELEASED_FOR_KEY_USER_APPS, #RELEASED_FOR_SAP_CLOUD_PLATFORM]
        valueHelpDefinition : array of { entity : { name : EntityRef; element : String(40); }; };
      }`,
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test' });
  assert.equal(countOf(api, 'annotationDefinitions'), 1);
  assert.equal(r.sources.annotationDefinitions, 'system DDLA', 'one source: the system');
  assert.deepEqual(fieldOf(r, 'Plant').warnings, []);
});

test('20: the field cap and the call ceiling are both respected', async () => {
  const many = Array.from({ length: 40 }, (_, i) => FIELD(`Plant${i}`, 'werks_d'));
  const api = fakeApi({ tree: { ZC_TEST: many } });
  const r = await analyseValueHelp(api, sources, {
    entity: 'ZC_Test',
    maxFields: 3,
    validate: false,
  });
  assert.equal(r.fields.length, 3);
  assert.match(r.notes.join(' '), /40 fields matched, 3 resolved/);
  // The data element is resolved once, not once per field.
  assert.equal(countOf(api, 'getDataElementProperties'), 1);
  assert.equal(countOf(api, 'getDomainProperties'), 1);

  const capped = fakeApi({ tree: { ZC_TEST: many } });
  const r2 = await analyseValueHelp(capped, sources, {
    entity: 'ZC_Test',
    maxFields: 10,
    maxCalls: 5,
    validate: false,
  });
  assert.ok(r2.adtCalls <= 12, `spent ${r2.adtCalls}`);
  assert.ok(
    r2.fields.some((f) => f.candidates?.some((c) => c.tier === 'unverified')),
    'a candidate beyond the budget is marked unverified, not silently dropped'
  );
});

test('21 and 24: a data element that does not resolve degrades, it does not throw', async () => {
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('Weird', 'zde_unknown')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'Weird');
  assert.equal(f.status, 'no candidate');
  // The failure is CARRIED, not swallowed: without it, "no candidate" would read as
  // "this field needs no value help", which is a different answer.
  assert.match(f.degraded, /data element zde_unknown did not resolve/);
  assert.equal(f.domain, null);
  assert.equal(countOf(api, 'getDomainProperties'), 0, 'no domain call after a failed DE');
});

test('23: an entity with no fields says so instead of reporting nothing', async () => {
  const api = fakeApi({ tree: { ZC_EMPTY: [] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Empty', validate: false });
  assert.deepEqual(r.fields, []);
  assert.match(r.notes.join(' '), /returned no field nodes/);
});

test('23b: an entity the system does not have fails with a message, not a stack trace', async () => {
  const api = fakeApi({ tree: {} });
  await assert.rejects(
    () => analyseValueHelp(api, sources, { entity: 'ZC_Nope', validate: false }),
    /Field list of ZC_Nope could not be read/
  );
});

test('25: a concept with no VH variant falls back to the released business view', async () => {
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('StorageLocation', 'lgort_d')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'StorageLocation');
  assert.equal(f.recommended, 'I_STORAGELOCATION');
  assert.match(f.candidates[0].kind, /business view/);
});

test('26: where a StdVH variant exists it outranks the plain business view', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'Plant');
  assert.equal(f.recommended, 'I_PLANTSTDVH');
  assert.ok(f.candidates.some((c) => c.name === 'I_PLANT' && c.tier === 'C'));
});

test('28: a Z append field matches on its domain, and says so', async () => {
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('CompanyCode', 'bukrs')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'CompanyCode');
  assert.equal(f.recommended, 'I_COMPANYCODEVH');
  assert.ok(f.concepts.some((c) => c.concept === 'BUKRS' && /domain/.test(c.from)));
});

test('29: a field with no data element is declared unmatched, never guessed', async () => {
  const api = fakeApi({
    tree: { ZC_TEST: [{ name: 'X1', type: 'STOB/DOF', properties: { elementProps: {} } }] },
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'X1');
  assert.equal(f.status, 'no candidate');
  assert.match(f.reason, /no data element|nothing about this field/);
  assert.equal(countOf(api, 'getDataElementProperties'), 0);
});

test('a domain with fixed values is a conclusion: no value help is wanted', async () => {
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('IsBlocked', 'xfeld')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'IsBlocked');
  assert.equal(f.status, 'no value help wanted');
  assert.match(f.reason, /2 fixed values/);
  assert.equal(countOther(api, 'getObjectSource', 'zc_test'), 0);
});

test('a single field can be looked up by data element, with no entity at all', async () => {
  const api = fakeApi({ tree: {} });
  const r = await analyseValueHelp(api, sources, {
    field: 'Plant',
    dataElement: 'werks_d',
    validate: false,
  });
  assert.equal(fieldOf(r, 'Plant').recommended, 'I_PLANTSTDVH');
  assert.equal(countOf(api, 'ddicElement'), 0);
  assert.equal(r.exposure, null, 'no entity means no exposure claim');
});

test('asking for nothing is an error with a usable message', async () => {
  await assert.rejects(
    () => analyseValueHelp(fakeApi(), sources, {}),
    /Give an entity, or a field\/dataElement/
  );
});

test('32 and 33: exposure is checked against the service definitions the system says use the entity', async () => {
  // Found by asking: the SRVD rows of the entity's where-used, read from the system. No file
  // name convention, no checkout -- a service in another package is found just the same.
  const SRVD = read('srvd-package', 'zui_demoitemrating.srvd.srvdsrv');
  const withService = (tree) =>
    fakeApi({
      tree,
      extraObjects: { ZC_DEMOITEMRATING: 'define view entity ZC_DemoItemRating as select from t001w { key werks as Plant }', ZUI_DEMOITEMRATING: SRVD },
      usage: [
        { 'adtcore:name': 'ZUI_DEMOITEMRATING', 'adtcore:type': 'SRVD/SRV', usageInformation: 'gradeDirect', packageRef: { 'adtcore:name': 'ZDEMO' } },
        { 'adtcore:name': 'ZC_OTHER', 'adtcore:type': 'DDLS/DF', usageInformation: 'gradeDirect' },
      ],
    });
  const api = withService({ ZC_DEMOITEMRATING: [FIELD('Plant', 'werks_d')] });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_DemoItemRating', validate: false });
  assert.equal(r.exposure.conclusive, true);
  assert.equal(r.exposure.ok, false, 'the real defect: the value help is not exposed');
  assert.match(r.exposure.note, /bound but not exposed/);
  assert.ok(api.calls.some((c) => c[0] === 'getObjectSource' && /srvd\/sources\/zui_demoitemrating/.test(c[1])));

  // No service uses it: inconclusive, never "fine".
  const lonely = fakeApi({ tree: { ZC_DEMOITEMRATING: [FIELD('Plant', 'werks_d')] }, extraObjects: { ZC_DEMOITEMRATING: 'define view entity ZC_DemoItemRating as select from t001w { key werks as Plant }' } });
  const r2 = await analyseValueHelp(lonely, sources, { entity: 'ZC_DemoItemRating', validate: false });
  assert.equal(r2.exposure.conclusive, false);

  // exposure: false skips the lookup entirely.
  const off = withService({ ZC_DEMOITEMRATING: [FIELD('Plant', 'werks_d')] });
  const r3 = await analyseValueHelp(off, sources, { entity: 'ZC_DemoItemRating', validate: false, exposure: false });
  assert.deepEqual(r3.exposure, { asked: false, reason: 'exposure: false' }, 'not asked is said, not left null');
  assert.equal(countOf(off, 'usageReferences'), 0);
});

test('the report always says which sources answered', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  assert.match(r.sources.catalogue, /catalog-mini\.json/);
  // Both halves of the catalogue are accounted for, and a missing one is announced --
  // the test fixture has no classification file next to it, so this is the degraded path.
  assert.match(r.sources.catalogue, /release info \+ 0 classifications/);
  assert.match(r.sources.catalogue, /DEGRADED/);
  assert.match(r.sources.precedent, /not asked/);
  assert.equal(typeof r.adtCalls, 'number');
  assert.equal(r.adtCalls, api.calls.length, 'the reported cost is the real cost');
});

test('a popular value help for a WEAKER concept never outranks the exact match', async () => {
  // Live regression, DEV 2026-09-08. `ProductType` yields four concepts: MATLTYPE
  // (defaultComponentName), MTART (domain), PRODUCTTYPE (the element name) and PRODUCT
  // (the element name minus its last word). Both I_ProductType and I_ProductStdVH are
  // released tier-A value helps, so the tier cannot separate them -- and ranking on
  // precedent count alone put the PRODUCT one first, because the product value help is
  // bound everywhere. The emitted annotation then offered a list of products for a field
  // that holds a product TYPE.
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('ProductType', 'producttype')] } });
  const result = await analyseValueHelp(api, sources, { entity: 'ZC_TEST' });
  const f = fieldOf(result, 'ProductType');

  assert.equal(f.status, 'recommended');
  assert.equal(f.recommended, 'I_PRODUCTTYPE');
  assert.equal(f.matchedConcept.concept, 'PRODUCTTYPE');
  assert.match(f.annotation, /element: 'ProductType'/);

  // And the product value help is not even a candidate any more: PRODUCT is no longer
  // a concept of this field, because dropping 'Type' drops the head noun.
  assert.equal(
    f.candidates.find((c) => c.name === 'I_PRODUCTSTDVH'),
    undefined,
    'the popular value help for another concept must not be offered at all'
  );
  assert.ok(
    !f.concepts.some((c) => c.concept === 'PRODUCT'),
    'ProductType is not a kind of Product for naming purposes'
  );
});

test('ranking: tier first, then concept strength, and popularity only last', () => {
  // The comparator on its own, because the live failure was in the ORDER of the keys.
  // `weakButPopular` is the shape that won before the fix: same tier, weaker concept,
  // seven real precedents behind it.
  const exact = { name: 'I_EXACT', tier: 'A', strength: 3, precedent: null };
  const weakButPopular = { name: 'I_BROAD', tier: 'A', strength: 6, precedent: { count: 7 } };
  const strongerButB = { name: 'I_B', tier: 'B', strength: 1, precedent: { count: 99 } };
  const equalPopular = { name: 'I_EQUAL', tier: 'A', strength: 3, precedent: { count: 2 } };

  assert.deepEqual(
    rankCandidates([weakButPopular, exact]).map((c) => c.name),
    ['I_EXACT', 'I_BROAD'],
    'a stronger concept beats a more popular one'
  );
  assert.deepEqual(
    rankCandidates([strongerButB, weakButPopular]).map((c) => c.name),
    ['I_BROAD', 'I_B'],
    'but the tier still comes first: a tier-B view loses to a tier-A one'
  );
  assert.deepEqual(
    rankCandidates([exact, equalPopular]).map((c) => c.name),
    ['I_EQUAL', 'I_EXACT'],
    'at equal tier and equal strength, what the system already uses wins'
  );
  assert.deepEqual(
    rankCandidates([]).map((c) => c.name),
    [],
    'and an empty list ranks to an empty list, not to undefined'
  );
});

test('the numeral-suffixed name is generated: ProductGroup exists only as I_ProductGroup_2', () => {
  // Measured in the PCE 2023 catalogue: 335 released CDS_STOB names end in `_<n>` and
  // 309 of them have no plain sibling, so skipping the form loses the only released
  // answer there is. Live, ProductGroup then fell through to a broader concept.
  // The numeral is NOT a version: SAP also uses it to stack layers of logic on one
  // concept, so `_2` may coexist with the plain name rather than supersede it.
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('ProductGroup', 'productgroup')] } });
  const names = candidateNames(
    conceptsFor({ name: 'ProductGroup', dataElement: 'productgroup', domain: 'MATKL' }),
    catalog
  ).map((c) => c.name);
  assert.ok(names.includes('I_PRODUCTGROUP_2'), `expected the _2 form, got ${names.join(', ')}`);
  assert.equal(api.calls.length, 0, 'name generation is offline');
});

// --- scenario 34: the semantic signal ----------------------------------------------

test('34: a UNIT field reaches I_UnitOfMeasureStdVH by its DDIC type, asking the system nothing', async () => {
  // The case the whole cycle started from, now answered offline. MEINS states
  // defaultComponentName BASEUOM (measured, and not what it looks like), so every
  // name-based signal misses -- but the field's DDIC type is UNIT, which the 7.58
  // documentation defines as "unit key of a quantity field"
  // (abenddic_builtin_types.md:85). That is a system-declared fact, free of charge,
  // and it is the only signal that survives a projection.
  const api = fakeApi({
    tree: { ZC_TEST: [FIELD('BaseUnit', 'meins', { ddicDataType: 'UNIT', ddicLength: 3 })] },
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'BaseUnit');

  assert.equal(f.status, 'recommended');
  assert.equal(f.recommended, 'I_UNITOFMEASURESTDVH');
  assert.equal(f.matchedConcept.concept, 'UNITOFMEASURE');
  assert.match(f.matchedConcept.from, /DDIC type UNIT/);
  assert.equal(f.matchedConcept.strength, 0, 'the semantic type outranks every name signal');
  assert.match(f.annotation, /element: 'UnitOfMeasure'/);

  // And the expensive routes stay shut: the active search exists for fields the type
  // cannot classify, not for a unit field.
  // Two searchObject calls, both plain name resolutions of the two catalogue hits for
  // the concept. What must NOT appear is a wildcard query -- that is the active search.
  assert.equal(countOther(api, 'searchObject', 'zc_test'), 2);
  assert.ok(
    !api.calls.some((c) => c[0] === 'searchObject' && String(c[1]).includes('*')),
    'no wildcard concept search was needed'
  );
  assert.equal(countOf(api, 'usageReferences'), 0, 'the 3.4 MB where-used on T006 is not touched');
  assert.equal(f.activeSearch, undefined);
});

test('34d: the domain carries the semantic type even when the element tree does not', async () => {
  // Two resources answer the same question and it is not observed which word this
  // release uses, so both are read: the domain's typeInformation.datatype first (the
  // call is already made for the value table) and the element tree's ddicDataType
  // behind it. Here the element says only 'char' and the domain says UNIT.
  const api = fakeApi({ tree: { ZC_TEST: [FIELD('BaseUnit', 'meins')] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });
  const f = fieldOf(r, 'BaseUnit');
  assert.equal(f.recommended, 'I_UNITOFMEASURESTDVH');
  assert.match(f.matchedConcept.from, /\(the domain\)/);
  assert.equal(countOf(api, 'usageReferences'), 0, 'and the value table is never touched');
  assert.equal(f.activeSearch, undefined);
});

test('34b: the ElementRef form names ANOTHER field, and is never applied to its carrier', async () => {
  // @Semantics.quantity.unitOfMeasure sits on the QUANTITY field and its value names
  // the unit field (abencds_annotations_abap_tables.md:176, type ElementRef). Reading
  // it as a property of the field that carries it would offer a list of units of
  // measure for a field that holds a quantity -- which is what the plan's wording
  // would have produced.
  const elements = {
    Quantity: { 'Semantics.quantity.unitOfMeasure': "'BaseUnit'" },
    BaseUnit: {},
    Amount: { 'Semantics.amount.currencyCode': "'TransactionCurrency'" },
    TransactionCurrency: {},
    Language: { 'Semantics.language': 'true' },
    Ghost: { 'Semantics.quantity.unitOfMeasure': "'FieldThatIsNotThere'" },
  };
  const found = semanticsFromAnnotations(elements);

  assert.equal(found.get('BaseUnit').concept, 'UNITOFMEASURE');
  assert.match(found.get('BaseUnit').from, /of Quantity names this field/);
  assert.equal(found.get('TransactionCurrency').concept, 'CURRENCY');
  assert.equal(found.get('Language').concept, 'LANGUAGE');
  assert.equal(found.has('Quantity'), false, 'the quantity field is not a unit key');
  assert.equal(found.has('Amount'), false, 'the amount field is not a currency key');
  assert.equal(found.has('Ghost'), false);
  assert.equal(found.has('FieldThatIsNotThere'), false, 'a dangling reference invents no field');
});

test('34e: the semantic annotations the system resolves classify a field, with no call of their own', async () => {
  // A projection restates neither @Semantics.quantity.unitOfMeasure nor its target; the field
  // list (elementinfo) carries what the model resolves, inherited annotations included. Here
  // OrderUnit is a plain CHAR with a Z data element (no concept of its own); the quantity field
  // names it as its unit.
  const qty = FIELD('OrderQuantity', 'zdemo_qty', { ddicDataType: 'quan' });
  qty.properties.annotations = [{ key: 'SEMANTICS.QUANTITY.UNITOFMEASURE', value: 'OrderUnit' }];
  const unit = FIELD('OrderUnit', 'zdemo_unit_c');
  unit.properties.annotations = [{ key: 'ENDUSERTEXT.LABEL', value: 'Order unit' }];
  const api = fakeApi({
    tree: { ZC_TEST: [qty, unit] },
    extraObjects: { ZC_TEST: 'define view entity ZC_Test as projection on ZI_Test { key OrderQuantity, OrderUnit }' },
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', fields: ['OrderUnit'], validate: false });
  const f = fieldOf(r, 'OrderUnit');
  assert.ok(r.notes.some((n) => /semantic annotations of the model: OrderUnit \(UNITOFMEASURE\)/.test(n)), r.notes.join(' | '));
  assert.equal(f.matchedConcept.concept, 'UNITOFMEASURE', JSON.stringify(f.concepts));
  assert.match(f.matchedConcept.from, /SEMANTICS\.QUANTITY\.UNITOFMEASURE of OrderQuantity names this field.*as the system resolves it/);
  assert.equal(f.recommended, 'I_UNITOFMEASURESTDVH');
  assert.equal(countOf(api, 'ddicElement'), 1, 'the field list is read once; the annotations come with it');
});

test('34c: readAnnotations is opt-in, and says so when the source states nothing', async () => {
  const tree = { ZC_TEST: [FIELD('Plant', 'werks_d')] };
  // The entity's own source is always read once (to see which fields are already bound);
  // the SEMANTIC reading of it is what stays opt-in.
  const off = fakeApi({ tree, extraObjects: { ZC_TEST: 'define view entity ZC_Test as select from t001w { key werks as Plant }' } });
  const quiet = await analyseValueHelp(off, sources, { entity: 'ZC_Test', validate: false });
  assert.ok(!quiet.notes.some((n) => /semantic annotation/.test(n)), 'no semantic reading unless asked for');
  assert.equal(off.calls.filter((c) => c[0] === 'getObjectSource' && /zc_test/.test(c[1])).length, 1, 'one read of its own source');

  const on = fakeApi({
    tree,
    extraObjects: { ZC_TEST: 'define view entity ZC_Test as select from t001w { key werks as Plant }' },
  });
  const r = await analyseValueHelp(on, sources, {
    entity: 'ZC_Test',
    validate: false,
    readAnnotations: true,
  });
  // Nothing semantic in that source -- and the note must say that this is what the
  // FILE says, not what the model says, because a projection inherits and does not
  // restate.
  assert.ok(
    r.notes.some((n) => /states no semantic annotation/.test(n) && /inherited/.test(n)),
    `expected the inheritance caveat, got: ${r.notes.join(' | ')}`
  );
  assert.equal(fieldOf(r, 'Plant').recommended, 'I_PLANTSTDVH', 'and the analysis is unaffected');
});

// --- scenario 22: a failure mid-run ------------------------------------------------

test('22: a candidate whose source cannot be read is marked unverified, and the other fields survive', async () => {
  // The SAP side going away in the middle of a run must never turn into a silent
  // "no value help for this field": the candidate is named, the reason is carried, and
  // the fields analysed before and after it keep their answers.
  const api = fakeApi({
    tree: { ZC_TEST: [FIELD('Plant', 'werks_d'), FIELD('CompanyCode', 'bukrs')] },
    methods: {
      async getObjectSource(url) {
        this.calls.push(['getObjectSource', url]);
        if (/companycode/i.test(url)) throw new Error('HTTP 503 while reading the source');
        const name = url.split('/').filter(Boolean).slice(-3)[0].toUpperCase();
        if (!SOURCES[name]) throw new Error(`no source for ${name}`);
        return SOURCES[name];
      },
    },
  });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false });

  const broken = fieldOf(r, 'CompanyCode');
  assert.equal(broken.status, 'no recommendation');
  const vh = broken.candidates.find((c) => c.name === 'I_COMPANYCODEVH');
  assert.equal(vh.tier, 'unverified');
  assert.match(vh.reasons[0], /source could not be read/);
  assert.match(vh.reasons[0], /503/, 'the real error is carried, not swallowed');
  assert.match(broken.reason, /I_COMPANYCODEVH/, 'the failing candidate is named in the answer');
  assert.equal(broken.annotation, undefined, 'and nothing is emitted for it');

  const ok = fieldOf(r, 'Plant');
  assert.equal(ok.status, 'recommended');
  assert.equal(ok.recommended, 'I_PLANTSTDVH');
});

test('the DDIC type comes from the data element first, the domain only as a fallback', async () => {
  // docs/adt-api-reference.md:114 records getDataElementProperties('werks_d') answering
  // `dataType: "CHAR"` VERBATIM on this system. The domain's typeInformation.datatype is
  // only a shape from the client's typings. Reading the measured source first means the
  // semantic signal no longer depends on an unobserved one -- and when the data element
  // is silent, the domain still fills the hole.
  const dtelOnly = {
    async getDataElementProperties() {
      return { properties: { typeName: 'MEINS', dataType: 'UNIT', dataTypeLength: 3 } };
    },
    async getDomainProperties() {
      return { properties: { typeInformation: { datatype: 'CHAR' }, valueInformation: {} } };
    },
  };
  const measured = await resolveDataElement(dtelOnly, 'meins');
  assert.equal(measured.ddicType, 'UNIT', 'the data element wins over the domain');
  assert.equal(measured.ddicLength, 3);

  const silentDtel = {
    async getDataElementProperties() {
      return { properties: { typeName: 'MEINS' } };
    },
    async getDomainProperties() {
      return { properties: { typeInformation: { datatype: 'UNIT' }, valueInformation: {} } };
    },
  };
  assert.equal((await resolveDataElement(silentDtel, 'meins')).ddicType, 'UNIT');

  // Neither source answers: no type, and never a guessed one.
  const silentBoth = {
    async getDataElementProperties() {
      return { properties: { typeName: 'MEINS' } };
    },
    async getDomainProperties() {
      return { properties: { valueInformation: {} } };
    },
  };
  assert.equal((await resolveDataElement(silentBoth, 'meins')).ddicType, undefined);
});

// --- the completeness contract (lib/completeness.mjs) ----------------------------

test('the analysis answers the contract, and two pages of fields are every field once', async () => {
  const tree = { ZC_TEST: [FIELD('Plant', 'werks_d'), FIELD('StorageLocation', 'lgort_d'), FIELD('CompanyCode', 'bukrs')] };
  const one = await analyseValueHelp(fakeApi({ tree }), sources, { entity: 'ZC_Test', validate: false, exposure: false, maxFields: 2 });
  assert.deepEqual(contractErrors(one), []);
  assert.equal(one.complete, false);
  assert.deepEqual(one.fieldsPage.next, { fieldsOffset: 2 });
  const two = await analyseValueHelp(fakeApi({ tree }), sources, { entity: 'ZC_Test', validate: false, exposure: false, maxFields: 2, fieldsOffset: 2 });
  assert.deepEqual(contractErrors(two), []);
  assert.equal(two.fieldsPage.next, undefined);
  assert.deepEqual([...one.fields, ...two.fields].map((f) => f.field), ['Plant', 'StorageLocation', 'CompanyCode']);
});

test('a candidate whose source does not parse is unverified, never tier C', async () => {
  const api = fakeApi({ tree: PLANT_TREE });
  const get = api.getObjectSource;
  api.getObjectSource = async (url) => (/i_plantstdvh/.test(url) ? ['annotate entity broken with', '  Plant;', '  Name;', '  Region;', '  Country;'].join('\n') : get(url));
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false, exposure: false });
  const c = fieldOf(r, 'Plant').candidates.find((x) => x.name === 'I_PLANTSTDVH');
  assert.equal(c.tier, 'unverified');
  assert.equal(c.unverifiedBy, 'parse');
  assert.ok(r.incomplete.some((i) => i.code === 'PARSE_FAILED' && i.list === 'fields.Plant.candidates'));
});

test('a precedent skipped for the budget is BUDGET_REACHED, not "no other binding"', async () => {
  // The calls the analysis needs without a precedent, plus one: every candidate is verified,
  // and the four calls a precedent costs no longer fit.
  const base = await analyseValueHelp(fakeApi({ tree: PLANT_TREE }), sources, { entity: 'ZC_Test', validate: false, exposure: false });
  const r = await analyseValueHelp(fakeApi({ tree: PLANT_TREE }), sources, { entity: 'ZC_Test', validate: false, exposure: false, precedent: true, maxCalls: base.adtCalls + 1 });
  const f = fieldOf(r, 'Plant');
  assert.equal(f.status, 'recommended');
  assert.deepEqual(f.precedent, { asked: true, read: false, reason: 'budget' });
  assert.ok(r.incomplete.some((i) => i.list === 'fields.Plant.precedent' && i.code === 'BUDGET_REACHED'));
  assert.equal(base.incomplete.some((i) => i.list === 'fields.Plant.precedent'), false, 'not asked is not incompleteness');
  assert.deepEqual(contractErrors(r), []);
});

test('exposure checked on part of the services is inconclusive: no missing entity is claimed', () => {
  const svc = { source: 'define service ZUI_DEMO { expose ZC_DemoItem; }', file: 'ZDEMO/zui_demo.srvd' };
  const edges = [{ entity: 'I_PlantStdVH', element: 'Plant' }];
  const all = checkExposure(edges, [svc]);
  assert.equal(all.conclusive, true);
  assert.equal(all.missing.length, 1);
  const part = checkExposure(edges, [svc], { allRead: false });
  assert.equal(part.conclusive, false);
  assert.deepEqual(part.missing, [], 'never a SRVD_EXPOSURE_MISSING on a partial read');
  assert.deepEqual(part.notInServicesRead.map((m) => m.entity), ['I_PlantStdVH']);
});

test('a field without a data element is an answer, not a gap: it adds no incomplete entry', async () => {
  const api = fakeApi({ tree: { ZC_TEST: [{ name: 'X1', type: 'STOB/DOF', properties: { elementProps: {} } }] } });
  const r = await analyseValueHelp(api, sources, { entity: 'ZC_Test', validate: false, exposure: false });
  assert.equal(fieldOf(r, 'X1').noDataElement, true);
  assert.equal(r.incomplete.some((i) => i.list === 'fields.X1'), false);
});
