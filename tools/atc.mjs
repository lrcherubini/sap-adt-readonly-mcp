// adt_atc_run -- run the ATC on ONE object and read its findings, legibly. The second POST
// this server sends and the first that leaves something on the server: a worklist of check
// results (not a repository object, no lock, no transport). The decision, dated 2026-09-14,
// is in docs/security.md.
//
// What it answers: "does this object pass the check variants this installation runs -- say a
// Clean Core governance variant and a development-practice one, next to SAP's DEFAULT -- and if
// not, which finding, which check, which line?" -- the question the official IDE MCP answers with
// "error" and nothing else (measured 2026-09-12). Up to three variants per call, run one after
// the other on the same object, each with its own worklist and its own findings.
//
// What it refuses, before any socket: a variant outside ATC_VARIANTS (the server hands a
// worklist id to any name, measured), an object URI that is not an ADT object URI, more than
// MAX_VERDICTS findings, a class/interface enhancement (ENHO/XH: its URI dumps the server).
//
// Three ADT calls per variant, three audit lines: variant+object, worklist id, worklist id + count.
// Never a finding text. Journal: ATC_NOT_RUN (no run = no verdict), ATC_RESULT_NOT_READ (a
// run without a readable result is not a clean object), SHAPE_DRIFT.

import { record } from '../lib/audit.mjs';
import { progressOf } from '../lib/tool-meta.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { isClasenh, CLASENH_WHERE } from '../lib/object-properties.mjs';
import { finish } from '../lib/completeness.mjs';
import {
  ATC_VARIANTS,
  DEFAULT_VARIANT,
  MAX_VERDICTS,
  DEFAULT_VERDICTS,
  DRIFT_CODE,
  AtcViolation,
  assertVariant,
  buildRunBody,
  atcPost,
  parseRunReply,
  parseWorklist,
  parseCustomizing,
  installSystemVariant,
  parseCheckVariant,
  SCI_VARIANT_NOTE,
} from '../lib/atc.mjs';

/**
 * Read the system check variant once, at start, BEFORE the tools are built: the variant joins
 * the closed set and the tool's schema. One GET on the `atcCustomizing` route, one audit line.
 * A failed read starts the server without it -- DEFAULT and the store's variants only -- and
 * files ATC_SYSTEM_VARIANT_NOT_READ; it never guesses a name.
 */
export async function loadSystemVariant(cfg, session, journal) {
  const fail = (detail) => {
    journal?.gap?.({
      code: 'ATC_SYSTEM_VARIANT_NOT_READ',
      subject: 'atc/customizing',
      detail,
      impact: 'adt_atc_run offers DEFAULT and the store\'s variants only; the system check variant is not among them for this run',
      fallback: 'restart the server; or name the variant with `npm run config -- atc add`',
    });
    return { read: false, installed: null, defaultVariant: DEFAULT_VARIANT, detail };
  };
  if (!session?.raw) return fail('this session has no raw client: atc/customizing cannot be read');
  let out;
  try {
    out = await namedGet(transportFor(session.raw), 'atcCustomizing', {});
  } catch (e) {
    return fail(`HTTP ${e?.status ?? '?'}: ${e?.message}`);
  } finally {
    record(cfg, 'adt_atc_run', 'atc/customizing#systemCheckVariant', out?.bytes ?? 0);
  }
  try {
    return { read: true, ...installSystemVariant(parseCustomizing(out.body).systemCheckVariant) };
  } catch (e) {
    return fail(`${e.name}: ${e.message}`);
  }
}

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

export const MAX_VARIANTS = 3;

/** The variants of one call, validated: `variants` or `variant`, never both; default the configured one. */
export function variantsOf({ variant, variants } = {}) {
  if (variant !== undefined && variant !== null && variants !== undefined && variants !== null) {
    throw new AtcViolation('pass `variants` (a list) or `variant` (one), not both.');
  }
  const asked = variants ?? (variant !== undefined && variant !== null ? [variant] : [DEFAULT_VARIANT]);
  const list = [...new Set(asked.map((v) => assertVariant(v)))];
  if (!list.length) throw new AtcViolation('`variants` needs at least one variant.');
  if (list.length > MAX_VARIANTS) throw new AtcViolation(`at most ${MAX_VARIANTS} variants per call (each run takes seconds and leaves a worklist); got ${list.length}.`);
  return list;
}

