// From a field to the entities that could serve as its value help.
//
// Two halves: turn the field into *concepts* (what is this field about?), then turn
// concepts into *candidate names* that exist and are released in the catalogue.
//
// The signal order is measured, not intuited (docs/adt-api-reference.md):
//
//   0. the SEMANTIC type -- what the field IS, declared by the system rather than
//      named. See SEMANTIC_TYPES below.
//   1. defaultComponentName of the data element -- the canonical VDM element name, and
//      the system says it: WERKS_D -> PLANT, ZDEMO_DE_MVGR1 -> PRC_GROUP1.
//   2. the domain -- the ONLY signal that works for a Z append field, whose data
//      element is a Z name matching no standard concept while its domain is standard.
//   3. the element name in the view (Plant, CompanyCode, BaseUnit).
//   4. the data element itself, with the DDIC suffixes removed.
//
// And the naming convention deliberately does NOT close the set: of the 9 SAP entities
// used in a measured workspace's valueHelpDefinitions only 2 are *VH variants, while
// I_StorageLocationStdVH / I_SalesOrganizationStdVH / I_DistributionChannelStdVH do not
// exist at all. So both families are generated -- the VH variants and the plain
// business view -- and ranking decides. Demanding a *VH suffix would reject the correct
// answer for three of a measured workspace's own fields.

/** Suffixes a DDIC data element carries that say nothing about the concept. */
const DE_NOISE = /(_D|_ID|_KEY|_CODE|_NUM|_NR|_TXT|_TEXT|_LONG|_SHORT)$/;

/** Z data element prefixes used in a measured workspace, stripped to reach the concept. */
const Z_PREFIX = /^(ZDE|ZE|Z)_?/;

const up = (s) => String(s ?? '').toUpperCase().trim();

/** Split CamelCase into words: 'CompanyCode' -> ['COMPANY','CODE']. */
export const camelWords = (name) =>
  String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());

/**
 * The concepts a field might be about, strongest first, each carrying where it came
 * from so a recommendation can show its evidence.
 *
 * @param {{name?:string, dataElement?:string, domain?:string,
 *          defaultComponentName?:string, valueTable?:string, fixValues?:number}} field
 * @returns {{concept:string, from:string, strength:number}[]}
 */
export function conceptsFor(field = {}) {
  const out = [];
  const push = (concept, from, strength) => {
    const key = up(concept).replace(/[^A-Z0-9]/g, '');
    if (!key || key.length < 3) return;
    if (out.some((c) => c.concept === key)) return;
    out.push({ concept: key, from, strength });
  };

  const semantic = semanticConcept(field);
  if (semantic) push(semantic.concept, semantic.from, 0);

  push(field.defaultComponentName, 'defaultComponentName of the data element', 1);
  push(field.domain, 'domain of the data element', 2);
  push(field.name, 'element name in the view', 3);

  const de = up(field.dataElement);
  if (de) {
    const stripped = de.replace(DE_NOISE, '');
    if (/^Z/.test(de)) {
      // A Z data element name is never a concept: ZDEMO_DE_MVGR1 names our own object
      // and matches nothing standard. Its last segment is the borrowed standard
      // concept (MVGR1), so that is what goes in -- and it is the weakest signal,
      // below the domain, which states the same thing properly.
      const last = stripped.replace(Z_PREFIX, '').split('_').filter(Boolean).pop();
      push(last, 'last segment of the Z data element name', 5);
    } else {
      push(stripped, 'data element, DDIC suffix removed', 4);
    }
  }

  // The element name minus a trailing QUALIFIER: SalesOrganizationName ->
  // SALESORGANIZATION, the compound the VDM does not use verbatim.
  //
  // ⚠️ Only a qualifier may be dropped, and this list is deliberately short. English
  // compound nouns are head-final, so the last word is normally the HEAD and dropping
  // it names a different business object: measured live on the system, an unrestricted
  // truncation turned ProductGroup, ProductHierarchy and ProductType all into PRODUCT
  // and got `I_ProductStdVH` -- a list of products -- recommended for three fields that
  // hold no product. CODE, KEY, NUMBER and TYPE are excluded on purpose: CompanyCode
  // and ProductType are concepts in their own right, not qualified companies and
  // products.
  const words = camelWords(field.name);
  if (words.length > 1 && QUALIFIER_WORDS.has(words.at(-1))) {
    push(words.slice(0, -1).join(''), `element name minus its trailing '${words.at(-1)}'`, 6);
  }
  return out.sort((a, b) => a.strength - b.strength);
}

