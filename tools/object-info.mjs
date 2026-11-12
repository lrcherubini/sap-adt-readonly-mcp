// adt_object_info: package, owner, dates, API release state and structure of one object, and
// what a service binding, a package or an enhancement implementation is about.
//
// Built by buildTools (tools/index.mjs), which wraps it in the schema check and the journal.

import { finish } from '../lib/completeness.mjs';
import { record } from '../lib/audit.mjs';
import { enhancedObjectOf, parseEnhoXhb } from '../lib/enhancement-target.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { namedGet, derivedGet, transportFor } from '../lib/adt-get.mjs';
import { parseObjectProperties, isClasenh, clasenhGap, CLASENH_WHERE } from '../lib/object-properties.mjs';
import { resolveDataElement, readDomain } from '../lib/ddic.mjs';
import { contractOf } from '../lib/type-contract.mjs';
import { readServiceBinding } from '../lib/service-binding.mjs';
import { parseApiRelease, API_RELEASE_OBJECT } from '../lib/api-release.mjs';
import { asText, typeNotInContractGap } from './common.mjs';

export function objectInfoTool(cfg, session, journal, { resolveOpts } = {}) {
  const api = session.api;
  const typeNotInContract = typeNotInContractGap(journal);

  return {
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
  };
}
