// Is this entity actually a value help?
//
// No single annotation answers that, and this module exists to stop anyone believing
// one does. Measured on four SAP views (docs/adt-api-reference.md and the fixtures):
//
//   I_CompanyCodeVH      dataCategory #VALUE_HELP + supportedCapabilities
//                        [#VALUE_HELP_PROVIDER, #SEARCHABLE_ENTITY]      released
//   I_PlantStdVH         dataCategory #VALUE_HELP + [#VALUE_HELP_PROVIDER]  released
//   I_UnitOfMeasureStdVH dataCategory #VALUE_HELP, no capabilities at all   released
//   I_PlantVH            dataCategory #VALUE_HELP + modelingPattern
//                        #ANALYTICAL_DIMENSION                          NOT released
//
// So `dataCategory: #VALUE_HELP` alone is a FALSE POSITIVE -- I_PlantVH carries it and
// is an analytical dimension -- while `#VALUE_HELP_PROVIDER` is missing from a
// legitimate released value help. Nothing here is necessary and sufficient, so the
// verdict is tiered and always carries its evidence.
//
// The annotation *syntax* is documented (ABAP Keyword Documentation 7.58,
// abencds_annotations_frmwrk_tables.md: ObjectModel.dataCategory is String(30) enum
// #HIERARCHY|#TEXT|#VALUE_HELP, released for Key User and SCP). The *semantics* -- that
// this marks a value help -- is NOT documented there: the phrase "value help view" appears zero
// times in its 6,088 pages, and SAP delegates the meaning to another document. So the rule below
// is observational, and says so.

import { enumTokens, isTrue, literal } from './annotations.mjs';

/** Capability tokens that mean "this is meant to serve F4". */
const VH_CAPABILITIES = new Set(['VALUE_HELP_PROVIDER', 'COLLECTIVE_VALUE_HELP']);

/**
 * Tokens that name a different primary purpose, derived from the documented CLOSED enum
 * of `ObjectModel.modelingPattern` (ABAP Keyword Documentation 7.58, abencds_annotations_frmwrk_tables)
 * minus the three that do not name another purpose: the two value-help patterns and
 * `#NONE`. Taking the whole enum rather than a hand-picked list is deliberate -- a
 * hand-picked list silently accepts every pattern nobody thought of, and my first draft
 * of it contained two tokens (`HIERARCHY_NODE`, `ANALYTICAL_CUBE` as a capability) that
 * are not in the enum at all.
 *
 * Applied to `modelingPattern` only: being an association target or a SQL data source
 * (`supportedCapabilities`) is not exclusive with serving F4, while a modelling pattern
 * declares what the entity IS.
 */
const MODELING_PATTERNS = [
  'ANALYTICAL_CUBE',
  'ANALYTICAL_DIMENSION',
  'ANALYTICAL_FACT',
  'ANALYTICAL_KPI',
  'ANALYTICAL_PARENT_CHILD_HIERARCHY_NODE',
  'ANALYTICAL_QUERY',
  'COLLECTIVE_VALUE_HELP',
  'DATA_STRUCTURE',
  'DERIVATION_FUNCTION',
  'ENTERPRISE_SEARCH_PROVIDER',
  'LANGUAGE_DEPENDENT_TEXT',
  'NONE',
  'OUTPUT_EMAIL_DATA_PROVIDER',
  'OUTPUT_FORM_DATA_PROVIDER',
  'OUTPUT_PARAMETER_DETERMINATION_DATA_SOURCE',
  'PARENT_CHILD_HIERARCHY_NODE_PROVIDER',
  'SITUATION_ANCHOR',
  'SITUATION_DATACONTEXT',
  'SITUATION_TRIGGER',
  'TRANSACTIONAL_ENTITY',
  'TRANSACTIONAL_INTERFACE',
  'TRANSACTIONAL_PROJECTED_ENTITY',
  'TRANSACTIONAL_QUERY',
  'VALUE_HELP_PROVIDER',
];

const OTHER_PURPOSE = new Set(
  MODELING_PATTERNS.filter((p) => !VH_CAPABILITIES.has(p) && p !== 'NONE')
);

/**
 * Classify one entity from its entity-level annotations.
 *
 * @param {Record<string,string>} entity flattened annotations, from parseAnnotations
 * @param {{profile?: 'standard'|'z', released?: boolean, releaseReason?: string|null,
 *          name?: string}} ctx
 * @returns {{tier:'A'|'B'|'C', signals:{signal:string,evidence:string}[],
 *            reasons:string[], representativeKey?:string, provenance:string}}
 */