export function atcTool(cfg, session, journal) {
  return {
    definition: {
      name: 'adt_atc_run',
      description:
        'Run ATC on ONE object with up to three variants: per finding priority, check, message, ' +
        'include + line, quickfix flags, documentation. Variants: ' +
        [...ATC_VARIANTS].map(([name, why]) => `${name} (${why})`).join('; ') +
        `. Default ${DEFAULT_VARIANT}. ~4 s per variant; each leaves an ATC result worklist, ` +
        'nothing else. `maxFindings` caps the list, never the counts. ENHO/XH is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          objectName: { type: 'string' },
          objectType: { type: 'string', description: 'Optional ADT type, e.g. CLAS/OC, PROG/P' },
          variants: {
            type: 'array',
            items: { type: 'string', enum: [...ATC_VARIANTS.keys()] },
            minItems: 1,
            maxItems: MAX_VARIANTS,
            description: `Up to ${MAX_VARIANTS} check variants, run one after the other (default [${DEFAULT_VARIANT}])`,
          },
          variant: { type: 'string', enum: [...ATC_VARIANTS.keys()], description: 'One variant (shorthand for variants: [variant])' },
          maxFindings: { type: 'integer', description: `1..${MAX_VERDICTS}, default ${DEFAULT_VERDICTS}` },
          includeExempted: { type: 'boolean', description: 'Also list findings under an approved exemption (default false)' },
        },
        required: ['objectName'],
      },
    },
    async handler({ objectName, objectType, variant, variants, maxFindings, includeExempted }, extra = {}) {
      // The fences that need no session: variants and count.
      const list = variantsOf({ variant, variants });
      if (!session?.raw) throw new AtcViolation('this session has no raw client: the ATC cannot be asked.');
      const name = String(objectName ?? '').trim();
      if (!name) throw new AtcViolation('adt_atc_run needs an objectName.');
      const type = objectType ? String(objectType).trim().toUpperCase() : undefined;

      const resolved = await resolveObject(session.api, name, type, 'metadata');
      const { hit, foundBy } = resolved;
      const objectUri = hit['adtcore:uri'];
      const subject = `${hit['adtcore:type']} ${hit['adtcore:name']}`;
      if (isClasenh(hit['adtcore:type'])) {
        throw new AtcViolation(`${subject} is a class/interface enhancement: its ADT resource dumps the server, so no run is sent. ${CLASENH_WHERE}. Run the ATC on the object that USES it instead.`);
      }
      const body = buildRunBody({ uri: objectUri, maxVerdicts: maxFindings });
      const object = { name: hit['adtcore:name'], type: hit['adtcore:type'], package: hit['adtcore:packageName'], uri: objectUri, foundBy };
      const progress = progressOf(extra);

      const runs = [];
      const failures = [];
      for (const [i, v] of list.entries()) {
        if (extra.signal?.aborted) {
          failures.push({ variant: v, error: 'cancelled before this variant ran' });
          continue;
        }
        progress(i, list.length, `ATC ${v} on ${subject}`);
        try {
          runs.push(await runVariant(cfg, session, journal, v, { subject, body, includeExempted }));
        } catch (e) {
          if (list.length === 1) throw e;
          // One variant failing must not hide the others: its gap is already journaled, and
          // the answer says which variant has NO verdict -- never a clean one.
          failures.push({ variant: v, error: `${e.name ?? 'Error'}: ${e.message}` });
        }
      }
      progress(list.length, list.length, 'done');
      if (!runs.length) throw new AtcViolation(`no variant ran on ${subject}: ${failures.map((f) => `${f.variant}: ${f.error}`).join('; ')}`);
      if (list.length === 1) {
        const { incomplete, ...run } = runs[0];
        return asText(finish({ object, ...run }, incomplete));
      }
      const incomplete = runs.flatMap((r) => r.incomplete.map((i) => ({ ...i, list: `${r.variant}.${i.list}` })));
      for (const f of failures) incomplete.push({ list: f.variant, code: /cancelled/.test(f.error) ? 'CANCELLED' : 'NOT_READ', reason: f.error.slice(0, 200) });
      return asText(finish({
        object,
        variants: list,
        summary: runs.map((r) => ({ variant: r.variant, count: r.count, byPriority: r.byPriority, worklistId: r.worklistId })),
        runs: runs.map(({ incomplete: _i, ...r }) => r),
        ...(failures.length ? { notRun: failures, note: 'a variant listed in notRun has NO verdict for this object -- not a clean one' } : {}),
      }, incomplete));
    },
  };
}

