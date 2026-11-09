// Tiering, against the four annotation blocks measured on the system. Two of them are
// real files; the other two are the annotation lines as read from the system, kept
// inline because only their ObjectModel block is relevant here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnnotations } from '../lib/annotations.mjs';
import { classifyVhSignals, tierLabel } from '../lib/vh-signals.mjs';

const fixture = (name) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

const classifySource = (source, ctx) =>
  classifyVhSignals(parseAnnotations(source).entity, { released: true, ...ctx });

test('I_PlantStdVH is tier A: it declares itself a value help provider', () => {
  const v = classifySource(fixture('i_plantstdvh.asddls'));
  assert.equal(v.tier, 'A');
  assert.equal(tierLabel(v.tier), 'recommended');
  assert.equal(v.representativeKey, 'Plant');
  assert.ok(v.signals.some((s) => s.signal === 'value help provider'));
  assert.deepEqual(v.reasons, []);
  assert.match(v.provenance, /observational/);
});

test('I_PlantVH is tier C for TWO independent reasons, and is never recommended', () => {
  const v = classifySource(fixture('i_plantvh.asddls'), {
    released: false,
    releaseReason: 'the catalogue marks it notToBeReleasedStable (stable, but not released)',
  });
  assert.equal(v.tier, 'C');
  assert.equal(v.reasons.length, 2, 'not released AND a different primary purpose');
  assert.match(v.reasons[0], /notToBeReleasedStable/);
  assert.match(v.reasons[1], /ANALYTICAL_DIMENSION/);
  // It does claim to be a value help, and the claim is reported rather than hidden.
  assert.ok(v.signals.some((s) => s.signal === 'declares dataCategory #VALUE_HELP'));
});

test('an analytical dimension stays tier C even when it IS released', () => {
  const v = classifySource(fixture('i_plantvh.asddls'), { released: true });
  assert.equal(v.tier, 'C');
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /primary purpose/);
});

test('I_CompanyCodeVH is tier A (measured annotation block)', () => {
  const v = classifySource(`
    @ObjectModel: {
      dataCategory: #VALUE_HELP,
      representativeKey: 'CompanyCode',
      modelingPattern: #VALUE_HELP_PROVIDER,
      supportedCapabilities: [#VALUE_HELP_PROVIDER, #SEARCHABLE_ENTITY]
    }
    @Search.searchable: true
    @Consumption.ranked: true
    define view entity I_CompanyCodeVH as select from I_CompanyCode {}
  `);
  assert.equal(v.tier, 'A');
  assert.equal(v.representativeKey, 'CompanyCode');
});

test('I_UnitOfMeasureStdVH is tier B: a real value help with no provider capability', () => {
  const v = classifySource(`
    @ObjectModel.dataCategory: #VALUE_HELP
    @ObjectModel.representativeKey: 'UnitOfMeasure'
    @Search.searchable: true
    define view I_UnitOfMeasureStdVH as select from t006 {}
  `);
  assert.equal(v.tier, 'B');
  assert.equal(tierLabel(v.tier), 'plausible');
  assert.deepEqual(v.reasons, []);
  assert.ok(!v.signals.some((s) => s.signal === 'value help provider'));
});

test('dataCategory alone, with nothing else, is not enough to recommend', () => {
  const v = classifySource(`
    @ObjectModel.dataCategory: #VALUE_HELP
    define view entity I_Something as select from x {}
  `);
  assert.equal(v.tier, 'C');
  assert.match(v.reasons[0], /do not identify a value help/);
});

test('a name that merely ends in VH is tier C', () => {
  const v = classifySource('define view entity I_LooksLikeAVH as select from x {}');
  assert.equal(v.tier, 'C');
  assert.match(v.reasons[0], /nothing but the name/);
});

test('#COLLECTIVE_VALUE_HELP counts as a provider (documented, not yet observed here)', () => {
  const v = classifySource(`
    @ObjectModel.supportedCapabilities: [#COLLECTIVE_VALUE_HELP]
    define view entity I_Collective as select from x {}
  `);
  assert.equal(v.tier, 'A');
});

test('not released outranks every positive signal', () => {
  const v = classifySource(fixture('i_plantstdvh.asddls'), {
    released: false,
    releaseReason: 'the catalogue marks it deprecated',
  });
  assert.equal(v.tier, 'C');
  assert.match(v.reasons[0], /deprecated/);
  // The provider signal is still listed: the evidence is not erased by the verdict.
  assert.ok(v.signals.some((s) => s.signal === 'value help provider'));
});

// The Z profile. Measured across the 16 local help views: exactly one carries
// dataCategory: #VALUE_HELP, and Consumption.ranked / supportedCapabilities /
// modelingPattern appear zero times in the whole workspace.
test('a Z help view is accepted by the workspace convention, not the VDM one', () => {
  const zSource = `
    @AbapCatalog.viewEnhancementCategory: [#NONE]
    @AccessControl.authorizationCheck: #NOT_REQUIRED
    @EndUserText.label: 'Search help - monitor tax id'
    @Metadata.ignorePropagatedAnnotations: true
    @ObjectModel.usageType: { serviceQuality: #X, sizeCategory: #S, dataClass: #MIXED }
    @Search.searchable: true
    define view entity ZI_DemoRosterTaxIdVH as select distinct from ZI_DemoRosterMonitor {}
  `;
  const asZ = classifySource(zSource, { profile: 'z' });
  assert.equal(asZ.tier, 'B');
  assert.ok(asZ.signals.some((s) => s.signal === 'matches the workspace Z convention'));

  // The point of having two profiles: the standard profile would throw it away.
  const asStandard = classifySource(zSource, { profile: 'standard' });
  assert.equal(asStandard.tier, 'C');
});

test('a Z view with no help signal at all is still rejected, with the fix named', () => {
  const v = classifySource(
    'define view entity ZI_Whatever as select from ztbl {}',
    { profile: 'z' }
  );
  assert.equal(v.tier, 'C');
  assert.match(v.reasons[0], /ignorePropagatedAnnotations/);
});
