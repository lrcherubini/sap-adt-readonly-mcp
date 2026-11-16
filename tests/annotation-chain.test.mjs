// The annotation chain, parsed.
//
// `tests/fixtures/annotation-chain-measured.xml` is the reply the system actually gave on
// 2026-09-09 for ZC_DemoInvMapTP/BaseUnit, reproduced byte for byte (9,137 bytes, the
// length the live call reported). Everything asserted against it is a measured fact.
//
// The conflict fixture below is SYNTHETIC and says so -- it was written before any real
// override had been seen. One has been seen since: ZC_DemoRosterMonitor/Stcd2 returns 37
// contributions from 5 sources with two keys written more than once, including a
// `UI.HIDDEN` that ZI_DEMOROSTERSTATUS writes as `true` and that NOTHING activates. The
// synthetic fixture reproduces exactly those two shapes -- an override with a winner, and
// a key with no active contribution -- so it stays; but the observed payload is the
// evidence, and it is recorded in docs/adt-api-reference.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAnnotationChain, hiddenWithUiRole } from '../lib/annotation-chain.mjs';

const MEASURED = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'annotation-chain-measured.xml'),
  'utf8'
);

test('the measured payload parses into 7 annotations from 2 sources', () => {
  const p = parseAnnotationChain(MEASURED);
  assert.equal(p.entity, 'ZC_DemoInvMapTP');
  assert.equal(p.element, 'BaseUnit');
  assert.deepEqual(p.counts, {
    contributions: 7,
    annotations: 7,
    conflicts: 0,
    silenced: 0,
    sources: 2,
  });
});

test('the property set differs by source kind, and the parser does not assume LAYER', () => {
  const p = parseAnnotationChain(MEASURED);
  const ext = p.annotations.find((a) => a.path === 'ui.lineitem[1].position');
  const own = p.annotations.find((a) => a.path === 'consumption.valuehelpdefinition[1].entity.name');

  // A metadata extension carries the layer...
  assert.equal(ext.from.type, 'DDLX/EX');
  assert.equal(ext.from.layer, '5500', 'the kernel pads it to "5500 "; it must be trimmed');
  assert.equal(ext.from.layerName, 'CUSTOMER');

  // ...and the view's own source carries none. `undefined` here means "written in the
  // view itself", which is a fact, not a missing field.
  assert.equal(own.from.type, 'DDLS/DF');
  assert.equal(own.from.layer, undefined);
  assert.equal(own.from.layerName, undefined);
  assert.equal(own.contributions, 1);
});

test('the value keeps its ABAP quoting, because that is what distinguishes the type', () => {
  const p = parseAnnotationChain(MEASURED);
  const by = (path) => p.annotations.find((a) => a.path === path).value;
  assert.equal(by('consumption.valuehelpdefinition[1].entity.name'), "'I_UnitOfMeasureStdVH'");
  assert.equal(by('ui.lineitem[1].importance'), '#LOW', 'an enum has no quotes');
  assert.equal(by('ui.lineitem[1].position'), '60', 'a number has none either');
});

test('a translated value is carried separately from the literal in the source', () => {
  const p = parseAnnotationChain(MEASURED);
  const label = p.contributions.find((c) => c.path === 'ui.fieldgroup[1].label');
  assert.equal(label.value, "'Unit'");
  assert.deepEqual(label.translated, {
    value: 'Unit',
    language: 'English',
    languageKey: 'E',
  });
  // Everything else on this element is untranslated, and that is absence, not an empty
  // string pretending to be a translation.
  assert.equal(
    p.contributions.find((c) => c.path === 'ui.lineitem[1].position').translated,
    undefined
  );
});

test('the chain corroborates the value-help binding the offline tool reported', () => {
  // adt_value_help said BaseUnit is "already covered", bound to I_UnitOfMeasureStdVH, by
  // reading the checkout. This is the same fact read out of the running system, through a
  // completely different route -- which is what makes it a cross-check and not an echo.
  const p = parseAnnotationChain(MEASURED);
  const vh = p.annotations.find((a) => a.path === 'consumption.valuehelpdefinition[1].entity.name');
  assert.equal(vh.value, "'I_UnitOfMeasureStdVH'");
  assert.equal(vh.from.name, 'ZC_DEMOINVMAPTP');
});

// --- overriding: SYNTHETIC, see the header -----------------------------------

/** The measured shape, with a second source writing a key the first one also writes. */
function withOverride() {
  const extra =
    '<abapsource:elementInfo adtcore:type="ANNO" adtcore:name="UI.LINEITEM$1$.POSITION" ' +
    'xmlns:adtcore="http://www.sap.com/adt/core"><abapsource:properties>' +
    '<abapsource:entry abapsource:key="SOURCE_NAME">ZE_SOME_EXTENSION</abapsource:entry>' +
    '<abapsource:entry abapsource:key="SOURCE_TYPE">DDLX/EX</abapsource:entry>' +
    '<abapsource:entry abapsource:key="LAYER">4000 </abapsource:entry>' +
    '<abapsource:entry abapsource:key="LAYER_NAME">PARTNER</abapsource:entry>' +
    '<abapsource:entry abapsource:key="ANNOTATION_VALUE">10</abapsource:entry>' +
    '<abapsource:entry abapsource:key="IS_ACTIVE"/>' +
    '</abapsource:properties></abapsource:elementInfo>';
  return MEASURED.replace(/<\/abapsource:elementInfo>$/, `${extra}</abapsource:elementInfo>`);
}