/**
 * What a field IS, when the system declares it rather than the name suggesting it.
 *
 * The DDIC built-in types, verbatim from the ABAP Keyword Documentation for 7.58 (=
 * this system's release, abenddic_builtin_types.md:83-85 and :74):
 *
 *   UNIT   "Unit key of a quantity field"
 *   CUKY   "Currency key for currency fields"
 *   LANG   "Language key"
 *
 * This is the strongest signal there is, and it costs nothing: `ddicElement` already
 * returns `ddicDataType` for every field, so no extra call is made. It is also the only
 * signal that survives a PROJECTION, where the field restates neither its type nor its
 * annotations -- which is the whole reason the source text cannot answer this.
 *
 * It is what finally reaches the case this tool was built for. `BaseUnit` is data
 * element MEINS, whose defaultComponentName is BASEUOM (measured -- not
 * UNIT_OF_MEASURE, which is what it looks like); nothing named BaseUnit, BASEUOM or
 * MEINS is in the catalogue, so every name-based signal misses. Its DDIC type is UNIT,
 * and UNITOFMEASURE lands on I_UnitOfMeasureStdVH, released. The two-hop active search
 * through the value table T006 still exists behind this, but it is now the fallback for
 * fields that carry no semantic type, not the first answer to a unit field.
 *
 * CLNT is deliberately absent: a client field takes no value help, and the catalogue
 * holds no entity for the concept anyway (measured: no I_Client in either file).
 */
const SEMANTIC_TYPES = new Map([
  ['UNIT', { concept: 'UNITOFMEASURE', meaning: 'unit key of a quantity field' }],
  ['CUKY', { concept: 'CURRENCY', meaning: 'currency key' }],
  ['LANG', { concept: 'LANGUAGE', meaning: 'language key' }],
]);

/**
 * The CDS annotations that say the same thing at model level, for a field whose DDIC
 * type does not (a calculated element, or a CHAR that carries the meaning by
 * annotation). API state as the system DDLA declares it (S/4HANA 2023): all four are released for Key User
 * Apps and SAP Cloud Platform (abencds_annotations_abap_tables.md:174-179).
 *
 * ⚠️ The two halves are NOT interchangeable, and reading them as one is the mistake
 * this map exists to prevent. `Semantics.unitOfMeasure` and `Semantics.currencyCode`
 * are Booleans on the key field itself -- "I am a unit key". `Semantics.quantity
 * .unitOfMeasure` and `Semantics.amount.currencyCode` are ElementRefs on the QUANTITY
 * or AMOUNT field, and their value names a DIFFERENT field, the one that holds the key.
 * Applying them to the field that carries them would offer a list of units of measure
 * for a field that holds a quantity.
 */
const SEMANTIC_SELF = new Map([
  ['SEMANTICS.UNITOFMEASURE', 'UNITOFMEASURE'],
  ['SEMANTICS.CURRENCYCODE', 'CURRENCY'],
  ['SEMANTICS.LANGUAGE', 'LANGUAGE'],
  ['SEMANTICS.ADDRESS.COUNTRY', 'COUNTRY'],
  ['SEMANTICS.TIMEZONE', 'TIMEZONE'],
]);

const SEMANTIC_REF = new Map([
  ['SEMANTICS.QUANTITY.UNITOFMEASURE', 'UNITOFMEASURE'],
  ['SEMANTICS.AMOUNT.CURRENCYCODE', 'CURRENCY'],
]);

/**
 * The semantic concept of one field: its DDIC type first, then a semantic annotation
 * already attached to it by `semanticsFromAnnotations`.
 *
 * @returns {{concept:string, from:string}|null}
 */
function semanticConcept(field = {}) {
  // The domain's datatype first, because it is the DDIC type proper. `dataType` off
  // the element tree is the same question asked of a different resource. The DOMAIN
  // side is measured (MEINS -> "UNIT", DEV, 2026-09-09); the element-tree side is NOT,
  // so it stays read as a second answer rather than being dropped. Both are read and
  // whichever answers wins. Neither answering is a false NEGATIVE: the active search
  // still runs, and nothing wrong is recommended.
  for (const [value, where] of [
    [field.ddicType, 'the domain'],
    [field.dataType, 'the element'],
  ]) {
    const type = up(value);
    const byType = SEMANTIC_TYPES.get(type);
    if (byType) {
      return {
        concept: byType.concept,
        from: `DDIC type ${type} (${where}) -- ${byType.meaning}`,
      };
    }
  }
  if (field.semantics?.concept) {
    return { concept: field.semantics.concept, from: field.semantics.from };
  }
  return null;
}

/**
 * Per-field semantic concepts from the parsed annotations of a whole entity.
 *
 * Two passes, because the ElementRef form points AWAY from itself: a quantity field's
 * `@Semantics.quantity.unitOfMeasure: 'BaseUnit'` says that *BaseUnit* is the unit key,
 * not that the quantity is. The reference is resolved case-insensitively against the
 * element names the parser found, and a reference to a field that does not exist is
 * dropped rather than invented.
 *
 * @param {Record<string, Record<string,string>>} elements `elements` of parseAnnotations
 * @returns {Map<string,{concept:string, from:string}>} keyed by the element name, as written
 */
