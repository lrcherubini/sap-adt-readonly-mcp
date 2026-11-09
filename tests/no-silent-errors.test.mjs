// No silent errors.
//
// The journal turned every declared degradation into a code. That only means something
// if the codes are actually WIRED -- and when this file was written, 7 of the 23
// registered codes were emitted by nothing at all: five gaps (CATALOG_MISS,
// CATALOG_PARTIAL, CONCEPT_NO_CANDIDATE, ENHANCEMENTS_NOT_READ,
// BUDGET_EXHAUSTED) and two findings (SRVD_EXPOSURE_MISSING, VH_VARIANT_AVAILABLE). The
// registry described an intention the code did not keep.
//
// So the guard here is structural rather than anecdotal: a code in the registry must
// have an emitter, and a `catch` that discards its error must be one of a short, named
// list of places where discarding is the right answer. Both fail the build when they rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FINDING_CODES, GAP_CODES, EMITTED_BY, ANY_TOOL, SWEEP_TOOLS } from '../lib/journal-codes.mjs';
import { openJournal } from '../lib/journal.mjs';
import { runCleanCoreScan } from '../tools/clean-core-scan.mjs';

const ROOT = path.join(import.meta.dirname, '..');

/** Every non-test source file of the server. */
function sourceFiles(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|\.git|tests|logs|data|coverage)$/.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.name.endsWith('.mjs') && e.name !== 'journal-codes.mjs') out.push(full);
  }
  return out;
}

const FILES = sourceFiles().map((f) => ({
  file: path.relative(ROOT, f).split(path.sep).join('/'),
  text: fs.readFileSync(f, 'utf8'),
}));

test('every registered code is emitted by some module', () => {
  const orphans = [];
  for (const code of [...FINDING_CODES.keys(), ...GAP_CODES.keys()]) {
    if (!FILES.some((f) => f.text.includes(`'${code}'`))) orphans.push(code);
  }
  assert.deepEqual(
    orphans,
    [],
    'a code nobody emits is a promise the server does not keep - wire it or delete it'
  );
});

test('the emitter registry names a module that really emits each code', () => {
  // The two tests above find emitters by matching text, and the second one matches
  // `code: 'X'` specifically -- which is blind to a code that reaches the journal through
  // a lookup table or a ternary. Five do: CC_LEVEL_B/C/D and CC_DEPRECATED come out of
  // CODE_BY_LEVEL in lib/clean-core.mjs, ANNOTATION_HIDDEN_HELD out of a ternary in
  // lib/annotation-detectors.mjs. Naming the module makes the indirect ones checkable.
  const wrong = [];
  for (const [code, origin] of EMITTED_BY) {
    const f = FILES.find((x) => x.file === origin.module);
    if (!f) {
      wrong.push(`${code}: ${origin.module} is not a source file`);
      continue;
    }
    if (!f.text.includes(`'${code}'`)) wrong.push(`${code}: ${origin.module} does not mention it`);
  }
  assert.deepEqual(wrong, [], 'the emitter registry has drifted from the code');
});

