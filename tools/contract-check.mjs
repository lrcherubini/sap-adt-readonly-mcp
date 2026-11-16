// adt_contract_check -- which expose aliases of a service definition are frozen contracts, and
// whether the Fiori apps named by the caller still address names the service publishes.
//
// The service definition format accepts NO comment of any kind, so the object that carries the
// most breakable decision in an OData service is also the one that cannot warn anybody. This
// tool is the substitute for that missing comment: for every `expose <entity> as <alias>` it
// names the EntitySet and EntityType the alias generates -- the names a consumer addresses by
// hand, and that a rename breaks with no activation error anywhere.
//
// Read from the system:
//   * the SRVD source (one ADT call);
//   * with `apps`: each app as the UI5 repository serves it (lib/adt-get.mjs, ui5Folder /
//     ui5File) and the LIVE $metadata of every OData service its manifest names, V2 or V4
//     (odataMetadata / odataMetadataV4). Every hand-written reference of the app is checked
//     against that live document (lib/ui5-repository.mjs) -- never against the localService copy
//     the app carries, which nobody refreshes and the app never loads.
//
// The consumers are NAMED, never searched: the filestore list (thousands of apps, 1.4 MB, no
// filter honoured -- measured) says nothing about which service an app consumes, and finding out
// would mean a manifest read per app on every call. No index is kept either (no cache of the
// system in this server unless asked for). So an alias no named app cites is NOT claimed unused,
// and the answer says so. CPI integrations live in another system (SAP BTP) and are out of scope.

import { record } from '../lib/audit.mjs';
import { checkContract } from '../lib/contract.mjs';
import { sourceUriOf } from '../lib/package-sources.mjs';
import { namedGet, transportFor, TEMPLATES } from '../lib/adt-get.mjs';
import { finish } from '../lib/completeness.mjs';
import {
  parseFolderFeed,
  dataSourcesOf,
  odataModelsOf,
  parseServiceMetadata,
  manifestCitations,
  citationsOf,
  checkCitations,
  filesWorthReading,
  folderWorthWalking,
} from '../lib/ui5-repository.mjs';

const SRVD_NAME = /^[A-Z0-9_/]{1,30}$/;
const APP_NAME = /^[A-Z0-9_]{1,30}$/;
export const MAX_APPS = 10;
/** Per app. The measured app has 9 folders and 12 files worth reading. */
export const MAX_FOLDERS = 40;
export const MAX_FILES = 60;

const upper = (s) => String(s ?? '').toUpperCase();
/** One part of an app not read: what (`kind`, `name`), the completeness code, and why. */
const gap = (kind, code, reason, extra = {}) => ({ kind, code, ...extra, reason: String(reason).slice(0, 200) });
const said = (e) => String(e?.message ?? e).slice(0, 200);

function appsOf(raw) {
  if (raw === undefined || raw === null) return [];
  const list = (Array.isArray(raw) ? raw : [raw]).map((a) => String(a ?? '').trim().toUpperCase()).filter(Boolean);
  const bad = list.filter((a) => !APP_NAME.test(a));
  if (bad.length) throw new Error(`apps must be names of deployed UI5 apps (BSP names, e.g. ZUI5_DEMO_APP) -- got '${bad.join("', '")}'`);
  if (list.length > MAX_APPS) throw new Error(`at most ${MAX_APPS} apps per call -- got ${list.length}`);
  return [...new Set(list)];
}

/**
 * Read one app and check it against the live metadata of its services.
 * @returns {object} the per-app report; `results` carries every checked citation
 */
