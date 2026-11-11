// Is the value help actually reachable through the service?
//
// The failure this catches is silent by construction: an entity named in a
// `valueHelpDefinition` but NOT exposed in the `.srvd.srvdsrv` activates cleanly, logs
// nothing in /IWFND/ERROR_LOG, and the F4 simply comes up empty for the user
// (guides/cds-rap-patterns.md:142-147). It costs zero ADT calls to check -- both sides
// are in the working tree -- and it already finds two real defects in a measured workspace:
//
//   zui_demoitemrating.srvd.srvdsrv   exposes none of the 5 value helps used in the
//                                       parameters of zc_demoitemrating
//   zui_demo_invmap_o4.srvd.srvdsrv    does not expose I_UnitOfMeasureStdVH
//
// Three rules the check has to respect:
//
//   * standard entities count. `I_CompanyCodeVH as CompanyCodeVH` is exposed explicitly
//     in zdemo_employee_ui, and it has to be -- being released does not put it in the
//     service.
//   * the ALIAS is free. `expose X as Y` satisfies a binding to X; the alias is what the
//     EntityType is called, and renaming it breaks the CPI mapping, not this check.
//   * no `.srvd` in the package is INCONCLUSIVE, not a defect. A view with no service
//     may be consumed by another package's service, and reporting that as broken would
//     be a false positive on every interface view in the workspace.

import { stripComments } from './annotations.mjs';

/**
 * The entities a service definition exposes.
 *
 * @param {string} source contents of a .srvd.srvdsrv
 * @returns {{service:string|null, exposed:{entity:string, alias:string|null}[]}}
 */
export function parseService(source) {
  const s = stripComments(String(source ?? ''));
  const service = /define\s+service\s+([A-Za-z_]\w*)/i.exec(s)?.[1] ?? null;
  const exposed = [];
  for (const m of s.matchAll(/\bexpose\s+([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/gi)) {
    exposed.push({ entity: m[1], alias: m[2] ?? null });
  }
  return { service, exposed };
}

/**
 * Check that every entity bound as a value help is exposed.
 *
 * @param {{entity:string, element?:string|null, file?:string, line?:number}[]} edges
 *        value-help edges of the consuming view (from lib/precedent)
 * @param {{source?:string, file?:string}[]} services the .srvd files of the package
 * @returns {{conclusive:boolean, ok:boolean, missing:object[], exposed:object[],
 *            services:string[], note:string}}
 */
export function checkExposure(edges = [], services = [], { allRead = true } = {}) {
  const parsed = services
    .filter((s) => s && typeof s.source === 'string')
    .map((s) => ({ ...parseService(s.source), file: s.file }));

  if (!parsed.length) {
    return {
      conclusive: false,
      ok: true,
      missing: [],
      exposed: [],
      services: [],
      note:
        'no service definition was given for this package, so exposure could not be ' +
        'checked -- this is inconclusive, not a defect: the view may be consumed by a ' +
        'service that lives elsewhere',
    };
  }

  const index = new Map();
  for (const svc of parsed) {
    for (const e of svc.exposed) {
      index.set(e.entity.toUpperCase(), { ...e, service: svc.service, file: svc.file });
    }
  }

  const missing = [];
  const exposed = [];
  const seen = new Set();
  for (const edge of edges) {
    const name = String(edge.entity ?? '');
    if (!name || seen.has(name.toUpperCase())) continue;
    seen.add(name.toUpperCase());
    const hit = index.get(name.toUpperCase());
    if (hit) {
      exposed.push({ entity: name, as: hit.alias ?? name, service: hit.service });
    } else {
      missing.push({
        entity: name,
        boundOn: edge.element ?? null,
        at: edge.file ? `${edge.file}${edge.line ? `:${edge.line}` : ''}` : null,
        effect:
          'the F4 will come up empty with no activation error and no /IWFND/ERROR_LOG ' +
          'entry: the ValueList points at an entity the service does not expose',
        fix: `add \`expose ${name} as ${name.replace(/^Z?[IC]_/i, '')};\` to ${
          parsed[0].service ?? 'the service definition'
        }`,
      });
    }
  }

  // A service not read may expose what the read ones do not: then a missing entity is only
  // missing from the services read, and the check concludes nothing about the others.
  if (!allRead) {
    return {
      conclusive: false,
      ok: missing.length === 0,
      missing: [],
      notInServicesRead: missing.map(({ entity, boundOn, at }) => ({ entity, boundOn, at })),
      exposed,
      services: parsed.map((p) => p.service).filter(Boolean),
      note: 'not every service definition that uses the entity was read: an entity not exposed in the ones read may be exposed in another',
    };
  }
  return {
    conclusive: true,
    ok: missing.length === 0,
    missing,
    exposed,
    services: parsed.map((p) => p.service).filter(Boolean),
    note: missing.length
      ? `${missing.length} value-help entit${missing.length === 1 ? 'y is' : 'ies are'} ` +
        `bound but not exposed in ${parsed.map((p) => p.service).join(', ')}`
      : `all ${exposed.length} value-help entities are exposed in ${parsed
          .map((p) => p.service)
          .join(', ')}`,
  };
}