test('every registered code says where it comes from, and nothing extra does', () => {
  // Both directions, because a code with no entry silently becomes un-retirable in the
  // report -- classifyStaleness cannot attribute it, so it stays "unknown" forever -- and
  // an entry for a code nobody registered is a route that does not exist.
  const codes = new Set([...FINDING_CODES.keys(), ...GAP_CODES.keys()]);
  assert.deepEqual(
    [...codes].filter((c) => !EMITTED_BY.has(c)),
    [],
    'a code with no emitter entry can never be retired from a report'
  );
  assert.deepEqual([...EMITTED_BY.keys()].filter((c) => !codes.has(c)), []);
  for (const [code, origin] of EMITTED_BY) {
    const tools = origin.tools === ANY_TOOL ? [] : origin.tools;
    // Three legitimate origins, and the point of the assert is that there is no FOURTH: a code
    // must say what re-run bears on it, or it is un-retirable by construction. `script` is for
    // codes emitted outside the tool ledger -- the sweeps under scripts/, which no tool call
    // can ever re-check. The module it names has to exist, so the escape hatch cannot rot.
    assert.ok(
      origin.tools === ANY_TOOL || (Array.isArray(tools) && tools.length) || origin.script,
      `${code} must name at least one tool, ANY_TOOL, or the script that emits it`
    );
    if (origin.script) {
      assert.match(origin.script, /^npm run [a-z:-]+$/, `${code} -> ${origin.script} is not a run`);
      assert.ok(
        fs.existsSync(new URL(`../${origin.module}`, import.meta.url)),
        `${code} names ${origin.module}, which does not exist`
      );
    }
    for (const t of tools) assert.match(t, /^adt_[a-z_]+$/, `${code} -> ${t} is not a tool name`);
  }
});

test('only a sweeping tool can ever retire a finding', () => {
  // The rule the whole staleness split rests on. adt_annotation_chain answers one element
  // per call, so no number of its calls is a census -- treating one as a re-look marked
  // two live defects as no longer reproduced when this was first written.
  for (const t of SWEEP_TOOLS) assert.match(t, /^adt_[a-z_]+_(scan|check)$/, `${t} is a sweep`);
  assert.equal(SWEEP_TOOLS.has('adt_annotation_chain'), false, 'one element per call');
  assert.equal(SWEEP_TOOLS.has('adt_value_help'), false, 'one field per call');
  assert.equal(SWEEP_TOOLS.has('adt_read_source'), false, 'one object per call');
});

test('every emitted code is registered', () => {
  // The other direction. journal.coded() throws on an unregistered code at runtime, but
  // only on the path that actually runs; this catches it without running anything.
  const known = new Set([...FINDING_CODES.keys(), ...GAP_CODES.keys()]);
  const seen = new Set();
  for (const f of FILES) {
    for (const m of f.text.matchAll(/code:\s*'([A-Z][A-Z0-9_]{3,})'/g)) seen.add(m[1]);
  }
  assert.deepEqual([...seen].filter((c) => !known.has(c)), []);
});

