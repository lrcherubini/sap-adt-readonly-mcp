// What adt_object_info and adt_read_source answer, per ADT object type -- decided, not inferred.
//
// Why this exists. On 2026-10-01 an agent concluded "the MCP does not return domain values"
// after two calls on a data element: the source read answered a raw 404, and the metadata
// read asked ddicElement for a field list, got an empty tree and filed DDIC_FIELDS_NOT_READ
// with the advice "read the source of the TABL". Both answers were dead ends dressed as
// answers. The journal showed the same false gap on packages and a service binding, and the
// measurement below found it on classes, interfaces, table types, search helps and
// application-log objects too: the field list was asked of EVERY type.
//
// So the behaviour per type is a table, and the table is the contract:
//   - `fields`: adt_object_info asks ddicElement only when true. Anything else gets a
//     `fieldsNote` that says why it was not asked -- never a gap, because nothing failed.
//   - `source`: true = adt_read_source reads it; `{ refuse, why }` = refused BEFORE any
//     request, naming the call that does answer.
//   - `evidence`: the reading behind the entry, dated. An entry without one does not pass
//     tests/type-contract.test.mjs.
// A type outside the table is not guessed at: it is attempted without the field list and
// filed as TYPE_NOT_IN_CONTRACT, so a new type shows up in `npm run report` instead of
// answering wrong.
//
// MEASURED 2026-10-01 on the development system (adt_object_info with fields + adt_read_source, one object
// per type; table in docs/adt-api-reference.md, "Type contract"). The structure's own
// `abapsource:sourceUri` matched the source answer on every type measured: present on
// TABL, DDLS, BDEF, DDLX, APLO, INTF; absent on DTEL, DOMA, DEVC, SRVB, TTYP, SHLP.

const OBJECT_INFO = 'adt_object_info';

