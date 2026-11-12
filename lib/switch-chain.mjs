// Which switch an object's package hangs on, and the state the system stores for that switch.
//
// MEASURED 2026-11-09 (docs/adt-api-reference.md, "The switch state"): package -> SFW_PACKAGE
// (switch) -> SFW_SWITCH_STATE (STATE: T on, S stand-by, F off). On KNA1 and VBAP it agreed with
// the active field list on 38 of 38 appends of SAP packages: every append behind an F switch or a
// switch with no stored row is absent, every one behind a T switch or no switch is active. No S
// row exists on the measured system, so stand-by is printed as read and never interpreted.
//
// ⚠️ The business-function step this module used to read is GONE on purpose. On this S/4HANA
// system no classic business function is active (SFW_ACTIVE_BFUNC holds feature toggles), yet
// switches such as OIJ_TSW and FICA are stored ON. A chain through business functions said "not
// active" for switches that are on. The stored state is the one read.
//
// It reads through a `query` the caller injects -- the adt_customizing handler, or `previewQuery`
// below over the same closed list and grammar -- so this module opens no route of its own.

import { buildSelect, previewPost, parsePreview, assertRanAsSent, truncationOf } from './data-preview.mjs';

const upper = (s) => String(s ?? '').trim().toUpperCase();

