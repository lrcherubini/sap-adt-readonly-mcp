// The two sources that say whether an annotation may be emitted.
//
// tests/fixtures/annotation-table-mini.md holds the rows COPIED VERBATIM from the ABAP
// Keyword Documentation mirror 7.58 (= S/4HANA 2023, the system release): every
// `Consumption.valueHelp*` row plus the ObjectModel/Search rows the tiering depends on.
// The DDLA half is exercised against the excerpt measured live on the system (see
// docs/adt-api-reference.md) and, for the nested forms, against text shaped like it --
// which is why those two cases say so out loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  fromDdla,
  noDefs,
  normalizeKey,
  SCP,
  KEY_USER,
} from '../lib/annotation-defs.mjs';

const mirror = fromDdla(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'annotation-defs.ddla.txt'), 'utf8'));

const VHD = 'Consumption.valueHelpDefinition[ ]';

test('the definitions parse, and a comment is not mistaken for an annotation', () => {
  assert.equal(mirror.available, true);
  assert.equal(mirror.count, 26, 'the fixture holds 26 annotations');
  assert.equal(mirror.has('Annotation'), false);
  assert.equal(mirror.has('---'), false);
  assert.equal(mirror.source, 'system DDLA');
});

test('association is refused: its API state is empty in this release', () => {
  const key = `${VHD}.association`;
  assert.deepEqual(mirror.apiStates(key), []);
  assert.equal(mirror.usableInOwnCode(key), false);
  assert.match(mirror.refusalReason(key), /not released/);
  assert.equal(mirror.def(key).type, 'AssociationRef');
});

test('selectionVariantQualifier is refused for the same reason', () => {
  const key = `${VHD}.selectionVariantQualifier`;
  assert.deepEqual(mirror.apiStates(key), []);
  assert.match(mirror.refusalReason(key), /not released/);
});

test('the singular Consumption.valueHelp is Key User only, and says which', () => {
  assert.deepEqual(mirror.apiStates('Consumption.valueHelp'), [KEY_USER]);
  assert.equal(mirror.usableInOwnCode('Consumption.valueHelp'), false);
  assert.match(mirror.refusalReason('Consumption.valueHelp'), /Key User apps only/);
});

test('the keys the tool actually emits are released for own code', () => {
  for (const key of [
    `${VHD}.entity.name`,
    `${VHD}.entity.element`,
    `${VHD}.label`,
    `${VHD}.qualifier`,
    `${VHD}.distinctValues`,
    `${VHD}.useForValidation`,
    `${VHD}.additionalBinding[ ].element`,
    `${VHD}.additionalBinding[ ].localElement`,
    `${VHD}.additionalBinding[ ].usage`,
  ]) {
    assert.equal(mirror.usableInOwnCode(key), true, key);
    assert.equal(mirror.refusalReason(key), null, key);
    assert.ok(mirror.apiStates(key).includes(SCP), key);
  }
});

test('scope is a list, and a two-word scope stays one token', () => {
  // 'Element<br>Entity<br>Parameter' is three scopes; 'Table Function' is one.
  assert.deepEqual(mirror.scopes(`${VHD}.entity.name`), ['ELEMENT', 'ENTITY', 'PARAMETER']);
  assert.deepEqual(mirror.scopes(`${VHD}.entity.element`), ['ELEMENT', 'PARAMETER']);
  assert.deepEqual(mirror.scopes('ObjectModel.dataCategory'), ['ENTITY', 'TABLE_FUNCTION']);
  assert.deepEqual(mirror.scopes('Search.searchable'), ['ENTITY']);
});

test('the closed enums come out whole', () => {
  assert.deepEqual(mirror.enums(`${VHD}.additionalBinding[ ].usage`), [
    'FILTER',
    'FILTER_AND_RESULT',
    'RESULT',
  ]);
  assert.deepEqual(mirror.enums('ObjectModel.dataCategory'), ['HIERARCHY', 'TEXT', 'VALUE_HELP']);
  // The two tiering tokens must be inside their documented enum -- if SAP ever drops
  // one, vh-signals is classifying on a token that cannot occur.
  assert.ok(mirror.enums('ObjectModel.modelingPattern').includes('VALUE_HELP_PROVIDER'));
  assert.ok(mirror.enums('ObjectModel.modelingPattern').includes('COLLECTIVE_VALUE_HELP'));
  assert.ok(mirror.enums('ObjectModel.supportedCapabilities[ ]').includes('VALUE_HELP_PROVIDER'));
  assert.ok(mirror.enums('ObjectModel.supportedCapabilities[ ]').includes('SEARCHABLE_ENTITY'));
});

