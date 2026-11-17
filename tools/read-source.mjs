// adt_read_source: the source the system stores, one object or a batch, a stored version or the
// diff of two, one method, the text elements, and the enhancements implanted in it.
//
// Built by buildTools (tools/index.mjs), which wraps it in the schema check and the journal.

import { finish } from '../lib/completeness.mjs';
import { mainInclude, classIncludes } from '../lib/object-structure.mjs';
import { record } from '../lib/audit.mjs';
import { enhancedObjectOf } from '../lib/enhancement-target.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { isClasenh, clasenhGap, CLASENH_WHERE } from '../lib/object-properties.mjs';
import { previewQuery, packagesOf, switchChain, describeChain } from '../lib/switch-chain.mjs';
import { contractOf, sourceRefusal } from '../lib/type-contract.mjs';
import { VERSION_PATTERN, readVersion, compareVersions, readerFor, documentVersion } from '../lib/source-versions.mjs';
import { parseClassComponents, findMethod, sliceLines, methodLabel } from '../lib/class-components.mjs';
import { objectSegmentOf } from '../lib/object-name.mjs';
import { asText, typeNotInContractGap } from './common.mjs';
import { invalidArguments, notApplicable } from '../lib/tool-error.mjs';

/** What a "not found" in a batch does and does not say -- the caveat of an empty adt_search. */
const NOT_FOUND_NOTE =
  'the search answered no object of this name, and so did the direct URI where the type has one ' +
  '(PROG/P, PROG/I, CLAS/OC, FUGR/F): the name resolves to nothing here. The index does not know ' +
  'every object that exists (measured), so for other types this is the index speaking';

export function readSourceTool(cfg, session, journal, { resolveOpts } = {}) {
  const api = session.api;
  const typeNotInContract = typeNotInContractGap(journal);

  // adt_read_source, one object. Shared by the single and the batch form so a batch
  // item is exactly what the single call would answer -- the only difference is that
  // a failure stays inside its item.
  const BATCH_CAP = 25;
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
      throw notApplicable(`method reads a method of a class; ${hit['adtcore:type']} ${name} is not one.`);
    }
    const v = version ?? 'active';
    if (v !== 'active' && v !== 'inactive') {
      throw invalidArguments('method is read in the active or the inactive version, not in a history number.');
    }
    if (!session.raw) throw new Error('this session has no raw client: the class outline cannot be read.');
    const read = readerFor(transportFor(session.raw), uri, (kind, out) =>
      record(cfg, 'adt_read_source', `${name}->${method} ${kind}`, out?.bytes ?? 0)
    );
    if (v === 'inactive') {
      const doc = await read('objectVersion', null, { version: 'inactive' });
      if (documentVersion(doc.body) !== 'inactive') {
        throw notApplicable(`${name} has no inactive version: read the method with version active.`);
      }
    }
    const outline = await read('classComponents', `${uri}/objectstructure`, { version: v, withShortDescriptions: 'true' });
    const found = findMethod(parseClassComponents(outline.body), method);
    if (!found.method) {
      throw notApplicable(
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
        out = await namedGet(transportFor(session.raw), route, { name: objectSegmentOf(decodeURIComponent(m[2])) ?? m[2].toLowerCase() });
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
      throw notApplicable(
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
        throw notApplicable(`Include '${include}' not available for ${objectName}.`);
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

  return {
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
        throw invalidArguments('method reads one method of one class: no compareTo, objectNames, include, enhancements or textElements with it.');
      }
      if (textElements && (version || compareTo)) throw invalidArguments('text elements are read as they are now: ask them without version/compareTo.');
      const versioned = version !== undefined && version !== null || compareTo !== undefined && compareTo !== null;
      if (versioned && Array.isArray(objectNames)) {
        throw invalidArguments('version and compareTo read one object: pass objectName, not objectNames.');
      }
      if (versioned && (enhancements || enhancementSource)) {
        throw invalidArguments('enhancements describe the object as it is now: ask them without version/compareTo.');
      }
      if (Array.isArray(objectNames)) {
        if (objectName) throw invalidArguments('Pass objectName or objectNames, never both.');
        if (!objectNames.length) throw invalidArguments('objectNames is empty.');
        if (objectNames.length > BATCH_CAP) {
          throw invalidArguments(
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
      if (!objectName) throw invalidArguments('objectName (or objectNames) is required.');
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
      // A client shows the text blocks or the structured content, not always both. The source is
      // therefore in each ONCE: as text in the first block, as `source` in the structured
      // content. (It used to be in the text only, and a client that shows structured content got
      // the metadata of a source and no source.) The second text block is the structure without
      // the source, so the text does not carry it twice.
      const notes = one.enhFooter.trim();
      return {
        content: [
          { type: 'text', text: one.header + one.source + one.enhFooter },
          { type: 'text', text: JSON.stringify(structured) },
        ],
        structuredContent: { ...structured, source: one.source, ...(notes ? { sourceNotes: notes } : {}) },
      };
    },
  };
}
