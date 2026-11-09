// Download or refresh the Clean Core catalogue into the state directory.
//
//   npm run sync:catalog                      the release in catalog.release, at upstream main
//   npm run sync:catalog -- --list            the releases SAP publishes
//   npm run sync:catalog -- --check           what is installed and how old it is (no network)
//   npm run sync:catalog -- --from <folder>   install two files downloaded by hand (no network)
//   npm run sync:catalog -- --release <r>     one-off release, without changing the setting
//
// Run by hand (monthly is a sensible cadence), never during a session: the catalogue is release
// data, the answers change with it, and refreshing it is a decision. lib/catalog-sync.mjs says why
// it is a copy and not a live query, and why it lives outside the repository.

import { offlineConfig, stateDir } from '../lib/config.mjs';
import { syncCatalog, listReleases, checkCatalog, CatalogSyncError } from '../lib/catalog-sync.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? '' : undefined;
};

async function main() {
  stateDir(); // creates it, and refuses a state directory inside a git work tree
  const cfg = offlineConfig();
  const release = flag('release') || cfg.catalogRelease;
  const dir = cfg.paths.catalogDir;

  if (argv.includes('--list')) {
    const rows = await listReleases();
    for (const r of rows) console.log(`${r.release.padEnd(14)} ${r.file.padEnd(40)} ${r.size ? `${Math.round(r.size / 1e6)} MB` : ''}`);
    console.log(`\n${rows.length} release(s). Choose the one matching the system: npm run config -- set catalog.release <release>`);
    return 0;
  }

  if (argv.includes('--check')) {
    const s = checkCatalog(dir, release);
    if (!s.installed) {
      console.log(`not installed: ${s.reason}`);
      return 1;
    }
    console.log(`release ${s.release} | commit ${s.commit ?? '(manual copy)'} | synced ${s.syncedAt ?? '?'} | ${s.ageDays ?? '?'} day(s) old`);
    if ((s.ageDays ?? 0) > 35) console.log('older than 35 days: run npm run sync:catalog');
    return 0;
  }

  const from = flag('from');
  const r = await syncCatalog({ release, dir, from: from || null });
  if (r.status === 'unchanged') {
    console.log(`unchanged: release ${r.release} is already at upstream commit ${r.commit.slice(0, 12)}.`);
  } else {
    for (const [name, f] of Object.entries(r.files)) {
      const before = r.previous?.[name]?.rows;
      console.log(`${name}: ${f.rows} rows${before !== undefined ? ` (was ${before})` : ''}, format ${f.formatVersion}`);
    }
    console.log(`installed release ${r.release}${r.commit ? ` at ${r.commit.slice(0, 12)}` : ' (manual copy)'} into ${dir}; previous copy kept as catalog.prev.`);
  }
  return 0;
}

// process.exitCode, never process.exit(): exiting with fetch sockets still open trips a libuv
// assertion on Windows.
try {
  process.exitCode = await main();
} catch (e) {
  console.error(e instanceof CatalogSyncError ? e.message : `sync:catalog failed: ${e?.message ?? e}`);
  process.exitCode = 1;
}