test('two sources on one key is reported as a conflict, and IS_ACTIVE picks the winner', () => {
  const p = parseAnnotationChain(withOverride());
  assert.equal(p.counts.conflicts, 1);
  const c = p.conflicts[0];
  assert.equal(c.path, 'ui.lineitem[1].position');
  // The winner comes from the kernel's IS_ACTIVE, NOT from comparing layer numbers -- a
  // switched-off contribution can sit on the higher layer and still lose.
  assert.equal(c.winner.name, 'ZC_DEMOINVMAPTP');
  assert.equal(c.winner.value, '60');
  assert.deepEqual(
    c.overridden.map((o) => [o.name, o.value, o.layerName]),
    [['ZE_SOME_EXTENSION', '10', 'PARTNER']]
  );
  // The annotation itself still reports the value that actually reaches the app.
  assert.equal(p.annotations.find((a) => a.path === c.path).value, '60');
});

test('a key with no active contribution at all is flagged silenced, not absent', () => {
  const dead = MEASURED.replace(
    '<abapsource:entry abapsource:key="IS_ACTIVE">X</abapsource:entry></abapsource:properties></abapsource:elementInfo><abapsource:elementInfo adtcore:type="ANNO" adtcore:name="UI.FIELDGROUP$1$.POSITION"',
    '<abapsource:entry abapsource:key="IS_ACTIVE"/></abapsource:properties></abapsource:elementInfo><abapsource:elementInfo adtcore:type="ANNO" adtcore:name="UI.FIELDGROUP$1$.POSITION"'
  );
  const p = parseAnnotationChain(dead);
  assert.equal(p.counts.silenced, 1);
  const a = p.annotations.find((x) => x.silenced);
  assert.equal(a.path, 'ui.fieldgroup[1].label');
  assert.equal(a.value, undefined, 'nothing reaches the app');
  assert.equal(a.from, undefined);
  // It still appears in conflicts, because "in the chain but reaching nothing" is exactly
  // the thing somebody is looking for when a label went missing.
  assert.ok(p.conflicts.some((c) => c.path === 'ui.fieldgroup[1].label' && c.winner === null));
});

// --- degenerate input ---------------------------------------------------------

test('an empty or unrecognised document parses to nothing rather than throwing', () => {
  for (const input of ['', null, undefined, '<html>not adt at all</html>']) {
    const p = parseAnnotationChain(input);
    assert.equal(p.counts.contributions, 0);
    assert.equal(p.entity, undefined);
    assert.deepEqual(p.annotations, []);
  }
});

// --- hidden AND given a display role: MEASURED, twice ---------------------------
//
// annotation-chain-hidden-role.xml is ZC_DemoShelfStock/Plant as measured.
// Unlike annotation-chain-measured.xml it is NOT byte-exact -- only the parsed answer was
// captured, so the XML is rebuilt from the measured facts (every key, value, source,
// layer and uri verbatim) in the structure of the byte-exact fixture. It reproduces the
// live parse exactly: 6 contributions, 2 sources, 0 conflicts.
//
// Zero conflicts is the whole point. `ui.hidden` and `ui.lineitem[1].position` are
// DIFFERENT keys, so nothing contests anything and a same-key check sees a clean chain
// while the field is missing from the app.

const HIDDEN_ROLE = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'annotation-chain-hidden-role.xml'),
  'utf8'
);

test('the measured hidden-with-role payload parses with ZERO conflicts', () => {
  const p = parseAnnotationChain(HIDDEN_ROLE);
  assert.equal(p.entity, 'ZC_DemoShelfStock');
  assert.equal(p.element, 'Plant');
  assert.deepEqual(p.counts, {
    contributions: 6, annotations: 6, conflicts: 0, silenced: 0, sources: 2,
  });
});

test('the contradiction is detected and both sides are named', () => {
  const [h] = hiddenWithUiRole(parseAnnotationChain(HIDDEN_ROLE));
  assert.equal(h.hiddenBy.name, 'ZI_DEMOSTORAGELOCATION');
  assert.equal(h.hiddenBy.type, 'DDLX/EX');
  assert.deepEqual(h.roles, ['ui.fieldgroup[1]', 'ui.lineitem[1]', 'ui.selectionfield[1]']);
  assert.deepEqual(h.roleSources.map((s) => s.name), ['ZC_DEMOSHELFSTOCK']);
});

