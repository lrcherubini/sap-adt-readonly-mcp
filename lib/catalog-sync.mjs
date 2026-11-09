// Download and install the Clean Core catalogue -- the one network read this project makes
// outside the SAP system, and only when someone runs `npm run sync:catalog`.
//
// Source: SAP's own repository (UPSTREAM in lib/catalog.mjs), the same files the ATC Cloud
// Readiness check reads by raw.githubusercontent.com URL. The commit of `main` is resolved first
// and both files are fetched AT THAT COMMIT, so the two always come from the same upstream state
// and PROVENANCE.json can name it.
//
// Why a copy and not a live query per answer: every recommendation would then depend on internet
// access and on GitHub being up, and stop being reproducible. A local copy at a recorded commit is
// the same data, deterministic and auditable. The server itself never downloads anything.
//
// Why outside the repository: it is reference data that changes when SAP publishes (monthly is a
// sensible cadence), 5-12 MB per release, and not this project's code. It lives in the state
// directory, next to the store.
//
// Install is all-or-nothing: both files are validated, written to a staging folder, and swapped in
// by rename; the previous copy stays as `catalog.prev`. A failed or half download never replaces a
// working catalogue.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPSTREAM, VIEWER, CLASSIFICATIONS_FILE, RELEASE_RE, releaseFileName, releaseOfFile, catalogStatus } from './catalog.mjs';

export const API = `https://api.github.com/repos/${UPSTREAM}`;
export const RAW = `https://raw.githubusercontent.com/${UPSTREAM}`;
const HEADERS = { 'User-Agent': 'sap-adt-readonly-mcp', Accept: 'application/vnd.github+json' };
const SHA = /^[0-9a-f]{40}$/;

export class CatalogSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogSyncError';
  }
}

async function get(fetchFn, url, kind = 'json') {
  let res;
  try {
    res = await fetchFn(url, { headers: HEADERS });
  } catch (e) {
    throw new CatalogSyncError(
      `no connection to ${new URL(url).host} (${e?.cause?.code ?? e?.message ?? e}). Behind a proxy, set NODE_USE_ENV_PROXY=1 ` +
        'with HTTPS_PROXY, or download the two files by hand and run: npm run sync:catalog -- --from <folder>'
    );
  }
  if (!res.ok) throw new CatalogSyncError(`${url} answered HTTP ${res.status}`);
  return kind === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

/** The commit `main` points at now: { sha, date }. */
export async function latestCommit(fetchFn = fetch) {
  const body = await get(fetchFn, `${API}/commits/main`);
  if (!SHA.test(body?.sha ?? '')) throw new CatalogSyncError('the upstream answered no commit id');
  return { sha: body.sha, date: body.commit?.committer?.date ?? null };
}

/** Every release the upstream offers at `ref`: [{ release, file, size }], sorted by name. */
export async function listReleases(fetchFn = fetch, ref = 'main') {
  const body = await get(fetchFn, `${API}/contents/src?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(body)) throw new CatalogSyncError('the upstream src/ listing is not a list');
  return body
    .filter((e) => e?.type === 'file' && releaseOfFile(e.name))
    .map((e) => ({ release: releaseOfFile(e.name), file: e.name, size: e.size ?? null }))
    .sort((a, b) => a.release.localeCompare(b.release));
}

/**
 * Validate one downloaded file before it may replace anything: it parses, it carries the list it
 * is named for, the list is not empty, and it states its format. Returns what PROVENANCE records.
 */
export function validateCatalogFile(name, bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new CatalogSyncError(`${name} is not JSON (${e.message})`);
  }
  const key = name === CLASSIFICATIONS_FILE ? 'objectClassifications' : 'objectReleaseInfo';
  const rows = parsed?.[key];
  if (!Array.isArray(rows) || !rows.length) throw new CatalogSyncError(`${name} carries no ${key} rows`);
  if (parsed.formatVersion === undefined) throw new CatalogSyncError(`${name} states no formatVersion`);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    rows: rows.length,
    formatVersion: String(parsed.formatVersion),
    bytes: bytes.length,
  };
}

/** Swap a staged folder in by rename; the current one becomes `<dir>.prev`. */
function swapIn(dir, staged) {
  const prev = `${dir}.prev`;
  if (fs.existsSync(dir)) {
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(dir, prev);
  }
  try {
    fs.renameSync(staged, dir);
  } catch (e) {
    // Put the working copy back: a failed swap must leave the old catalogue in place.
    if (fs.existsSync(prev) && !fs.existsSync(dir)) fs.renameSync(prev, dir);
    throw e;
  }
}

const readProvenance = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Bring the catalogue of `release` into `dir`.
 *   from      a folder holding the two files (a manual download) -- no network at all
 *   fetchFn   injectable for tests
 * Returns { status: 'installed' | 'unchanged', release, commit, files }.
 */
export async function syncCatalog({ release, dir, from = null, fetchFn = fetch, now = () => new Date() }) {
  if (!RELEASE_RE.test(String(release ?? ''))) {
    throw new CatalogSyncError(
      `no catalogue release chosen (got '${release ?? ''}'): npm run config -- set catalog.release <release>; ` +
        'npm run sync:catalog -- --list shows the releases SAP publishes'
    );
  }
  const names = [releaseFileName(release), CLASSIFICATIONS_FILE];
  const current = readProvenance(dir);
  let commit = null;
  const bytes = {};

  if (from) {
    for (const name of names) {
      const file = path.join(from, name);
      if (!fs.existsSync(file)) throw new CatalogSyncError(`${file} not found (expected ${names.join(' and ')})`);
      bytes[name] = fs.readFileSync(file);
    }
  } else {
    commit = await latestCommit(fetchFn);
    if (current?.release === release && current?.upstreamCommit === commit.sha && names.every((n) => fs.existsSync(path.join(dir, n)))) {
      return { status: 'unchanged', release, commit: commit.sha, files: current.files };
    }
    for (const name of names) bytes[name] = await get(fetchFn, `${RAW}/${commit.sha}/src/${name}`, 'bytes');
  }

  const files = Object.fromEntries(names.map((n) => [n, validateCatalogFile(n, bytes[n])]));
  const provenance = {
    upstream: `https://github.com/${UPSTREAM}`,
    viewer: VIEWER,
    licence: 'Apache-2.0 (SAP SE or an SAP affiliate company and contributors)',
    release,
    upstreamCommit: commit?.sha ?? null,
    upstreamCommitDate: commit?.date ?? null,
    source: from ? 'manual download (--from)' : 'raw.githubusercontent.com at upstreamCommit',
    syncedAt: now().toISOString(),
    files,
  };

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staged = `${dir}.new`;
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged);
  for (const name of names) fs.writeFileSync(path.join(staged, name), bytes[name]);
  fs.writeFileSync(path.join(staged, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  swapIn(dir, staged);
  return { status: 'installed', release, commit: provenance.upstreamCommit, files, previous: current?.files ?? null };
}

/** The installed catalogue's state, for --check and doctor. */
export const checkCatalog = (dir, release, opts) => catalogStatus(release ? path.join(dir, releaseFileName(release)) : null, { release, ...opts });
