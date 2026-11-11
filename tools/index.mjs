// The sixteen read-only tools. Everything they reach is a GET or a read-only POST on
// the ADT REST API or the SAP-standard launchpad OData services (/UI2); nothing here
// can change the system, and nothing reads a local checkout: every source comes from the system.

import { finish, page } from '../lib/completeness.mjs';
import { mainInclude, classIncludes } from '../lib/object-structure.mjs';
import { record, budgetLeft } from '../lib/audit.mjs';
import { enhancedObjectOf, parseEnhoXhb } from '../lib/enhancement-target.mjs';
import { resolveObject, parseObjectReferences, FACET_ONLY_TYPES } from '../lib/resolve.mjs';
import { namedGet, derivedGet, transportFor } from '../lib/adt-get.mjs';
import { parseObjectProperties, isClasenh, clasenhGap, CLASENH_WHERE } from '../lib/object-properties.mjs';
import { dumpAfter500, explainWithDump } from '../lib/dump-after-500.mjs';
import { openJournal } from '../lib/journal.mjs';
import { resolveDataElement, readDomain } from '../lib/ddic.mjs';
import { previewQuery, packagesOf, switchChain, describeChain } from '../lib/switch-chain.mjs';
import { contractOf, sourceRefusal } from '../lib/type-contract.mjs';
import { readServiceBinding } from '../lib/service-binding.mjs';
import { virtualFoldersPost, parseVirtualFolders } from '../lib/virtual-folders.mjs';
import { legacyKindOf, readLegacyObjects } from '../lib/legacy-objects.mjs';
import { VERSION_PATTERN, readVersion, compareVersions, readerFor, documentVersion } from '../lib/source-versions.mjs';
import { parseClassComponents, findMethod, sliceLines, methodLabel } from '../lib/class-components.mjs';
import { parseApiRelease, API_RELEASE_OBJECT } from '../lib/api-release.mjs';
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
import { publish, schemaErrors, closeSchema, withStructuredContent } from '../lib/tool-meta.mjs';

// Z*, Y* and /NAMESPACE/ objects are ours; anything else is SAP standard.
const CUSTOM_NAMESPACE = /^([ZY]|\/)/;

/** What a "not found" in a batch does and does not say -- the caveat of an empty adt_search. */
const NOT_FOUND_NOTE =
  'the search answered no object of this name, and so did the direct URI where the type has one ' +
  '(PROG/P, PROG/I, CLAS/OC, FUGR/F): the name resolves to nothing here. The index does not know ' +
  'every object that exists (measured), so for other types this is the index speaking';

