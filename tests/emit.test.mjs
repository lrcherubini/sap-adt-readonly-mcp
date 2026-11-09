// Emission: what gets written, what gets refused, and what gets flagged unvalidated.
// Validated against the same annotation definitions as annotation-defs.test.mjs (DDLA form).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fromDdla, noDefs } from '../lib/annotation-defs.mjs';
import {
  annotationKeys,
  validateEmission,
  renderAnnotation,
  renderOwnVhProposal,
  emit,
  VHD,
  ELEMENT,
  PARAMETER,
} from '../lib/emit.mjs';

const defs = fromDdla(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'annotation-defs.ddla.txt'), 'utf8'));

const PLANT = { entity: { name: 'I_PlantStdVH', element: 'Plant' }, useForValidation: true };

test('the keys of a record are the paths that will be written', () => {
  assert.deepEqual(annotationKeys(PLANT).map((k) => k.key), [
    `${VHD}[ ].entity.name`,
    `${VHD}[ ].entity.element`,
    `${VHD}[ ].useForValidation`,
  ]);
  assert.deepEqual(annotationKeys({}), [], 'an empty record writes nothing');
});

test('the normal case validates clean and renders the block', () => {
  const out = emit(PLANT, defs);
  assert.equal(out.validation.ok, true);
  assert.deepEqual(out.validation.refused, []);
  assert.deepEqual(out.validation.unvalidated, []);
  assert.equal(out.validation.checked, 3);
  assert.equal(
    out.text,
    "@Consumption.valueHelpDefinition: [{\n" +
      "  entity: { name: 'I_PlantStdVH', element: 'Plant' },\n" +
      '  useForValidation: true\n' +
      '}]'
  );
  assert.deepEqual(out.warnings, []);
});

test('association is refused, and nothing at all is rendered', () => {
  const out = emit({ ...PLANT, association: '_Plant' }, defs);
  assert.equal(out.validation.ok, false);
  assert.equal(out.text, null, 'a partial block next to a refusal would ship the violation');
  assert.equal(out.validation.refused.length, 1);
  assert.match(out.validation.refused[0].key, /\.association$/);
  assert.match(out.validation.refused[0].reason, /not released/);
  assert.match(out.warnings[0], /association refused/);
});

test('selectionVariantQualifier is refused; presentationVariantQualifier is not', () => {
  const bad = emit({ ...PLANT, selectionVariantQualifier: 'Q1' }, defs);
  assert.equal(bad.validation.ok, false);
  assert.match(bad.validation.refused[0].reason, /not released/);

  const good = emit({ ...PLANT, presentationVariantQualifier: 'Q1' }, defs);
  assert.equal(good.validation.ok, true);
  assert.match(good.text, /presentationVariantQualifier: 'Q1'/);
});

test('the singular Consumption.valueHelp is refused by name, naming the replacement', () => {
  const v = validateEmission(['Consumption.valueHelp'], defs);
  assert.equal(v.ok, false);
  assert.match(v.refused[0].reason, /Key User apps only/);
  assert.match(v.refused[0].reason, /Consumption\.valueHelpDefinition instead/);
});

test('a usage outside the closed enum is refused, quoting the enum', () => {
  const v = validateEmission(
    [{ key: `${VHD}[ ].additionalBinding[ ].usage`, value: '#FILTER_ONLY' }],
    defs
  );
  assert.equal(v.ok, false);
  assert.match(v.refused[0].reason, /#FILTER \| #FILTER_AND_RESULT \| #RESULT/);

  for (const usage of ['#FILTER', '#FILTER_AND_RESULT', '#RESULT', 'filter']) {
    const ok = validateEmission(
      [{ key: `${VHD}[ ].additionalBinding[ ].usage`, value: usage }],
      defs
    );
    assert.equal(ok.ok, true, usage);
  }
});

test('an annotation written at the wrong scope is refused', () => {
  // Search.searchable is Entity-scoped; writing it on an element is the mistake.
  const v = validateEmission(['Search.searchable'], defs, { scope: ELEMENT });
  assert.equal(v.ok, false);
  assert.match(v.refused[0].reason, /scope is ENTITY.*written at ELEMENT/);

  // entity.element is Element+Parameter: both scopes pass, Entity does not.
  const key = `${VHD}[ ].entity.element`;
  assert.equal(validateEmission([key], defs, { scope: ELEMENT }).ok, true);
  assert.equal(validateEmission([key], defs, { scope: PARAMETER }).ok, true);
  assert.equal(validateEmission([key], defs, { scope: 'ENTITY' }).ok, false);
  // entity.name is the one that IS also Entity-scoped.
  assert.equal(validateEmission([`${VHD}[ ].entity.name`], defs, { scope: 'ENTITY' }).ok, true);
});

test('a key the definitions do not list is unvalidated, not refused', () => {
  const v = validateEmission([`${VHD}[ ].someNewThing`], defs);
  assert.equal(v.ok, true, 'unknown is not a refusal');
  assert.deepEqual(v.refused, []);
  assert.equal(v.unvalidated.length, 1);
  assert.match(v.unvalidated[0].reason, /do not list this key/);
  assert.equal(v.checked, 0);
});

test('with no definition source the block is emitted, marked NOT VALIDATED', () => {
  const out = emit(PLANT, noDefs('the system DDLA could not be read'));
  assert.ok(out.text, 'the answer is still given');
  assert.match(out.text, /I_PlantStdVH/);
  assert.equal(out.validation.source, null);
  assert.equal(out.validation.checked, 0);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /NOT VALIDATED/);
  assert.match(out.warnings[0], /the system DDLA could not be read/);
  assert.match(out.warnings[0], /scope and release state/);
});

