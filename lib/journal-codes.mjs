// The closed registry of journal codes.
//
// Why a registry and not free-form strings. Every module in this server already
// declares its own degradation, but it declares it in PROSE -- "enhancements NOT read",
// "inconclusive, not a defect", "no candidate". Prose is unusable a month later: it
// cannot be counted, ranked, or deduplicated, so the same limitation is rediscovered
// instead of being fixed. A closed set of codes is what turns that discipline into
// something measurable, and the closure is the point: `journal()` refuses a code that
// is not here, so a new code is a deliberate act with a severity and a meaning.
//
// Two families, and the split matters more than it looks:
//
//   FINDING -- a defect in the WORKSPACE. Someone has to change an ABAP, CPI or Fiori
//              repository. This stream is a backlog.
//   GAP     -- a limit of THIS SERVER. Something could not be answered, or was answered
//              with less evidence than the design wants. This stream is the server's own
//              improvement backlog, ranked by how often each limit actually bites.
//
// A gap is never reported as a finding. Confusing them would let "I could not check"
// masquerade as "there is nothing wrong", which is the one inference this whole
// repository exists to refuse.

/** high: breaks or silently wrongs something. medium: real defect, contained. low: hygiene. */
export const FINDING_CODES = new Map([
  // The four Clean Core levels, mapped exactly as lib/clean-core.mjs maps them. Two
  // entries are counter-intuitive and both used to be wrong here: `deprecated` is still Level A, and absent-from-both is C, not D.
  [
    'CC_LEVEL_C',
    {
      severity: 'high',
      meaning:
        'a Z view consumes a Level C object -- notToBeReleased, notToBeReleasedStable, ' +
        'internalAPI, or absent from BOTH catalogues (internal unclassified). Needs ' +
        'architect approval and reassessment in 12 months; the basis is in the context',
    },
  ],
  [
    'CC_LEVEL_D',
    {
      severity: 'high',
      meaning:
        'a Z view consumes a noAPI object: no contract of any kind, forbidden -- the ' +
        'Exception Form is required BEFORE coding, with remediation in 6 months',
    },
  ],
  [
    'CC_LEVEL_B',
    {
      severity: 'medium',
      meaning:
        'a Z view consumes a classicAPI: a stable classic API, an acceptable bridge in ' +
        'Standard ABAP, but never a Level A answer',
    },
  ],
  [
    'CC_DEPRECATED',
    {
      severity: 'low',
      meaning:
        'the consumed object is deprecated but STILL RELEASED (Level A): the ATC reports ' +
        'Info, not an error (SAP Note 3638292). Plan the migration, do not count it as debt',
    },
  ],
  [
    'SRVD_EXPOSURE_MISSING',
    {
      severity: 'high',
      meaning:
        'an entity bound as a value help is not exposed in the service definition: the F4 ' +
        'comes up empty with no activation error and no /IWFND/ERROR_LOG entry',
    },
  ],
  [
    'ALIAS_DRIFT',
    {
      severity: 'medium',
      meaning:
        'the same CDS entity is exposed under different aliases in different services, so a ' +
        'consumer written against one breaks against the other',
    },
  ],
  [
    'ANNOTATION_OVERRIDDEN',
    {
      severity: 'medium',
      meaning:
        'more than one source wrote the same annotation key on one element, so the value the ' +
        'app receives is not the one in the source in front of you -- or, when nothing is ' +
        'active, the annotation reaches nothing at all and the field disappears with no error',
    },
  ],
  [
    'ANNOTATION_HIDDEN_WITH_ROLE',
    {
      severity: 'high',
      meaning:
        'one layer of the chain gives the element a display role (lineItem/selectionField/' +
        'fieldGroup/identification/dataPoint) while another layer sets @UI.hidden: true, both ' +
        'active -- the field is gone from the app and nothing contests anything, so this is ' +
        'invisible to a same-key conflict check and to reading either source on its own',
    },
  ],
  [
    'ANNOTATION_HIDDEN_HELD',
    {
      severity: 'medium',
      meaning:
        'the same contradiction as ANNOTATION_HIDDEN_WITH_ROLE, except the consuming view ' +
        'carries @Metadata.ignorePropagatedAnnotations: true, which is holding the upstream ' +
        'hide back. ARMED-BUT-HELD, not clean: the hide is still written upstream, and ' +
        'whoever removes the ignorePropagatedAnnotations re-arms it and the field ' +
        'disappears again, with no error anywhere',
    },
  ],
  [
    'UI5_REFERENCE_BROKEN',
    {
      severity: 'high',
      meaning:
        'a deployed Fiori app addresses an entity set, property, function import, action or ' +
        'parameter, or an annotation target, that the LIVE $metadata of its service no longer ' +
        'publishes: the app fails at runtime, in the browser, with no error on the system',
    },
  ],
  [
    'VH_VARIANT_AVAILABLE',
    {
      severity: 'low',
      meaning:
        'a business view is bound where a released *StdVH/*VH variant exists for the same ' +
        'concept',
    },
  ],
]);