/**
 * What the variant that just ran contains, read once after its run and never in its way: a
 * failure here leaves the findings standing. A 404 is the documented answer for a variant
 * created in transaction SCI (the ATC just ran it, so it exists): said, not filed as a gap.
 */
export async function describeVariant(cfg, session, journal, v, tool = 'adt_atc_run') {
  let out;
  try {
    out = await namedGet(transportFor(session.raw), 'atcCheckVariant', { name: String(v).toLowerCase() });
  } catch (e) {
    if (e?.status === 404) return { variantKind: 'SCI', variantNote: SCI_VARIANT_NOTE };
    journal?.gap?.({
      code: 'ATC_VARIANT_NOT_READ',
      subject: `check variant ${v}`,
      detail: `HTTP ${e?.status ?? '?'}: ${e?.message}`,
      impact: 'the run and its findings stand; which checks the variant contains could not be read',
      fallback: 'open the variant in Eclipse ADT (search type:chkv) or in transaction SCI',
    });
    return { variantNote: `check list not read: ${e?.name ?? 'Error'}: ${e?.message}` };
  } finally {
    record(cfg, tool, `${v}#variant`, out?.bytes ?? 0);
  }
  const parsed = parseCheckVariant(out.body);
  if (parsed.drift.length && journal?.enabled) {
    journal.gap({
      code: DRIFT_CODE,
      subject: `check variant ${v}`,
      detail: parsed.drift.map((d) => `<${d.node}> x${d.count}`).join('; '),
      impact: 'the checks listed stand; the measured shape of the check variant has aged',
      fallback: 're-measure (docs/adt-api-reference.md, "Check variants, broad round")',
    });
  }
  const notes = [];
  if (parsed.referencedVariant) {
    notes.push(`references ${parsed.referencedVariant}: its checks are not merged here (no variant with a reference was measured)`);
  }
  if (!parsed.checks.length) notes.push('the variant lists no check');
  return {
    variantKind: 'CHKV',
    variantChecks: parsed.checks,
    ...(notes.length ? { variantNote: notes.join('; ') } : {}),
  };
}

/**
 * One variant on one object set: worklist, run, result. Throws (after journaling) on a failed
 * step. Shared by adt_atc_run (one object) and adt_package_health (one package).
 */
