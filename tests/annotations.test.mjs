// Annotation parsing, tested against source read out of the system verbatim.
//
// The two fixtures are not illustrations: I_PlantStdVH is the grouped-syntax case that
// classifies as a real value help, and I_PlantVH is the one that would fool a naive
// reader -- it carries dataCategory: #VALUE_HELP while being an analytical dimension,
// and it carries commented-out annotations that must not be read as live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAnnotations,
  stripComments,
  elementName,
  enumTokens,
  literal,
  isTrue,
} from '../lib/annotations.mjs';

const fixture = (name) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

const PLANT_STD_VH = fixture('i_plantstdvh.asddls');
const PLANT_VH = fixture('i_plantvh.asddls');

test('grouped syntax flattens to dotted keys (I_PlantStdVH, measured)', () => {
  const { name, kind, entity, source } = parseAnnotations(PLANT_STD_VH);

  assert.equal(name, 'I_PlantStdVH');
  assert.equal(kind, 'define view');
  assert.equal(source.from, 't001w');

  assert.equal(entity['ObjectModel.dataCategory'], '#VALUE_HELP');
  assert.equal(entity['ObjectModel.representativeKey'], "'Plant'");
  assert.equal(entity['ObjectModel.supportedCapabilities'], '[#VALUE_HELP_PROVIDER]');
  // Nested inside the group, and with no space after the colon in the source.
  assert.equal(entity['ObjectModel.usageType.dataClass'], '#CUSTOMIZING');
  assert.equal(entity['ObjectModel.usageType.serviceQuality'], '#A');
  // A dotted key *inside* a group keeps both halves.
  assert.equal(entity['AbapCatalog.compiler.compareFilter'], 'true');
  assert.equal(entity['AbapCatalog.buffering.status'], '#ACTIVE');
  assert.equal(entity['VDM.lifecycle.contract.type'], '#PUBLIC_LOCAL_API');
});

test('ungrouped syntax parses alongside grouped, in the same view', () => {
  const { entity } = parseAnnotations(PLANT_STD_VH);
  assert.equal(entity['Search.searchable'], 'true');
  assert.equal(entity['Consumption.ranked'], 'true');
  assert.equal(entity['Analytics.dataCategory'], '#DIMENSION');
  assert.equal(entity['ClientHandling.algorithm'], '#SESSION_VARIABLE');
  assert.equal(entity['EndUserText.label'], "'Plant'");
});

test('element annotations attach to the aliased name, not the column', () => {
  const { elements } = parseAnnotations(PLANT_STD_VH);

  assert.deepEqual(Object.keys(elements).sort(), ['Plant', 'PlantName']);
  // `key werks as Plant` -> Plant
  assert.equal(elements.Plant['ObjectModel.text.element'], "'PlantName'");
  assert.equal(elements.Plant['Search.ranking'], '#HIGH');
  // `cast(name1 as werks_name) as PlantName` -- the cast's own `as` must not win
  assert.equal(elements.PlantName['Semantics.text'], 'true');
  assert.equal(elements.PlantName['Search.ranking'], '#LOW');
});

test('commented-out annotations are NOT read as live (I_PlantVH, measured)', () => {
  const { entity, elements } = parseAnnotations(PLANT_VH);

  // //@AbapCatalog:{ ... } and //@ClientHandling.algorithm: are commented out.
  assert.equal(entity['AbapCatalog.sqlViewName'], undefined);
  assert.equal(entity['ClientHandling.algorithm'], undefined);
  // The live ones next to them are still there.
  assert.equal(entity['Analytics.technicalName'], "'IPLANTEXTVH'");
  assert.equal(entity['Metadata.ignorePropagatedAnnotations'], 'true');
  // The commented `text.element: 'PlantName'` is followed by a live array form.
  assert.equal(elements.Plant['ObjectModel.text.element'], "['PlantName']");
});

test('the tier-C signature of I_PlantVH is readable, and it is not a value help', () => {
  const { kind, entity } = parseAnnotations(PLANT_VH);

  assert.equal(kind, 'define view entity');
  // It DOES claim to be a value help ...
  assert.equal(entity['ObjectModel.dataCategory'], '#VALUE_HELP');
  // ... and its primary purpose says otherwise, in two independent annotations.
  assert.equal(entity['ObjectModel.modelingPattern'], '#ANALYTICAL_DIMENSION');
  assert.deepEqual(enumTokens(entity['ObjectModel.supportedCapabilities']), [
    'ANALYTICAL_DIMENSION',
    'CDS_MODELING_ASSOCIATION_TARGET',
    'SQL_DATA_SOURCE',
    'CDS_MODELING_DATA_SOURCE',
  ]);
});

