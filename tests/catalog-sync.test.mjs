// The catalogue lives outside the repository and is refreshed on purpose. These tests drive the
// download with a fake fetch: no network, no GitHub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncCatalog, listReleases, validateCatalogFile, checkCatalog, CatalogSyncError, API, RAW } from '../lib/catalog-sync.mjs';
import { catalogStatus, releaseFileName, releaseOfFile, catalogMissingGap, CatalogMissing, VIEWER } from '../lib/catalog.mjs';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const release = (rows = 2) => JSON.stringify({ formatVersion: '1', objectReleaseInfo: Array.from({ length: rows }, (_, i) => ({ tadirObjName: `I_X${i}`, state: 'released' })) });
const classif = JSON.stringify({ formatVersion: '2', objectClassifications: [{ objectKey: 'BAPI_X', state: 'classicAPI' }] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'catsync-'));

/** A fetch that answers from a map of URL -> body, and records what was asked. */
function fakeFetch(map) {
  const asked = [];
  const fn = async (url) => {
    asked.push(url);
    if (!(url in map)) return { ok: false, status: 404 };
    const body = map[url];
    return {
      ok: true,
      status: 200,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer,
    };
  };
  return { fn, asked };
}
const upstream = (sha, rows = 2) => ({
  [`${API}/commits/main`]: { sha, commit: { committer: { date: '2026-11-03T13:49:35Z' } } },
  [`${RAW}/${sha}/src/objectReleaseInfo_PCE2023_0.json`]: release(rows),
  [`${RAW}/${sha}/src/objectClassifications_SAP.json`]: classif,
});

test('the release file names follow upstream: Latest is the one without an underscore', () => {
  assert.equal(releaseFileName('Latest'), 'objectReleaseInfoLatest.json');
  assert.equal(releaseFileName('PCE2025_2'), 'objectReleaseInfo_PCE2025_2.json');
  assert.equal(releaseOfFile('objectReleaseInfo_PCELatest.json'), 'PCELatest');
  assert.equal(releaseOfFile('objectReleaseInfoLatest.json'), 'Latest');
  assert.equal(releaseOfFile('objectReleaseInfo_PCELatest.toon'), null, 'the TOON pilot files are not catalogues here');
});

test('a sync downloads both files AT the resolved commit, records provenance, and a rerun is unchanged', async () => {
  const dir = path.join(tmp(), 'catalog');
  const { fn, asked } = fakeFetch(upstream(SHA1));
  const r = await syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fn, now: () => new Date('2026-11-08T00:00:00Z') });
  assert.equal(r.status, 'installed');
  assert.ok(asked.every((u) => u === `${API}/commits/main` || u.startsWith(`${RAW}/${SHA1}/`)), 'never a moving ref');
  const prov = JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8'));
  assert.equal(prov.upstreamCommit, SHA1);
  assert.equal(prov.release, 'PCE2023_0');
  assert.equal(prov.viewer, VIEWER);
  assert.equal(prov.files['objectReleaseInfo_PCE2023_0.json'].rows, 2);
  assert.match(prov.files['objectClassifications_SAP.json'].sha256, /^[0-9a-f]{64}$/);

  const again = fakeFetch(upstream(SHA1));
  const r2 = await syncCatalog({ release: 'PCE2023_0', dir, fetchFn: again.fn });
  assert.equal(r2.status, 'unchanged');
  assert.deepEqual(again.asked, [`${API}/commits/main`], 'nothing is downloaded when the commit did not move');
});

test('a new upstream commit replaces the copy and keeps the previous one as catalog.prev', async () => {
  const dir = path.join(tmp(), 'catalog');
  await syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fakeFetch(upstream(SHA1)).fn });
  const r = await syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fakeFetch(upstream(SHA2, 5)).fn });
  assert.equal(r.status, 'installed');
  assert.equal(r.previous['objectReleaseInfo_PCE2023_0.json'].rows, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8')).upstreamCommit, SHA2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(`${dir}.prev`, 'PROVENANCE.json'), 'utf8')).upstreamCommit, SHA1);
});

