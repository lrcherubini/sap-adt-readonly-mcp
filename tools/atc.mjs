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
} from '../lib/atc.mjs';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
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
        'Run the ABAP Test Cockpit on ONE object, with up to three check variants, and return the ' +
        'findings of each: priority, check, message, source position (include + line), quickfix info ' +
        'and the documentation link. Variants of this installation: ' +
        [...ATC_VARIANTS].map(([name, why]) => `${name} (${why})`).join('; ') +
        `. Default ${DEFAULT_VARIANT}. Three ADT calls per variant: ` +
        'POST a worklist for the variant, POST the run with the object, GET the worklist ' +
        '(measured: 3.7-5 s per run, findings in the reply). Each run leaves an ATC ' +
        'result worklist on the server and nothing else -- no lock, no transport, no object ' +
        `changed. maxFindings 1..${MAX_VERDICTS} (default ${DEFAULT_VERDICTS}); includeExempted ` +
        'adds findings under an approved exemption. A class/interface enhancement (ENHO/XH) is ' +
        'refused (its URI dumps the server). ABAP Unit is NOT run here.',
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

      const resolved = await resolveObject(session.api, name, type, 'metadata', { journal });
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
          runs.push(await runVariant(v, { subject, body, includeExempted }));
        } catch (e) {
          if (list.length === 1) throw e;
          // One variant failing must not hide the others: its gap is already journaled, and
          // the answer says which variant has NO verdict -- never a clean one.
          failures.push({ variant: v, error: `${e.name ?? 'Error'}: ${e.message}` });
        }
      }
      progress(list.length, list.length, 'done');
      if (!runs.length) throw new AtcViolation(`no variant ran on ${subject}: ${failures.map((f) => `${f.variant}: ${f.error}`).join('; ')}`);
      if (list.length === 1) return asText({ object, ...runs[0] });
      return asText({
        object,
        variants: list,
        summary: runs.map((r) => ({ variant: r.variant, count: r.count, byPriority: r.byPriority, worklistId: r.worklistId })),
        runs,
        ...(failures.length ? { notRun: failures, note: 'a variant listed in notRun has NO verdict for this object -- not a clean one' } : {}),
      });
    },
  };

  /** One variant on one object: worklist, run, result. Throws (after journaling) on a failed step. */
  async function runVariant(v, { subject, body, includeExempted }) {
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
      record(cfg, 'adt_atc_run', `${v} ${subject}#worklist`, created?.bytes ?? 0);
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
      record(cfg, 'adt_atc_run', `${worklistId}#run`, run?.bytes ?? 0);
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
      record(cfg, 'adt_atc_run', `${worklistId}#worklist`, out?.bytes ?? 0);
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
    return {
      variant: v,
      variantWhy: ATC_VARIANTS.get(v),
      worklistId,
      timestamp: runReply.timestamp,
      runMs: run.ms,
      runStats: runReply.byPriority,
      count: parsed.findings.length,
      byPriority: parsed.byPriority,
      truncated: parsed.findings.length >= body.maxVerdicts ? 'possible' : false,
      objectSetIsComplete: parsed.objectSetIsComplete,
      findings: parsed.findings,
      rule:
        'a run leaves a result worklist on the server and nothing else; the findings above are the ' +
        `verdict of variant ${v} on this one object, read from that worklist (measured)`,
      ...(parsed.drift.length ? { drift: parsed.drift } : {}),
    };
  }
}