test('additionalBinding without a precedent is not written, and the omission is stated', () => {
  const r = renderAnnotation({
    ...PLANT,
    additionalBinding: [{ localElement: 'CompanyCode', element: 'CompanyCode', usage: '#FILTER' }],
  });
  assert.ok(!/additionalBinding/.test(r.text), 'invented bindings never reach the output');
  assert.equal(r.omitted.length, 1);
  assert.match(r.omitted[0], /no precedent shows it/);
});

test('additionalBinding with a precedent is written and cites it', () => {
  const r = renderAnnotation({
    ...PLANT,
    additionalBinding: [
      {
        localElement: 'CompanyCode',
        element: 'CompanyCode',
        usage: '#FILTER',
        precedent: 'zdemo_employee_ui/zc_demoemployee.ddls.asddls:41',
      },
    ],
  });
  assert.match(
    r.text,
    /additionalBinding: \[ \{ localElement: 'CompanyCode', element: 'CompanyCode', usage: #FILTER \} \]/
  );
  assert.match(r.notes[0], /zc_demoemployee\.ddls\.asddls:41/);
  assert.deepEqual(r.omitted, []);
});

test('with no binding at all the block says the binding cannot be inferred', () => {
  const r = renderAnnotation(PLANT);
  assert.match(r.notes.join(' '), /depends on the fields of the consuming view/);
});

test('an element name in lower case is preserved literally', () => {
  // Measured in the workspace: precedents bind `grund` and `kostl` in lower case. The
  // tool must not "correct" them to CamelCase -- the element name is what it is.
  const r = renderAnnotation({ entity: { name: 'ZI_DemoReasonVH', element: 'grund' } });
  assert.match(r.text, /element: 'grund'/);
});

test('a quote inside a literal is escaped the CDS way', () => {
  const r = renderAnnotation({ entity: { name: 'X' }, label: "Company d'Demo" });
  assert.match(r.text, /label: 'Company d''Demo'/);
});

test('a value help of our own carries the default name rule and the two requirements', () => {
  const p = renderOwnVhProposal({
    concept: 'SalesChannel',
    source: 'ZI_DemoChannel',
    key: 'SalesChannel',
    text: 'Sales channel',
  });
  assert.equal(p.name, 'ZI_SalesChannelVH');
  assert.match(p.text, /@Metadata\.ignorePropagatedAnnotations: true/);
  assert.match(p.text, /define view entity ZI_SalesChannelVH/);
  assert.match(p.text, /as select distinct from ZI_DemoChannel/);
  assert.match(p.text, /@Search\.searchable: true/);
  assert.match(p.text, /@EndUserText\.label: 'Value help - Sales channel'/);
  assert.match(p.notes.join(' '), /naming rule ZI_<entity>VH \(valueHelp\.namePattern\)/);
  assert.match(p.notes.join(' '), /F4 renders empty/);
  assert.match(p.notes.join(' '), /\.srvd\.srvdsrv/);
});

test('the name and label of a proposed value help follow the installation, and a label stays a CDS literal', () => {
  const p = renderOwnVhProposal(
    { concept: 'Region', key: 'Region', text: "State's region" },
    { namePattern: 'ZC_{entity}_VH', labelPrefix: 'Search help - ' }
  );
  assert.equal(p.name, 'ZC_Region_VH');
  assert.match(p.text, /define view entity ZC_Region_VH/);
  assert.match(p.text, /@EndUserText\.label: 'Search help - State''s region'/);
  assert.match(p.notes.join(' '), /ZC_<entity>_VH/);
  const long = renderOwnVhProposal({ concept: 'X', text: 'y'.repeat(100) });
  assert.ok(/label: '([^']*)'/.exec(long.text)[1].length <= 60, 'a CDS label holds 60 characters');
});
