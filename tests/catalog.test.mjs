// The release catalogue, and candidate generation on top of it.
//
// tests/fixtures/catalog-mini.json holds 18 rows COPIED VERBATIM out of
// SAP's objectReleaseInfo_PCE2023_0.json (data/release_index/), chosen because
// each one settles a case: the released StdVH, the released business views whose StdVH
// variant does not exist, the two underscore variants, the ValueHelp name with no VH
// suffix, the one CDS_STOB ending in VH that is NOT released, and a deprecated view.
// The last three come from the live run: I_PRODUCTTYPE and I_PRODUCTSTDVH are the pair
// where two released tier-A value helps competed for one field, and I_PRODUCTGROUP_2 is
// a concept whose ONLY released entity carries a numeral-suffixed name. I_UNITOFMEASURE
// is the 18th: the concept view the ACTIVE search reaches through the value table T006,
// which no name form built from the field BaseUnit can ever generate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCatalog } from '../lib/catalog.mjs';
import { conceptsFor, candidateNames, camelWords, hasFixedValues } from '../lib/vh-candidates.mjs';

const CATALOG = path.join(import.meta.dirname, 'fixtures', 'catalog-mini.json');
const catalog = loadCatalog(CATALOG);

test('the catalogue indexes by name and answers released state', () => {
  assert.equal(catalog.count, 18);
  assert.equal(catalog.isReleased('I_PlantStdVH'), true);
  assert.equal(catalog.isReleased('i_plantstdvh'), true, 'lookup is case-insensitive');
  assert.equal(catalog.state('I_FUNCNLLOCCATSTDVH'), 'notToBeReleasedStable');
  assert.equal(catalog.isReleased('I_FUNCNLLOCCATSTDVH'), false);
  assert.match(catalog.stateReason('I_FUNCNLLOCCATSTDVH'), /notToBeReleasedStable/);
  assert.match(catalog.stateReason('C_BILLGDOCITMPRCGELMNTBSCDEX'), /deprecated/);
});

test('a name absent from the catalogue is absent, not released', () => {
  // Measured: I_PlantVH has NO row in the PCE 2023 catalogue at all. That is why it is
  // eliminated before any ADT call -- there is nothing to ask about.
  assert.equal(catalog.has('I_PlantVH'), false);
  assert.equal(catalog.isReleased('I_PlantVH'), false);
  assert.equal(catalog.stateReason('I_PlantVH'), undefined);
});

test('a missing catalogue file fails loudly instead of yielding no candidates', () => {
  assert.throws(
    () => loadCatalog(path.join(import.meta.dirname, 'fixtures', 'nope.json')),
    /Clean Core catalogue not readable/
  );
});

test('concepts come out strongest first, and the system-stated one wins', () => {
  const concepts = conceptsFor({
    name: 'Plant',
    dataElement: 'werks_d',
    domain: 'WERKS',
    defaultComponentName: 'PLANT',
  });
  assert.equal(concepts[0].concept, 'PLANT');
  assert.match(concepts[0].from, /defaultComponentName/);
  assert.ok(concepts.some((c) => c.concept === 'WERKS' && /domain/.test(c.from)));
  // PLANT arrives from defaultComponentName, the element name and the stripped data
  // element -- it must appear once, not three times.
  assert.equal(concepts.filter((c) => c.concept === 'PLANT').length, 1);
});

test('a Z append field matches on its domain, never on its Z data element', () => {
  const concepts = conceptsFor({
    name: 'MaterialGroup1',
    dataElement: 'zdemo_de_mvgr1',
    domain: 'MVGR1',
    defaultComponentName: 'PRC_GROUP1',
  });
  const names = concepts.map((c) => c.concept);
  assert.ok(names.includes('MVGR1'), 'the domain is the only signal that works here');
  assert.ok(names.includes('PRCGROUP1'), 'defaultComponentName, non-alphanumerics dropped');
  // The Z data element name itself must not become a concept.
  assert.ok(!names.includes('ZDEMODEMVGR1'));
});