/** A value the data preview takes in `=`/`IN` (lib/data-preview.mjs VALUE), for names. */
const PLAIN = /^[A-Z0-9_/&$%.+#-]{1,60}$/;

/** The three stored states, as SFW_SETTING defines them. */
export const SWITCH_STATE = { T: 'on', S: 'stand-by', F: 'off' };

/**
 * The `query` this module and its callers inject, over the data preview: one SELECT, the same
 * grammar and echo check as adt_customizing. `audit(target, bytes)` records the read.
 */
export function previewQuery(rawClient, { audit = () => {} } = {}) {
  return async ({ table, fields, where, rows }) => {
    const built = buildSelect({ table, fields, where, rows });
    let out;
    try {
      out = await previewPost(rawClient, built.sql, built.rows);
    } finally {
      audit(`${table} rows<=${built.rows}`, out?.bytes ?? 0);
    }
    const parsed = parsePreview(out.body);
    assertRanAsSent(built.sql, parsed.executedQuery);
    return {
      rows: parsed.rows,
      count: parsed.rows.length,
      totalRows: parsed.totalRows,
      truncated: truncationOf(parsed, built.rows),
    };
  };
}

/**
 * @param {string[]} packages the packages of the objects in question
 * @param {Function} query see `previewQuery`
 * @param {{client?: string}} opts the logon client: a client's own row wins over the cross-client one
 * @returns {Promise<{byPackage: Map<string, {package: string, switches: {id: string, state: 'on'|'stand-by'|'off'|null, raw: string|null}[]}>, notes: string[]}>}
 *   `state: null` with `raw: null` is "no stored row" -- measured to behave as off (3 of 3),
 *   and reported as what it is.
 */
export async function switchChain(packages, query, { client } = {}) {
  const notes = [];
  // The same facts as `notes`, as data: what was cut and what was not read (lib/completeness.mjs).
  const gaps = [];
  const pkgs = [...new Set(packages.map(upper).filter(Boolean))];
  const byPackage = new Map(pkgs.map((p) => [p, { package: p, switches: [] }]));
  const asked = pkgs.filter((p) => PLAIN.test(p));
  for (const p of pkgs.filter((x) => !PLAIN.test(x))) {
    notes.push(`package ${p}: not a name the preview grammar takes -- its switch was not read`);
    gaps.push({ code: 'NOT_READ', subject: `package ${p}`, reason: 'not a name the preview grammar takes' });
  }
  if (!asked.length) return { byPackage, notes, gaps };

  const read = async (table, fields, where) => {
    const r = await query({ table, fields, where, rows: 200 });
    if (r.truncated) {
      notes.push(`${table}: ${r.count ?? r.rows?.length} of ${r.totalRows} rows read -- the answer below may be short`);
      gaps.push({ code: 'CAP_REACHED', subject: table, returned: r.count ?? r.rows?.length ?? null, total: r.totalRows ?? null, truncated: true, narrowBy: ['objectName'] });
    }
    return r.rows ?? [];
  };
  const active = { field: 'VERSION', op: '=', value: 'A' };

  // 1. package -> switch
  const assigned = await read('SFW_PACKAGE', ['SWITCH_ID', 'DEVCLASS'], [{ field: 'DEVCLASS', op: 'IN', value: asked }, active]);
  const switches = new Map();
  for (const row of assigned) {
    const p = upper(row.DEVCLASS);
    const id = upper(row.SWITCH_ID);
    if (!byPackage.has(p) || !id) continue;
    if (!switches.has(id)) switches.set(id, { id, state: null, raw: null });
    byPackage.get(p).switches.push(switches.get(id));
  }
  if (!switches.size) return { byPackage, notes, gaps };

  // 2. switch -> stored state. USERNAME is filter-only (docs/security.md): blank is the system
  // setting, and no user-specific row exists on the measured system.
  const ids = [...switches.keys()].filter((id) => PLAIN.test(id));
  for (const id of switches.keys()) {
    if (PLAIN.test(id)) continue;
    notes.push(`switch ${id}: not a name the preview grammar takes -- its state was not read`);
    gaps.push({ code: 'NOT_READ', subject: `switch ${id}`, reason: 'not a name the preview grammar takes' });
  }
  const rows = ids.length
    ? await read('SFW_SWITCH_STATE', ['SWITCH_ID', 'CLIENT', 'STATE'], [{ field: 'SWITCH_ID', op: 'IN', value: ids }, active, { field: 'USERNAME', op: '=', value: '' }])
    : [];
  const own = upper(client);
  for (const id of ids) {
    const mine = rows.filter((r) => upper(r.SWITCH_ID) === id);
    // A row of the logon client wins; otherwise the cross-client (blank) row. A row of another
    // client says nothing about this one.
    const row = (own ? mine.find((r) => upper(r.CLIENT) === own) : undefined) ?? mine.find((r) => !upper(r.CLIENT));
    const sw = switches.get(id);
    sw.raw = row ? upper(row.STATE) || null : null;
    sw.state = sw.raw ? SWITCH_STATE[sw.raw] ?? null : null;
    if (sw.raw && !sw.state) notes.push(`switch ${id}: STATE '${sw.raw}' is outside T/S/F -- reported raw`);
  }
  return { byPackage, notes, gaps };
}

/** The lines printed for one package: the state as read, never a cause. */
export function describeChain(entry) {
  if (!entry) return ['switch: package unknown -- nothing to look up'];
  if (!entry.switches.length) return [`package ${entry.package}: behind no switch (SFW_PACKAGE)`];
  return entry.switches.map((sw) => {
    const state = sw.state
      ? `${sw.state.toUpperCase()} (SFW_SWITCH_STATE ${sw.raw})`
      : sw.raw
        ? `STATE '${sw.raw}', not one of T/S/F`
        : 'OFF (no row in SFW_SWITCH_STATE; measured as off on KNA1 and VBAP, 3 of 3)';
    return `package ${entry.package} -> switch ${sw.id}: ${state}`;
  });
}

/**
 * The packages of named repository objects, from TADIR (an admitted table). Names the preview
 * grammar refuses are left out and said.
 */
export async function packagesOf(objectType, names, query) {
  const notes = [];
  const gaps = [];
  const plain = [...new Set(names.map(upper).filter(Boolean))].filter((n) => {
    if (PLAIN.test(n)) return true;
    notes.push(`${objectType} ${n}: not a name the preview grammar takes -- its package was not read`);
    gaps.push({ code: 'NOT_READ', subject: `${objectType} ${n}`, reason: 'not a name the preview grammar takes' });
    return false;
  });
  const out = new Map();
  if (!plain.length) return { packages: out, notes, gaps };
  const r = await query({
    table: 'TADIR',
    fields: ['OBJ_NAME', 'DEVCLASS'],
    where: [{ field: 'PGMID', op: '=', value: 'R3TR' }, { field: 'OBJECT', op: '=', value: objectType }, { field: 'OBJ_NAME', op: 'IN', value: plain }],
    rows: 200,
  });
  if (r.truncated) {
    notes.push(`TADIR: ${r.count} of ${r.totalRows} rows read`);
    gaps.push({ code: 'CAP_REACHED', subject: 'TADIR', returned: r.count ?? null, total: r.totalRows ?? null, truncated: true, narrowBy: ['objectName'] });
  }
  for (const row of r.rows ?? []) out.set(upper(row.OBJ_NAME), upper(row.DEVCLASS));
  return { packages: out, notes, gaps };
}