test('multi-line array values survive, including a nested valueHelpDefinition', () => {
  const { elements } = parseAnnotations(PLANT_VH);
  const raw = elements.PlantCustomer['Consumption.valueHelpDefinition'];

  assert.ok(raw.startsWith('['), 'the array must be kept as raw text');
  assert.match(raw, /'I_Customer_VH'/);
  assert.match(raw, /element: 'Customer'/);
  assert.equal(elements.PlantCustomer['ObjectModel.foreignKey.association'], "'_Customer'");
  // The underscore variant is real: this is where I_Customer_VH comes from.
  assert.match(elements.PlantSupplier['Consumption.valueHelpDefinition'], /'I_Supplier_VH'/);
});

test('casts, associations and commented-out fields are handled', () => {
  const { elements } = parseAnnotations(PLANT_VH);
  const names = Object.keys(elements);

  // `cast(X as t preserving type ) as Y` -> Y
  assert.ok(names.includes('DefaultPurchasingOrganization'));
  assert.ok(names.includes('DistributionChannel'));
  // Bare fields.
  assert.ok(names.includes('SalesOrganization'));
  // Associations are elements too, and keep their underscore.
  assert.ok(names.includes('_Customer'));
  // Commented-out fields must not appear at all.
  assert.ok(!names.includes('Language'), 'Language is commented out in the source');
  assert.ok(!names.includes('IsMarkedForArchiving'));
});

test('stripComments keeps string literals that contain a comment marker', () => {
  const s = stripComments("@EndUserText.label: 'a // b' // real comment\n");
  assert.match(s, /'a \/\/ b'/);
  assert.ok(!s.includes('real comment'));
});

test('elementName resolves the shapes measured in the workspace', () => {
  assert.equal(elementName('  key werks as Plant'), 'Plant');
  assert.equal(elementName('  key Plant'), 'Plant');
  assert.equal(elementName('  key Mon.Bukrs                      as Bukrs'), 'Bukrs');
  assert.equal(elementName('  PlantName'), 'PlantName');
  assert.equal(elementName('  _Customer'), '_Customer');
  assert.equal(elementName('  cast(name1 as werks_name) as PlantName'), 'PlantName');
  // An expression with no alias has no name -- and must not be guessed.
  assert.equal(elementName('  sum(Quantity)'), undefined);
});

test('DDLX annotate entity parses as elements, with semicolon statements', () => {
  const { name, kind, elements } = parseAnnotations(`
    @Metadata.layer: #CORE
    annotate view ZC_Thing with
    {
      @UI.lineItem: [{ position: 10 }]
      @UI.selectionField: [{ position: 10 }]
      Plant;
      @UI.hidden: true
      Internal;
    }
  `);
  assert.equal(name, 'ZC_Thing');
  assert.equal(kind, 'annotate view');
  assert.equal(elements.Plant['UI.selectionField'], '[{ position: 10 }]');
  assert.equal(elements.Internal['UI.hidden'], 'true');
});

test('value helpers do not turn absence into a value', () => {
  assert.equal(literal("'Plant'"), 'Plant');
  assert.equal(literal(undefined), undefined);
  assert.equal(isTrue('true'), true);
  assert.equal(isTrue('TRUE'), true);
  assert.equal(isTrue(undefined), false);
  assert.equal(isTrue(''), false);
  assert.deepEqual(enumTokens(undefined), []);
});

test('the SQL-style comment is stripped too, not only //', () => {
  // Measured: both forms are in production in a measured workspace, and one real file has
  // `as select from` sitting inside a comment. Treating `--` as live text would invent
  // a data source that does not exist.
  const src = [
    '@EndUserText.label: \'live\'',
    '-- @EndUserText.label: \'dead\'',
    'define view entity ZC_X as select from mara -- as select from vbbe',
    '{ key matnr as Product }',
  ].join('\n');
  const stripped = stripComments(src);
  assert.ok(stripped.includes("select from mara"));
  assert.equal(stripped.includes('vbbe'), false);
  assert.equal(stripped.includes('dead'), false);
  assert.ok(stripped.includes('live'));
  // Offsets are preserved: comments become spaces, never disappear.
  assert.equal(stripped.length, src.length);
});

test('a double hyphen inside a string literal is not a comment', () => {
  const src = "@EndUserText.label: 'a -- b'\ndefine view entity ZC_X as select from mara {}";
  const stripped = stripComments(src);
  assert.ok(stripped.includes("'a -- b'"));
  assert.ok(stripped.includes('select from mara'));
});
