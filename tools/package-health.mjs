// adt_package_health -- one Clean Core summary of a package, composed of reads this server
// already makes.
//
// The question: "how healthy is this package for Clean Core?" -- which today takes a Clean Core
// scan, then a syntax check per class and program, then reading both answers side by side for
// what each could not see. This tool runs them on ONE listing of the package and answers:
//
//   cleanCore  what the CDS views consume, A/B/C/D against SAP's catalogue (adt_clean_core_scan's
//              own run, so its findings and gaps are the same)
//   syntax     the stored active version of each class and program, checked (adt_syntax_check's
//              own check run), at most `maxChecks` of them
//   atc        NOT run: whether an ATC run accepts a package as its object set is not measured
//              (docs/backlog.md); adt_atc_run checks one object
//
// Nothing is summarised about what was not read. `complete` is true only when every part read
// everything it was asked to read; a part that could not run says why and counts as incomplete,
// never as clean.

import { listPackage } from '../lib/package-sources.mjs';
import { buildCheckBody } from '../lib/syntax-check.mjs';
import { CatalogMissing } from '../lib/catalog.mjs';
import { progressOf } from '../lib/tool-meta.mjs';
import { runCleanCoreScan } from './clean-core-scan.mjs';
import { checkStored } from './syntax-check.mjs';

export const CHECK_TYPES = Object.freeze(['CLAS/OC', 'PROG/P']);
export const DEFAULT_MAX_CHECKS = 20;
export const MAX_CHECKS = 50;
const TOOL = 'adt_package_health';
const FINDINGS_SHOWN = 20;

const capOf = (value) => {
  if (value === undefined || value === null) return DEFAULT_MAX_CHECKS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHECKS) throw new Error(`maxChecks must be an integer from 1 to ${MAX_CHECKS}; got ${value}.`);
  return n;
};

/** The syntax half: the stored active version of each class and program, one check run each. */
export async function checkPackage(cfg, session, journal, listing, { max, signal, progress = () => {} } = {}) {
  const candidates = listing.objects
    .filter((o) => CHECK_TYPES.includes(o.type))
    .sort((a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`));
  const todo = candidates.slice(0, max);
  const out = { candidates: candidates.length, checked: 0, clean: 0, withMessages: [], notChecked: [], skipped: candidates.length - todo.length, cancelled: false };
  for (const [i, o] of todo.entries()) {
    if (signal?.aborted) {
      out.cancelled = true;
      out.skipped += todo.length - i;
      break;
    }
    const subject = `${o.type} ${o.name}`;
    let verdict;
    try {
      if (!o.uri) throw new Error('the package listing gave no URI for it');
      verdict = await checkStored(cfg, session, journal, { subject, body: buildCheckBody(o.uri, 'active'), version: 'active', tool: TOOL });
    } catch (e) {
      // Not swallowed: the object is named in the answer as not checked, with the reason, and
      // a failed POST has already filed SYNTAX_NOT_CHECKED.
      verdict = { checked: false, reason: String(e?.message ?? e).slice(0, 200) };
    }
    progress(i + 1, todo.length, subject);
    if (!verdict.checked) {
      out.notChecked.push({ object: subject, package: o.package, reason: verdict.reason });
      continue;
    }
    out.checked += 1;
    if (verdict.clean) out.clean += 1;
    else out.withMessages.push({ object: subject, package: o.package, byType: verdict.byType, first: verdict.messages.slice(0, 3) });
  }
  if (out.skipped) {
    journal?.gap?.({
      code: 'SCAN_AT_CAP',
      subject: `${TOOL} ${listing.packages[0] ?? ''} syntax`,
      detail: `${out.skipped} of ${out.candidates} class(es) and program(s) not checked${out.cancelled ? ' (cancelled)' : ' (maxChecks reached)'}`,
      impact: 'the syntax part covers part of the package: unchecked is not clean',
      fallback: `raise maxChecks (at most ${MAX_CHECKS}), or check a sub-package`,
    });
  }
  out.complete = !out.notChecked.length && !out.skipped;
  return out;
}

export async function runPackageHealth(cfg, session, args = {}, journal = null, extra = {}) {
  const pkg = String(args.package ?? '').trim().toUpperCase();
  if (!pkg) throw new Error('adt_package_health needs a package.');
  if (!session?.raw) throw new Error('this session has no raw client: the syntax checks cannot be asked.');
  const max = capOf(args.maxChecks);
  const progress = progressOf(extra);
  const listing = await listPackage(session.api, pkg, { recursive: args.recursive !== false, signal: extra.signal });

  let cleanCore;
  try {
    const scan = await runCleanCoreScan(cfg, session.api, { package: pkg, recursive: args.recursive, maxObjects: args.maxObjects, minLevel: 'B' }, journal, {
      ...extra,
      listing,
      tool: TOOL,
    });
    cleanCore = {
      read: true,
      complete: scan.scope.complete,
      views: scan.scope.objects,
      viewsRead: scan.scope.read,
      levels: scan.levels,
      findings: scan.findings.slice(0, FINDINGS_SHOWN),
      ...(scan.findings.length > FINDINGS_SHOWN ? { moreFindings: scan.findings.length - FINDINGS_SHOWN } : {}),
      ...(scan.scope.notRead ? { notRead: scan.scope.notRead } : {}),
      ...(scan.scope.skipped ? { skipped: scan.scope.skipped } : {}),
    };
  } catch (e) {
    if (!(e instanceof CatalogMissing)) throw e;
    // Not swallowed: CATALOG_MISSING is already filed, and the part says it did not run.
    cleanCore = { read: false, complete: false, reason: e.message };
  }

  const syntax = await checkPackage(cfg, session, journal, listing, { max, signal: extra.signal, progress });
  const listed = !listing.notListed.length;
  return {
    package: pkg,
    packages: listing.packages.length,
    objects: listing.objects.length,
    ...(listed ? {} : { notListed: listing.notListed }),
    complete: listed && cleanCore.complete && syntax.complete,
    cleanCore,
    syntax,
    atc: {
      read: false,
      reason: 'not run: whether an ATC run accepts a package as its object set is not measured; adt_atc_run checks one object',
    },
    reminder:
      'complete false means a part did not read everything: what was not read is not clean. ' +
      'Level B is reported, not recommended. The syntax part checks the stored active version.',
  };
}

export function packageHealthTool(cfg, session, journal) {
  return {
    definition: {
      name: TOOL,
      description:
        'Clean Core health of a package in one answer, on one listing: the Clean Core level of ' +
        'what its CDS views consume (as adt_clean_core_scan) and the syntax check of the stored ' +
        'active version of its classes and programs (as adt_syntax_check). One call per view ' +
        'and per check: keep the package small. ATC is not run. Needs the catalogue for the ' +
        'Clean Core part; without it that part says so and the rest still runs.',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package, e.g. ZDEMO_SALES' },
          recursive: { type: 'boolean', description: 'Include sub-packages (default true)' },
          maxObjects: { type: 'integer', minimum: 1, maximum: 300, description: 'Max CDS sources read (default 100)' },
          maxChecks: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_CHECKS,
            description: `Max classes and programs checked (default ${DEFAULT_MAX_CHECKS})`,
          },
        },
        required: ['package'],
      },
    },
    async handler(args = {}, extra = {}) {
      const out = await runPackageHealth(cfg, session, args, journal, extra);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  };
}
