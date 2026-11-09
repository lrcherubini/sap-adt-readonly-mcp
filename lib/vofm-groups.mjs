// VOFM routine naming, transcribed from the system that generates the names.
//
// A VOFM routine (pricing formula, requirement, data transfer, copy requirement, ...) is customer
// code with a SAP name in a SAP package: `RV64A951` in `VKON`. Transaction VOFM derives the include
// name from the group and the number, and nothing else -- so "every customer routine in the
// system" is a finite set: every group x every number of the customer range. This module keeps the
// table of groups, which adt_customizing uses to validate the routine columns of a customizing table.
//
// SOURCE: `SAPMV80H`, include `MV80H200`, FORM `xd0200_include_namen_setzen` (the CASE over
// `xi_grpze`, lines 759-1398 on the system read of 2026-09-11) and the constants in `MV80HTOP`:
//
//   user_grpno_first1 = 600   user_grpno_last1 = 999    -- most groups
//   user_grpno_first2 =  50   user_grpno_last2 =  99    -- TDAT and PSTK
//   user_grpno_first3 = 900                             -- FOFU
//
// The SAP Library ("Routines", Shipping) states the same split for the two common cases -- standard
// 001-599 (2-digit: 01-49), customer 600-999 (2-digit: 50-99); the FOFU exception is only in the
// constants. Checked 2026-09-12:
// https://help.sap.com/saphelp_pserv464/helpdata/en/04/c3dc097a35d111950d0060b03c6b76/content.htm
//
// Three things the FORM does that a "prefix + number" summary gets wrong:
//   - Only TDAT shifts the number left (`SHIFT xi_grpno LEFT` after the CASE), so its include is
//     TWO digits: `RV45TE50`. PSTK shares the 50..99 range but keeps three: `RV65A050`.
//   - In the LIS groups (`MC*`, `JCV*`) and in `SPEV` both branches of the IF produce the SAME
//     prefix; only the number says whether the routine is SAP's or the customer's.
//   - `PBES` and `EXKO` are groups with no include at all (`include_report_name = space` / absent
//     from the CASE). `OIRQ`/`OICA` exist as constants and are in no CASE either.
//
// `pkg` is the package the SAME program assigns to a NEW customer routine today (FORM transport,
// the CASE at lines 1581-1664). It is informational: a routine created under an older release
// sits where that release put it -- measured, `RV64A9xx` are in `VKON` while `RV64A971` is in
// `VF_PRC_CORE`, and the table says `VF_PRC_CORE` for `PFRM`. Never filter by it.

const R1 = { first: 600, last: 999, digits: 3 };
const R2 = { first: 50, last: 99, digits: 3 }; // PSTK: same range as TDAT, no SHIFT
const R2S = { first: 50, last: 99, digits: 2 }; // TDAT: the only group that SHIFTs
const R3 = { first: 900, last: 999, digits: 3 }; // FOFU

const g = (grpze, family, sap, prefix, pkg, range = R1) => ({
  grpze,
  family,
  sap,
  prefix,
  pkg,
  ...range,
});

/**
 * Every group VOFM knows, in the order of the FORM. `prefix` is the customer include prefix,
 * `sap` the SAP one -- the pair is kept because in a third of the groups they are equal and the
 * number alone decides. `prefix: null` means the group has no include.
 */
