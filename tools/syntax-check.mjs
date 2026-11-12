// adt_syntax_check -- does the stored source of ONE class, program, behaviour definition, CDS
// view or metadata extension compile? The check the
// editor runs after every save, on the version the system stores: active, or inactive.
//
// MEASURED 2026-11-10 (lib/syntax-check.mjs; docs/adt-api-reference.md, "Old versions, the
// inactive version and the syntax check run"; decision in docs/security.md). No source text is
// sent: the server checks what it holds. Nothing is left on the server, so a second call has no
// further effect.
//
// The inactive check is asked only after the object document said an inactive version exists:
// on an object with none, the server checks an empty source and reports an error that is not in
// the program (measured). The answer then says there is no inactive version, and nothing is sent.

import { record } from '../lib/audit.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { derivedGet, transportFor } from '../lib/adt-get.mjs';
import { documentVersion } from '../lib/source-versions.mjs';
import { finish } from '../lib/completeness.mjs';
import {
  buildCheckBody,
  checkRunPost,
  parseCheckRun,
  countByType,
  CHECK_VERSIONS,
  DRIFT_CODE,
  SyntaxCheckViolation,
} from '../lib/syntax-check.mjs';

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** The incomplete entries of one verdict of `checkStored`. */
export function verdictIncomplete(v, list = 'messages') {
  const out = [];
  if (!v.checked) out.push({ list, code: 'NOT_READ', reason: v.reason });
  if (v.reportsNotProcessed) out.push({ list: 'reports', code: 'NOT_READ', count: v.reportsNotProcessed, reason: 'reports the server did not process: see reports' });
  if (v.drift?.length) out.push({ list, code: 'PARSE_FAILED', count: v.drift.length, reason: 'nodes the measured shape does not describe: see drift' });
  return out;
}

/**
 * One check run on a body built by `buildCheckBody`, and the verdict. Shared by
 * adt_syntax_check and adt_package_health. A failed POST files SYNTAX_NOT_CHECKED and throws;
 * a report the server did not process is `checked: false` and never clean.
 */
export async function checkStored(cfg, session, journal, { subject, body, version, tool = 'adt_syntax_check' }) {
  let res;
  try {
    res = await checkRunPost(session.raw, body);
  } catch (e) {
    journal?.gap?.({
      code: 'SYNTAX_NOT_CHECKED',
      subject,
      detail: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 300),
      impact: 'nothing is said about whether this source compiles: this is NOT a clean check',
      fallback: 'the syntax check of the IDE (Ctrl+F2)',
    });
    throw e;
  } finally {
    // One line per call: the object and the version, never a message or a line of source.
    record(cfg, tool, `${subject} ${version}`, res?.bytes ?? 0);
  }
  const { reports, drift } = parseCheckRun(res.body);
  if (drift.length) {
    journal?.gap?.({
      code: DRIFT_CODE,
      subject: `${subject} check run`,
      detail: drift.map((d) => (d.attribute ? `${d.node}/@${d.attribute}` : `<${d.node}>`)).join('; ').slice(0, 300),
      impact: 'the answer stands, but the measured shape no longer describes this reply fully',
      fallback: 're-read the raw reply and update lib/syntax-check.mjs and docs/adt-api-reference.md',
    });
  }
  // Every report of the reply, not only the main one: a second reporter's messages are messages,
  // and a report it did not process is a part not checked.
  const report = reports.find((r) => r.reporter === 'abapCheckRun') ?? reports[0] ?? null;
  const summary = reports.map((r) => ({ reporter: r.reporter ?? null, status: r.status ?? null, statusText: r.statusText ?? null, count: r.messages?.length ?? 0 }));
  if (!report || report.status !== 'processed') {
    journal?.gap?.({
      code: 'SYNTAX_NOT_CHECKED',
      subject,
      detail: report ? `status ${report.status}: ${report.statusText ?? ''}`.slice(0, 300) : 'no checkReport in the reply',
      impact: 'nothing is said about whether this source compiles: this is NOT a clean check',
      fallback: 'the syntax check of the IDE (Ctrl+F2)',
    });
    return {
      checked: false,
      status: report?.status ?? null,
      statusText: report?.statusText ?? null,
      reason: 'the server did not process the check: no statement is made about this source',
      reports: summary,
      ...(drift.length ? { drift } : {}),
    };
  }
  const processed = reports.filter((r) => r.status === 'processed');
  const tagged = reports.length > 1;
  const messages = processed.flatMap((r) => (tagged ? r.messages.map((m) => ({ ...m, reporter: r.reporter ?? null })) : r.messages));
  const reportsNotProcessed = reports.length - processed.length;
  return {
    checked: true,
    // Clean only when every report was processed and none has a message.
    clean: messages.length === 0 && reportsNotProcessed === 0,
    count: messages.length,
    byType: countByType(messages),
    messages,
    reports: summary,
    ...(reportsNotProcessed ? { reportsNotProcessed } : {}),
    ...(drift.length ? { drift } : {}),
  };
}

export function syntaxCheckTool(cfg, session, journal) {
  return {
    definition: {
      name: 'adt_syntax_check',
      description:
        'Syntax check of ONE class, program, behaviour definition, CDS view or metadata ' +
        'extension on the source the system stores (active or ' +
        'inactive): each message with type, text, include, line and column. No source is ' +
        'sent and nothing is left on the server. An inactive check runs only when an inactive ' +
        'version exists. One call (inactive: two).',
      inputSchema: {
        type: 'object',
        properties: {
          objectName: { type: 'string' },
          objectType: { type: 'string', description: 'Optional ADT type: CLAS/OC, PROG/P, BDEF/BDO, DDLS/DF or DDLX/EX' },
          version: { type: 'string', enum: [...CHECK_VERSIONS], description: 'Default active' },
        },
        required: ['objectName'],
      },
    },
    async handler({ objectName, objectType, version }) {
      const v = version ?? 'active';
      if (!session?.raw) throw new SyntaxCheckViolation('this session has no raw client: the check cannot be asked.');
      const name = String(objectName ?? '').trim();
      if (!name) throw new SyntaxCheckViolation('adt_syntax_check needs an objectName.');
      const type = objectType ? String(objectType).trim().toUpperCase() : undefined;
      const { hit, foundBy } = await resolveObject(session.api, name, type, 'metadata');
      const uri = hit['adtcore:uri'];
      const subject = `${hit['adtcore:type']} ${hit['adtcore:name']}`;
      const object = { name: hit['adtcore:name'], type: hit['adtcore:type'], package: hit['adtcore:packageName'] ?? null, uri, foundBy };
      // Refused before any read when it is not one of the measured families.
      const body = buildCheckBody(uri, v);

      if (v === 'inactive') {
        let said = null;
        let out;
        try {
          out = await derivedGet(transportFor(session.raw), uri, uri, { kind: 'objectVersion', query: { version: 'inactive' } });
          said = documentVersion(out.body);
        } finally {
          record(cfg, 'adt_syntax_check', `${subject} object?version=inactive`, out?.bytes ?? 0);
        }
        if (said !== 'inactive') {
          // An answer, not a gap: there is no inactive version to check.
          return asText(finish({
            object,
            version: v,
            checked: false,
            reason:
              `no inactive version: the object document says '${said ?? 'nothing'}'. A check of ` +
              'inactive would check an empty source (measured); ask version active.',
            inactiveExists: false,
          }, []));
        }
      }

      const verdict = await checkStored(cfg, session, journal, { subject, body, version: v });
      return asText(finish({ object, version: v, ...verdict }, verdictIncomplete(verdict)));
    },
  };
}