test('a broken download never replaces a working catalogue', async () => {
  const dir = path.join(tmp(), 'catalog');
  await syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fakeFetch(upstream(SHA1)).fn });
  const bad = upstream(SHA2);
  bad[`${RAW}/${SHA2}/src/objectClassifications_SAP.json`] = '{"formatVersion":"2","objectClassifications":[]}';
  await assert.rejects(() => syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fakeFetch(bad).fn }), /carries no objectClassifications rows/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8')).upstreamCommit, SHA1);
  const missing = upstream(SHA2);
  delete missing[`${RAW}/${SHA2}/src/objectReleaseInfo_PCE2023_0.json`];
  await assert.rejects(() => syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fakeFetch(missing).fn }), /HTTP 404/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROVENANCE.json'), 'utf8')).upstreamCommit, SHA1);
});

test('no release chosen, no connection, a bad file: each is refused with the way out', async () => {
  await assert.rejects(() => syncCatalog({ release: undefined, dir: tmp() }), (e) => e instanceof CatalogSyncError && /catalog\.release/.test(e.message));
  const offline = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  await assert.rejects(() => syncCatalog({ release: 'PCE2023_0', dir: tmp(), fetchFn: offline }), /--from <folder>/);
  assert.throws(() => validateCatalogFile('objectReleaseInfo_X.json', Buffer.from('not json')), /not JSON/);
  assert.throws(() => validateCatalogFile('objectReleaseInfo_X.json', Buffer.from('{"objectReleaseInfo":[{}]}')), /formatVersion/);
});

test('--from installs a manual download with no network at all', async () => {
  const src = tmp();
  fs.writeFileSync(path.join(src, 'objectReleaseInfo_PCE2023_0.json'), release(3));
  fs.writeFileSync(path.join(src, 'objectClassifications_SAP.json'), classif);
  const dir = path.join(tmp(), 'catalog');
  const noNet = async () => assert.fail('no network for --from');
  const r = await syncCatalog({ release: 'PCE2023_0', dir, from: src, fetchFn: noNet });
  assert.equal(r.status, 'installed');
  assert.equal(r.commit, null);
  await assert.rejects(() => syncCatalog({ release: 'PCE2025_2', dir, from: src, fetchFn: noNet }), /objectReleaseInfo_PCE2025_2\.json not found/);
});

test('--list keeps only release files, sorted', async () => {
  const { fn } = fakeFetch({
    [`${API}/contents/src?ref=main`]: [
      { type: 'file', name: 'objectReleaseInfo_PCELatest.json', size: 12 },
      { type: 'file', name: 'objectClassifications_SAP.json', size: 2 },
      { type: 'file', name: 'objectReleaseInfo_PCELatest.toon', size: 9 },
      { type: 'dir', name: 'partner' },
      { type: 'file', name: 'objectReleaseInfoLatest.json', size: 10 },
    ],
  });
  assert.deepEqual((await listReleases(fn)).map((r) => r.release), ['Latest', 'PCELatest']);
});

test('the installed catalogue reports its age, and a missing one says how to get it', async () => {
  const dir = path.join(tmp(), 'catalog');
  assert.equal(checkCatalog(dir, null).installed, false);
  assert.match(checkCatalog(dir, 'PCE2023_0').reason, /does not exist/);
  await syncCatalog({ release: 'PCE2023_0', dir, fetchFn: fakeFetch(upstream(SHA1)).fn, now: () => new Date('2026-10-01T00:00:00Z') });
  const s = checkCatalog(dir, 'PCE2023_0', { now: Date.parse('2026-11-08T00:00:00Z') });
  assert.equal(s.installed, true);
  assert.equal(s.ageDays, 38);
  assert.equal(s.commit, SHA1);
  const missing = catalogStatus(null, { release: null });
  const err = new CatalogMissing(missing);
  assert.match(err.message, /npm run sync:catalog/);
  assert.equal(catalogMissingGap(missing).code, 'CATALOG_MISSING');
});
