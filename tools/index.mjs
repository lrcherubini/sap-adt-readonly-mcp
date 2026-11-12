// The read-only tools. Everything they reach is a GET or a read-only POST on
// the ADT REST API or the SAP-standard launchpad OData services (/UI2); nothing here
// can change the system, and nothing reads a local checkout: every source comes from the system.

import { record, budgetLeft } from '../lib/audit.mjs';
import { inCall, currentCall } from '../lib/call-context.mjs';
import { parseObjectReferences } from '../lib/resolve.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { dumpAfter500, explainWithDump } from '../lib/dump-after-500.mjs';
import { openJournal } from '../lib/journal.mjs';
import { withSignature } from '../lib/system-signature.mjs';
import { publish, schemaErrors, closeSchema, withStructuredContent } from '../lib/tool-meta.mjs';
import { searchTool } from './search.mjs';
import { readSourceTool } from './read-source.mjs';
import { objectInfoTool } from './object-info.mjs';
import { whereUsedTool } from './where-used.mjs';
import { packageTreeTool } from './package-tree.mjs';
import { valueHelpTool } from './value-help.mjs';
import { cleanCoreScanTool } from './clean-core-scan.mjs';
import { contractCheckTool } from './contract-check.mjs';
import { annotationChainTool } from './annotation-chain.mjs';
import { annotationScanTool } from './annotation-scan.mjs';
import { transportTool } from './transport.mjs';
import { customizingTool } from './customizing.mjs';
import { runtimeErrorsTool } from './runtime-errors.mjs';
import { atcTool } from './atc.mjs';
import { launchpadTool } from './launchpad.mjs';
import { syntaxCheckTool } from './syntax-check.mjs';
import { packageHealthTool } from './package-health.mjs';
import { definitionTool } from './definition.mjs';
import { usedObjectsTool } from './used-objects.mjs';

/**
 * Wrap every handler so that one line lands in the journal per invocation: which tool,
 * whether it answered, how long it took, and how much of the read budget it spent.
 *
 * This is the measurement that makes the cost claims checkable rather than
 * asserted -- the share of answers that cost the system nothing is a number in
 * logs/calls/, not a design intention. The wrapper never changes an answer and never
 * fails one: lib/journal.mjs swallows its own write errors.
 */
