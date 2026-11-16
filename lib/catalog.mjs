// The Clean Core release catalogue, a local copy of SAP's -- BOTH files of it.
//
// Source: SAP's abap-atc-cr-cv-s4hc (Apache-2.0), downloaded by `npm run sync:catalog` into the
// state directory -- OUTSIDE the repository, refreshed on purpose (monthly), recorded in
// PROVENANCE.json. One release file (objectReleaseInfo_<release>.json, chosen with the setting
// `catalog.release`) plus objectClassifications_SAP.json, and the second is NOT optional:
// measured on PCE2023_0, **258 CDS entities exist only there** (state `classicAPI`),
// I_BankAccount and I_TechnicalObjectLabelVH among them.
//
// ⚠️ That is why absence from the first file proves nothing. Loading one file would
// answer "this name is unknown to the catalogue" for a standard entity that exists and
// is classified -- an inference-from-absence that a catalogue checker must not make. A Level B classicAPI is not recommendable for Level A, but "known and
// Level B" and "does not exist" are different answers and the caller has to see which
// one it got.
//
// Read directly, on purpose: the catalogue files are SAP's own, byte for byte, so no other tool
// stands between them and this code. The viewer (VIEWER below) is the human cross-check. Any independent checker of the same
// upstream stays a human cross-check, never a dependency.
//
// Why this runs BEFORE any ADT call: filtering candidates to released here makes it
// impossible to recommend a non-released entity, and costs nothing. I_PlantVH is
// eliminated at this step rather than after a round trip.

import fs from 'node:fs';
import path from 'node:path';

/** SAP's upstream and its human viewer -- the viewer is linked in answers, never queried. */
export const UPSTREAM = 'SAP/abap-atc-cr-cv-s4hc';
export const VIEWER = 'https://sap.github.io/abap-atc-cr-cv-s4hc/';
export const CLASSIFICATIONS_FILE = 'objectClassifications_SAP.json';
/** `Latest`, `PCELatest`, `BTPLatest`, `PCE2025_2`, `PCE2023_0`, ... (upstream src/ names). */
export const RELEASE_RE = /^[A-Za-z][A-Za-z0-9_]{1,29}$/;

/** The upstream file of a release: `Latest` is the one name without an underscore. */
export const releaseFileName = (release) =>
  release === 'Latest' ? 'objectReleaseInfoLatest.json' : `objectReleaseInfo_${release}.json`;

/** Which release a file name holds, or null (`objectReleaseInfo_PCE2025_2.json` -> PCE2025_2). */
export const releaseOfFile = (name) => {
  if (name === 'objectReleaseInfoLatest.json') return 'Latest';
  const m = /^objectReleaseInfo_([A-Za-z][A-Za-z0-9_]{1,29})\.json$/.exec(name);
  return m ? m[1] : null;
};

const DAY = 24 * 60 * 60 * 1000;

/**
 * The status as an answer carries it: the file by its name only. Where the server keeps its state
 * is the operator's business (`npm run config -- doctor` prints the path), not every caller's.
 */
export const catalogForAnswer = (status) => (status?.file ? { ...status, file: path.basename(status.file) } : status);

/**
 * What the installed catalogue is, without parsing it: release, file, whether it is there, and
 * how old the copy is (from PROVENANCE.json written by sync:catalog). Answers carry it so a
 * stale catalogue is visible in every recommendation instead of being discovered by surprise.
 */
export function catalogStatus(file, { release = null, now = Date.now() } = {}) {
  const base = { release, file: file ?? null, viewer: VIEWER };
  if (!file) return { ...base, installed: false, reason: 'catalog.release is not set' };
  if (!fs.existsSync(file)) return { ...base, installed: false, reason: `${file} does not exist` };
  let provenance = null;
  try {
    provenance = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'PROVENANCE.json'), 'utf8'));
  } catch {
    // No provenance (a manual copy): the catalogue still answers, its age is simply unknown.
  }
  const syncedAt = provenance?.syncedAt ?? null;
  const ageDays = syncedAt ? Math.floor((now - Date.parse(syncedAt)) / DAY) : null;
  return { ...base, installed: true, commit: provenance?.upstreamCommit ?? null, syncedAt, ageDays };
}