test('@Consumption.hidden hides just as hard, and the finding says which one did it', () => {
  // "Hidden" is not one annotation. @Consumption.hidden takes the element out of the
  // exposed service, so a field with a display role disappears exactly the same way --
  // and the two have different remedies, which is why the finding carries `hiddenKey`.
  // Measured on real checkouts: the few occurrences of @Consumption.hidden were all on
  // associations, none with a UI role. None of them is this shape.
  const p = parseAnnotationChain(HIDDEN_ROLE.replace('UI.HIDDEN', 'CONSUMPTION.HIDDEN'));
  assert.equal(
    p.annotations.find((a) => a.path === 'consumption.hidden')?.value,
    'true',
    'the fixture edit must actually produce a consumption hide'
  );
  const [h] = hiddenWithUiRole(p);
  assert.equal(h.hiddenKey, 'consumption.hidden');
  assert.deepEqual(h.roles, ['ui.fieldgroup[1]', 'ui.lineitem[1]', 'ui.selectionfield[1]']);

  // And the UI one still names itself, so the backlog never has to guess.
  assert.equal(hiddenWithUiRole(parseAnnotationChain(HIDDEN_ROLE))[0].hiddenKey, 'ui.hidden');
});

test('a hide with no display role is legitimate, whichever annotation hides it', () => {
  // The measured ZA_Product shape. Generalising the hider must not invent a finding: the
  // falsifiable gate is that `npm run scan:annotations` stays at 9 ARMED / 15 HELD.
  const noRole = HIDDEN_ROLE.replace('UI.HIDDEN', 'CONSUMPTION.HIDDEN')
    .replace(/UI\.LINEITEM\$1\$\.\w+/g, 'CONSUMPTION.SEMANTICOBJECT')
    .replace(/UI\.FIELDGROUP\$1\$\.\w+/g, 'CONSUMPTION.SEMANTICOBJECT')
    .replace(/UI\.SELECTIONFIELD\$1\$\.\w+/g, 'CONSUMPTION.SEMANTICOBJECT');
  const p = parseAnnotationChain(noRole);
  assert.equal(p.annotations.some((a) => /^ui\./.test(a.path)), false, 'no UI role is left');
  assert.deepEqual(hiddenWithUiRole(p), []);
});

test('an element with roles and no hidden is not a contradiction', () => {
  // The byte-exact fixture: BaseUnit carries lineItem and fieldGroup, no ui.hidden.
  assert.deepEqual(hiddenWithUiRole(parseAnnotationChain(MEASURED)), []);
});

test('@UI.hidden bound to a field is deliberate design, not a contradiction', () => {
  // `@UI.hidden: 'SomeFlag'` makes visibility conditional. Only a literal `true` is an
  // unconditional hide, and only that is reported.
  const p = parseAnnotationChain(HIDDEN_ROLE.replace('>true<', ">'IsHiddenFlag'<"));
  assert.equal(p.annotations.find((a) => a.path === 'ui.hidden').value, "'IsHiddenFlag'");
  assert.deepEqual(hiddenWithUiRole(p), []);
});

test('a #FOR_ACTION entry is a button on the element, not the field, and is ignored', () => {
  // Observed on ZC_DemoEmployee/Stcd2: ui.lineitem[2] is an action. Hiding the element
  // does not contradict a button declared on it, so a chain whose ONLY role is an action
  // must not be reported.
  const actionOnly = HIDDEN_ROLE
    .replace('UI.FIELDGROUP$1$.POSITION', 'UI.LINEITEM$2$.LABEL')
    .replace('UI.FIELDGROUP$1$.QUALIFIER', 'UI.LINEITEM$2$.TYPE')
    .replace('>&#39;DadosGerais&#39;<', '>#FOR_ACTION<')
    .replace(">'DadosGerais'<", '>#FOR_ACTION<')
    .replace('UI.LINEITEM$1$.IMPORTANCE', 'UI.LINEITEM$2$.DATAACTION')
    .replace('UI.LINEITEM$1$.POSITION', 'UI.LINEITEM$2$.POSITION')
    .replace('UI.SELECTIONFIELD$1$.POSITION', 'UI.LINEITEM$2$.CRITICALITY');
  const p = parseAnnotationChain(actionOnly);
  assert.equal(
    p.annotations.find((a) => a.path === 'ui.lineitem[2].type')?.value,
    '#FOR_ACTION',
    'the fixture edit must actually produce an action group'
  );
  assert.deepEqual(hiddenWithUiRole(p), []);
});

test('a hidden that nothing activates is held, not a contradiction', () => {
  // The ZC_DemoRosterMonitor/Stcd2 shape: the hide is in the chain but inactive, because
  // @Metadata.ignorePropagatedAnnotations neutralises it. The field DOES render, so this
  // is not the same defect -- it is the live trap, already reported as `silenced`.
  const held = HIDDEN_ROLE.replace(
    '<abapsource:entry abapsource:key="ANNOTATION_VALUE">true</abapsource:entry>' +
      '<abapsource:entry abapsource:key="IS_ACTIVE">X</abapsource:entry>',
    '<abapsource:entry abapsource:key="ANNOTATION_VALUE">true</abapsource:entry>' +
      '<abapsource:entry abapsource:key="IS_ACTIVE"/>'
  );
  const p = parseAnnotationChain(held);
  assert.equal(p.counts.silenced, 1, 'the hide is in the chain and reaches nothing');
  assert.deepEqual(hiddenWithUiRole(p), []);
});