test('array markers and case do not change which annotation is meant', () => {
  assert.equal(
    normalizeKey('Consumption.valueHelpDefinition[ ].entity.name'),
    'consumption.valuehelpdefinition.entity.name'
  );
  assert.equal(
    normalizeKey('Consumption.valueHelpDefinition[0].entity.name'),
    normalizeKey('consumption.valueHelpDefinition.Entity.Name')
  );
  assert.equal(mirror.has('Consumption.valueHelpDefinition[0].entity.name'), true);
});

test('an unknown key is unknown, never "refused" and never "allowed"', () => {
  // The distinction the caller depends on: undefined means "I could not check this",
  // which must surface as a warning, not as a verdict.
  assert.equal(mirror.refusalReason('Consumption.madeUpThing'), undefined);
  assert.equal(mirror.usableInOwnCode('Consumption.madeUpThing'), false);
  assert.equal(mirror.has('Consumption.madeUpThing'), false);
});

test('absent definitions answer nothing and carry the reason', () => {
  const none = fromDdla('');
  assert.equal(none.available, false);
  assert.equal(none.count, 0);
  assert.equal(none.refusalReason(`${VHD}.entity.name`), undefined);

  const declared = noDefs('the system DDLA could not be read');
  assert.equal(declared.available, false);
  assert.match(declared.note, /could not be read/);
});

// --- the system's DDLA -------------------------------------------------------------

// Measured verbatim on the system (docs/adt-api-reference.md): the first lines of the
// 182,092-character reply of annotationDefinitions().
const DDLA_MEASURED = `@Scope:[#VIEW, #TABLE_FUNCTION, #HIERARCHY]
annotation AccessControl {
  @API.state: [#RELEASED_FOR_KEY_USER_APPS, #RELEASED_FOR_SAP_CLOUD_PLATFORM]
  authorizationCheck : String(20) enum { NOT_REQUIRED; NOT_ALLOWED; MANDATORY; CHECK; PRIVILEGED_ONLY; } default #NOT_REQUIRED;
}`;

test('the DDLA excerpt measured on the system parses with scope, state, enum and default', () => {
  const defs = fromDdla(DDLA_MEASURED);
  const d = defs.def('AccessControl.authorizationCheck');
  assert.ok(d, 'the leaf is reached');
  assert.deepEqual(d.scopes, ['VIEW', 'TABLE_FUNCTION', 'HIERARCHY'], 'inherited from the block');
  assert.deepEqual(d.apiStates, [KEY_USER, SCP]);
  assert.equal(defs.usableInOwnCode('AccessControl.authorizationCheck'), true);
  assert.equal(d.type, 'String(20)');
  assert.deepEqual(d.enums, ['NOT_REQUIRED', 'NOT_ALLOWED', 'MANDATORY', 'CHECK', 'PRIVILEGED_ONLY']);
  assert.equal(d.default, 'NOT_REQUIRED');
  assert.match(d.from, /annotationDefinitions/);
});

test('nested groups and arrays flatten to the same dotted keys as the documentation', () => {
  // NOT measured: only the top of the DDLA was read live, so this text is SHAPED like
  // the measured excerpt with the nesting the documented annotation names imply. If the
  // real DDLA nests differently, the key is unknown and the emission says NOT VALIDATED -- which
  // is exactly why that fallback is per key and not per source.
  const defs = fromDdla(`
    @Scope:[#ELEMENT, #PARAMETER]
    annotation Consumption {
      @API.state: [#RELEASED_FOR_KEY_USER_APPS, #RELEASED_FOR_SAP_CLOUD_PLATFORM]
      valueHelpDefinition : array of {
        entity : {
          @Scope:[#ELEMENT, #ENTITY, #PARAMETER]
          name : EntityRef;
          element : String(40);
        };
        additionalBinding : array of {
          usage : String(30) enum { FILTER; FILTER_AND_RESULT; RESULT; };
        };
        @API.state: []
        association : AssociationRef;
      };
      valueHelp : ElementRef;
    }
  `);
  assert.equal(defs.has('Consumption.valueHelpDefinition[ ].entity.name'), true);
  assert.deepEqual(defs.scopes(`${VHD}.entity.name`), ['ELEMENT', 'ENTITY', 'PARAMETER']);
  assert.deepEqual(defs.scopes(`${VHD}.entity.element`), ['ELEMENT', 'PARAMETER'], 'inherited');
  assert.deepEqual(defs.enums(`${VHD}.additionalBinding[ ].usage`), [
    'FILTER',
    'FILTER_AND_RESULT',
    'RESULT',
  ]);
  assert.equal(defs.usableInOwnCode(`${VHD}.entity.element`), true);
  // An empty @API.state on the member overrides the released block above it.
  assert.deepEqual(defs.apiStates(`${VHD}.association`), []);
  assert.match(defs.refusalReason(`${VHD}.association`), /not released/);
  // The enum body of a leaf must not be read as a group: no phantom key below it.
  assert.equal(defs.has(`${VHD}.additionalBinding[ ].usage.FILTER`), false);
});