/** Thrown when no catalogue is installed: a missing release gate must never read as "released". */
export class CatalogMissing extends Error {
  constructor(status) {
    super(
      `no Clean Core catalogue (${status.reason}): set the release once with ` +
        '`npm run config -- set catalog.release <release>` (npm run sync:catalog -- --list shows them), ' +
        'then download it with `npm run sync:catalog`.'
    );
    this.name = 'CatalogMissing';
    this.status = status;
  }
}

/** The journal gap for a missing catalogue. */
export const catalogMissingGap = (status, subject = 'Clean Core catalogue') => ({
  code: 'CATALOG_MISSING',
  subject,
  detail: status.reason,
  impact: 'no release check is possible: nothing can be recommended or classified',
  fallback: 'npm run config -- set catalog.release <release>; npm run sync:catalog',
});

/** `released` is the only state safe to recommend; the others are reported with why. */
const STATE_REASON = {
  released: null,
  notToBeReleased: 'the catalogue marks it notToBeReleased',
  notToBeReleasedStable: 'the catalogue marks it notToBeReleasedStable (stable, but not released)',
  deprecated: 'the catalogue marks it deprecated',
  // From objectClassifications_SAP.json. A classic API is usable in Standard ABAP but is
  // NOT released for ABAP Cloud, so it is Level B: reportable, never recommendable.
  classicAPI:
    'the catalogue classifies it as classicAPI -- Level B, usable in Standard ABAP but ' +
    'not released for ABAP Cloud, so it is not a Level A answer',
  noAPI: 'the catalogue classifies it as noAPI: it is not an API at all',
};

/**
 * Load and index the catalogue.
 *
 * @param {string} file path to objectReleaseInfo_*.json
 * @param {{classifications?:string}} opts path to objectClassifications_SAP.json; when
 *        absent the loader looks for it next to `file`, and degrades by SAYING it is
 *        missing rather than by silently answering "unknown" for its 258 CDS rows.
 * @returns {{count:number, file:string, formatVersion:string,
 *            row:(name:string, type?:string)=>object|undefined,
 *            state:(name:string, type?:string)=>string|undefined,
 *            isReleased:(name:string, type?:string)=>boolean,
 *            stateReason:(name:string, type?:string)=>string|null|undefined,
 *            has:(name:string, type?:string)=>boolean}}
 */
