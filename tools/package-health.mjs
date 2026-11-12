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
//   atc        with `atc: true`, one ATC run of the default variant over the whole package, as
//              the IDE runs it (the package as one virtual-folders object reference, measured
//              2026-11-10); the run leaves a result worklist, like adt_atc_run. Off by default:
//              it is the slowest part and the one that leaves something on the server
//
// Nothing is summarised about what was not read. `complete` is true only when every part read
// everything it was asked to read; a part that could not run says why and counts as incomplete,
// never as clean.

import { listPackage, packageIncomplete } from '../lib/package-sources.mjs';
import { finish } from '../lib/completeness.mjs';
import { buildCheckBody } from '../lib/syntax-check.mjs';
import { CatalogMissing } from '../lib/catalog.mjs';
import { progressOf } from '../lib/tool-meta.mjs';
import { buildPackageRunBody, DEFAULT_VARIANT } from '../lib/atc.mjs';
import { runCleanCoreScan } from './clean-core-scan.mjs';
import { checkStored } from './syntax-check.mjs';
import { runVariant } from './atc.mjs';

export const CHECK_TYPES = Object.freeze(['CLAS/OC', 'PROG/P']);
export const DEFAULT_MAX_CHECKS = 20;
export const MAX_CHECKS = 50;
const TOOL = 'adt_package_health';
const DEFAULT_FINDINGS = 20;
export const MAX_FINDINGS = 200;
/**
 * Types that carry ABAP source and that no part of this tool checks: counted as out of scope,
 * so a package of interfaces and function groups never reads as healthy for being unchecked.
 */
export const SOURCE_NOT_CHECKED = Object.freeze(['INTF/OI', 'FUGR/F', 'PROG/I', 'BDEF/BDO']);

const capOf = (value) => {
  if (value === undefined || value === null) return DEFAULT_MAX_CHECKS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHECKS) throw new Error(`maxChecks must be an integer from 1 to ${MAX_CHECKS}; got ${value}.`);
  return n;
};