export async function runVariant(cfg, session, journal, v, { subject, body, includeExempted, tool = 'adt_atc_run' }) {
  // 1. the worklist for the variant
  let worklistId;
  let created;
  try {
    created = await atcPost(session.raw, 'worklist', { variant: v });
    worklistId = created.body.trim();
  } catch (e) {
    journal?.gap?.({
      code: 'ATC_NOT_RUN',
      subject,
      detail: `worklist for ${v}: HTTP ${e?.status ?? '?'}: ${e?.message}`,
      impact: 'no ATC verdict exists for this object from this call -- NOT a clean object',
      fallback: 'run the ATC in Eclipse ADT (Ctrl+Shift+F2) or SE80',
    });
    throw e;
  } finally {
    record(cfg, tool, `${v} ${subject}#worklist`, created?.bytes ?? 0);
  }

  // 2. the run
  let run;
  try {
    run = await atcPost(session.raw, 'run', { worklistId, body });
  } catch (e) {
    journal?.gap?.({
      code: 'ATC_NOT_RUN',
      subject,
      detail: `run on worklist ${worklistId}: HTTP ${e?.status ?? '?'}: ${e?.message}`,
      impact: 'no ATC verdict exists for this object from this call -- NOT a clean object',
      fallback: 'run the ATC in Eclipse ADT (Ctrl+Shift+F2) or SE80',
    });
    throw e;
  } finally {
    record(cfg, tool, `${worklistId}#run`, run?.bytes ?? 0);
  }
  const runReply = parseRunReply(run.body);

  // 3. the result
  let out;
  try {
    out = await namedGet(transportFor(session.raw), 'atcWorklist', {
      id: worklistId,
      ...(includeExempted ? { includeExemptedFindings: 'true' } : {}),
    });
  } catch (e) {
    journal?.gap?.({
      code: 'ATC_RESULT_NOT_READ',
      subject,
      detail: `worklist ${worklistId}: HTTP ${e?.status ?? '?'}: ${e?.message}`,
      impact: `the run happened (${runReply.infos.map((i) => `${i.type} ${i.description}`).join('; ') || 'no stats'}) but its findings were not read -- NOT zero findings`,
      fallback: 'open the ATC Result Browser in Eclipse ADT with the worklist id',
    });
    throw e;
  } finally {
    record(cfg, tool, `${worklistId}#worklist`, out?.bytes ?? 0);
  }
  const parsed = parseWorklist(out.body);
  if (parsed.drift.length && journal?.enabled) {
    journal.gap({
      code: DRIFT_CODE,
      subject: `ATC worklist ${worklistId}`,
      detail: parsed.drift.map((d) => `<${d.node}> x${d.count} (${d.where})`).join('; '),
      impact: 'the findings stand; the measured shape of the worklist has aged and the parser may be dropping something',
      fallback: 'compare with the ATC Result Browser in Eclipse ADT; re-measure (docs/adt-api-reference.md)',
    });
  }
  // The server ignores maximumVerdicts (measured 2026-11-09): the worklist holds every finding,
  // so the cap is applied here, most severe first. `count` is what the worklist holds; the run
  // stats are the server's own total, and a worklist holding fewer is cut too.
  const definition = await describeVariant(cfg, session, journal, v, tool);
  const stats = runReply.byPriority;
  const statsTotal = stats ? stats[1] + stats[2] + stats[3] : 0;
  const shown = [...parsed.findings].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)).slice(0, body.maxVerdicts);
  // Why the list is short, from a closed list: our cap, or a worklist holding fewer findings
  // than the run's own stats (the rest is not readable from this worklist).
  const cut = shown.length < parsed.findings.length;
  const short = Boolean(stats) && parsed.findings.length < statsTotal;
  const truncatedBy = [...(cut ? ['maxFindings'] : []), ...(short ? ['worklist'] : [])];
  const exempted = parsed.findings.filter((f) => f.exemption).length;
  const incomplete = [];
  if (cut) incomplete.push({ list: 'findings', code: 'CAP_REACHED', returned: shown.length, total: parsed.findings.length, narrowBy: ['maxFindings'] });
  if (short) incomplete.push({ list: 'findings', code: 'NOT_READ', count: statsTotal - parsed.findings.length, reason: `the run counted ${statsTotal}, the worklist holds ${parsed.findings.length}` });
  if (runReply.statsState === 'unparsed') incomplete.push({ list: 'runStats', code: 'PARSE_FAILED', reason: 'FINDING_STATS is not three integers' });
  if (!parsed.objectSetIsComplete) incomplete.push({ list: 'objects', code: 'NOT_READ', reason: 'the worklist says its object set is not complete' });
  if (parsed.drift.length) incomplete.push({ list: 'findings', code: 'PARSE_FAILED', count: parsed.drift.length, reason: 'see drift' });
  return {
    variant: v,
    worklistId,
    timestamp: runReply.timestamp,
    // The server's own count, only where it differs from what the worklist holds (`short`).
    ...(short || runReply.statsState !== 'read' ? { runStats: stats } : {}),
    count: parsed.findings.length,
    shown: shown.length,
    byPriority: parsed.byPriority,
    ...(truncatedBy.length ? { truncatedBy } : {}),
    runStatsState: runReply.statsState,
    exempted: { listed: exempted, asked: includeExempted === true },
    objectSetIsComplete: parsed.objectSetIsComplete,
    // How many objects the worklist says were checked: it lists each one, findings or not
    // (measured), so zero objects is a run over nothing, not a clean set.
    objectsChecked: parsed.objects.length,
    findings: shown,
    ...definition,
    ...(parsed.drift.length ? { drift: parsed.drift } : {}),
    incomplete,
  };
}