test('a catch that discards its error is only allowed where discarding is the answer', () => {
  // `catch {` with no binding cannot report anything, by construction. Each entry below
  // is a place where the thrown thing genuinely carries no information a caller could
  // act on. Everywhere else has to report - to the journal, to the answer, or to stderr.
  const allowed = new Map([
    // Exact counts, not headroom: a budget with slack in it silently absorbs the next one.
    // statSync on a day file not created yet, plus the two in readStream that DO record
    // (into out.unreadable, which reportFromDisk surfaces) -- the regex cannot see that,
    // so they are budgeted rather than exempted.
    ['lib/journal.mjs', 3],
    // absent audit.log -> `missing: true`, and a line that will not parse -> `unreadable++`.
    // Both ARE reported, in the returned shape rather than by the thrown thing; the regex
    // cannot see that, so they are budgeted rather than exempted.
    ['lib/audit-runs.mjs', 2],
    // absent stream dir, unstattable file and undateable audit line for the age plan;
    // the same three again for the selective plan, plus oldestDay's absent stream dir
    ['lib/prune.mjs', 7],
    // the Stop hook: malformed hook input, an untracked file gone between status and read, no
    // stamp yet, a stamp that cannot be written -- each only decides whether the suite reruns
    ['.claude/hooks/stop-check.mjs', 4],
    ['lib/session.mjs', 2], // dropSession + logout during shutdown: nothing left to tell
    ['scripts/prune-logs.mjs', 1], // audit.log absent, and the output says so
    // no PROVENANCE.json: on install it is the first one, in catalogStatus a manual copy whose age
    // is then reported as unknown (ageDays: null) -- both said in the returned shape.
    ['lib/catalog-sync.mjs', 1],
    ['lib/catalog.mjs', 1],
    // text that merely starts with a brace is not JSON: the answer stays text-only, unchanged
    ['lib/tool-meta.mjs', 1],
    // an Origin that is not a URL: the catch RETURNS the refusal (403), the regex cannot see that
    ['lib/mcp-server.mjs', 1],
  ]);
  const offenders = [];
  for (const f of FILES) {
    const bare = [...f.text.matchAll(/\}\s*catch\s*\{/g)].length;
    const budget = allowed.get(f.file) ?? 0;
    if (bare > budget) offenders.push(`${f.file}: ${bare} silent catch(es), ${budget} allowed`);
    // The other direction: a file that stopped discarding leaves its entry behind, and the
    // entry then quietly licenses a NEW one. An allowance nobody uses has to go.
    if (bare < budget) offenders.push(`${f.file}: only ${bare} silent catch(es), ${budget} allowed - lower it`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a new silent catch appeared - report the failure, or list it here with why it carries none'
  );
});

// --- the scanners now say what they could not read ---------------------------

test('a package scan files SOURCE_NOT_READ for an object and for a package it could not read', async () => {
  // The online form of the old bare `continue`: an object whose source does not come back, and a
  // sub-package whose listing fails, each lower the counts -- and a lower count reads cleaner.
  const lines = [];
  const cfg = {
    auditSink: () => {},
    journalSink: (stream, record) => lines.push({ stream, ...record }),
    budget: { reads: 1000 },
    paths: { catalog: path.join(import.meta.dirname, 'fixtures', 'clean-core-release.json') },
  };
  const api = {
    nodeContents: async (_t, pkg) => {
      if (pkg === 'ZDEMO_SUB') throw new Error('403 no authorization for the package');
      return {
        nodes: [
          { OBJECT_NAME: 'ZI_OK', OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zi_ok' },
          { OBJECT_NAME: 'ZI_GONE', OBJECT_TYPE: 'DDLS/DF', OBJECT_URI: '/sap/bc/adt/ddic/ddl/sources/zi_gone' },
          { OBJECT_NAME: 'ZDEMO_SUB', OBJECT_TYPE: 'DEVC/K' },
        ],
      };
    },
    getObjectSource: async (uri) => {
      if (uri.includes('zi_gone')) throw new Error('500 the server dumped');
      return 'define view entity ZI_Ok as select from mara { key matnr }';
    },
  };
  const out = await runCleanCoreScan(cfg, api, { package: 'ZDEMO' }, openJournal(cfg));
  const gaps = lines.filter((l) => l.stream === 'gaps' && l.code === 'SOURCE_NOT_READ').map((l) => l.subject).sort();
  assert.deepEqual(gaps, ['DDLS/DF ZI_GONE', 'DEVC/K ZDEMO_SUB']);
  assert.equal(out.scope.complete, false, 'the counts are a floor, not a total');
  assert.equal(out.scope.read, 1, 'the readable half still came through: degrading is not failing');
});

// --- the journal cannot journal its own failure ------------------------------

test('a journal that cannot write says so on stderr, once, and never breaks the answer', () => {
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let dir;
  try {
    // A logs path that cannot become a directory: a FILE sits where the tree must go.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nolog-'));
    const blocked = path.join(dir, 'logs');
    fs.writeFileSync(blocked, 'not a directory');
    const journal = openJournal({ paths: { logs: blocked } });
    assert.equal(journal.finding({ code: 'CC_DEPRECATED', subject: 'x' }), null);
    assert.equal(journal.finding({ code: 'CC_DEPRECATED', subject: 'y' }), null);
    assert.equal(journal.counts().dropped, 2);
  } finally {
    process.stderr.write = original;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  const warnings = written.filter((w) => w.includes('journal write failed'));
  assert.equal(warnings.length, 1, 'once per process, not once per record');
  assert.match(warnings[0], /UNRECORDED, not clean/);
});