export function classifyVhSignals(entity = {}, ctx = {}) {
  const profile = ctx.profile ?? 'standard';
  const signals = [];
  const reasons = [];
  const add = (signal, evidence) => signals.push({ signal, evidence });

  const capabilities = [
    ...enumTokens(entity['ObjectModel.supportedCapabilities']),
    ...enumTokens(entity['ObjectModel.modelingPattern']),
  ];
  const pattern = enumTokens(entity['ObjectModel.modelingPattern']);
  const isVhProvider = capabilities.some((c) => VH_CAPABILITIES.has(c));
  const otherPurpose = pattern.filter((c) => OTHER_PURPOSE.has(c));
  const claimsVh = enumTokens(entity['ObjectModel.dataCategory']).includes('VALUE_HELP');
  const searchable = isTrue(entity['Search.searchable']);
  const ranked = isTrue(entity['Consumption.ranked']);
  const repKey = literal(entity['ObjectModel.representativeKey']);
  const ignoresPropagated = isTrue(entity['Metadata.ignorePropagatedAnnotations']);
  const usageType = Object.keys(entity).some((k) => k.startsWith('ObjectModel.usageType'));

  if (isVhProvider) {
    add(
      'value help provider',
      `capabilities ${capabilities.filter((c) => VH_CAPABILITIES.has(c)).join(', ')}`
    );
  }
  if (claimsVh) add('declares dataCategory #VALUE_HELP', 'ObjectModel.dataCategory');
  if (searchable) add('searchable', 'Search.searchable: true');
  if (ranked) add('ranked', 'Consumption.ranked: true');
  if (repKey) add('representative key', `ObjectModel.representativeKey: '${repKey}'`);
  if (ignoresPropagated) {
    add('ignores propagated annotations', 'Metadata.ignorePropagatedAnnotations: true');
  }
  if (usageType) add('declares a usage type', 'ObjectModel.usageType');

  // A released gate before anything else: a non-released entity is never a
  // recommendation, however convincing its annotations are.
  if (ctx.released === false) {
    reasons.push(ctx.releaseReason ?? 'it is not released in the Clean Core catalogue');
  }
  if (otherPurpose.length) {
    reasons.push(
      `its primary purpose is declared as ${otherPurpose.join(', ')} ` +
        '(ObjectModel.modelingPattern), not a value help'
    );
  }

  const provenance =
    'the annotation syntax is documented (ABAP Keyword Documentation 7.58); the rule ' +
    'that these annotations identify a value help is observational -- SAP documents no ' +
    'semantics for ObjectModel.dataCategory';

  let tier;
  if (reasons.length) {
    tier = 'C';
  } else if (profile === 'z') {
    // The workspace's own value helps do not follow the VDM convention: of 16 local
    // help views exactly one carries dataCategory: #VALUE_HELP, and none carries
    // supportedCapabilities or Consumption.ranked. What they do carry is
    // ignorePropagatedAnnotations + Search.searchable + usageType. Judging them by the
    // standard profile would reject 15 of the 16 that work.
    if (ignoresPropagated && searchable) {
      tier = 'B';
      signals.push({
        signal: 'matches the workspace Z convention',
        evidence: 'ignorePropagatedAnnotations + Search.searchable',
      });
    } else if (isVhProvider || claimsVh) {
      tier = 'B';
    } else {
      tier = 'C';
      reasons.push(
        'no value-help signal at all: a Z help view is expected to carry ' +
          '@Metadata.ignorePropagatedAnnotations: true and @Search.searchable: true'
      );
    }
  } else if (isVhProvider) {
    tier = 'A';
  } else if (claimsVh && (searchable || repKey)) {
    // I_UnitOfMeasureStdVH lands here: a legitimate released value help with no
    // #VALUE_HELP_PROVIDER anywhere. Offered, marked plausible, never hidden.
    tier = 'B';
  } else {
    tier = 'C';
    reasons.push(
      signals.length
        ? 'the signals present do not identify a value help; nothing declares it serves F4'
        : 'nothing but the name suggests a value help'
    );
  }

  return { tier, signals, reasons, representativeKey: repKey, provenance };
}

/** Short one-line verdict, for a table row. */
export const tierLabel = (tier) =>
  ({ A: 'recommended', B: 'plausible', C: 'rejected' })[tier] ?? tier;