export const GAP_CODES = new Map([
  [
    'CDS_PARSE_EMPTY',
    {
      severity: 'high',
      meaning:
        'a CDS source that plainly declares elements parsed to none of them: a parser gap, ' +
        'NOT an annotation-free view. Reported so the answer is "I could not read it" ' +
        'instead of a confident "no signal" -- the shape of the naive first-brace defect ' +
        'measured on three DDLX on 2026-09-09',
    },
  ],
  [
    'SHAPE_UNOBSERVED',
    {
      severity: 'high',
      meaning:
        'a reply was NOT interpreted: either the route has never been observed on this ' +
        'system, or it came back 200 and matched none of the measured shape. The payload ' +
        'is handed back raw and no conclusion is drawn -- which is never the same as ' +
        '"there is nothing there"',
    },
  ],
  [
    'SHAPE_DRIFT',
    {
      severity: 'medium',
      meaning:
        'the reply WAS interpreted and the measured shape no longer fits it: a node or ' +
        'attribute the projection does not declare came back, or a value the server ' +
        'computes itself disagreed with the same value recomputed from the parts. The ' +
        'answer stands -- it is the MEASUREMENT that aged, and the aging is the report. ' +
        'Deliberately not SHAPE_UNOBSERVED: that one means "I did not interpret this"',
    },
  ],
  [
    'CATALOG_MISS',
    {
      severity: 'low',
      meaning: 'a name was absent from both catalogues, so no release statement could be made',
    },
  ],
  [
    'CATALOG_MISSING',
    {
      severity: 'high',
      meaning:
        'no Clean Core catalogue is installed (catalog.release unset, or never synced): no release ' +
        'check was possible, so nothing was recommended or classified -- NOT "everything is released"',
    },
  ],
  [
    'CATALOG_PARTIAL',
    {
      severity: 'high',
      meaning:
        'the classification catalogue was unreadable: the 258 CDS entities that exist only ' +
        'there would be reported as unknown',
    },
  ],
  [
    'SOURCE_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'an object of the scanned package (or the package listing itself) could not be read from ' +
        'the system, so the scan saw less than what is there -- a lower count, never a cleaner one',
    },
  ],
  [
    'SCAN_AT_CAP',
    {
      severity: 'low',
      meaning:
        'a package scan stopped at its object cap (maxObjects) or was cancelled: the answer covers ' +
        'part of the package, and absent here is not absent there',
    },
  ],
  [
    'CONCEPT_NO_CANDIDATE',
    {
      severity: 'medium',
      meaning:
        'no released candidate was found for a concept: either the field needs an own view, ' +
        'or the concept extraction is too weak',
    },
  ],
  [
    'UI5_APP_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'part of a Fiori app named to adt_contract_check was not checked -- its manifest, a ' +
        'folder or file, the $metadata of a service it consumes, or a data source form not ' +
        'measured -- so its references there are unknown: NOT "no broken reference"',
    },
  ],
  [
    'ENHANCEMENTS_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'the enhancement read failed: this is NOT evidence that the object carries no ' +
        'enhancement',
    },
  ],
  [
    'BINDING_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'a service binding document, or the detail of one of its versions, could not be read: ' +
        'its kind or publication state is unknown -- NOT evidence that it is unpublished',
    },
  ],
  [
    'BATCH_ITEM_NOT_READ',
    {
      severity: 'low',
      meaning:
        'one name of an adt_read_source batch failed: an ambiguous name, a refused type or a read ' +
        'that errored. The batch went on and the item says why; this is never evidence of absence. ' +
        'A name that resolves to nothing is not this code: it is an answer, counted as notFound',
    },
  ],
  [
    'CLASENH_NOT_IN_ADT',
    {
      severity: 'low',
      meaning:
        'a class enhancement or function-module interface enhancement (ENHO/XH, tools CLASENH ' +
        'and FUGRENH) has no model in the ADT: its own resource dumps the server (measured ' +
        '2026-09-12 and 2026-09-14, 3 of 3), the enhanced object does not list it, and the ' +
        'search index does not know the methods it adds. The tool read the one resource that ' +
        'answers (objectproperties) or nothing; the methods, attributes and parameters are in ' +
        'SE19 and in the abapGit files *.enho.xml and *.enho.em_<method>.abap',
    },
  ],
  [
    'ENHO_SOURCE_IS_ELSEWHERE',
    {
      severity: 'low',
      meaning:
        "adt_read_source was asked for an enhancement implementation (ENHO): the ENHO's own URI " +
        'returns empty source by design (measured), and the code it implants is read ' +
        'from the enhanced object with enhancements: true. Nothing was read; the answer names ' +
        'the enhanced object and the call to make',
    },
  ],
  [
    'SEARCH_AT_CAP',
    {
      severity: 'low',
      meaning:
        'adt_search returned exactly as many hits as its limit: the quick search has no ' +
        'paging and no total, so the list may be cut and nothing in it says so. A census ' +
        'built on such an answer under-counts (ENHO/XHH measured 182 of 200 on 2026-09-11)',
    },
  ],
  [
    'NO_VERSION_FEED',
    {
      severity: 'low',
      meaning:
        'adt_transport was asked for the history of an object whose objectStructure publishes ' +
        'no atom:link rel=.../relations/versions, so nothing was read: which transports carried ' +
        'it is unknown by this route, and that is NOT evidence that it was never transported. ' +
        'The link was measured on CLAS (five), PROG and DOMA (2026-09-10); other types are not measured',
    },
  ],
  [
    'SYNTAX_NOT_CHECKED',
    {
      severity: 'medium',
      meaning:
        'adt_syntax_check could not check an object: the POST failed or the server answered ' +
        'a report that was not processed. Nothing is said about whether the source compiles -- ' +
        'this is NOT a clean check',
    },
  ],
  [
    'API_RELEASE_NOT_READ',
    {
      severity: 'low',
      meaning:
        'adt_object_info could not read the API release state of an object it resolved: whether ' +
        'the object is released for use is unknown -- NOT evidence that it is not released',
    },
  ],
  [
    'TEXT_ELEMENTS_NOT_READ',
    {
      severity: 'low',
      meaning:
        'adt_read_source was asked for the text elements of a program or class and one category ' +
        '(symbols, selections, headings) could not be read: that category is unknown -- NOT evidence ' +
        'that the object has none',
    },
  ],
  [
    'VERSION_NOT_READ',
    {
      severity: 'low',
      meaning:
        'adt_read_source was asked for a stored version (version / compareTo) it could not read: ' +
        'the object publishes no version feed for that include, the number is not in the feed, or ' +
        'a read failed. Nothing is said about that version -- it is NOT evidence that the version ' +
        'does not differ. Measured on classes and programs only (2026-11-10)',
    },
  ],
  [
    'FEED_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'adt_runtime_errors could not read a monitoring feed (dumps, gateway log): no statement ' +
        'about what dumped or what was logged -- a failed read is NOT an empty log',
    },
  ],
  [
    'DUMP_NOT_READ',
    {
      severity: 'low',
      meaning:
        'a dump named by id was not among the entries the feed answered within the page asked: ' +
        'not read, which is NOT evidence that it was deleted from ST22',
    },
  ],
  [
    'DDIC_FIELDS_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'ddicElement answered an empty tree for an object: not read, which is NOT evidence that ' +
        'the object has no fields -- this resource answers empty for a path it does not resolve',
    },
  ],
  [
    'DOMAIN_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'the domain of a data element (or a domain asked directly) could not be read: no statement ' +
        'about its type, value table or fixed values -- a failed read is NOT a domain without fixed values',
    },
  ],
  [
    'TYPE_NOT_IN_CONTRACT',
    {
      severity: 'low',
      meaning:
        'adt_object_info or adt_read_source met an object type lib/type-contract.mjs never decided: ' +
        'answered on the generic path without a field list -- what the tool answers for it is unmeasured',
    },
  ],
  [
    'UNCLASSIFIED_ADT_ERROR',
    {
      severity: 'medium',
      meaning:
        'a tool call failed with an HTTP status and no code explained it: the caller saw a bare error, ' +
        'which is NOT evidence that the object or the capability is absent',
    },
  ],
  [
    'TABLE_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'adt_customizing could not read an allow-listed customizing table through the data ' +
        'preview: no statement about its rows -- a failed read is NOT an empty table',
    },
  ],
  [
    'LAUNCHPAD_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'adt_launchpad could not read a launchpad object (catalog, group, space, page, semantic ' +
        'object) through its OData or data preview route: no statement about it -- a failed read ' +
        'is NOT an empty catalog and NOT an unregistered semantic object',
    },
  ],
  [
    'ATC_NOT_RUN',
    {
      severity: 'medium',
      meaning:
        'adt_atc_run could not create the worklist or start the run: no ATC verdict exists for ' +
        'this object from this call -- a run that did not happen is NOT a clean object',
    },
  ],
  [
    'ATC_SYSTEM_VARIANT_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'the system check variant (systemCheckVariant of atc/customizing) was not read at start: ' +
        'adt_atc_run offers only DEFAULT and the store\'s variants for this run -- the system\'s own ' +
        'governance run is missing from the choice, NOT absent from the system',
    },
  ],
  [
    'LEGACY_OBJECTS_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'the legacy objects of an APLO or CHKV search (created in SLG0 or SCI, not published by the ' +
        'ADT) could not be read from their tables: the ADT hits stand, and nothing is said about ' +
        'the legacy ones -- NOT "there are none"',
    },
  ],
  [
    'PACKAGE_FOLDERS_NOT_READ',
    {
      severity: 'low',
      meaning:
        'the virtual folders of a package could not be read: its sub-package descriptions came ' +
        'from the search instead and the object counts below them are not given -- NOT empty packages',
    },
  ],
  [
    'ATC_VARIANT_NOT_READ',
    {
      severity: 'low',
      meaning:
        'an ATC run happened and its findings stand, but the check variant it used could not be ' +
        'read: which checks it contains is unknown here (a variant created in transaction SCI is ' +
        'not this code: the ADT does not publish those, and that is said, not filed)',
    },
  ],
  [
    'ATC_RESULT_NOT_READ',
    {
      severity: 'medium',
      meaning:
        'the ATC run happened (the server answered the run) but its worklist was not read: the ' +
        'findings exist on the server and were not seen here -- NOT zero findings',
    },
  ],
  [
    'ADT_ERROR',
    {
      severity: 'medium',
      meaning:
        'an ADT call failed: the partial answer stands, and the named object is the one ' +
        'that could not be read',
    },
  ],
  [
    'BUDGET_EXHAUSTED',
    {
      severity: 'low',
      meaning:
        'this session passed the read count named in budget.reads. NOTHING was refused and no ' +
        'answer was shortened: lib/audit.mjs counts a read after it returns, so the number is a ' +
        'notice and not a gate. Low, not medium, because no evidence was lost -- it used to say ' +
        'the opposite, and a code that overstates its own finding spends the credibility of the rest',
    },
  ],
  [
    'SERVER_DUMPED',
    {
      severity: 'high',
      meaning:
        'a call answered HTTP 500 and the SAP system left an ST22 dump of this user since the call ' +
        'started (or none was found, which the detail says): the call was not served, and the ' +
        'runtime error, exception and terminated program are the lead to what to change',
    },
  ],
  [
    'LOG_TRUNCATED',
    {
      severity: 'low',
      meaning:
        'the journal hit its size cap for the day and stopped appending: never let logging ' +
        'fill the disk',
    },
  ],
]);