function journaled(tool, journal, cfg, session) {
  if (!journal?.enabled) return tool;
  const inner = tool.handler;
  return {
    ...tool,
    handler: (args = {}, extra = {}) => inCall(async () => {
      const started = Date.now();
      // The reads of THIS call, counted by lib/audit.mjs at the call site, so the number is
      // what actually went out rather than what this wrapper believes went out. It is the
      // call's own count (lib/call-context.mjs): the difference of the session counter before
      // and after also counted the reads of every other call in flight.
      const call = currentCall();
      const before = budgetLeft(cfg);
      // Which limits THIS answer ran into. Opened before the handler and closed on both
      // paths, so a call that failed still says what it hit on the way down.
      const frame = journal.collect();
      const close = (ok, outcome) => {
        const left = budgetLeft(cfg);
        // The read counter passing its configured number. Recorded once, at the call that
        // crossed the line -- and recorded as what it is: lib/audit.mjs counts reads after
        // they return, so nothing was refused and no answer was shortened. The previous
        // text claimed the opposite, which taught whoever read it to doubt intact data.
        if (before > 0 && left <= 0) {
          journal.gap({
            code: 'BUDGET_EXHAUSTED',
            subject: tool.definition.name,
            detail: `this session passed the ${cfg.budget.reads} reads named in budget.reads`,
            impact: 'none on this answer: the number is a notice, and nothing refuses a read',
            fallback: 'raise budget.reads (npm run config -- set budget.reads <n>) to stop seeing it, or ignore it',
          });
        }
        // Closed AFTER the gap above, so a call that crossed the line says so on its own line.
        const codes = frame.end();
        journal.call({
          tool: tool.definition.name,
          ok,
          ...(outcome ? { outcome } : {}),
          ms: Date.now() - started,
          adtCalls: call.adtCalls,
          budgetLeft: left,
          args,
          ...(codes.length ? { codes } : {}),
        });
      };
      try {
        const out = await inner(args, extra);
        close(true);
        return out;
      } catch (e) {
        // A 500 is, on every measurement so far, a dump on the system: one more call names
        // the runtime error and the program (lib/dump-after-500.mjs). The original error
        // stands; the explanation is appended to it and filed as SERVER_DUMPED.
        const explained = await dumpAfter500({ cfg, session, journal, tool: tool.definition.name, error: e, since: started });
        if (explained?.checked) {
          try {
            e.message = `${e.message}${explainWithDump(explained)}`;
          } catch (assign) {
            // A frozen error keeps its message; the journal still carries the dump.
            journal.gap({
              code: 'DUMP_NOT_READ',
              subject: tool.definition.name,
              detail: `the dump was read but could not be attached to the error: ${assign?.message}`,
              impact: 'the caller sees the bare 500; the SERVER_DUMPED line has the detail',
              fallback: 'read logs/gaps for this run',
            });
          }
          if (explained.dump) e.dump = explained.dump;
        }
        // An HTTP failure no code explains. Until 2026-10-01 it was only a `failed` count in
        // the report -- a source read of a data element answered 404 and nothing said "this
        // was asked, of this type, and the tool had no answer". Filed per tool x type, so a
        // need that keeps coming back becomes one row that counts, not a number that hides it.
        // The server's own refusals carry no status and stay out: they ARE answers.
        const status = [e?.err, e?.status, e?.response?.status].map(Number).find((n) => Number.isInteger(n) && n >= 100);
        if (status && !frame.codes().length) {
          journal.gap({
            code: 'UNCLASSIFIED_ADT_ERROR',
            subject: `${tool.definition.name} ${args?.objectType ?? 'type not given'}`,
            detail: `HTTP ${status} on ${args?.objectName ?? args?.table ?? args?.packageName ?? '?'}: ${String(e?.message ?? e).slice(0, 160)}`,
            impact: 'the tool had no answer and no code says why; the caller saw a bare error -- NOT evidence that the object or the capability is absent',
            fallback: 'read the call in logs/calls; if the type has no answer by design, add it to lib/type-contract.mjs with a refusal that names the call that answers',
          });
        }
        // The message, not the stack: a stack can carry a path or a payload fragment,
        // and the journal's whole safety property is that content cannot reach it.
        close(false, e?.message);
        throw e;
      }
    }),
  };
}

/**
 * Refuse a call whose arguments do not meet the tool's own inputSchema, before the handler
 * runs. The SDK passes `arguments` through unchecked, and a handler reads what it was promised:
 * `adt_package_tree` called with `package` for `packageName` died on `undefined.toUpperCase()`
 * (2026-10-02), and `objectNames` sent as a JSON string read as "Object 'undefined' not found"
 * (2026-09-24) -- a negative answer about the system for what was a malformed call. The schema is
 * enforced as published (closed: an unknown argument is refused, it is usually a misspelt one):
 * required, type, enum, ranges, items (lib/tool-meta.mjs). Nothing is coerced; the message names
 * what arrived.
 */
export function argumentErrors(schema, args) {
  return schemaErrors(closeSchema(schema ?? { type: 'object' }), args && typeof args === 'object' ? args : {});
}

function validated(tool, signature) {
  const inner = tool.handler;
  return {
    ...tool,
    async handler(args = {}, extra = {}) {
      const errors = argumentErrors(tool.definition.inputSchema, args);
      if (errors.length) throw new Error(`${tool.definition.name}: ${errors.join('; ')}.`);
      // The answer as JSON too (structuredContent), when it is one JSON object, and where it
      // was read from in front of it (lib/system-signature.mjs).
      return withSignature(withStructuredContent(await inner(args, extra)), signature);
    },
  };
}