test('a field with no data element still yields the element-name concept', () => {
  const concepts = conceptsFor({ name: 'CompanyCode' });
  // COMPANY is deliberately NOT produced. English compounds are head-final, so dropping
  // the last word normally drops the head and names another business object -- and a
  // company code is not a kind of company. Only a trailing qualifier may be dropped:
  assert.deepEqual(concepts.map((c) => c.concept), ['COMPANYCODE']);
  assert.deepEqual(
    conceptsFor({ name: 'CompanyCodeName' }).map((c) => c.concept),
    ['COMPANYCODENAME', 'COMPANYCODE']
  );
});

test('the head noun is never dropped, whatever the field is called', () => {
  // The live failure: all three of these truncated to PRODUCT and got the product value
  // help recommended for fields that hold no product.
  for (const name of ['ProductType', 'ProductGroup', 'ProductHierarchy']) {
    const concepts = conceptsFor({ name }).map((c) => c.concept);
    assert.ok(!concepts.includes('PRODUCT'), `${name} must not yield PRODUCT (got ${concepts})`);
  }
  // A trailing qualifier is still dropped -- that is what the rule is for.
  assert.ok(conceptsFor({ name: 'SalesOrganizationName' }).some((c) => c.concept === 'SALESORGANIZATION'));
  assert.ok(conceptsFor({ name: 'SupplierID' }).some((c) => c.concept === 'SUPPLIER'));
});

test('a field with no signal at all yields no concept, and no guess', () => {
  assert.deepEqual(conceptsFor({ name: 'X1' }), []);
  assert.deepEqual(conceptsFor({}), []);
});

test('camelWords splits the shapes the VDM uses', () => {
  assert.deepEqual(camelWords('CompanyCode'), ['COMPANY', 'CODE']);
  assert.deepEqual(camelWords('BaseUnit'), ['BASE', 'UNIT']);
  assert.deepEqual(camelWords('ProductOID'), ['PRODUCT', 'OID']);
  assert.deepEqual(camelWords('Plant'), ['PLANT']);
});

test('candidates keep only names the catalogue knows, both families', () => {
  const found = candidateNames(conceptsFor({ name: 'Plant', defaultComponentName: 'PLANT' }), catalog);
  const names = found.map((c) => c.name);
  assert.deepEqual(names, ['I_PLANTSTDVH', 'I_PLANT']);
  assert.equal(found[0].kind, 'StdVH variant of PLANT');
  assert.equal(found[1].kind, 'business view of PLANT');
  assert.ok(found.every((c) => c.recommendable));
});

test('a concept with no VH variant falls back to the released business view', () => {
  // Measured: I_StorageLocationStdVH, I_SalesOrganizationStdVH and
  // I_DistributionChannelStdVH do not exist. Demanding a VH suffix would leave these
  // three fields with no answer, while the business view is the correct one.
  for (const concept of ['STORAGELOCATION', 'SALESORGANIZATION', 'DISTRIBUTIONCHANNEL']) {
    const found = candidateNames([{ concept, from: 'test', strength: 1 }], catalog);
    assert.deepEqual(found.map((c) => c.name), [`I_${concept}`], concept);
    assert.match(found[0].kind, /business view/);
  }
});

test('the underscore variant and the ValueHelp name are both recognised', () => {
  const customer = candidateNames([{ concept: 'CUSTOMER', from: 't', strength: 1 }], catalog);
  assert.deepEqual(customer.map((c) => c.name), ['I_CUSTOMER_VH']);
  assert.match(customer[0].kind, /underscore VH variant/);

  const cal = candidateNames([{ concept: 'FACTORYCALENDAR', from: 't', strength: 1 }], catalog);
  assert.deepEqual(cal.map((c) => c.name), ['I_FACTORYCALENDARVALUEHELP']);
  assert.match(cal[0].kind, /ValueHelp name/);
});

test('a not-released candidate is returned marked, never silently dropped', () => {
  const found = candidateNames([{ concept: 'FUNCNLLOCCAT', from: 't', strength: 1 }], catalog);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'I_FUNCNLLOCCATSTDVH');
  assert.equal(found[0].recommendable, false);
  assert.match(found[0].reason, /notToBeReleasedStable/);
});