/** Look a code up in either family. Returns undefined for an unregistered code. */
export function codeInfo(code) {
  const key = String(code ?? '');
  const finding = FINDING_CODES.get(key);
  if (finding) return { ...finding, code: key, family: 'finding' };
  const gap = GAP_CODES.get(key);
  if (gap) return { ...gap, code: key, family: 'gap' };
  return undefined;
}

/**
 * Which tool an entry could have come from. `'*'` means any: the journal wrapper and the
 * journal itself emit under whatever tool was running.
 */
export const ANY_TOOL = '*';

/**
 * Tools whose run is a CENSUS of the workspace rather than an answer about one target.
 *
 * Only these can retire anything, and only when they ran unnarrowed. `adt_annotation_chain`
 * answers one element per call: a hundred of them still prove nothing about the hundred
 * and first, so a chain call can never mean "that defect is gone". Measured on this
 * journal -- treating any later call as a re-look marked two live defects
 * (`ZC_DemoShelfStock/Plant`, `ZC_DemoShelfStockDEMO/Plant`) as no longer reproduced.
 */
export const SWEEP_TOOLS = new Set([
  'adt_clean_core_scan',
  'adt_annotation_scan',
]);

/**
 * Code -> the module that emits it and the tool(s) it runs under.
 *
 * This exists so a report can answer a question the journal alone cannot: has the thing
 * that filed this row RUN AGAIN since, and did it file it again? Without it every entry
 * is reported as present forever, including the limits that have since been measured away.
 *
 * It is also the registry `tests/no-silent-errors.test.mjs` checks the emitters against.
 * That test used to find emitters by matching `code: 'X'` in the source, which is blind to
 * a code reaching the journal through a lookup table or a ternary -- five did. Naming the
 * module here makes the indirect ones checkable like the rest.
 *
 * ⚠️ `tools` is where a code CAN come from, not where a given row DID: two tools file
 * ANNOTATION_HIDDEN_WITH_ROLE, one offline and one against the system.
 */