/** The syntax half: the stored active version of each class and program, one check run each. */
export async function checkPackage(cfg, session, journal, listing, { max, offset = 0, signal, progress = () => {} } = {}) {
  const candidates = listing.objects
    .filter((o) => CHECK_TYPES.includes(o.type))
    .sort((a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`));
  // A page of the candidates, in name order: `offset` starts after the ones already checked.
  const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const todo = candidates.slice(from, from + max);
  const out = { candidates: candidates.length, offset: from, checked: 0, clean: 0, withMessages: [], notChecked: [], skipped: Math.max(0, candidates.length - from - todo.length), cancelled: false };
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
  // Only the cap leaves a next page; a cancel is asked again from the same offset.
  if (out.skipped && !out.cancelled) out.next = { checksOffset: from + todo.length };
  if (from) out.notAsked = from;
  out.complete = !out.notChecked.length && !out.skipped && !from;
  return out;
}

/** The ATC half: one run of the default variant over the package, summarised. Never "clean" unread. */
export async function atcPackage(cfg, session, journal, pkg, { maxFindings = DEFAULT_FINDINGS } = {}) {
  let body;
  try {
    body = buildPackageRunBody({ packageName: pkg });
  } catch (e) {
    // Not swallowed: the part says why it did not run (a package name the run is not measured on).
    return { read: false, complete: false, reason: e.message };
  }
  let run;
  try {
    run = await runVariant(cfg, session, journal, DEFAULT_VARIANT, { subject: `DEVC/K ${pkg}`, body, tool: TOOL });
  } catch (e) {
    // Not swallowed: runVariant filed ATC_NOT_RUN or ATC_RESULT_NOT_READ before throwing.
    return { read: false, complete: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
  // A run whose worklist names no object checked nothing: zero findings there is not a clean
  // package, so the part is incomplete and says why.
  const checkedNothing = run.objectsChecked === 0;
  return {
    read: true,
    complete: run.objectSetIsComplete === true && !checkedNothing,
    variant: run.variant,
    worklistId: run.worklistId,
    objectsChecked: run.objectsChecked,
    ...(checkedNothing ? { reason: 'the worklist names no object: the run checked nothing, so no finding is not a clean package' } : {}),
    count: run.count,
    byPriority: run.byPriority,
    findings: run.findings.slice(0, maxFindings),
    returned: Math.min(run.findings.length, maxFindings),
    truncated: run.count > Math.min(run.findings.length, maxFindings),
    ...(run.count > Math.min(run.findings.length, maxFindings) ? { narrowBy: ['maxFindings', 'package'] } : {}),
    note: 'the findings of one run over the package, read from the worklist it left (adt_atc_run reads one object)',
    // The run's own cuts and failures, except our findings cap (said by this part below).
    runIncomplete: run.incomplete.filter((i) => !(i.list === 'findings' && i.code === 'CAP_REACHED')),
  };
}

export async function runPackageHealth(cfg, session, args = {}, journal = null, extra = {}) {
  const pkg = String(args.package ?? '').trim().toUpperCase();
  if (!pkg) throw new Error('adt_package_health needs a package.');
  if (!session?.raw) throw new Error('this session has no raw client: the syntax checks cannot be asked.');
  const max = capOf(args.maxChecks);
  const maxFindings = Number.isInteger(args.maxFindings) ? Math.min(Math.max(args.maxFindings, 1), MAX_FINDINGS) : DEFAULT_FINDINGS;
  const progress = progressOf(extra);
  const listing = await listPackage(session.api, pkg, { recursive: args.recursive !== false, signal: extra.signal });
  // The listing is shared by every part: its limits are said once, here.
  const incomplete = packageIncomplete({ notListed: listing.notListed, limits: listing.limits });

  let cleanCore;
  try {
    const scan = await runCleanCoreScan(cfg, session.api, { package: pkg, recursive: args.recursive, maxObjects: args.maxObjects, minLevel: 'B' }, journal, {
      ...extra,
      listing,
      tool: TOOL,
    });
    const total = scan.findingsPage.total;
    const shown = scan.findings.slice(0, maxFindings);
    cleanCore = {
      read: true,
      complete: scan.complete,
      views: scan.scope.objects,
      viewsRead: scan.scope.read,
      levels: scan.levels,
      absent: scan.absent,
      findings: shown,
      findingsTotal: total,
      truncated: total > shown.length,
      ...(total > shown.length ? { next: { tool: 'adt_clean_core_scan', findingsOffset: 0 }, narrowBy: ['maxFindings'] } : {}),
      ...(scan.scope.notRead ? { notRead: scan.scope.notRead } : {}),
      ...(scan.scope.skipped ? { skipped: scan.scope.skipped } : {}),
    };
    // The scan's own entries, minus the listing's (said once above), under this part's name.
    for (const i of scan.incomplete) {
      if (i.list === 'packages' || i.list === 'findings') continue;
      incomplete.push({ ...i, list: `cleanCore.${i.list}`, ...(i.next ? { next: { tool: 'adt_clean_core_scan', ...i.next } } : {}) });
    }
    if (cleanCore.truncated) incomplete.push({ list: 'cleanCore.findings', code: 'CAP_REACHED', returned: shown.length, total, next: { tool: 'adt_clean_core_scan', findingsOffset: 0 }, narrowBy: ['maxFindings'] });
  } catch (e) {
    if (!(e instanceof CatalogMissing)) throw e;
    // Not swallowed: CATALOG_MISSING is already filed, and the part says it did not run.
    cleanCore = { read: false, complete: false, reason: e.message };
    incomplete.push({ list: 'cleanCore', code: 'NOT_READ', reason: 'the Clean Core catalogue is missing: npm run sync:catalog' });
  }

  const syntax = await checkPackage(cfg, session, journal, listing, { max, offset: args.checksOffset, signal: extra.signal, progress });
  if (syntax.notChecked.length) incomplete.push({ list: 'syntax', code: 'NOT_READ', count: syntax.notChecked.length, reason: 'see syntax.notChecked' });
  if (syntax.skipped) {
    incomplete.push(
      syntax.cancelled
        ? { list: 'syntax', code: 'CANCELLED', count: syntax.skipped }
        : { list: 'syntax', code: 'CAP_REACHED', returned: syntax.checked + syntax.notChecked.length, total: syntax.candidates, next: syntax.next }
    );
  }
  if (syntax.notAsked) incomplete.push({ list: 'syntax', code: 'CAP_REACHED', count: syntax.notAsked, reason: 'before checksOffset: checked by an earlier page' });

  const asked = args.atc === true;
  let atc;
  if (!asked) atc = { asked: false, read: false, reason: 'not asked: pass atc: true for one ATC run over the package (it leaves a result worklist)' };
  else if (extra.signal?.aborted) {
    atc = { asked: true, read: false, complete: false, reason: 'cancelled before the ATC run' };
    incomplete.push({ list: 'atc', code: 'CANCELLED' });
  } else {
    atc = { asked: true, ...(await atcPackage(cfg, session, journal, pkg, { maxFindings })) };
    if (!atc.read) incomplete.push({ list: 'atc', code: 'NOT_READ', reason: atc.reason });
    else if (!atc.complete && atc.reason) incomplete.push({ list: 'atc', code: 'NOT_READ', reason: atc.reason });
    for (const i of atc.runIncomplete ?? []) incomplete.push({ ...i, list: `atc.${i.list}` });
    if (atc.truncated) incomplete.push({ list: 'atc.findings', code: 'CAP_REACHED', returned: atc.returned, total: atc.count, narrowBy: ['maxFindings', 'package'], reason: 'one more page is one more ATC run: raise maxFindings, or run a sub-package' });
  }

  // What no part checks, by type: never left to read as clean.
  const notCovered = {};
  for (const o of listing.objects) if (SOURCE_NOT_CHECKED.includes(o.type)) notCovered[o.type] = (notCovered[o.type] ?? 0) + 1;
  const outOfScope = Object.values(notCovered).reduce((n, c) => n + c, 0);
  if (outOfScope) incomplete.push({ list: 'objects', code: 'OUT_OF_SCOPE', count: outOfScope, reason: 'source types no part checks: see notCovered' });

  return finish({
    package: pkg,
    packages: listing.packages.length,
    objects: listing.objects.length,
    ...(listing.notListed.length ? { notListed: listing.notListed } : {}),
    notCovered,
    cleanCore,
    syntax,
    atc,
    reminder:
      'complete false means a part did not read everything: what was not read is not clean. ' +
      'Level B is reported, not recommended. The syntax part checks the stored active version.',
  }, incomplete);
}

export function packageHealthTool(cfg, session, journal) {
  return {
    definition: {
      name: TOOL,
      description:
        'Clean Core health of a package in one answer, on one listing: the Clean Core level of ' +
        'what its CDS views consume (as adt_clean_core_scan) and the syntax check of the stored ' +
        'active version of its classes and programs (as adt_syntax_check). One call per view ' +
        'and per check: keep the package small. `atc: true` adds one ATC run over the package ' +
        '(default variant; leaves a result worklist). Needs the catalogue for the ' +
        'Clean Core part; without it that part says so and the rest still runs.',
      inputSchema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package, e.g. ZDEMO_SALES' },
          recursive: { type: 'boolean', description: 'Include sub-packages (default true)' },
          maxObjects: { type: 'integer', minimum: 1, maximum: 300, description: 'Max CDS sources read (default 100)' },
          atc: { type: 'boolean', description: 'Also one ATC run over the package (default false)' },
          maxFindings: { type: 'integer', minimum: 1, maximum: MAX_FINDINGS, description: `Findings shown per part (default ${DEFAULT_FINDINGS}, at most ${MAX_FINDINGS})` },
          checksOffset: { type: 'integer', minimum: 0, description: 'First class or program to check, in name order: `syntax.next.checksOffset` of the previous answer' },
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
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  };
}