const asText = (value) => ({
  content: [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
});

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
    async handler(args = {}, extra = {}) {
      const started = Date.now();
      // The budget counter is the only honest measure of how many ADT calls an answer
      // cost: it is incremented by lib/audit.mjs at the call site, so it counts what
      // actually went out rather than what this wrapper believes went out.
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
          adtCalls: before - left,
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
    },
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

function validated(tool) {
  const inner = tool.handler;
  return {
    ...tool,
    async handler(args = {}, extra = {}) {
      const errors = argumentErrors(tool.definition.inputSchema, args);
      if (errors.length) throw new Error(`${tool.definition.name}: ${errors.join('; ')}.`);
      // The answer as JSON too (structuredContent), when it is one JSON object.
      return withStructuredContent(await inner(args, extra));
    },
  };
}

/** Where-used rows per page: the snippets of a page are one POST, which takes at most 500 identifiers. */
const WHERE_USED_CEILING = 500;
/** Objects listed per package in one answer of adt_package_tree. */
const TREE_OBJECTS_CEILING = 5000;
/** The quick search takes maxResults up to three digits (the route's own alphabet). */
const SEARCH_CEILING = 999;

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

  // adt_read_source, one object. Shared by the single and the batch form so a batch
  // item is exactly what the single call would answer -- the only difference is that
  // a failure stays inside its item.
  const BATCH_CAP = 25;
  const typeNotInContract = (hit, tool) =>
    journal?.gap?.({
      code: 'TYPE_NOT_IN_CONTRACT',
      subject: String(hit['adtcore:type'] ?? '?'),
      detail: `${tool} on ${hit['adtcore:name']}: this type has no entry in lib/type-contract.mjs`,
      impact: 'answered on the generic path, without a field list; what this tool answers for the type was never measured',
      fallback: 'measure one object of the type (adt_object_info + adt_read_source) and add the entry, with its evidence',
    });
  // A form-based type has no source (lib/type-contract.mjs, measured): refused with
  // the call that does answer -- before any request when the type is given, after the
  // resolver otherwise. A type the contract never decided is attempted, and filed.
  /**
   * The stored switch state of each listed enhancement implementation, by name. A failure or a
   * missing raw client is said in `switchNotes`, never left as an absent line: "no switch line"
   * must not read as "behind no switch".
   */
  const enhancementSwitches = async (impls) => {
    const switchOf = new Map();
    const switchNotes = [];
    const switchGaps = [];
    if (!impls.length) return { switchOf, switchNotes, switchGaps };
    if (!session.raw) {
      switchNotes.push('switch state not read: this session has no raw client for the data preview');
      switchGaps.push({ code: 'NOT_READ', count: impls.length, reason: 'no raw client in this session' });
      return { switchOf, switchNotes, switchGaps };
    }
    try {
      const query = previewQuery(session.raw, { audit: (target, n) => record(cfg, 'adt_read_source', target, n) });
      const { packages, notes, gaps } = await packagesOf('ENHO', impls.map((i) => i.name), query);
      const chain = await switchChain([...packages.values()], query, { client: cfg?.client });
      switchNotes.push(...notes, ...chain.notes);
      switchGaps.push(...(gaps ?? []), ...(chain.gaps ?? []));
      const unpackaged = impls.filter((i) => !packages.get(String(i.name).toUpperCase())).length;
      if (unpackaged) switchGaps.push({ code: 'NOT_READ', count: unpackaged, reason: 'package not found in TADIR' });
      for (const i of impls) {
        const name = String(i.name).toUpperCase();
        const pkg = packages.get(name);
        switchOf.set(name, pkg ? describeChain(chain.byPackage.get(pkg)).join('; ') : 'package not found in TADIR -- switch not read');
      }
    } catch (e) {
      switchNotes.push(`switch state not read: ${e.name ?? 'Error'}: ${e.message}`);
      switchGaps.push({ code: 'NOT_READ', count: impls.length, reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) });
    }
    return { switchOf, switchNotes, switchGaps };
  };

  // One method of a class, sliced from the include its outline names (lib/class-components.mjs,
  // MEASURED 2026-11-10). The outline and the include are read in ONE version, active or inactive,
  // or the lines do not match; both are derived GETs under the class, no library call.
  const readMethod = async ({ hit, foundBy, warning, method, version }) => {
    const uri = hit['adtcore:uri'];
    const name = hit['adtcore:name'];
    if (!/^\/sap\/bc\/adt\/oo\/classes\/[^/]+$/i.test(uri)) {
      throw new Error(`method reads a method of a class; ${hit['adtcore:type']} ${name} is not one.`);
    }
    const v = version ?? 'active';
    if (v !== 'active' && v !== 'inactive') {
      throw new Error('method is read in the active or the inactive version, not in a history number.');
    }
    if (!session.raw) throw new Error('this session has no raw client: the class outline cannot be read.');
    const read = readerFor(transportFor(session.raw), uri, (kind, out) =>
      record(cfg, 'adt_read_source', `${name}->${method} ${kind}`, out?.bytes ?? 0)
    );
    if (v === 'inactive') {
      const doc = await read('objectVersion', null, { version: 'inactive' });
      if (documentVersion(doc.body) !== 'inactive') {
        throw new Error(`${name} has no inactive version: read the method with version active.`);
      }
    }
    const outline = await read('classComponents', `${uri}/objectstructure`, { version: v, withShortDescriptions: 'true' });
    const found = findMethod(parseClassComponents(outline.body), method);
    if (!found.method) {
      throw new Error(
        found.candidates.length
          ? `'${method}' names several methods of ${name}: ${found.candidates.join(', ')}. Name one (LOCAL_CLASS->NAME for a local class).`
          : `${name} has no method '${method}'. Its methods: ${found.known.slice(0, 40).join(', ')}${found.known.length > 40 ? ', ...' : ''}.`
      );
    }
    const m = found.method;
    const impl = m.positions.implementationBlock;
    const pos = impl?.include ? impl : m.positions.definitionBlock;
    if (!pos?.include) throw new Error(`the outline of ${name} gives no position for ${method}.`);
    const src = await read('sourceVersion', `${uri}/${pos.include}`, { version: v });
    const slice = sliceLines(src.body, pos.start.line, pos.end.line);
    if (slice === null) {
      journal?.gap?.({
        code: 'VERSION_NOT_READ',
        subject: `${hit['adtcore:type']} ${name}`,
        detail: `${method}: lines ${pos.start.line}-${pos.end.line} are past the end of ${pos.include} (${v})`,
        impact: 'the method was not sliced; this is NOT evidence that it is empty',
        fallback: `adt_read_source({ objectName: '${name}' }) and read the whole include`,
      });
      throw new Error(`the outline of ${name} places ${method} past the end of ${pos.include}: the method was not sliced.`);
    }
    const which = impl?.include ? 'implementation' : 'definition (no implementation: abstract, or not written yet)';
    const shown = methodLabel(m);
    const header =
      `* ${name} (${hit['adtcore:type']}) -- package ${hit['adtcore:packageName'] ?? '?'}\n` +
      `* read live from ${cfg.host} client ${cfg.client} at ${new Date().toISOString()}\n` +
      (warning ? `* WARNING: ${warning}\n` : '') +
      `* method: ${shown} (${m.visibility ?? '?'}, ${m.level ?? '?'})${m.description ? ` -- ${m.description}` : ''}\n` +
      `* ${which}: ${pos.include} lines ${pos.start.line}-${pos.end.line}, version ${v}\n\n`;
    return { hit, foundBy, warning, header, source: slice, enhFooter: '', meta: { method: { name: shown, include: pos.include, start: pos.start.line, end: pos.end.line, version: v } } };
  };

  // The text elements of a program or a class, the three categories (MEASURED 2026-11-10). A
  // failure is said in the footer and filed: "no text elements" and "not read" are not the same.
  const readTextElements = async (hit) => {
    const name = hit['adtcore:name'];
    const m = String(hit['adtcore:uri'] ?? '').match(/^\/sap\/bc\/adt\/(oo\/classes|programs\/programs)\/([^/]+)$/i);
    if (!m) {
      return {
        text: `\n\n* ===== text elements: only programs and classes have them here (${hit['adtcore:type']}) =====\n`,
        meta: { asked: true, applicable: false },
        gaps: [],
      };
    }
    if (!session.raw) {
      return {
        text: '\n\n* ===== text elements NOT read: this session has no raw client =====\n',
        meta: { asked: true, read: false, reason: 'no raw client in this session' },
        gaps: [{ list: 'textElements', code: 'NOT_READ', reason: 'no raw client in this session' }],
      };
    }
    const categories = {};
    const gaps = [];
    const kind = m[1].startsWith('oo') ? 'Class' : 'Program';
    const lines = [`\n\n* ===== text elements of ${name} =====`];
    for (const category of ['symbols', 'selections', 'headings']) {
      const route = `textElements${kind}${category[0].toUpperCase()}${category.slice(1)}`;
      let out;
      try {
        out = await namedGet(transportFor(session.raw), route, { name: m[2].toLowerCase() });
        lines.push(`* --- ${category} ---`, out.body.trim() ? out.body.trimEnd() : '* (none)');
        categories[category] = { read: true, lines: out.body.trim() ? out.body.trimEnd().split(/\r?\n/).length : 0 };
      } catch (e) {
        journal?.gap?.({
          code: 'TEXT_ELEMENTS_NOT_READ',
          subject: `${hit['adtcore:type']} ${name}`,
          detail: `${category}: ${e.name ?? 'Error'}: ${e.message}`.slice(0, 300),
          impact: `the ${category} of this object are unknown; this is NOT evidence that it has none`,
          fallback: 'the text elements in the IDE (or SE38 / SE24)',
        });
        lines.push(`* --- ${category}: NOT read (${e.message}) -- this is not the same as "none" ---`);
        categories[category] = { read: false, reason: String(e.message).slice(0, 200) };
        gaps.push({ list: `textElements.${category}`, code: 'NOT_READ', reason: String(e.message).slice(0, 200) });
      } finally {
        record(cfg, 'adt_read_source', `${name} text elements ${category}`, out?.bytes ?? 0);
      }
    }
    return { text: lines.join('\n') + '\n', meta: { asked: true, read: !gaps.length, categories }, gaps };
  };

  // A stored version of one class or program, or two of them compared (lib/source-versions.mjs,
  // MEASURED 2026-11-10). Every read is a derived GET under the object, held to the two families
  // measured; the client library is not used for any of it.
  const STORED_FAMILY = /^\/sap\/bc\/adt\/(oo\/classes|programs\/programs)\/[^/]+$/i;
  const readStored = async ({ hit, foundBy, warning, structure, sourceUrl, include, version, compareTo }) => {
    const objectUri = hit['adtcore:uri'];
    const name = hit['adtcore:name'];
    if (!STORED_FAMILY.test(objectUri)) {
      throw new Error(
        `version and compareTo are measured for classes and programs only; ${hit['adtcore:type']} ${name} ` +
          'is not one. Read the current source without them, or compare in the IDE.'
      );
    }
    if (!session.raw) throw new Error('this session has no raw client: a stored version cannot be read.');
    const read = readerFor(transportFor(session.raw), objectUri, (kind, out) =>
      record(cfg, 'adt_read_source', `${name}#${include ?? 'main'} ${kind}`, out?.bytes ?? 0)
    );
    const ctx = { read, structure, sourceUrl, include };
    const header =
      `* ${name} (${hit['adtcore:type']}) -- package ${hit['adtcore:packageName'] ?? '?'}\n` +
      `* read live from ${cfg.host} client ${cfg.client} at ${new Date().toISOString()}\n` +
      (warning ? `* WARNING: ${warning}\n` : '');
    try {
      if (compareTo) {
        const r = await compareVersions(ctx, version ?? 'active', compareTo);
        const json = {
          object: { name, type: hit['adtcore:type'], include: include ?? 'main', foundBy },
          from: { version: r.from.version, label: r.from.label, exists: r.from.exists, ...(r.from.entry ? { entry: r.from.entry } : {}) },
          to: { version: r.to.version, label: r.to.label, exists: r.to.exists, ...(r.to.entry ? { entry: r.to.entry } : {}) },
          ...(r.diff
            ? {
                added: r.diff.added,
                removed: r.diff.removed,
                hunks: r.diff.hunks,
                ...(r.diff.reason ? { reason: r.diff.reason } : {}),
                identical: r.diff.complete && r.diff.added === 0 && r.diff.removed === 0,
                diff: r.diff.text,
              }
            : { diff: null }),
          ...(r.notes.length ? { notes: r.notes } : {}),
        };
        // The diff is cut at an edit or a line limit (lib/line-diff.mjs): a narrower read (one
        // include, one method) is the way to the rest. A side that does not exist is not compared.
        const gaps = r.diff
          ? r.diff.complete
            ? []
            : [{ list: 'diff', code: 'CAP_REACHED', reason: r.diff.reason ?? 'the diff was cut', narrowBy: ['include'] }]
          : [{ list: 'diff', code: 'NOT_READ', reason: 'one of the two versions does not exist' }];
        return { hit, foundBy, warning, json: finish(json, gaps) };
      }
      const one = await readVersion({ ...ctx, version });
      if (!one.exists) {
        return {
          hit,
          foundBy,
          warning,
          header:
            header +
            `* version: ${one.label}\n` +
            '* NO INACTIVE VERSION: the system holds only the active one. Nothing is shown here; ' +
            'read it with version: active.\n',
          source: '',
          enhFooter: '',
          meta: { version: { asked: one.version ?? version, exists: false, label: one.label } },
        };
      }
      return { hit, foundBy, warning, header: `${header}* version: ${one.label}\n\n`, source: one.source, enhFooter: '', meta: { version: { asked: one.version ?? version, exists: true, label: one.label } } };
    } catch (e) {
      // A request that names nothing to read (the same version twice, a malformed number) is
      // the caller's mistake and is answered as one; only a read that could not be made is filed.
      if (e?.name === 'VersionNotRead' && !e.code) throw e;
      journal?.gap?.({
        code: 'VERSION_NOT_READ',
        subject: `${hit['adtcore:type']} ${name}`,
        detail: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 300),
        impact: 'nothing is said about that version; this is NOT evidence that it does not differ',
        fallback: 'adt_transport({ object }) lists the versions; the IDE compares them (Compare With > History)',
      });
      throw e;
    }
  };

  const readOne = async (objectName, { objectType, include, enhancements, enhancementSource, context, version, compareTo, method, textElements }) => {
    const early = objectType ? sourceRefusal(objectType, objectName) : null;
    if (early) throw early;
    const resolved = await resolveObject(api, objectName, objectType, 'source', resolveOpts);
    const { hit, facets, warning, foundBy } = resolved;
    const refused = sourceRefusal(hit['adtcore:type'], hit['adtcore:name']);
    if (refused) throw refused;
    if (!contractOf(hit['adtcore:type'])) typeNotInContract(hit, 'adt_read_source');
    let enhancedObject;
    // An enhancement implementation has no source of its own: its URI answers empty
    // (measured), and the code it implants lives in the enhanced object. So
    // nothing is read here: the answer names that object and the call that reads it.
    // A class enhancement (ENHO/XH) does not even answer its structure -- see
    // adt_object_info for the cause; the same gap is filed from here.
    if (isClasenh(hit['adtcore:type'])) {
      // A class / interface enhancement (measured, 3 of 3): its structure
      // resource dumps the server, so it is never asked. The answer is the same empty
      // source with the place the code really is.
      clasenhGap(journal, hit['adtcore:name'], `adt_read_source on ${hit['adtcore:uri']}: no structure read (the resource dumps the server)`);
      record(cfg, 'adt_read_source', `${hit['adtcore:name']}#enho`, 0);
      const header =
        `* ${hit['adtcore:name']} (${hit['adtcore:type']}) -- package ${hit['adtcore:packageName'] ?? '?'}\n` +
        `* WARNING: a class enhancement (CLASENH) or function-module interface enhancement (FUGRENH) has no ` +
        `source through the ADT, and its structure was NOT read (the resource dumps the server). ${CLASENH_WHERE}.\n` +
        '* enhanced object: not readable through the ADT for this type (the abapGit .enho.xml names it: <CLASS> or <FUGR>)\n\n';
      return {
        hit, foundBy, warning: 'ENHO/XH: no source through the ADT', header, source: '', enhFooter: '', enhancedObject: null, clasenh: true,
        meta: { source: { exists: false, reason: 'a class or function-module interface enhancement has no source through the ADT' } },
        gaps: [{ list: 'enhancedObject', code: 'NOT_READ', reason: 'the structure of this type dumps the server, so it is not asked' }],
      };
    }
    if (/^ENHO\//.test(String(hit['adtcore:type']))) {
      let structure = resolved.structure;
      if (!structure) {
        try {
          structure = await api.objectStructure(hit['adtcore:uri']);
        } catch (e) {
          journal?.gap?.({
            code: 'ENHANCEMENTS_NOT_READ',
            subject: hit['adtcore:name'],
            detail: `HTTP ${e?.response?.status ?? e?.status ?? '?'} on ${hit['adtcore:uri']} (${hit['adtcore:type']})`,
            impact: 'the enhancement exists but its structure could not be read; what it implants is unknown',
            fallback: 'SE19 (the enhoxh persistence supports BADI_IMPL and HOOK_IMPL only, read live 2026-09-12)',
          });
          throw new Error(
            `${hit['adtcore:type']} ${hit['adtcore:name']} exists but its structure could not be read ` +
              `(HTTP ${e?.response?.status ?? e?.status ?? '?'}); a class enhancement dumps server-side on ` +
              'this resource (see adt_object_info). A failed read is not an absent enhancement.'
          );
        }
      }
      enhancedObject = enhancedObjectOf(structure);
      const hint = enhancedObject
        ? `adt_read_source({ objectName: '${enhancedObject.name}', enhancements: true, enhancementSource: true })`
        : 'this is a BAdI implementation (no enhanced object is published): the implementing class is in adt_object_info';
      journal?.gap?.({
        code: 'ENHO_SOURCE_IS_ELSEWHERE',
        subject: hit['adtcore:name'],
        detail: enhancedObject ? `enhances ${enhancedObject.kind} ${enhancedObject.name}` : 'no enhanced object published (BAdI implementation)',
        impact: 'nothing was read: an ENHO has no source at its own URI',
        fallback: hint,
      });
      record(cfg, 'adt_read_source', `${hit['adtcore:name']}#enho`, 0);
      const header =
        `* ${hit['adtcore:name']} (${hit['adtcore:type']}) -- package ${hit['adtcore:packageName'] ?? '?'}\n` +
        `* WARNING: an enhancement implementation has no source of its own; its URI answers empty. ` +
        `The code it implants is read from the enhanced object: ${hint}\n` +
        (enhancedObject
          ? `* enhanced object: ${enhancedObject.kind} ${enhancedObject.name} (${enhancedObject.uri})\n`
          : '* enhanced object: none published (a BAdI implementation implements a spot)\n') +
        '\n';
      return { hit, foundBy, warning: 'ENHO has no source of its own', header, source: '', enhFooter: '', enhancedObject, meta: { source: { exists: false, reason: 'an enhancement implementation has no source of its own' } } };
    }
    const structure = resolved.structure ?? (await api.objectStructure(hit['adtcore:uri']));
    let sourceUrl;
    if (include && include !== 'main' && structure.objectUrl?.includes('/oo/classes/')) {
      const includes = classIncludes(structure);
      sourceUrl = includes.get(include);
      if (!sourceUrl) {
        throw new Error(`Include '${include}' not available for ${objectName}.`);
      }
    } else {
      sourceUrl = mainInclude(structure);
    }
    if (method) return await readMethod({ hit, foundBy, warning, method, version });
    if (version || compareTo) {
      return await readStored({ hit, foundBy, warning, structure, sourceUrl, include, version, compareTo });
    }
    const source = await api.getObjectSource(sourceUrl);

    // The enhancements bound to this object. Kept as a footer of the source rather
    // than as a tool of its own, because that is what they are: code that runs
    // inside this object and is not in it. A failure is reported, never swallowed --
    // "no enhancements" and "I could not ask" are different answers, and the second
    // one read as the first is how customer code stays invisible.
    let enhFooter = '';
    const gaps = [];
    let enhMeta = { asked: false };
    if (enhancements || enhancementSource) {
      try {
        const found = await api.objectEnhancements(sourceUrl, context, !!enhancementSource);
        const impls = found?.implementations ?? [];
        // Bound is not running: the listing ignores switches (measured on SAPMV45A). So each
        // implementation gets the stored state of the switch its package hangs on -- TADIR,
        // SFW_PACKAGE, SFW_SWITCH_STATE, three reads for the whole list (lib/switch-chain.mjs).
        const { switchOf, switchNotes, switchGaps } = await enhancementSwitches(impls);
        for (const g of switchGaps) gaps.push({ list: 'enhancements.switch', ...g });
        const otherElements = impls.reduce((n, i) => n + (i.otherElements ?? 0), 0);
        if (otherElements) gaps.push({ list: 'enhancements.elements', code: 'OUT_OF_SCOPE', count: otherElements, reason: 'elements of another kind than a source code plugin are not shown' });
        const noSource = enhancementSource ? impls.reduce((n, i) => n + (i.elements ?? []).filter((e) => !e.source).length, 0) : 0;
        if (noSource) gaps.push({ list: 'enhancements.source', code: 'NOT_READ', count: noSource, reason: 'the element carried no source' });
        enhMeta = {
          asked: true,
          read: true,
          count: impls.length,
          elements: impls.reduce((n, i) => n + (i.elements ?? []).length, 0),
          implementations: impls.map((i) => ({ name: i.name, type: i.type, version: i.version, elements: (i.elements ?? []).length })),
        };
        // `version` is the OBJECT's version (adtcore:version), not its switch: the listing names
        // implementations whose package sits behind a switch with no active business function
        // too (measured on SAPMV45A, 2026-11-09). So the heading says "bound to", never "runs".
        const lines = impls.flatMap((i) => [
          `* ${i.name} (${i.type ?? '?'}, version ${i.version ?? '?'})` +
            (i.enhancedObject?.name ? ` on ${i.enhancedObject.name}` : ''),
          ...(switchOf.has(String(i.name).toUpperCase()) ? [`*   switch: ${switchOf.get(String(i.name).toUpperCase())}`] : []),
          ...(i.elements ?? []).map(
            (e) =>
              `*   [${e.id}] ${e.fullname}` +
              (e.replacing ? ' -- REPLACES the enhancement point' : '') +
              (e.position ? ` at line ${e.position.startLine}` : '')
          ),
          ...(enhancementSource
            ? (i.elements ?? []).flatMap((e) =>
                e.source ? [`* --- source of [${e.id}] ---`, e.source] : []
              )
            : []),
        ]);
        enhFooter =
          `\n\n* ===== ${impls.length} enhancement implementation(s) bound to ` +
          `${hit['adtcore:name']} =====\n` +
          (lines.length
            ? '* listed whatever their Switch Framework switch says: bound is not running\n' +
              switchNotes.map((n) => `* ⚠ ${n}\n`).join('') +
              lines.join('\n')
            : '* none -- the system reports no enhancement bound to this object') +
          '\n';
      } catch (e) {
        enhFooter =
          `\n\n* ===== enhancements NOT read: ${e.name ?? 'Error'}: ${e.message} =====\n` +
          '* This is not the same as "there are none".\n';
        enhMeta = { asked: true, read: false, reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) };
        gaps.push({ list: 'enhancements', code: e?.name === 'XmlError' ? 'PARSE_FAILED' : 'NOT_READ', reason: enhMeta.reason });
        // The footer tells whoever reads this one answer. The gap tells whoever
        // reads the journal in a month -- and this is the read that stands between
        // the workspace and an inventory of customer code hidden inside standard
        // objects, so a recurring failure here has to be countable.
        journal?.gap?.({
          code: 'ENHANCEMENTS_NOT_READ',
          subject: hit['adtcore:name'],
          detail: `${e.name ?? 'Error'}: ${e.message}`,
          impact:
            'no statement can be made about customer code implanted in this object; ' +
            'a Z-namespace sweep would not see it either',
          fallback: 'read the enhancement implementations in the IDE (Eclipse ADT)',
        });
      }
    }

    record(
      cfg,
      'adt_read_source',
      `${hit['adtcore:name']}#${include ?? 'main'}${enhancements || enhancementSource ? '+enh' : ''}`,
      source.length
    );
    const header =
      `* ${hit['adtcore:name']} (${hit['adtcore:type']}) -- package ` +
      `${hit['adtcore:packageName'] ?? '?'}\n` +
      `* read live from ${cfg.host} client ${cfg.client} at ${new Date().toISOString()}\n` +
      (facets.length > 1
        ? `* this name also exists as ${facets
            .filter((f) => f !== hit['adtcore:type'])
            .join(', ')} -- facets of the same object\n`
        : '') +
      (warning ? `* WARNING: ${warning}\n` : '') +
      (foundBy === 'uri'
        ? `* FOUND BY URI: the quick search does not see this name; read from ` +
          `${hit['adtcore:uri']} directly. Package unknown on this path.\n`
        : '') +
      `\n`;
    const text = textElements ? await readTextElements(hit) : null;
    if (text) gaps.push(...text.gaps);
    return {
      hit, foundBy, warning, header, source, enhFooter: enhFooter + (text?.text ?? ''), enhancedObject,
      alternatives: resolved.alternatives ?? [],
      meta: { enhancements: enhMeta, textElements: text?.meta ?? { asked: false } },
      gaps,
    };
  };

  const tools = [
    {
      definition: {
        name: 'adt_search',
        description:
          'Find repository objects by name or pattern (e.g. "ZCL_SD*"): name, type, package, ' +
          'URI. For APLO and CHKV it also returns `legacy`: objects created in SLG0/SCI, which ' +
          'the ADT does not list.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Name or pattern, e.g. ZCL_SD* or I_SalesDocument',
            },
            objectType: {
              type: 'string',
              description: 'ADT type filter, e.g. CLAS/OC, DDLS/DF, TABL/DT, PROG/P',
            },
            max: {
              type: 'integer',
              minimum: 1,
              maximum: SEARCH_CEILING,
              description: `Hits asked of the search (default 50, at most ${SEARCH_CEILING}); the search has no paging`,
            },
          },
          required: ['query'],
        },
      },
      async handler({ query, objectType, max }) {
        const limit = max === undefined || max === null ? 50 : Number(max);
        const facet = objectType ? String(objectType).toUpperCase() : undefined;
        const incomplete = [];
        const facetOnly = FACET_ONLY_TYPES.has(facet);
        let hits = facetOnly ? [] : await api.searchObject(query, objectType, limit);
        let byFacet = false;
        if (!facetOnly) record(cfg, 'adt_search', query, hits.length);
        // A full page is "more may exist": the quick search has no paging and no total
        // (measured: ENHO/XHH answered 182 of a 200 cap). Counted on the reply, before the facet
        // filter below, because it is the reply that is cut.
        const pageFull = hits.length >= limit;
        // The library form asks the MAJOR type, so a facet's siblings share the page: they are
        // left out of the answer and counted.
        let outsideFacet = 0;
        if (facet?.includes('/') && !facetOnly) {
          const kept = hits.filter((h) => String(h['adtcore:type'] ?? '').toUpperCase() === facet);
          outsideFacet = hits.length - kept.length;
          hits = kept;
        }
        // Empty with a facet is a question, not a verdict (measured): ask once more with the
        // facet whole. The reply then carries no description, and the answer says so.
        const retryable = facet?.includes('/') && /^[A-Z0-9_/]{1,40}\*?$/i.test(String(query));
        let facetRetry = { asked: false, reason: hits.length ? 'the first search answered' : !facet?.includes('/') ? 'no facet asked' : !retryable ? 'the query is not a name or a name with a trailing *' : 'no raw client in this session' };
        if (!hits.length && retryable && facetSearch) {
          hits = await facetSearch(query, facet, limit);
          byFacet = hits.length > 0;
          facetRetry = { asked: true, found: hits.length };
        }
        if (facetOnly && !facetSearch) {
          incomplete.push({ list: 'hits', code: 'NOT_READ', reason: `${facet} answers only through the whole-facet route, and this session has no raw client` });
        }
        // APLO and CHKV have a second kind the ADT never lists (SLG0 / SCI): read it from its
        // tables, so an ADT-only answer is not taken for the whole set (lib/legacy-objects.mjs).
        const legacyKind = legacyKindOf(facet);
        let legacy;
        if (legacyKind) {
          legacy = session.raw
            ? await readLegacyObjects(session.raw, legacyKind, query, {
                language: cfg?.language,
                gap: (row) => journal?.gap?.(row),
                audit: (target, n) => record(cfg, 'adt_search', target, n),
              })
            : { objects: [], complete: false, incomplete: { code: 'NOT_READ', reason: 'no raw client in this session' } };
          if (!legacy.complete) incomplete.push({ list: 'legacy.objects', ...legacy.incomplete });
        }
        if (pageFull) {
          journal?.gap?.({
            code: 'SEARCH_AT_CAP',
            subject: `${query}${objectType ? ` (${objectType})` : ''}`,
            detail: `the quick search returned ${limit} hits for a limit of ${limit}`,
            impact: 'the list may be cut: anything the search ranked below the cap is missing',
            fallback: `narrow the query (a longer prefix, an objectType) or raise max up to ${SEARCH_CEILING}`,
          });
          incomplete.push({
            list: 'hits',
            code: 'SERVER_PAGE_FULL',
            returned: limit,
            total: null,
            narrowBy: limit < SEARCH_CEILING ? ['query', 'objectType', 'max'] : ['query', 'objectType'],
          });
        }
        return asText(
          finish(
            {
              count: hits.length,
              limit,
              ceiling: SEARCH_CEILING,
              truncated: pageFull,
              ...(pageFull ? { narrowBy: limit < SEARCH_CEILING ? ['query', 'objectType', 'max'] : ['query', 'objectType'] } : {}),
              ...(outsideFacet ? { outsideFacet } : {}),
              facetRetry,
              ...(byFacet
                ? {
                    foundBy: 'facet',
                    descriptions: false,
                    note: 'answered by the quick search with the WHOLE facet; that reply carries no description (measured)',
                  }
                : {}),
              // MEASURED 2026-09-12: the information system does not index every object that exists
              // (RV64A953 answers 0 hits by name while its URI reads). The list is complete for the
              // index; the by-name tools also try the direct URI and say foundBy: "uri".
              source: 'quick search index',
              ...(legacy ? { legacy } : {}),
              hits: hits.map((h) => ({
                name: h['adtcore:name'],
                type: h['adtcore:type'],
                package: h['adtcore:packageName'],
                description: h['adtcore:description'],
                uri: h['adtcore:uri'],
              })),
            },
            incomplete
          )
        );
      },
    },

    {
      definition: {
        name: 'adt_read_source',
        description:
          'Source of an object as the system holds it, standard objects included. ' +
          '`enhancements: true` adds the enhancement implementations bound to it (bound is not ' +
          'running: the switch state is reported). `objectNames` reads up to 25 at once. Types ' +
          'without source (DTEL, DOMA, SRVB, TTYP, SHLP, DEVC) are refused with the tool to use.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string' },
            objectNames: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 25,
              description: 'Batch instead of objectName: one item per name, source or error.',
            },
            objectType: {
              type: 'string',
              description: 'Optional ADT type, e.g. CLAS/OC',
            },
            include: {
              type: 'string',
              enum: ['main', 'definitions', 'implementations', 'testclasses', 'macros'],
              description: 'Class include to read (default main)',
            },
            enhancements: {
              type: 'boolean',
              description:
                'List bound ENHOs: point, REPLACES, line, switch state. 1 call, +3 if any.',
            },
            enhancementSource: {
              type: 'boolean',
              description: 'Also the source of each enhancement (implies enhancements).',
            },
            context: {
              type: 'string',
              description: 'Containing program URI, for a PROG/I include used by several.',
            },
            version: {
              type: 'string',
              pattern: VERSION_PATTERN,
              description: 'Class or program: active, inactive, or a history number (00000 = active).',
            },
            compareTo: {
              type: 'string',
              pattern: VERSION_PATTERN,
              description: 'Unified diff from this version to `version` (default active).',
            },
            method: {
              type: 'string',
              description: 'Class only: one method, NAME, INTF~NAME or LOCAL_CLASS->NAME (active/inactive).',
            },
            textElements: {
              type: 'boolean',
              description: 'Program or class: also its text symbols, selection texts and headings.',
            },
          },
        },
      },
      async handler({ objectName, objectNames, objectType, include, enhancements, enhancementSource, context, version, compareTo, method, textElements }) {
        const flags = { objectType, include, enhancements, enhancementSource, context, version, compareTo, method, textElements };
        if (method && (compareTo || Array.isArray(objectNames) || enhancements || enhancementSource || include || textElements)) {
          throw new Error('method reads one method of one class: no compareTo, objectNames, include, enhancements or textElements with it.');
        }
        if (textElements && (version || compareTo)) throw new Error('text elements are read as they are now: ask them without version/compareTo.');
        const versioned = version !== undefined && version !== null || compareTo !== undefined && compareTo !== null;
        if (versioned && Array.isArray(objectNames)) {
          throw new Error('version and compareTo read one object: pass objectName, not objectNames.');
        }
        if (versioned && (enhancements || enhancementSource)) {
          throw new Error('enhancements describe the object as it is now: ask them without version/compareTo.');
        }
        if (Array.isArray(objectNames)) {
          if (objectName) throw new Error('Pass objectName or objectNames, never both.');
          if (!objectNames.length) throw new Error('objectNames is empty.');
          if (objectNames.length > BATCH_CAP) {
            throw new Error(
              `objectNames has ${objectNames.length} names; the cap is ${BATCH_CAP} per call -- split the batch.`
            );
          }
          const items = [];
          for (const name of objectNames) {
            try {
              const one = await readOne(name, flags);
              const itemGaps = one.gaps ?? [];
              items.push({ name, type: one.hit['adtcore:type'], package: one.hit['adtcore:packageName'] ?? null,
                foundBy: one.foundBy, ...(one.warning ? { warning: one.warning } : {}),
                ...(one.enhancedObject !== undefined ? { enhancedObject: one.enhancedObject } : {}),
                ...(one.meta ?? {}),
                complete: !itemGaps.length,
                incomplete: itemGaps,
                source: one.header + one.source + one.enhFooter });
            } catch (e) {
              // A name that resolves to nothing is an ANSWER, the same one a single call gives
              // (lib/report.mjs counts it as a negative answer, not a failure): counted apart, no
              // gap. It carries the caveat adt_search carries, because the index is not complete.
              if (e?.notFound === true) {
                items.push({ name, notFound: true, error: `${e.name ?? 'Error'}: ${e.message}`, note: NOT_FOUND_NOTE });
                continue;
              }
              // The batch goes on. The item says why, the journal counts it, and the count
              // at the top of the reply cannot be read as "all were read".
              journal?.gap?.({
                code: 'BATCH_ITEM_NOT_READ',
                subject: name,
                detail: `${e.name ?? 'Error'}: ${e.message}`,
                impact: 'this name of the batch was not read; the others were, and this is not evidence of absence',
                fallback: `adt_read_source({ objectName: '${name}' }) alone, or the IDE`,
              });
              items.push({ name, error: `${e.name ?? 'Error'}: ${e.message}` });
            }
          }
          const notFound = items.filter((i) => i.notFound).length;
          const failed = items.filter((i) => i.error && !i.notFound).length;
          const partial = items.filter((i) => i.incomplete?.length).length;
          return asText(
            finish({ count: items.length, read: items.length - failed - notFound, notFound, failed, items }, [
              failed ? { list: 'items', code: 'NOT_READ', count: failed, reason: 'see the error of each item' } : null,
              partial ? { list: 'items', code: 'NOT_READ', count: partial, reason: 'items read in part: see the incomplete of each item' } : null,
            ])
          );
        }
        if (!objectName) throw new Error('objectName (or objectNames) is required.');
        const one = await readOne(objectName, flags);
        if (one.json) return asText(one.json);
        // The source stays the text a person reads; what was asked, read and left out is the
        // structured answer, given as JSON text too (the MCP rule: structured content and its text).
        const structured = finish(
          {
            object: { name: one.hit['adtcore:name'], type: one.hit['adtcore:type'], package: one.hit['adtcore:packageName'] ?? null, uri: one.hit['adtcore:uri'] },
            foundBy: one.foundBy,
            ...(one.warning ? { warning: one.warning } : {}),
            ...(one.alternatives?.length ? { alternatives: one.alternatives.map((h) => ({ name: h['adtcore:name'], type: h['adtcore:type'], package: h['adtcore:packageName'] ?? null })) } : {}),
            ...(one.enhancedObject !== undefined ? { enhancedObject: one.enhancedObject } : {}),
            ...(one.meta ?? {}),
          },
          one.gaps ?? []
        );
        return {
          content: [
            { type: 'text', text: one.header + one.source + one.enhFooter },
            { type: 'text', text: JSON.stringify(structured, null, 2) },
          ],
          structuredContent: structured,
        };
      },
    },


    {
      definition: {
        name: 'adt_object_info',
        description:
          'Metadata of an object: package, responsible, dates, release state, structure. Tables ' +
          'and CDS views add the field list (data element, type, annotations). By type: DEVC ' +
          '`packagePath`; ENHO/XHB `badi`; SRVB `binding` (per service version: SRVD, ' +
          'published, URL, entity sets); DTEL `dataElement` and DOMA `domain` (fixed values). ' +
          'Classes, interfaces, CDS, tables, data elements, function modules add `apiRelease` ' +
          '(per contract: state, usable in key-user apps / cloud, successors), read live.',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string' },
            objectType: { type: 'string' },
            fields: {
              type: 'boolean',
              description: 'Fetch the DDIC field list. Default true.',
            },
          },
          required: ['objectName'],
        },
      },
      async handler({ objectName, objectType, fields }) {
        const resolved = await resolveObject(api, objectName, objectType, 'metadata', resolveOpts);
        const { hit, facets, warning, foundBy } = resolved;
        let structure = resolved.structure;
        if (!structure && isClasenh(hit['adtcore:type'])) {
          // A class / interface enhancement: the structure resource dumps the server (3 of 3,
          // 2026-09-12 and 2026-09-14), so it is never asked. The one resource that answers
          // for the type is objectproperties (measurement, step 1c): package chain, owner, API
          // state, creation date -- and nothing about what the enhancement adds.
          clasenhGap(journal, hit['adtcore:name'], `adt_object_info on ${hit['adtcore:uri']}: objectproperties read instead of the structure`);
          if (!session.raw) {
            throw new Error(
              `${hit['adtcore:type']} ${hit['adtcore:name']} exists; its structure is not read on purpose (the ` +
                'resource dumps the server) and this session has no raw client for the objectproperties read. ' +
                CLASENH_WHERE + '.'
            );
          }
          const out = await namedGet(transportFor(session.raw), 'objectProperties', { uri: hit['adtcore:uri'] });
          record(cfg, 'adt_object_info', `${hit['adtcore:name']}#properties`, out.bytes);
          const props = parseObjectProperties(out.body);
          if (props.drift.length) {
            journal?.gap?.({
              code: 'SHAPE_DRIFT',
              subject: hit['adtcore:name'],
              detail: props.drift.map((d) => `${d.node} x${d.count}`).join('; '),
              impact: 'the package chain and owner stand; the measured shape of objectproperties has aged',
              fallback: 're-measure (docs/adt-api-reference.md, "objectproperties")',
            });
          }
          return asText(finish({
            found: hit,
            foundBy,
            facets,
            ...(warning ? { warning } : {}),
            clasenh: true,
            rule:
              'a class enhancement (CLASENH) or function-module interface enhancement (FUGRENH) has no ' +
              `model in the ADT: the structure was NOT read (it dumps the server); ${CLASENH_WHERE}`,
            enhancedObject: null,
            packagePath: props.packagePath,
            parentPackage: props.parentPackage,
            properties: {
              owner: props.owner,
              apiState: props.apiState,
              language: props.language,
              version: props.version,
              created: props.created,
              component: props.component,
              applicationComponent: props.applicationComponent,
              description: props.object.text,
            },
            metadata: {},
            elements: [],
            elementsNote: 'no structure elements: the resource that lists them dumps the server for this type',
          }, [{ list: 'elements', code: 'NOT_READ', reason: 'the structure of this type dumps the server, so it is not asked' }]));
        }
        if (!structure) {
          try {
            structure = await api.objectStructure(hit['adtcore:uri']);
          } catch (e) {
            // A class enhancement (ENHO/XH) answers 500 to its own URI -- 3 of 3 on this
            // system, measured with every Accept, and the cause is in the source
            // (read live): CL_ENH_ADT_ENHO_OBJ_PERSIST->GET_DATA_FROM_TOOL creates its result
            // in a CASE over the tool type with two branches only, BADI_IMPL and HOOK_IMPL,
            // and no WHEN OTHERS; a class enhancement's tool is CLASENH, the result stays
            // initial and the next line dereferences it (CX_SY_REF_IS_INITIAL). Not API
            // misuse: no Accept or parameter cures it. A FAILED READ IS NOT AN ABSENT
            // ENHANCEMENT, and the journal has to count it as the read it is.
            if (/^ENHO\//.test(String(hit['adtcore:type']))) {
              journal?.gap?.({
                code: 'ENHANCEMENTS_NOT_READ',
                subject: hit['adtcore:name'],
                detail: `HTTP ${e?.response?.status ?? e?.status ?? '?'} on ${hit['adtcore:uri']} (${hit['adtcore:type']})`,
                impact:
                  'the enhancement exists (the search returns it) but its structure could not be read; ' +
                  'no statement can be made about what it implants -- this is NOT evidence that it is empty',
                fallback:
                  'SE19 (the enhoxh persistence supports BADI_IMPL and HOOK_IMPL only, read live 2026-09-12; ' +
                  'Eclipse opens a class enhancement in the embedded SAP GUI, not through this resource)',
              });
              throw new Error(
                `${hit['adtcore:type']} ${hit['adtcore:name']} exists but its structure could not be ` +
                  `read (HTTP ${e?.response?.status ?? e?.status ?? '?'}). On this system a class ` +
                  'enhancement (ENHO/XH) dumps server-side on this resource: the persistence ' +
                  '(CL_ENH_ADT_ENHO_OBJ_PERSIST->GET_DATA_FROM_TOOL) supports BADI_IMPL and HOOK_IMPL ' +
                  'only and dereferences an initial result for CLASENH (CX_SY_REF_IS_INITIAL; read live ' +
                  '2026-09-12, 3 of 3). No Accept or parameter cures it. A failed read is not an absent enhancement.'
              );
            }
            throw e;
          }
        }
        // Keep the whole metadata block: which release/API-state attribute the 7.58
        // kernel returns is measured in phase 0, never assumed.
        const skip = new Set(['objectUrl', 'includes', 'nodes']);
        const metadata = Object.fromEntries(
          Object.entries(structure).filter(([k]) => !skip.has(k))
        );

        const gaps = [];
        let elements = [];
        let elementsNote;
        // Only a class and an interface have an outline (lib/adt-reads.mjs): for any other type the
        // list is not asked, which the answer says rather than leaving an empty list to be read.
        const outlined = /\/oo\/(classes|interfaces)\//i.test(String(hit['adtcore:uri'] ?? ''));
        try {
          elements = await api.objectStructureElements(hit['adtcore:uri']);
        } catch (e) {
          gaps.push({ list: 'elements', code: 'NOT_READ', reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) });
          // Not every object type exposes structure elements. Measured: a CDS view
          // returns [] rather than throwing, which is why `ddic` below exists. So this
          // is not a gap of the server -- but it is not nothing either, and an empty
          // `elements` that came from a FAILURE must not read like an empty one that
          // came from an answer.
          elementsNote = `structure elements not read: ${e.name ?? 'Error'}: ${e.message}`;
        }

        // The DDIC field list. objectStructureElements returns [] for a CDS view and
        // a data element has no source at all, so this is the only route to "which
        // data element is behind this field". The shape IS measured -- see "Measured
        // shapes" in docs/adt-api-reference.md, including that `annotations` comes back
        // empty at every path shape -- and it is still handed back RAW by choice: this
        // tool is an inventory, and parsing here would mean deciding what to drop. A
        // failure is reported rather than swallowed either way.
        //
        // ⚠️ IT IS ASKED BY NAME, AND THAT IS NOT A STYLE CHOICE. The dossier measured on
        // 2026-09-09 that `ddicElement` answers on the NAME, not the URL, and that called with
        // a URI it returns `{children: []}` -- an empty answer, NOT an error. This call passed
        // `hit['adtcore:uri']` until 2026-09-22, so every DDIC object came back `ok: true` with
        // no fields, which reads as "this object has no fields" -- the exact silent-wrong answer
        // this server exists to refuse. Measured empty by URI that day: VBAK, KOMPAZ, AGR_TIMEB,
        // ZC_DEMOITEMRATING. The tests did not catch it because `ddicElement` is a double.
        // An empty answer is therefore now REPORTED rather than returned as a field list.
        // A data element and a domain have no fields: ddicElement answers them an empty tree,
        // and filing DDIC_FIELDS_NOT_READ for that sent the reader to "read the TABL" (it did,
        // for BTCXPGSTAT). What they carry is the domain -- type, value table, FIXED VALUES --
        // read through the two allow-listed property calls (lib/ddic.mjs).
        const kind = String(hit['adtcore:type'] ?? '').split('/')[0];
        let dataElement;
        let domain;
        if (kind === 'DTEL' || kind === 'DOMA') {
          const name = hit['adtcore:name'];
          if (kind === 'DTEL') {
            const r = await resolveDataElement(api, name);
            const { calls, ...rest } = r;
            dataElement = rest;
            if (!r.ok || r.reason) gaps.push({ list: 'dataElement', code: 'NOT_READ', reason: String(r.reason ?? 'the data element did not resolve').slice(0, 200) });
            if (!r.ok || r.reason) {
              journal?.gap?.({
                code: 'DOMAIN_NOT_READ',
                subject: name,
                detail: r.reason ?? 'the data element did not resolve',
                impact: 'no statement about the type, value table or fixed values of this element -- NOT "no fixed values"',
                fallback: 'SE11 on the data element, then on its domain (Value Range tab)',
              });
            }
          } else {
            const r = await readDomain(api, name);
            const { calls, ...rest } = r;
            domain = rest;
            if (!r.ok) gaps.push({ list: 'domain', code: 'NOT_READ', reason: String(r.reason ?? 'the domain did not resolve').slice(0, 200) });
            if (!r.ok) {
              journal?.gap?.({
                code: 'DOMAIN_NOT_READ',
                subject: name,
                detail: r.reason,
                impact: 'no statement about the type, value table or fixed values of this domain -- NOT "no fixed values"',
                fallback: 'SE11 on the domain (Value Range tab)',
              });
            }
          }
        }

        // The field list is asked only of a type the contract says has one (lib/type-contract.mjs):
        // asked of anything else, ddicElement answers an empty tree -- or, for a BDEF/DDLX, the
        // fields of the CDS entity of the same name -- and either reads as an answer about THIS
        // object. A type outside the contract is not asked, and is filed.
        const contract = contractOf(hit['adtcore:type']);
        if (!contract) typeNotInContract(hit, 'adt_object_info');
        let fieldsNote;
        if (fields !== false && !contract) gaps.push({ list: 'fields', code: 'OUT_OF_SCOPE', reason: `${hit['adtcore:type']} is not a measured type: its field list is not asked` });
        if (fields !== false && !contract?.fields) {
          fieldsNote = contract
            ? contract.fieldsNote ?? `field list not asked: ${hit['adtcore:type']} has none (lib/type-contract.mjs)`
            : `field list not asked: ${hit['adtcore:type']} is not in lib/type-contract.mjs, so what ddicElement answers for it was never measured -- this is NOT "no fields"`;
        }
        let ddic;
        if (fields !== false && contract?.fields) {
          const path = hit['adtcore:name'];
          try {
            const raw = await api.ddicElement(path);
            ddic = { ok: true, askedBy: 'name', path, raw };
            if (!Array.isArray(raw?.children) || !raw.children.length) {
              ddic.ok = false;
              gaps.push({ list: 'ddic', code: 'NOT_READ', reason: 'the element info answered an empty tree, which it also answers for a path it does not resolve' });
              ddic.note =
                `ddicElement('${path}') answered no children. That is NOT evidence that the object ` +
                'has no fields: this resource answers an empty tree for a path it does not resolve.';
              journal?.gap?.({
                code: 'DDIC_FIELDS_NOT_READ',
                subject: hit['adtcore:name'],
                detail: `ddicElement('${path}') returned ${Array.isArray(raw?.children) ? '0 children' : 'no children array'}`,
                impact: 'no statement can be made about the fields of this object -- an empty tree is not an empty object',
                fallback: 'SE11, or read the DDIC source (adt_read_source on the TABL) and follow its includes',
              });
            }
          } catch (e) {
            ddic = { ok: false, askedBy: 'name', path, error: `${e.name ?? 'Error'}: ${e.message}` };
            gaps.push({ list: 'ddic', code: 'NOT_READ', reason: ddic.error.slice(0, 200) });
          }
        }

        // An ENHO's answer is what it enhances: the link on the structure, decoded the
        // way the sweep decodes it (lib/enhancement-target.mjs). null on a BAdI
        // implementation is the measured answer, not a miss.
        const enhancedObject = /^ENHO\//.test(String(hit['adtcore:type']))
          ? enhancedObjectOf(structure)
          : undefined;

        // A package's parent is not in its structure (measured: no packageRef, no
        // parent link). `findObjectPath` -- allow-listed, one call -- answers the whole chain
        // as DEVC/K steps, root first (YDEMO_ROOT -> YDEMO_FI -> ZDEMO_EXPENSES measured). A failure
        // is reported next to an absent path, never as a root package.
        let packagePath;
        let parentPackage;
        let packagePathNote;
        if (hit['adtcore:type'] === 'DEVC/K') {
          try {
            const steps = await api.findObjectPath(hit['adtcore:uri']);
            packagePath = (Array.isArray(steps) ? steps : []).map((s) => ({
              name: s['adtcore:name'],
              type: s['adtcore:type'],
              uri: s['adtcore:uri'],
            }));
            record(cfg, 'adt_object_info', `${hit['adtcore:name']}#path`, packagePath.length);
            const self = packagePath.findIndex((s) => String(s.name).toUpperCase() === String(hit['adtcore:name']).toUpperCase());
            parentPackage = self > 0 ? packagePath[self - 1].name : self === 0 ? null : undefined;
            if (parentPackage === undefined) {
              packagePathNote = 'the path answered does not contain the package itself; parentPackage is not derived';
              gaps.push({ list: 'packagePath', code: 'PARSE_FAILED', reason: 'the path does not contain the package itself' });
            }
          } catch (e) {
            packagePathNote = `package path not read: ${e.name ?? 'Error'}: ${e.message} -- this is NOT a root package`;
            gaps.push({ list: 'packagePath', code: e?.name === 'XmlError' ? 'PARSE_FAILED' : 'NOT_READ', reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) });
          }
        }

        // A BAdI implementation names its spot only in its body (measured): the
        // object URI is read once more, raw, with the one Accept. Needs the raw client; a
        // failure files ENHANCEMENTS_NOT_READ and the rest of the answer stands.
        let badi;
        let badiNote;
        if (hit['adtcore:type'] === 'ENHO/XHB') {
          if (!session.raw) {
            badiNote = 'badi not read: this session has no raw client';
            gaps.push({ list: 'badi', code: 'NOT_READ', reason: 'no raw client in this session' });
          } else {
            try {
              const out = await derivedGet(transportFor(session.raw), hit['adtcore:uri'], hit['adtcore:uri'], { kind: 'enhoxhb' });
              record(cfg, 'adt_object_info', `${hit['adtcore:name']}#badi`, out.bytes);
              badi = parseEnhoXhb(out.body);
              if (badi.drift.length) {
                journal?.gap?.({
                  code: 'SHAPE_DRIFT',
                  subject: hit['adtcore:name'],
                  detail: badi.drift.map((d) => `${d.node} x${d.count}`).join('; '),
                  impact: 'the spot and class stand; the measured shape of the XHB body has aged',
                  fallback: 'SE19; re-measure (docs/adt-api-reference.md, ENHO/XHB section)',
                });
              }
            } catch (e) {
              journal?.gap?.({
                code: 'ENHANCEMENTS_NOT_READ',
                subject: hit['adtcore:name'],
                detail: `HTTP ${e?.status ?? '?'} on ${hit['adtcore:uri']} (enhoxhb body)`,
                impact: 'the implementation exists; which spot it implements could not be read -- NOT evidence of an orphan',
                fallback: 'SE19, or the implementing class in the structure elements',
              });
              badiNote = `badi not read: ${e.name ?? 'Error'}: ${e.message}`;
              gaps.push({ list: 'badi', code: 'NOT_READ', reason: badiNote.slice(0, 200) });
            }
          }
        }

        // A service binding is form-based (no source, no fields): what it IS lives in the binding
        // document and, per version, in the detail (lib/service-binding.mjs). Needs the raw client.
        let binding;
        let bindingNote;
        if (hit['adtcore:type'] === 'SRVB/SVB') {
          if (!session.raw) {
            bindingNote = 'binding not read: this session has no raw client';
            gaps.push({ list: 'binding', code: 'NOT_READ', reason: 'no raw client in this session' });
          } else {
            const out = await readServiceBinding(transportFor(session.raw), hit['adtcore:name'], {
              gap: (row) => journal?.gap?.(row),
              audit: (target, n) => record(cfg, 'adt_object_info', target, n),
            });
            binding = out.binding;
            bindingNote = out.note;
            if (!binding) gaps.push({ list: 'binding', code: 'NOT_READ', reason: String(out.note ?? 'not read').slice(0, 200) });
            const unread = (binding?.versions ?? []).filter((v) => v.detailNote).length;
            if (unread) gaps.push({ list: 'binding.versions', code: 'NOT_READ', count: unread, reason: 'the detail of these versions was not read: published unknown' });
          }
        }

        // The API release state, read from the system for the families measured (2026-11-10).
        // An empty list is "no contract": the object was resolved above, so it exists.
        let apiRelease;
        if (API_RELEASE_OBJECT.test(String(hit['adtcore:uri'] ?? ''))) {
          if (!session.raw) {
            apiRelease = { read: false, reason: 'this session has no raw client' };
            gaps.push({ list: 'apiRelease', code: 'NOT_READ', reason: 'no raw client in this session' });
          } else {
            let out;
            try {
              out = await namedGet(transportFor(session.raw), 'apiRelease', { uri: hit['adtcore:uri'] });
              const parsed = parseApiRelease(out.body);
              // A reply without its root is not "no contract": it is a reply this parser does not know.
              const rootMissing = parsed.drift.some((d) => d.where === 'root missing');
              apiRelease = rootMissing
                ? { read: false, reason: 'the reply has no ars:apiRelease root' }
                : { read: true, anyReleased: parsed.anyReleased, contracts: parsed.contracts };
              if (rootMissing) gaps.push({ list: 'apiRelease', code: 'PARSE_FAILED', reason: apiRelease.reason });
              if (parsed.drift.length) {
                journal?.gap?.({
                  code: 'SHAPE_DRIFT',
                  subject: `${hit['adtcore:name']} apireleases`,
                  detail: parsed.drift.map((d) => `${d.node}/${d.attribute ?? ''} ${d.where ?? ''}`).join('; '),
                  impact: 'the release state stands where it was read; the measured shape has aged',
                  fallback: 're-measure (docs/adt-api-reference.md, "The API release state of one object")',
                });
              }
            } catch (e) {
              journal?.gap?.({
                code: 'API_RELEASE_NOT_READ',
                subject: `${hit['adtcore:type']} ${hit['adtcore:name']}`,
                detail: `HTTP ${e?.status ?? '?'}: ${e?.message ?? e}`.slice(0, 300),
                impact: 'whether this object is released for use is unknown: this is NOT "not released"',
                fallback: 'the API State tab of the object in the IDE',
              });
              apiRelease = { read: false, reason: `${e.name ?? 'Error'}: ${e.message}` };
              gaps.push({ list: 'apiRelease', code: 'NOT_READ', reason: apiRelease.reason.slice(0, 200) });
            } finally {
              record(cfg, 'adt_object_info', `${hit['adtcore:name']}#apirelease`, out?.bytes ?? 0);
            }
          }
        }
        const abapLanguageVersion = structure?.metaData?.['adtcore:abapLanguageVersion'] ?? null;

        record(cfg, 'adt_object_info', hit['adtcore:name'], elements.length);
        return asText(finish({
          found: hit,
          foundBy,
          facets,
          ...(warning ? { warning } : {}),
          ...(enhancedObject !== undefined ? { enhancedObject } : {}),
          ...(packagePath !== undefined ? { packagePath, parentPackage } : {}),
          ...(packagePathNote ? { packagePathNote } : {}),
          ...(badi !== undefined ? { badi } : {}),
          ...(badiNote ? { badiNote } : {}),
          ...(binding !== undefined ? { binding } : {}),
          ...(bindingNote ? { bindingNote } : {}),
          ...(abapLanguageVersion ? { abapLanguageVersion } : {}),
          ...(apiRelease ? { apiRelease } : {}),
          ...(elementsNote ? { elementsNote } : {}),
          ...(resolved.alternatives?.length ? { alternatives: resolved.alternatives.map((h) => ({ name: h['adtcore:name'], type: h['adtcore:type'], package: h['adtcore:packageName'] ?? null })) } : {}),
          metadata,
          elementsAsked: outlined,
          elements,
          ...(ddic ? { ddic } : {}),
          ...(fieldsNote ? { fieldsNote } : {}),
          ...(contract ? {} : { contract: 'unmeasured' }),
          ...(dataElement ? { dataElement } : {}),
          ...(domain ? { domain } : {}),
        }, gaps));
      },
    },

    {
      definition: {
        name: 'adt_where_used',
        description:
          'Who uses this object, according to the system (ADT usage references).',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string' },
            objectType: { type: 'string' },
            snippets: {
              type: 'boolean',
              description: 'Also fetch the calling code snippet of the rows of this page (slower)',
            },
            max: { type: 'integer', minimum: 1, maximum: WHERE_USED_CEILING, description: `Rows per page (default 100, at most ${WHERE_USED_CEILING})` },
            offset: { type: 'integer', minimum: 0, description: 'First row of the page: `next.offset` of the previous answer' },
            allowStandard: {
              type: 'boolean',
              description:
                'Required for a non-Z/Y object: such a search is expensive for the system.',
            },
          },
          required: ['objectName'],
        },
      },
      async handler({ objectName, objectType, snippets, allowStandard, max, offset }) {
        if (!CUSTOM_NAMESPACE.test(objectName) && !allowStandard) {
          throw new Error(
            `'${objectName}' is an SAP standard object. Where-used on standard objects is the ` +
              'most expensive call this server can make against the SAP system -- pass allowStandard: true ' +
              'if you really need it.'
          );
        }
        const { hit, warning, foundBy } = await resolveObject(api, objectName, objectType, 'metadata', resolveOpts);
        const refs = await api.usageReferences(hit['adtcore:uri']);
        // The whole list is in the reply; the answer pages it, and the snippets are asked for the
        // rows of the page only (the next page asks the where-used again: `next.costsCalls`).
        const p = page(refs, { max, offset, defaultMax: 100, ceiling: WHERE_USED_CEILING });
        const rows = p.items.map((r) => ({
          name: r['adtcore:name'],
          type: r['adtcore:type'],
          package: r.packageRef?.['adtcore:name'],
          responsible: r['adtcore:responsible'],
          usage: r.usageInformation,
          uri: r.uri,
        }));
        const incomplete = [];
        if (p.truncated) incomplete.push({ list: 'rows', code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { ...p.next, costsCalls: 1 } });
        let snippetPart = { asked: false };
        let code = [];
        if (snippets) {
          const askable = p.items.filter((r) => r.objectIdentifier);
          const notAskable = p.items.length - askable.length;
          if (askable.length) {
            const fetched = await api.usageReferenceSnippets(askable);
            code = fetched.flatMap((s) =>
              // `at` is the position of the use (uri, start, end, and the component's type and
              // name); the snippet object carries its identifier, which ties it to its row.
              (s.snippets ?? []).map((x) => ({
                objectIdentifier: s.objectIdentifier,
                at: x.uri,
                content: x.content,
              }))
            );
          }
          snippetPart = { asked: true, rowsAsked: askable.length, count: code.length, ...(notAskable ? { rowsWithoutIdentifier: notAskable } : {}) };
        }
        record(cfg, 'adt_where_used', hit['adtcore:name'], rows.length);
        return asText(
          finish(
            {
              object: hit['adtcore:name'],
              foundBy,
              ...(warning ? { warning } : {}),
              callers: p.total,
              returned: p.returned,
              offset: p.offset,
              limit: p.limit,
              truncated: p.truncated,
              ...(p.next ? { next: { ...p.next, costsCalls: 1 } } : {}),
              rows,
              snippetsPart: snippetPart,
              snippets: code,
            },
            incomplete
          )
        );
      },
    },

    {
      definition: {
        name: 'adt_package_tree',
        description:
          'Contents of a package: sub-packages and objects by type, with counts. The tree\'s ' +
          'descriptions are shifted one row, so they come as `treeDescription`; `describe: true` ' +
          'reads the correct ones and `objectsBelow`.',
        inputSchema: {
          type: 'object',
          properties: {
            packageName: { type: 'string' },
            depth: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: 'Sub-package depth: default 1, at most 3 (5 with compact)',
            },
            max: { type: 'integer', minimum: 1, maximum: TREE_OBJECTS_CEILING, description: `Objects listed per package (default 500, at most ${TREE_OBJECTS_CEILING})` },
            offset: { type: 'integer', minimum: 0, description: 'First object of the listed package: `next.offset` of the previous answer' },
            compact: {
              type: 'boolean',
              description: 'Counts and hierarchy, no object list (a deep tree is MBs otherwise).',
            },
            describe: {
              type: 'boolean',
              description: 'One virtual-folders call per package. Default false.',
            },
          },
          required: ['packageName'],
        },
      },
      async handler({ packageName, depth, describe, compact, max, offset }) {
        const isCompact = compact === true;
        const depthCeiling = isCompact ? 5 : 3;
        if (depth !== undefined && depth !== null && Number(depth) > depthCeiling) {
          throw new Error(`depth ${depth} is beyond ${depthCeiling}${isCompact ? '' : ' (5 with compact: true)'}: walk a sub-package from the answer instead.`);
        }
        const maxDepth = Number(depth) || 1;
        const seen = new Set();
        const wantsDescriptions = describe === true;
        const incomplete = [];

        // `description` is the sub-package text the PARENT fetched with describe: true; in
        // compact form the object list that carried it is dropped, so it rides on the node.
        const walk = async (pkg, level, description) => {
          if (seen.has(pkg) || level > maxDepth) return null;
          seen.add(pkg);
          const node = await api.nodeContents('DEVC/K', pkg);
          // `nodes` mixes two things: real objects, and the TYPE FOLDERS the ADT tree
          // draws ("Dictionary", "Business Services", ...). A folder comes back with an
          // OBJECT_TYPE like DEVC/Q1S and an EMPTY OBJECT_NAME. Counting them as
          // objects inflates the answer -- measured on ZDEMO_ERP_INT, which reported 11
          // objects when it holds 6. They are reported separately rather than dropped,
          // so the number still reconciles with what the tree shows.
          // ⚠️ DESCRIPTION IS NOT THE DESCRIPTION OF THE ROW IT SITS ON. Measured on
          // YDEMO_ROOT: the reply is 11 nodes -- the "Subpacotes" folder (empty name) plus ten
          // packages -- and the folder carries the FIRST package's text, each package carries
          // the NEXT one's, the last is empty. The library's parser is one object per XML
          // element (nodeContents.js), so nothing on this side can shift a child across
          // siblings: the server sends it that way, and the resource is POST-only (a raw GET
          // answers 405), so the bytes cannot be re-read through the GET seam. Realigning by
          // one would be a guess from one package with one folder; the text is carried as
          // what it is, and the search -- which answers correctly -- is offered instead.
          const all = (node.nodes ?? []).map((n) => ({
            name: n.OBJECT_NAME,
            type: n.OBJECT_TYPE,
            treeDescription: n.DESCRIPTION,
          }));
          const objects = all.filter((o) => (o.name ?? '').trim());
          const subs = objects.filter((x) => x.type === 'DEVC/K');
          if (wantsDescriptions && subs.length) {
            // One POST for the whole package (lib/virtual-folders.mjs): every sub-package's
            // description, aligned, and the objects below it. The search per sub-package stays as
            // the fallback, so a failed POST costs calls, never the answer.
            let vf = null;
            if (session.raw) {
              let out;
              try {
                out = await virtualFoldersPost(session.raw, pkg);
                vf = parseVirtualFolders(out.body);
              } catch (e) {
                journal?.gap?.({
                  code: 'PACKAGE_FOLDERS_NOT_READ',
                  subject: pkg,
                  detail: `HTTP ${e?.status ?? '?'}: ${e?.message}`,
                  impact: 'the descriptions were read through the search instead (one call per sub-package); objectsBelow is not given',
                  fallback: 'the project explorer of Eclipse ADT',
                });
              } finally {
                record(cfg, 'adt_package_tree', `${pkg}#folders`, out?.bytes ?? 0);
              }
              if (vf?.drift.length) {
                journal?.gap?.({
                  code: 'SHAPE_DRIFT',
                  subject: pkg,
                  detail: vf.drift.map((d) => `<${d.node}> x${d.count}`).join('; '),
                  impact: 'the folders read stand; the measured shape of the virtual folders has aged',
                  fallback: 're-measure (docs/adt-api-reference.md, "Virtual folders")',
                });
              }
            }
            let undescribed = 0;
            for (const o of subs) {
              const f = vf?.subPackages.find((x) => String(x.name).toUpperCase() === String(o.name).toUpperCase());
              if (f) {
                o.description = f.description;
                o.objectsBelow = f.objectsBelow;
                o.descriptionSource = 'folders';
              } else {
                const hits = await api.searchObject(o.name, 'DEVC/K', 5);
                const own = hits.find((h) => String(h['adtcore:name']).toUpperCase() === String(o.name).toUpperCase());
                o.description = own?.['adtcore:description'] ?? null;
                o.descriptionSource = own ? 'search' : 'notFound';
                if (!own) undescribed += 1;
              }
            }
            if (undescribed) incomplete.push({ list: `${pkg}.subPackages.description`, code: 'NOT_READ', count: undescribed, reason: 'neither the folders nor the search answered the sub-package' });
          }
          const folders = all.length - objects.length;
          const byType = objects.reduce((acc, o) => {
            acc[o.type] = (acc[o.type] ?? 0) + 1;
            return acc;
          }, {});
          const subPackages = [];
          const notWalked = [];
          for (const sub of objects.filter((o) => o.type === 'DEVC/K')) {
            if (level >= maxDepth) {
              notWalked.push(sub.name);
              continue;
            }
            const child = await walk(sub.name, level + 1, sub.description);
            if (child) subPackages.push(child);
          }
          if (notWalked.length) incomplete.push({ list: `${pkg}.subPackages`, code: 'DEPTH_LIMIT', count: notWalked.length, packages: notWalked });
          // The objects of each package, paged: `offset` applies to the package asked, and the
          // `next` of any other names it, to be asked as packageName.
          const listed = isCompact ? null : page(objects, { max, offset: level === 1 ? offset : 0, defaultMax: 500, ceiling: TREE_OBJECTS_CEILING });
          const next = listed?.next ? { packageName: pkg, offset: listed.next.offset } : null;
          if (listed?.truncated) incomplete.push({ list: `${pkg}.objects`, code: 'CAP_REACHED', returned: listed.returned, total: listed.total, next });
          return {
            package: pkg,
            ...(isCompact && description !== undefined ? { description } : {}),
            total: objects.length,
            ...(folders ? { treeFolders: folders } : {}),
            byType,
            ...(listed ? { objects: listed.items, objectsPage: { returned: listed.returned, offset: listed.offset, limit: listed.limit, truncated: listed.truncated, ...(next ? { next } : {}) } } : {}),
            ...(notWalked.length ? { subPackagesNotWalked: notWalked } : {}),
            subPackages,
          };
        };

        const tree = await walk(packageName.toUpperCase(), 1);
        record(cfg, 'adt_package_tree', `${packageName}${isCompact ? '#compact' : ''}`, tree?.total ?? 0);
        return asText(finish({
          ...tree,
          depth: maxDepth,
          depthCeiling,
          ...(isCompact ? { compact: true } : {}),
          descriptions:
            'treeDescription is the text the tree resource sent on that row, and on this system ' +
            'it belongs to the NEXT row (measured, docs/adt-api-reference.md). ' +
            (wantsDescriptions
              ? 'description on each sub-package is from the virtual folders (with objectsBelow), or from the search where those were not read; both answer correctly.'
              : 'Pass describe: true, or adt_search(name, DEVC/K), for the correct text.'),
        }, incomplete));
      },
    },

    // The sixth tool lives in its own file: it is a pipeline over nine steps and eight
    // modules, not a single call like the five above.
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

  // Validated INSIDE the journal wrapper, so a refused call is still one line in logs/calls.
  // `publish` adds what tools/list owes a client: title, behaviour hints, a closed schema.
  return tools.map((t) => journaled(validated({ ...t, definition: publish(t.definition) }), journal, cfg, session));
}