export const EMITTED_BY = new Map([
  ['CC_LEVEL_B', { module: 'lib/clean-core.mjs', tools: ['adt_clean_core_scan', 'adt_package_health'] }],
  ['CC_LEVEL_C', { module: 'lib/clean-core.mjs', tools: ['adt_clean_core_scan', 'adt_package_health'] }],
  ['CC_LEVEL_D', { module: 'lib/clean-core.mjs', tools: ['adt_clean_core_scan', 'adt_package_health'] }],
  ['CC_DEPRECATED', { module: 'lib/clean-core.mjs', tools: ['adt_clean_core_scan', 'adt_package_health'] }],
  ['CATALOG_MISS', { module: 'tools/clean-core-scan.mjs', tools: ['adt_clean_core_scan', 'adt_package_health'] }],
  ['CATALOG_MISSING', { module: 'lib/catalog.mjs', tools: ['adt_clean_core_scan', 'adt_value_help', 'adt_package_health'] }],
  [
    'CATALOG_PARTIAL',
    { module: 'tools/clean-core-scan.mjs', tools: ['adt_clean_core_scan', 'adt_value_help', 'adt_package_health'] },
  ],
  ['ALIAS_DRIFT', { module: 'lib/contract.mjs', tools: ['adt_contract_check'] }],
  ['UI5_REFERENCE_BROKEN', { module: 'tools/contract-check.mjs', tools: ['adt_contract_check'] }],
  ['UI5_APP_NOT_READ', { module: 'tools/contract-check.mjs', tools: ['adt_contract_check'] }],
  ['SRVD_EXPOSURE_MISSING', { module: 'tools/value-help.mjs', tools: ['adt_value_help'] }],
  ['VH_VARIANT_AVAILABLE', { module: 'tools/value-help.mjs', tools: ['adt_value_help'] }],
  ['CONCEPT_NO_CANDIDATE', { module: 'tools/value-help.mjs', tools: ['adt_value_help'] }],
  ['CDS_PARSE_EMPTY', { module: 'tools/annotation-scan.mjs', tools: ['adt_annotation_scan'] }],
  [
    'ANNOTATION_HIDDEN_WITH_ROLE',
    {
      module: 'lib/annotation-detectors.mjs',
      tools: ['adt_annotation_scan', 'adt_annotation_chain'],
    },
  ],
  [
    'ANNOTATION_HIDDEN_HELD',
    { module: 'lib/annotation-detectors.mjs', tools: ['adt_annotation_scan'] },
  ],
  [
    'ANNOTATION_OVERRIDDEN',
    { module: 'tools/annotation-chain.mjs', tools: ['adt_annotation_chain'] },
  ],
  ['SHAPE_UNOBSERVED', { module: 'tools/annotation-chain.mjs', tools: ['adt_annotation_chain'] }],
  // The parser declares the code and decides the drift; tools/transport.mjs files it. The
  // module named here is the one that owns the MEANING, and it is also the one that has to
  // change when the measured shape does.
  ['SHAPE_DRIFT', { module: 'lib/transport-requests.mjs', tools: ['adt_transport', 'adt_customizing', 'adt_runtime_errors', 'adt_object_info', 'adt_atc_run', 'adt_launchpad', 'adt_syntax_check', 'adt_package_health'] }],
  ['FEED_NOT_READ', { module: 'tools/runtime-errors.mjs', tools: ['adt_runtime_errors'] }],
  // Also filed by lib/dump-after-500.mjs when the feed read that explains a 500 fails, for any tool.
  ['DUMP_NOT_READ', { module: 'tools/runtime-errors.mjs', tools: ANY_TOOL }],
  ['DDIC_FIELDS_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_object_info'] }],
  ['DOMAIN_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_object_info'] }],
  ['TYPE_NOT_IN_CONTRACT', { module: 'tools/index.mjs', tools: ['adt_object_info', 'adt_read_source'] }],
  ['UNCLASSIFIED_ADT_ERROR', { module: 'tools/index.mjs', tools: ANY_TOOL }],
  ['TABLE_NOT_READ', { module: 'tools/customizing.mjs', tools: ['adt_customizing'] }],
  ['LAUNCHPAD_NOT_READ', { module: 'tools/launchpad.mjs', tools: ['adt_launchpad'] }],
  ['ATC_NOT_RUN', { module: 'tools/atc.mjs', tools: ['adt_atc_run'] }],
  ['ATC_RESULT_NOT_READ', { module: 'tools/atc.mjs', tools: ['adt_atc_run'] }],
  ['ATC_VARIANT_NOT_READ', { module: 'tools/atc.mjs', tools: ['adt_atc_run'] }],
  ['PACKAGE_FOLDERS_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_package_tree'] }],
  ['LEGACY_OBJECTS_NOT_READ', { module: 'lib/legacy-objects.mjs', tools: ['adt_search'] }],
  // Filed at start by loadSystemVariant (server.mjs), before any tool runs; the tool it narrows is adt_atc_run.
  ['ATC_SYSTEM_VARIANT_NOT_READ', { module: 'tools/atc.mjs', tools: ['adt_atc_run'] }],
  [
    'ADT_ERROR',
    {
      module: 'tools/annotation-chain.mjs',
      tools: ['adt_annotation_chain', 'adt_value_help', 'adt_transport'],
    },
  ],
  ['SOURCE_NOT_READ', { module: 'lib/package-sources.mjs', tools: ['adt_clean_core_scan', 'adt_annotation_scan', 'adt_package_health'] }],
  ['SCAN_AT_CAP', { module: 'lib/package-sources.mjs', tools: ['adt_clean_core_scan', 'adt_annotation_scan', 'adt_package_health'] }],
  ['ENHANCEMENTS_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_read_source', 'adt_object_info'] }],
  ['SEARCH_AT_CAP', { module: 'tools/index.mjs', tools: ['adt_search'] }],
  ['BATCH_ITEM_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_read_source'] }],
  ['BINDING_NOT_READ', { module: 'lib/service-binding.mjs', tools: ['adt_object_info'] }],
  ['ENHO_SOURCE_IS_ELSEWHERE', { module: 'tools/index.mjs', tools: ['adt_read_source'] }],
  ['CLASENH_NOT_IN_ADT', { module: 'lib/object-properties.mjs', tools: ['adt_read_source', 'adt_object_info', 'adt_transport'] }],
  ['NO_VERSION_FEED', { module: 'tools/transport.mjs', tools: ['adt_transport'] }],
  ['VERSION_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_read_source'] }],
  ['TEXT_ELEMENTS_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_read_source'] }],
  ['API_RELEASE_NOT_READ', { module: 'tools/index.mjs', tools: ['adt_object_info'] }],
  ['SYNTAX_NOT_CHECKED', { module: 'tools/syntax-check.mjs', tools: ['adt_syntax_check', 'adt_package_health'] }],
  ['BUDGET_EXHAUSTED', { module: 'tools/index.mjs', tools: ANY_TOOL }],
  ['SERVER_DUMPED', { module: 'lib/dump-after-500.mjs', tools: ANY_TOOL }],
  ['LOG_TRUNCATED', { module: 'lib/journal.mjs', tools: ANY_TOOL }],
]);

/** Where a code comes from. Returns undefined for an unregistered code. */
export function emittedBy(code) {
  return EMITTED_BY.get(String(code ?? ''));
}

const SEVERITY_ORDER = ['high', 'medium', 'low'];

/** Sort key for severity, so a report can rank without a switch at every call site. */
export const severityRank = (severity) => {
  const i = SEVERITY_ORDER.indexOf(String(severity));
  return i === -1 ? SEVERITY_ORDER.length : i;
};