export function semanticsFromAnnotations(elements = {}) {
  const found = new Map();
  const byLower = new Map(Object.keys(elements).map((n) => [n.toLowerCase(), n]));
  const set = (name, concept, from) => {
    if (name && !found.has(name)) found.set(name, { concept, from });
  };

  for (const [element, annos] of Object.entries(elements)) {
    for (const [key, raw] of Object.entries(annos ?? {})) {
      const k = up(key);
      const self = SEMANTIC_SELF.get(k);
      // Boolean annotations default to true when written bare (`@Semantics.language`),
      // which the annotation definitions state for every one of them.
      if (self && (raw === undefined || raw === '' || isTrueish(raw))) {
        set(element, self, `@${key} on the field itself`);
        continue;
      }
      const ref = SEMANTIC_REF.get(k);
      if (!ref) continue;
      const target = byLower.get(literalName(raw));
      if (!target) continue;
      set(target, ref, `@${key} of ${element} names this field as its key`);
    }
  }
  return found;
}

const isTrueish = (raw) => /^\s*true\s*$/i.test(String(raw ?? ''));

/** The element a `'Name'` ElementRef points at, lowercased for matching. */
const literalName = (raw) =>
  String(raw ?? '').trim().replace(/^'(.*)'$/s, '$1').trim().toLowerCase();

/** Trailing words that qualify a concept instead of naming one. */
const QUALIFIER_WORDS = new Set([
  'NAME',
  'TEXT',
  'DESCRIPTION',
  'DESC',
  'ID',
  'UUID',
  'GUID',
]);

/**
 * The name shapes measured among the released catalogue entries.
 *
 * ⚠️ The trailing `_<n>` is NOT a version number, and reading it as one leads to the
 * wrong conclusion (that `I_Product_2` supersedes `I_Product`). SAP also uses the
 * numeral to stack LAYERS of logic on one concept, because a CDS view cannot always do
 * in one entity what the model needs -- so `_2` may be a second layer that coexists
 * with the first, each with its own job. Which of the two a given name is cannot be
 * told from the name.
 *
 * What is measured, and all this code relies on: in the PCE 2023 catalogue 335 released
 * CDS_STOB names end in `_<n>` (291 `_2`, 34 `_3`), and **309 of those have no plain
 * sibling in the catalogue at all** -- so for those concepts the numeral-suffixed name
 * is the only released entity there is. `ProductGroup` is one: there is no
 * `I_ProductGroup`, only `I_ProductGroup_2`. Not generating the form loses the answer;
 * the signal check downstream still decides whether it serves as a value help.
 */
export const NAME_FORMS = [
  { form: (p, c) => `${p}_${c}STDVH`, kind: 'StdVH variant' },
  { form: (p, c) => `${p}_${c}VH`, kind: 'VH variant' },
  { form: (p, c) => `${p}_${c}_VH`, kind: 'underscore VH variant' },
  { form: (p, c) => `${p}_${c}VALUEHELP`, kind: 'ValueHelp name' },
  { form: (p, c) => `${p}_${c}`, kind: 'business view' },
  { form: (p, c) => `${p}_${c}_2`, kind: 'numeral-suffixed view' },
  { form: (p, c) => `${p}_${c}_3`, kind: 'numeral-suffixed view' },
];

const PREFIXES = ['I', 'C'];

/**
 * Candidate entities for a set of concepts, filtered against the catalogue.
 *
 * Everything the catalogue knows is returned, including the not-released ones, marked
 * with the reason -- the plan is to *show* the rejected candidate and why, never to
 * quietly drop it. Only `recommendable` entries may be recommended.
 *
 * @returns {{name:string, concept:string, from:string, kind:string, state?:string,
 *            recommendable:boolean, reason:string|null}[]}
 */
export function candidateNames(concepts, catalog, { max = 40 } = {}) {
  const seen = new Set();
  const out = [];
  for (const { concept, from, strength } of concepts) {
    for (const { form, kind } of NAME_FORMS) {
      for (const prefix of PREFIXES) {
        const name = form(prefix, concept);
        if (seen.has(name)) continue;
        seen.add(name);
        const candidate = catalogCandidate(name, catalog, {
          concept,
          from,
          strength,
          kind: `${kind} of ${concept}`,
        });
        if (!candidate) continue;
        out.push(candidate);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * One candidate, with what the catalogue says about it -- or null when the catalogue
 * has never heard of the name.
 *
 * Shared with the active search (lib/concept-search.mjs), which finds NAMES in the
 * system and has to put them through exactly the same catalogue gate as a generated
 * one. A name the system returned is not a licence to skip the release check.
 */
export function catalogCandidate(name, catalog, { concept, from, strength, kind } = {}) {
  if (!catalog?.has(name)) return null;
  const state = catalog.state(name);
  return {
    name,
    concept,
    from,
    // Carried through because the caller has to rank on it: a value help for a
    // WEAKER concept must never win just because it is more popular. See the
    // ranking in tools/value-help.mjs.
    strength,
    kind,
    state,
    recommendable: state === 'released',
    reason: catalog.stateReason(name) ?? null,
  };
}

/**
 * A field whose domain carries fixed values wants no value help at all: the DDIC
 * values already render as a dropdown, and pointing a value help at them adds a round
 * trip and a second source of truth. This is a conclusion, not a gap.
 */
export const hasFixedValues = (field = {}) => Number(field.fixValues ?? 0) > 0;