export const GROUPS = [
  // Kopierbedingungen -- copy requirements
  g('ABED', 'copy-requirement', 'LV45C', 'RV45B', 'VA'),
  g('LBED', 'copy-requirement', 'FV50B', 'RV50B', 'VL'),
  g('FBED', 'copy-requirement', 'LV60A', 'RV60B', 'VF'),
  g('CASB', 'copy-requirement', 'LV43A', 'RV43A', 'VCA'),
  g('TBED', 'copy-requirement', 'LV45T', 'RV45T', 'VT'),
  // Datentransporte -- data transfer
  g('ADAT', 'data-transfer', 'FV45C', 'RV45C', 'VA'),
  g('LDAT', 'data-transfer', 'FV50C', 'RV50C', 'VL'),
  g('FDAT', 'data-transfer', 'FV60C', 'RV60C', 'VF'),
  g('CASC', 'data-transfer', 'FV44A', 'RV44A', 'VCA'),
  g('TDAT', 'data-transfer', 'LV45TE', 'RV45TE', 'VT', R2S),
  g('VSEL', 'data-transfer', 'FV51A', 'RV51A', 'VV'),
  g('TRAU', 'data-transfer', 'FV56C', 'RV56C', 'VTR'),
  // Textnamen -- text names
  g('TNAM', 'text-name', 'LV70T', 'RV70T', 'VT'),
  g('TXNM', 'text-name', 'FV46T', 'RV46T', 'VT'),
  // Bedingungen -- requirements
  g('PBED', 'requirement', 'LV61A', 'RV61A', 'VF_PRC_CORE'),
  g('VKMP', 'requirement', 'LVKMP', 'RVKMP', 'VKM'),
  g('RISK', 'requirement', 'LRISK', 'RRISK', 'VKM'),
  g('PBNA', 'requirement', 'FV62N', 'RV62N', 'VKON'),
  g('CMPD', 'requirement', 'FV623', 'RV623', 'CMPD'),
  g('BBYR', 'requirement', 'FBBYN', 'RBBYN', 'WBBY'),
  g('PBWV', 'requirement', 'LWVK1', 'RWVK1', 'WVKP'),
  g('POFO', 'requirement', 'LV61M', 'RV61M', 'WPORTFOLIO'),
  g('PACK', 'requirement', 'LV61P', 'RV61P', 'ISAUTO_VHU_PACKOBJ'),
  g('PBEF', 'requirement', 'LV61D', 'RV61D', 'VKON'),
  g('PBEN', 'requirement', 'LV61B', 'RV61B', 'VN'),
  g('PBEK', 'requirement', 'LV61C', 'RV61C', 'VKON'),
  g('PBEL', 'requirement', 'LV61G', 'RV61G', 'VKON'),
  g('PBES', 'requirement', null, null, null), // include_report_name = space
  // Chargen -- batches
  g('CHBE', 'batch', 'L080M', 'R080M', 'VB'),
  g('CHRG', 'batch', 'LV01F', 'RV01F', 'VB'),
  g('CHMV', 'batch', 'LMDBF', 'RMDBF', 'MDBF'),
  // Ausfuhrbedingungen -- export control: a group with a package and no include
  g('EXKO', 'requirement', null, null, 'VA'),
  // Folgefunktionen -- subsequent functions
  g('FOFU', 'subsequent-function', 'LV07A', 'RV07A', 'VL', R3),
  // Formeln -- formulas
  g('PFRS', 'formula', 'FV62A', 'RV62A', 'VF_PRC_CORE'),
  g('PFRA', 'formula', 'FV63A', 'RV63A', 'VF_PRC_CORE'),
  g('PFRM', 'formula', 'FV64A', 'RV64A', 'VF_PRC_CORE'),
  g('PRUN', 'formula', 'FV13A', 'RV13Z', 'VKON'),
  g('PSTK', 'formula', 'FV65A', 'RV65A', 'VF_PRC_CORE', R2),
  g('PNAT', 'formula', 'LV61N', 'RV61N', 'VKON'),
  // Reporting
  g('LST1', 'reporting', 'RV77S', 'RV77U', 'VREP'),
  // LIS -- same prefix on both sides, the number decides
  g('MCA1', 'lis', 'FMCA1', 'FMCA1', 'MCWF'),
  g('MCA2', 'lis', 'FMCA2', 'FMCA2', 'MCWF'),
  g('MCV1', 'lis', 'FMCV1', 'FMCV1', 'MCS'),
  g('MCV2', 'lis', 'FMCV2', 'FMCV2', 'MCS'),
  g('MCT1', 'lis', 'FMCT1', 'FMCT1', 'MCS'),
  g('MCT2', 'lis', 'FMCT2', 'FMCT2', 'MCS'),
  g('MCE1', 'lis', 'FMCE1', 'FMCE1', 'MCS'),
  g('MCE2', 'lis', 'FMCE2', 'FMCE2', 'MCS'),
  g('MCF1', 'lis', 'FMCF1', 'FMCF1', 'MCS'),
  g('MCF2', 'lis', 'FMCF2', 'FMCF2', 'MCS'),
  g('MCB1', 'lis', 'FMCB1', 'FMCB1', 'MCS'),
  g('MCB2', 'lis', 'FMCB2', 'FMCB2', 'MCS'),
  g('MCW1', 'lis', 'FMCW1', 'FMCW1', 'MCS'),
  g('MCW2', 'lis', 'FMCW2', 'FMCW2', 'MCS'),
  g('MCL1', 'lis', 'FMCL1', 'FMCL1', 'VL'),
  g('MCL2', 'lis', 'FMCL2', 'FMCL2', 'VL'),
  g('MCZ1', 'lis', 'FMCZ1', 'FMCZ1', 'MCS'),
  g('MCZ2', 'lis', 'FMCZ2', 'FMCZ2', 'MCS'),
  g('MCQ1', 'lis', 'FMCQ1', 'FMCQ1', 'MCS'),
  g('MCQ2', 'lis', 'FMCQ2', 'FMCQ2', 'MCS'),
  g('MCI1', 'lis', 'FMCI1', 'FMCI1', 'MCS'),
  g('MCI2', 'lis', 'FMCI2', 'FMCI2', 'MCS'),
  // Archivierung -- archiving
  g('REAK', 'archiving', 'AKSAP', 'AKUSR', 'VZ'),
  g('RERK', 'archiving', 'RKSAP', 'RKUSR', 'VZ'),
  g('RELK', 'archiving', 'DKSAP', 'DKUSR', 'VZ'),
  g('REKA', 'archiving', 'KASAP', 'KAUSR', 'VZ'),
  // Inbound validation (EWM/SPE), payment card, shipping
  g('SPEV', 'inbound-validation', '/SPE/VAL', '/SPE/VAL', '/SPE/INB_VALFRW'),
  g('VCAU', 'requirement', 'DVCAU', 'RVCAU', 'VFC'),
  g('VFCL', 'transport', 'FV57A', 'RV57A', 'VFSC_1'),
  g('MCU1', 'lis', 'FMCU1', 'FMCU1', 'MCS'),
  g('MCU2', 'lis', 'FMCU2', 'FMCU2', 'MCS'),
  // IS2ERP: IS-M and DIMP/CEM
  g('JCV1', 'lis', 'FJCV1', 'FJCV1', 'JSD'),
  g('JCV2', 'lis', 'FJCV2', 'FJCV2', 'JSD'),
  g('J3GJ', 'requirement', 'LJ3GJ', 'RJ3GJ', 'J3GJ'),
];

const byGrpze = new Map(GROUPS.map((x) => [x.grpze, x]));
export const groupOf = (grpze) => byGrpze.get(String(grpze ?? '').toUpperCase());