export const TYPE_CONTRACT = new Map([
  // --- types with a field list (a structure is not one of them: see TABL/DS below) ------
  ['TABL/DT', { fields: true, source: true, evidence: '2026-10-01 ZDEMO_TRK_OC: 25 fields by name, source read; VBAK by name 2026-09-22' }],
  ['TABL/DS', {
    fields: false,
    fieldsNote:
      'ddicElement answers an empty tree for every structure (measured): the fields are in its source ' +
      '(adt_read_source), and the appends that extend it are named by enhancement/elements',
    source: true,
    evidence:
      'ddicElement by name answered 0 children on 7 of 7 structures: KOMPAZ, KOMPCV, INCL_EEW_KNA1, ' +
      'MEREP_OUTTAB_PURCHDOC (2026-09-22), EXTCMDEXEX (2026-10-01), BAPIRET2, SYST (2026-11-09); source read 2026-10-01',
  }],
  ['DDLS/DF', { fields: true, source: true, evidence: '2026-10-01 ZI_DemoChannel: 11 fields by name, source read (6 reads in the call log)' }],
  ['STOB/DO', { fields: true, source: true, evidence: 'the CDS entity facet of a DDLS: ddicElement answers DDLS/STOB with STOB/DOF children (2026-10-01)' }],

  // --- code: source yes, field list no ------------------------------------------------
  ['CLAS/OC', { fields: false, source: true, evidence: '2026-10-01 ZCL_DEMO_BUPA_CHANGE: ddicElement empty (false gap), elements carry the members; source read 4x in the call log' }],
  ['INTF/OI', { fields: false, source: true, evidence: '2026-10-01 IF_HTTP_CLIENT: ddicElement empty (false gap), abapsource:sourceUri present' }],
  ['PROG/P', { fields: false, source: true, evidence: 'in the source order of lib/resolve.mjs; no successful read in the call log yet' }],
  ['PROG/I', { fields: false, source: true, evidence: '23 includes (RV64A9xx etc.) read through the URI on 2026-10-01' }],
  ['FUGR/F', { fields: false, source: true, evidence: 'in the source order of lib/resolve.mjs; no successful read in the call log yet' }],
  ['FUGR/FF', { fields: false, source: true, evidence: 'SXPG_COMMAND_EXECUTE, CALCULATE_HASH_FOR_CHAR: source read 4x in the call log (2026-09-30)' }],
  ['FUGR/I', { fields: false, source: true, evidence: 'in the source order of lib/resolve.mjs; no successful read in the call log yet' }],
  ['BDEF/BDO', {
    fields: false,
    fieldsNote: 'ddicElement answers this name with the fields of the CDS entity of the same name (measured): ask adt_object_info on the DDLS',
    source: true,
    evidence: '2026-10-01 ZR_DEMOOCCGROUPTP: source read; ddicElement returned the DDLS/STOB of the same name',
  }],
  ['DDLX/EX', {
    fields: false,
    fieldsNote: 'ddicElement answers this name with the fields of the CDS entity of the same name (measured): ask adt_object_info on the DDLS',
    source: true,
    evidence: '2026-10-01 ZC_DEMOOCCCODETP: ddicElement returned the DDLS/STOB of the same name; source read 2026-09-30',
  }],
  ['APLO/TYP', { fields: false, source: true, evidence: '2026-10-01 ZDEMO_FREIGHT: source is JSON (header + subobjects); ddicElement empty (false gap)' }],

  // --- enhancements: their own branches in tools/object-info.mjs and tools/read-source.mjs ----------------------------
  ['ENHO/XHH', { fields: false, source: true, evidence: 'the ENHO branch of adt_read_source answers the enhanced object (2026-09-11); no field list' }],
  ['ENHO/XHB', { fields: false, source: true, evidence: 'BAdI implementation: the ENHO branch answers `badi` (2026-09-12); no field list' }],
  ['ENHO/XH', { fields: false, source: true, evidence: 'class enhancement: never asked, the structure dumps the server (2026-09-12/14); the branch answers where the code is' }],

  // --- form-based: no source text, no field list -------------------------------------
  ['DTEL/DE', {
    fields: false,
    fieldsNote: 'a data element has no fields: its domain, type and fixed values are in `dataElement`',
    source: { refuse: OBJECT_INFO, why: 'a data element is form-based' },
    evidence: '2026-10-01 BTCXPGSTAT: source 404; ddicElement empty (the false gap of that day)',
  }],
  ['DOMA/DD', {
    fields: false,
    fieldsNote: 'a domain has no fields: its type and fixed values are in `domain`',
    source: { refuse: OBJECT_INFO, why: 'a domain is form-based' },
    evidence: '2026-10-01 CHAR1: no abapsource:sourceUri; source not asked (refused by analogy with DTEL/DE, not measured)',
  }],
  ['DEVC/K', {
    fields: false,
    fieldsNote: 'a package has no fields: its ancestry is in `packagePath`, its content in adt_package_tree',
    source: { refuse: 'adt_package_tree', why: 'a package has no source; the read returned the package XML as if it were source' },
    evidence: '2026-10-01 ZDEMO_DEV: source read answered the pak:package XML; ddicElement empty (false gap, also ZDEMO_BI_EXTRACT and ZDEMO_FREIGHT_TRACK in the journal)',
  }],
  ['SRVB/SVB', {
    fields: false,
    fieldsNote: 'a service binding has no fields: the entities are in its SRVD',
    source: { refuse: OBJECT_INFO, why: 'a service binding is form-based; its exposures are in the SRVD source' },
    evidence: '2026-10-01 ZUI_DEMOOCCGROUP_O4: source 404; ddicElement empty (false gap, also in the journal)',
  }],
  ['TTYP/DA', {
    fields: false,
    fieldsNote: 'a table type has no field list of its own: the line type is another object',
    source: { refuse: OBJECT_INFO, why: 'a table type is form-based' },
    evidence: '2026-10-01 BAPIRET2_T: source 404; ddicElement empty (false gap)',
  }],
  ['SHLP/DH', {
    fields: false,
    fieldsNote: 'a search help has no field list through this resource',
    source: { refuse: OBJECT_INFO, why: 'a search help is form-based' },
    evidence: '2026-10-01 H_T001W_C: source 404; ddicElement empty (false gap); the structure carries no links',
  }],
]);

/** The contract entry of one type, or null when the type was never decided. */
export function contractOf(type) {
  return TYPE_CONTRACT.get(String(type ?? '').toUpperCase()) ?? null;
}

/** The refusal of adt_read_source for a type without source, or null when it reads. */
export function sourceRefusal(type, name) {
  const c = contractOf(type);
  if (!c || c.source === true) return null;
  const t = String(type).toUpperCase();
  const n = String(name ?? '').toUpperCase();
  const call = c.source.refuse === OBJECT_INFO ? `${OBJECT_INFO}({ objectName: '${n}', objectType: '${t}' })` : `${c.source.refuse}({ packageName: '${n}' })`;
  return new Error(`${t} ${n} has no source text in the ADT (${c.source.why}). It is answered by ${call}.`);
}