export function loadCatalog(file, opts = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // A missing catalogue must be loud: silently having no candidates would look
    // exactly like "there is no value help for this field", which is a lie.
    throw new Error(
      `Clean Core catalogue not readable at ${file}: ${e.message}. ` +
        'Without it, released state cannot be checked and no recommendation is safe.'
    );
  }
  const rows = parsed.objectReleaseInfo ?? parsed;
  if (!Array.isArray(rows)) {
    throw new Error(`Catalogue at ${file} has no objectReleaseInfo array.`);
  }

  // The second catalogue. Missing is survivable -- it holds classic APIs, none of which
  // is recommendable anyway -- but the degradation is stated, never assumed.
  const classFile =
    opts.classifications ?? path.join(path.dirname(file), CLASSIFICATIONS_FILE);
  let classRows = [];
  let classNote = null;
  try {
    const c = JSON.parse(fs.readFileSync(classFile, 'utf8'));
    classRows = c.objectClassifications ?? (Array.isArray(c) ? c : []);
    if (!Array.isArray(classRows)) classRows = [];
  } catch (e) {
    classNote =
      `the classification catalogue was not readable at ${classFile} (${e.message}); ` +
      'an entity that exists only there will be reported as unknown';
    classRows = [];
  }

  // Indexed by type+name and by name alone, because one technical name can appear
  // under more than one objectType -- the workspace rule that names repeat.
  const byTypeName = new Map();
  const byName = new Map();
  // A SECOND index, on objectKey, and it is not a nicety: measured over these two files,
  // 6,454 rows are addressable ONLY this way -- 5,610 function modules and 838 BAdI
  // definitions, where `tadirObjName` carries the CONTAINER (the function group, the
  // enhancement spot) and `objectKey` carries the object anyone actually names.
  // J_1BREAD_BRANCH_DATA lives under tadirObjName 'J1BS'; indexing on the name alone
  // answers "absent from both catalogues" for a classicAPI that is right there, which is
  // precisely the inference-from-absence this module exists to prevent.
  const byKey = new Map();
  for (const r of [...rows, ...classRows]) {
    const name = String(r.tadirObjName ?? '').toUpperCase();
    const key = String(r.objectKey ?? '').toUpperCase();
    if (!name && !key) continue;
    if (name) {
      // The release info wins on a collision: it is the release-specific file, and the
      // classifications are the general SAP list.
      const tk = `${r.objectType}|${name}`;
      if (!byTypeName.has(tk)) byTypeName.set(tk, r);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(r);
    }
    if (key && key !== name) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
  }
  /** Rows a name can mean, exact object first, container second. */
  const candidates = (name) => {
    const k = String(name ?? '').toUpperCase();
    return [...(byKey.get(k) ?? []), ...(byName.get(k) ?? [])];
  };

  const row = (name, type = 'CDS_STOB') => {
    const key = String(name ?? '').toUpperCase();
    if (type) return byTypeName.get(`${type}|${key}`);
    return (byName.get(key) ?? [])[0];
  };

  return {
    file,
    classificationsFile: classNote ? null : classFile,
    ...(classNote ? { note: classNote } : {}),
    count: rows.length + classRows.length,
    releaseInfoCount: rows.length,
    classificationCount: classRows.length,
    formatVersion: parsed.formatVersion,
    row,
    has: (name, type) => !!row(name, type),
    state: (name, type) => row(name, type)?.state,
    /**
     * The released successors the Cloudification catalogue names for a classic API.
     *
     * This is the half of the second file that makes it worth loading beyond honesty:
     * a Level B entity usually comes with the Level A one that replaces it
     * (I_BankAccount -> I_BankAccountBasicData), so a rejected candidate can say what to
     * use instead rather than only why it was rejected.
     */
    successors: (name, type) =>
      (row(name, type)?.successors ?? []).map((s) => String(s.tadirObjName).toUpperCase()),
    /**
     * Cross-type lookup, for a name whose object type is NOT known in advance.
     *
     * `row()` above defaults `type` to 'CDS_STOB' and only consults the by-name index
     * when the caller passes a falsy type -- then returning just the first row. That is
     * right for the value-help pipeline, which only ever asks about CDS entities, and
     * wrong for a sweep over what a view reads: `mara` and `vbak` are TABL, `I_Product`
     * is CDS_STOB, and a function module is FUNC. This tries the given types in order
     * and falls back to whatever the name has.
     *
     * Release info wins over classifications, because the by-name index is built with
     * the release-specific file first.
     */
    lookup: (name, types = ['CDS_STOB', 'TABL', 'CLAS', 'INTF', 'FUNC']) => {
      const found = candidates(name);
      if (!found.length) return undefined;
      for (const t of types) {
        const hit = found.find((r) => r.objectType === t);
        if (hit) return hit;
      }
      return found[0];
    },
    /** Every row a name has, so a caller can see that it exists under several types. */
    allRows: (name) => candidates(name),
    isReleased: (name, type) => row(name, type)?.state === 'released',
    stateReason: (name, type) => {
      const r = row(name, type);
      if (!r) return undefined;
      const base = STATE_REASON[r.state] ?? `the catalogue state is '${r.state}'`;
      const successors = (r.successors ?? []).map((s) => s.tadirObjName).filter(Boolean);
      return base && successors.length
        ? `${base}. The catalogue names its released successor: ${successors.join(', ')}`
        : base;
    },
    /** Every name of a type, uppercased. Used only by tests and diagnostics. */
    namesOfType: (type) =>
      [...rows, ...classRows]
        .filter((r) => r.objectType === type)
        .map((r) => String(r.tadirObjName).toUpperCase()),
  };
}