test('a concept the VDM names differently is not reachable by name', () => {
  // MVGR1 is AdditionalMaterialGroup1 in the VDM, and I_ADDITIONALMATERIALGROUP1 is
  // released -- but no name form of MVGR1 or PRCGROUP1 reaches it. This is a real
  // limit of name matching, pinned here so it is a known gap and not a surprise: the
  // route that would close it is the domain's value table (TVM1), which needs a
  // datasource query the client cannot currently make.
  const found = candidateNames(
    conceptsFor({ name: 'MaterialGroup1', domain: 'MVGR1', defaultComponentName: 'PRC_GROUP1' }),
    catalog
  );
  assert.deepEqual(found, []);
  assert.equal(catalog.isReleased('I_ADDITIONALMATERIALGROUP1'), true);
});

test('a domain with fixed values wants no value help at all', () => {
  assert.equal(hasFixedValues({ fixValues: 3 }), true);
  assert.equal(hasFixedValues({ fixValues: 0 }), false);
  assert.equal(hasFixedValues({}), false);
});

// --- the second catalogue ------------------------------------------------------------
//
// Measured on the workspace files: 258 CDS entities exist ONLY in
// objectClassifications_SAP.json, all of them `classicAPI`. Loading just the release
// info answers "unknown to the catalogue" for every one of them -- the
// inference-from-absence a catalogue checker must not make.

const twoCatalogs = loadCatalog(CATALOG, {
  classifications: path.join(import.meta.dirname, 'fixtures', 'classifications-mini.json'),
});

test('an entity that lives only in the classification catalogue is KNOWN, not unknown', () => {
  // Verbatim rows: I_BankAccount and I_TechnicalObjectLabelVH are both absent from
  // objectReleaseInfo and present here.
  assert.equal(catalog.has('I_BANKACCOUNT'), false, 'invisible with one file');
  assert.equal(twoCatalogs.has('I_BANKACCOUNT'), true);
  assert.equal(twoCatalogs.state('I_BANKACCOUNT'), 'classicAPI');
  assert.equal(twoCatalogs.isReleased('I_BANKACCOUNT'), false, 'known is not recommendable');
  assert.match(twoCatalogs.stateReason('I_BANKACCOUNT'), /Level B/);
  assert.equal(twoCatalogs.count, 20, '18 release rows + 2 classification rows');
});

test('a Level B candidate carries the released successor the catalogue names', () => {
  assert.deepEqual(twoCatalogs.successors('I_BANKACCOUNT'), ['I_BANKACCOUNTBASICDATA']);
  assert.match(twoCatalogs.stateReason('I_BANKACCOUNT'), /released successor: I_BANKACCOUNTBASICDATA/);
  // Not every classic API has one, and inventing a successor would be worse than none.
  assert.deepEqual(twoCatalogs.successors('I_TECHNICALOBJECTLABELVH'), []);
  assert.ok(!/successor/.test(twoCatalogs.stateReason('I_TECHNICALOBJECTLABELVH')));
});

test('a value help that is only Level B becomes a stated candidate, not a silent absence', () => {
  // I_TechnicalObjectLabelVH is the one VH-shaped name among the 258. Before, a
  // TechnicalObjectLabel field got "no candidate at all" plus a proposal to build an own
  // view; now the standard one is on the table, marked Level B, for the human to decide.
  const one = candidateNames([{ concept: 'TECHNICALOBJECTLABEL', from: 't', strength: 1 }], catalog);
  assert.deepEqual(one, [], 'with one catalogue: nothing, as if it did not exist');
  const two = candidateNames([{ concept: 'TECHNICALOBJECTLABEL', from: 't', strength: 1 }], twoCatalogs);
  assert.deepEqual(two.map((c) => c.name), ['I_TECHNICALOBJECTLABELVH']);
  assert.equal(two[0].recommendable, false);
  assert.match(two[0].reason, /classicAPI/);
});

test('a missing classification catalogue degrades by saying so', () => {
  const only = loadCatalog(CATALOG, { classifications: path.join(import.meta.dirname, 'nope.json') });
  assert.equal(only.classificationsFile, null);
  assert.match(only.note, /not readable/);
  assert.match(only.note, /reported as unknown/);
  assert.equal(only.count, 18, 'still usable: the release info alone still loaded');
});
