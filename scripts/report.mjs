#!/usr/bin/env node
// npm run report -- [--since 2026-09-01] [--json] [--dir <path>] [--runs [--audit <dir>]]
//
// Reads logs/ back: how the server performed, what it found in the workspace, and where
// it could not answer. No SAP logon, no network -- the journal is on disk.
//
// The default output is Markdown because the destination of a finding is a backlog item
// somebody pastes somewhere, and of a gap a line in this repository's own plan.

import { offlineConfig } from '../lib/config.mjs';
import { reportFromDisk, renderMarkdown } from '../lib/report.mjs';
import { runsFromAudit, renderRuns, auditPath } from '../lib/audit-runs.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const cfg = offlineConfig();
const dir = flag('dir') ?? cfg.paths.logs;
const report = reportFromDisk(dir, { since: flag('since') });

// --runs crosses from the journal into the AUDIT TRAIL, and it is opt-in for that reason:
// docs/security.md keeps the two artefacts apart (analysis / evidence), so the default
// report reads only logs/ and the crossing is something somebody asks for.
const runs = argv.includes('--runs')
  ? runsFromAudit(auditPath(flag('audit')), { since: flag('since') })
  : null;

if (argv.includes('--json')) {
  console.log(JSON.stringify(runs ? { ...report, runs } : report, null, 2));
} else {
  console.log(renderMarkdown(report));
  if (runs) console.log(`
${renderRuns(runs)}`);
  if (!report.quality.calls && !report.totals.findings) {
    // An empty report and a journal that was never written look identical, and the
    // difference matters: one says "clean", the other says "you measured nothing".
    console.log(`(nothing journaled under ${dir} yet — the journal fills as the server answers)`);
  }
}