async function readApp(ctx, app) {
  const { cfg, transport, journal, metaCache } = ctx;
  const report = { app, services: [], filesRead: 0, notRead: [], results: [] };
  const get = async (route, params, target) => {
    const out = await namedGet(transport, route, params);
    record(cfg, 'adt_contract_check', target, out.bytes);
    return out;
  };

  let manifest;
  try {
    manifest = JSON.parse((await get('ui5File', { path: `${app}/manifest.json` }, `UI5 ${app}/manifest.json`)).body);
  } catch (e) {
    report.notRead.push(gap('manifest', 'NOT_READ', said(e), { name: 'manifest.json' }));
    report.read = false;
    return report;
  }
  report.read = true;

  // --- the services, live ----------------------------------------------------------------
  const services = [];
  for (const ds of dataSourcesOf(manifest)) {
    const row = { dataSource: ds.name, uri: ds.uri, version: ds.version };
    report.services.push(row);
    if (!ds.route) {
      row.metadata = { read: false, reason: ds.unmeasured };
      report.notRead.push(gap('service', 'OUT_OF_SCOPE', ds.unmeasured, { name: ds.name }));
      continue;
    }
    if (TEMPLATES.get(ds.route).shapeObserved !== true) {
      row.metadata = { read: false, reason: `the ${ds.route} route has not been measured on this system yet -- nothing is checked against it` };
      report.notRead.push(gap('service', 'OUT_OF_SCOPE', `${ds.route} not measured`, { name: ds.name }));
      continue;
    }
    const key = `${ds.route}|${ds.key}`;
    let md = metaCache.get(key);
    if (!md) {
      try {
        md = parseServiceMetadata((await get(ds.route, { service: ds.key }, `$metadata ${ds.uri}`)).body);
      } catch (e) {
        row.metadata = { read: false, reason: said(e) };
        report.notRead.push(gap('service', 'NOT_READ', said(e), { name: ds.name }));
        continue;
      }
      metaCache.set(key, md);
    }
    if (!md.entitySets.size && !md.operations.size) {
      row.metadata = { read: false, reason: 'the reply has no entity set and no operation -- not the measured shape' };
      report.notRead.push(gap('service', 'PARSE_FAILED', 'unrecognised $metadata shape', { name: ds.name }));
      continue;
    }
    Object.assign(row, { metadata: { read: true }, service: ds.service, srvd: md.srvd, odata: md.version, entitySets: md.entitySets.size, operations: md.operations.size });
    services.push({ service: ds.service, dataSource: ds.name, metadata: md });
  }

  // --- the app's files ----------------------------------------------------------------
  const entries = [];
  const queue = [app];
  let folders = 0;
  while (queue.length) {
    const folder = queue.shift();
    if (folders >= MAX_FOLDERS) {
      report.notRead.push(gap('folders', 'CAP_REACHED', `folders past ${MAX_FOLDERS} were not walked`, { count: queue.length + 1 }));
      break;
    }
    folders++;
    try {
      const items = parseFolderFeed((await get('ui5Folder', { path: folder }, `UI5 ${folder}/`)).body);
      entries.push(...items);
      for (const i of items) if (i.kind === 'folder' && folderWorthWalking(i.path)) queue.push(i.path);
    } catch (e) {
      report.notRead.push(gap('folder', 'NOT_READ', said(e), { name: `${folder}/` }));
    }
  }
  let files = filesWorthReading(entries);
  if (files.length > MAX_FILES) {
    report.notRead.push(gap('files', 'CAP_REACHED', `files past ${MAX_FILES} were not read`, { count: files.length - MAX_FILES, total: files.length }));
    files = files.slice(0, MAX_FILES);
  }
  const models = odataModelsOf(manifest);
  const citations = manifestCitations(`${app}/manifest.json`, manifest);
  for (const file of files) {
    try {
      citations.push(...citationsOf(file, (await get('ui5File', { path: file }, `UI5 ${file}`)).body, models));
      report.filesRead++;
    } catch (e) {
      report.notRead.push(gap('file', 'NOT_READ', said(e), { name: file }));
    }
  }
  report.citations = citations.length;
  if (!services.length) {
    report.notRead.push(gap('references', 'NOT_READ', 'no service of this app could be read: its references were NOT checked', { count: citations.length }));
    return report;
  }
  report.results = checkCitations(citations, services);
  return report;
}