export function buildTools(cfg, session, journal = openJournal(cfg)) {
  const api = session.api;

  // THE SECOND ASK of the quick search: the same resource, the facet sent whole, through the
  // named GET route (lib/adt-get.mjs `quickSearch`). The client library strips the facet and
  // for FUGR/FF that is the difference between a hit and an empty list (measured).
  // One audit line per call, like every other route. Absent when the session has no raw
  // client (tests that build tools without one): the resolver then simply has no second ask.
  const facetSearch = session.raw
    ? async (name, facet, max = 20) => {
        const out = await namedGet(transportFor(session.raw), 'quickSearch', {
          query: name,
          objectType: facet,
          maxResults: max,
        });
        record(cfg, 'adt_search', `${name} (${facet}, whole facet)`, out.bytes);
        return parseObjectReferences(out.body);
      }
    : undefined;
  const resolveOpts = { facetSearch };

  const tools = [
    searchTool(cfg, session, journal, { facetSearch }),
    readSourceTool(cfg, session, journal, { resolveOpts }),
    objectInfoTool(cfg, session, journal, { resolveOpts }),
    whereUsedTool(cfg, session, journal, { resolveOpts }),
    packageTreeTool(cfg, session, journal),

    // A pipeline over nine steps and eight modules, not a single call like the five above.
    valueHelpTool(cfg, api, session.sources, journal),

    // Package scans: the sources are read from the system, one call per object
    // (lib/package-sources.mjs), the release state from SAP's catalogue (sync:catalog).
    cleanCoreScanTool(cfg, api, journal),
    // With `apps`, it also reads the UI5 repository and the live $metadata of each app's services.
    contractCheckTool(cfg, api, journal, session),
    annotationScanTool(cfg, api, journal),
    // The one that DOES call the system -- it is the verdict the scan above ranks work for.
    annotationChainTool(cfg, session, journal),
    // The only tool that answers about CHANGE rather than about state: the repository has
    // the objects, CTS has which of them moved together and when.
    transportTool(cfg, session, journal),
    // The first POST, fenced to a closed list of customizing tables (docs/security.md,
    // 2026-09-12): where a VOFM routine is used is table content, not a repository property.
    customizingTool(cfg, session, journal),
    // The Feed Reader's feeds (ST22 dumps, gateway log): named GET routes over hrefs the
    // catalogue publishes, $query generated from measured attributes (2026-09-12).
    runtimeErrorsTool(cfg, session, journal),
    // The second POST: one ATC run on one object, variant from a closed measured set, the
    // findings read back from the worklist the run leaves (docs/security.md, 2026-09-14).
    atcTool(cfg, session, journal),
    // The launchpad: SAP-standard OData V2 under /UI2, the one place the routes leave
    // /sap/bc/adt (docs/security.md, "The Fiori launchpad").
    launchpadTool(cfg, session, journal),
    // The fourth POST: the syntax check on the stored version, no source sent, nothing left
    // behind (docs/security.md, 2026-11-10).
    syntaxCheckTool(cfg, session, journal),
    // A composition, no read of its own: the Clean Core scan and the syntax check on one listing.
    packageHealthTool(cfg, session, journal),
    // A POST that reads: go to definition, its body the stored source just read, never caller
    // text (docs/security.md, 2026-11-10).
    definitionTool(cfg, session, journal),
    // A POST that reads: the Relation Explorer's "Used Objects" of one class, its body naming the
    // class and nothing else, then the release state of each (docs/security.md, 2026-11-10).
    usedObjectsTool(cfg, session, journal),
  ];

  // A tool the installation switched off (`tools.disabled`) is not built into the list at all:
  // it is neither announced nor callable, which is the only "off" a client cannot talk past.
  const off = new Set(cfg.disabledTools ?? []);
  // Validated INSIDE the journal wrapper, so a refused call is still one line in logs/calls.
  // `publish` adds what tools/list owes a client: title, behaviour hints, a closed schema.
  return tools.filter((t) => !off.has(t.definition.name)).map((t) => journaled(validated({ ...t, definition: publish(t.definition) }, cfg.systemSignature), journal, cfg, session));
}