test('unparseable DDLA yields nothing and terminates', () => {
  // The parser advances on every branch; a reply that is not DDLA at all (an ADT error
  // page, say) must come back empty instead of hanging.
  for (const junk of ['', '<html>500</html>', '@@@ {{{ ;;;', 'annotation', 'annotation X {']) {
    const defs = fromDdla(junk);
    assert.equal(defs.available, false, JSON.stringify(junk));
  }
});


// --- the scalar annotation form, measured --------------------------------
//
// `npm run measure:ddla` compared the roots the DDLA text declares against the roots
// fromDdla() returned: 31 declared, 27 parsed. The four missing ones -- DefaultAggregation,
// Feature, MappingRole, Scope -- are all declared WITHOUT a `{}` body, and the top-level
// loop used to `continue` on anything that was not followed by a brace, dropping the root
// and its @Scope/@API.state with it. Consequence: defs.has('Feature') answered false about
// an annotation this system defines, and adt_value_help would have refused it as "not a
// known annotation". Every excerpt below is copied VERBATIM from the measured DDLA, with
// the line it came from, because the whole point is that these shapes were not guessed.
const DDLA_SCALARS = `@Scope:[#ENTITY, #ELEMENT ]
define annotation Feature : String(1024);

@API.state: [#RELEASED_FOR_KEY_USER_APPS, #RELEASED_FOR_SAP_CLOUD_PLATFORM]
annotation MappingRole
 : Boolean default true
 ;

@Scope:[#ELEMENT]
@API.state: [#RELEASED_FOR_SAP_CLOUD_PLATFORM , #RELEASED_FOR_KEY_USER_APPS ]
annotation DefaultAggregation : String(30) enum { NONE; SUM; MIN; MAX; AVG; COUNT; COUNT_DISTINCT; FORMULA; };`;

test('an annotation declared with no braces is a root, not something to skip', () => {
  const defs = fromDdla(DDLA_SCALARS);

  // line 2098 of the measured DDLA -- `define annotation`, terminated on the same line.
  assert.equal(defs.has('Feature'), true, 'Feature is defined by this system');
  assert.equal(defs.def('Feature').type, 'String(1024)');
  assert.deepEqual(defs.scopes('Feature'), ['ENTITY', 'ELEMENT']);

  // line 2191 -- no `define`, and the `:` is on the NEXT line, so the form is only
  // recognised after trivia is skipped.
  assert.equal(defs.has('MappingRole'), true);
  assert.equal(defs.def('MappingRole').type, 'Boolean');
  assert.equal(defs.def('MappingRole').default, 'true');
  assert.deepEqual(defs.apiStates('MappingRole'), [KEY_USER, SCP]);
  assert.equal(defs.usableInOwnCode('MappingRole'), true);

  // line 1199 -- scalar AND enumerated, which is why the enum is read off the declaration
  // rather than off a body.
  assert.deepEqual(defs.enums('DefaultAggregation'), [
    'NONE',
    'SUM',
    'MIN',
    'MAX',
    'AVG',
    'COUNT',
    'COUNT_DISTINCT',
    'FORMULA',
  ]);
});

test('an enum comment is prose, not a permitted value', () => {
  // Measured at line 3222: `annotation Scope : array of String(20) enum { ... }` where
  // every member carries a `//` comment. Tokenising the body without stripping those
  // would register `in`, `front`, `of`, `DEFINE` as valid values -- and a validator that
  // accepts more than the system does is worse than none, because it stays silent.
  const defs = fromDdla(`// defines the scope in which the annotated annotation is valid
@Scope: [#ANNOTATION]
annotation Scope : array of String(20)
  enum {
    ENTITY;               // in front of DEFINE for all entity types
    VIEW;                 // in front of DEFINE VIEW
    ENUM_VALUE;           // in front enum value within ENUM keyword
  };`);
  assert.deepEqual(defs.enums('Scope'), ['ENTITY', 'VIEW', 'ENUM_VALUE']);
  assert.deepEqual(defs.scopes('Scope'), ['ANNOTATION']);
  // `array of` belongs to the declaration; the key stays plain, and normalizeKey folds
  // the array marker away exactly as it does for valueHelpDefinition[ ].
  assert.deepEqual(defs.keys().filter((k) => k.startsWith('scope')), ['scope']);
  assert.equal(defs.has('Scope[ ]'), true, 'same annotation, written with the marker');
});