export async function runContractCheck(cfg, api, args = {}, journal = null, transport = null) {
  const service = String(args.service ?? '').trim().toUpperCase();
  if (!SRVD_NAME.test(service)) throw new Error(`service must be a service definition name, e.g. ZUI_DEMO_O4 -- got '${args.service}'`);
  const apps = appsOf(args.apps);
  if (apps.length && typeof transport !== 'function') {
    throw new Error('apps cannot be read: this session has no raw client for the UI5 repository routes.');
  }
  let source;
  try {
    source = String(await api.getObjectSource(sourceUriOf({ type: 'SRVD/SRV', name: service })));
    record(cfg, 'adt_contract_check', `SRVD/SRV ${service}`, source.length);
  } catch (e) {
    journal?.gap?.({
      code: 'SOURCE_NOT_READ',
      subject: `SRVD/SRV ${service}`,
      detail: String(e?.message ?? e).slice(0, 200),
      impact: 'no contract could be stated for this service: NOT "it exposes nothing"',
      fallback: 'adt_search the name with objectType SRVD/SRV, then adt_read_source',
    });
    throw new Error(`the service definition ${service} was not read: ${e?.message ?? e}`);
  }

  const out = checkContract({ services: [{ file: `${service.toLowerCase()}.srvd`, source }] });
  const findings = [...out.findings];

  // --- the named apps -------------------------------------------------------------------
  const ctx = { cfg, transport, journal, metaCache: new Map() };
  const reports = [];
  for (const app of apps) reports.push(await readApp(ctx, app));

  /** contract row (by upper entity set) -> who cites it */
  const citedBy = new Map();
  const rowOf = new Map();
  for (const c of out.contract) {
    for (const g of [...c.generated, c.entityType]) rowOf.set(upper(g), c);
  }
  for (const r of reports) {
    for (const res of r.results) {
      const c = res.citation;
      if (res.status === 'broken') {
        findings.push({
          code: 'UI5_REFERENCE_BROKEN',
          repo: r.app,
          file: c.file,
          line: c.line,
          subject: c.of ? `${c.of}.${c.name}` : c.type && c.name ? `${c.type}/${c.name}` : c.name ?? c.type,
          context: { kind: c.kind, app: r.app },
          effect: `${c.file}${c.line ? `:${c.line}` : ''} addresses something the live service does not publish: ${res.reason}. The app fails at runtime, in the browser, with no error on the system`,
          fix: 'point the app at a name the service publishes today, or restore the name in the service',
        });
        continue;
      }
      // Attribution to THIS service definition: only through the live namespace of the service the
      // reference held in (a binding of another SRVD may well carry an entity set of the same name).
      if (res.status !== 'holds' || upper(res.srvd) !== service) continue;
      const name = c.kind === 'entitySet' ? c.name : c.kind === 'property' ? c.of : c.kind.startsWith('annotation') ? c.type : null;
      const row = name ? rowOf.get(upper(name)) : null;
      if (!row) continue;
      if (!citedBy.has(row.entitySet)) citedBy.set(row.entitySet, []);
      const list = citedBy.get(row.entitySet);
      if (!list.some((x) => x.file === c.file && x.as === name)) list.push({ app: r.app, file: c.file, line: c.line, as: name });
    }
    // ONE row per app, whatever it could not read (the detail names up to six parts): a call
    // names at most MAX_APPS apps, so the stream grows by at most that many rows per call --
    // the bound the removed offline scan lacked (one row per consumer file, 99.7% of a stream).
    if (r.notRead.length) {
      journal?.gap?.({
        code: 'UI5_APP_NOT_READ',
        subject: `UI5 ${r.app}`,
        detail: r.notRead.slice(0, 6).map((g) => `${g.name ?? g.kind}: ${g.reason}`).join('; '),
        impact: 'the parts named were not checked: NOT "no broken reference"',
        fallback: 'open the app in the IDE (Fiori tools / BAS) and the service in /IWFND/MAINT_SERVICE',
      });
    }
  }
  if (journal?.enabled) for (const f of findings) journal.finding(f);

  const fiori = apps.length
    ? `READ: ${apps.length} app(s) named by the caller, each checked against the LIVE $metadata of its services. ` +
      'The UI5 repository cannot be searched by service, so an alias no app below cites may still be cited by an app not named'
    : 'NOT READ: name the deployed apps (apps: [<BSP name>, ...]) to check them -- no alias below is claimed unused';

  // Every part not read, per app; and the references no service could judge.
  const incomplete = [];
  for (const r of reports) {
    for (const g of r.notRead) incomplete.push({ list: `apps.${r.app}.${g.kind}`, code: g.code, ...(g.count !== undefined ? { count: g.count } : {}), ...(g.total !== undefined ? { total: g.total } : {}), reason: g.reason });
    const unattributed = r.results.filter((x) => x.status === 'unattributed').length;
    if (unattributed) incomplete.push({ list: `apps.${r.app}.references`, code: 'NOT_READ', count: unattributed, reason: "local annotations on a namespace none of the app's services has: not checked" });
  }

  return finish({
    service,
    scope: {
      exposes: out.contract.length,
      appsAsked: apps.length > 0,
      consumers: {
        fiori,
        cpi: 'out of scope: CPI runs in SAP BTP, another system with another credential',
      },
    },
    findings,
    // The artefact to freeze: every alias and the names it generates.
    contract: out.contract.map((c) => ({
      entity: c.entity,
      alias: c.alias,
      entitySet: c.entitySet,
      entityType: c.entityType,
      alsoGenerated: c.generated.filter((g) => g !== c.entitySet && g !== c.entityType),
      ...(apps.length ? { citedBy: citedBy.get(c.entitySet) ?? [] } : {}),
    })),
    ...(apps.length
      ? {
          apps: reports.map((r) => {
            const count = (s) => r.results.filter((x) => x.status === s).length;
            return {
              app: r.app,
              read: r.read,
              services: r.services,
              filesRead: r.filesRead,
              references: r.citations ?? 0,
              holds: count('holds'),
              broken: count('broken'),
              // A local annotation on a namespace none of the app's services has: not checked.
              unattributed: count('unattributed'),
              notRead: r.notRead,
            };
          }),
          notChecked:
            'relative bindings ({Prop}: their context is decided at runtime), payloads built in a variable, ' +
            'Filter objects, paths past their first navigation, JSON models',
        }
      : {}),
  }, incomplete);
}

export function contractCheckTool(cfg, api, journal, session = null) {
  return {
    definition: {
      name: 'adt_contract_check',
      description:
        'OData contract of one service definition: each expose alias and the EntitySet/EntityType ' +
        'it generates (a rename breaks consumers silently). With `apps`, the named Fiori apps\' ' +
        'references are checked against the live $metadata. One call, plus ~15-30 per app.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service definition (SRVD) name, e.g. ZUI_DEMO_O4' },
          apps: {
            type: 'array',
            items: { type: 'string' },
            maxItems: MAX_APPS,
            description: `Deployed UI5 apps (BSP names); at most ${MAX_APPS}`,
          },
        },
        required: ['service'],
      },
    },
    async handler(args = {}) {
      // Bound only when apps are asked for: without them the tool makes its one ADT call, as before.
      const transport = args.apps?.length && session?.raw ? transportFor(session.raw) : null;
      const out = await runContractCheck(cfg, api, args, journal, transport);
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  };
}
