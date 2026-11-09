// Which switch an object's package hangs on, and whether that switch's business functions are
// active in the logon client.
//
// The chain is the one MEASURED on 2026-11-09 (docs/adt-api-reference.md, "The switch chain"):
// package -> SFW_PACKAGE (switch) -> SFW_SW_BF (business function, activation or standby) ->
// SFW_ACTIVE_BFUNC (active in this client). On KNA1 it separated the four appends whose fields
// are not active from three whose fields are. That makes it EVIDENCE to print beside an absence,
// and never the stated cause: a conflict switch or an activation error is not read here.
//
// It reads through a `query` the caller injects -- the adt_customizing handler, which holds the
// closed table list and the grammar -- so this module opens no route of its own.

const upper = (s) => String(s ?? '').trim().toUpperCase();

/** A value the data preview takes in `=`/`IN` (lib/data-preview.mjs VALUE), for names. */
const PLAIN = /^[A-Z0-9_/]{1,60}$/;

const SWITCH_TYPE = { A: 'activation', E: 'standby' };

/**
 * @param {string[]} packages the packages of the objects in question
 * @param {(q: {table: string, where?: object[], rows?: number}) => Promise<{rows: object[], truncated?: boolean, count?: number, totalRows?: number}>} query
 * @returns {Promise<{byPackage: Map<string, {package: string, switches: {id: string, functions: {name: string, type: string, active: boolean|null, note?: string}[]}[]}>, notes: string[]}>}
 *   `active: null` is "not read", never "not active"; `notes` says what was not read and why.
 */
export async function switchChain(packages, query) {
  const notes = [];
  const pkgs = [...new Set(packages.map(upper).filter(Boolean))];
  const byPackage = new Map(pkgs.map((p) => [p, { package: p, switches: [] }]));
  const asked = pkgs.filter((p) => PLAIN.test(p));
  for (const p of pkgs.filter((x) => !PLAIN.test(x))) notes.push(`package ${p}: not a name the preview grammar takes -- its switch was not read`);
  if (!asked.length) return { byPackage, notes };

  const read = async (table, where) => {
    const r = await query({ table, where, rows: 200 });
    if (r.truncated) notes.push(`${table}: ${r.count ?? r.rows?.length} of ${r.totalRows} rows read -- the chain below may be short`);
    return r.rows ?? [];
  };
  const active = { field: 'VERSION', op: '=', value: 'A' };

  // 1. package -> switch
  const assigned = await read('SFW_PACKAGE', [{ field: 'DEVCLASS', op: 'IN', value: asked }, active]);
  const switchesOf = new Map();
  for (const row of assigned) {
    const p = upper(row.DEVCLASS);
    const id = upper(row.SWITCH_ID);
    if (!byPackage.has(p) || !id) continue;
    if (!switchesOf.has(id)) switchesOf.set(id, { id, functions: [] });
    byPackage.get(p).switches.push(switchesOf.get(id));
  }
  if (!switchesOf.size) return { byPackage, notes };

  // 2. switch -> business function
  const ids = [...switchesOf.keys()].filter((id) => PLAIN.test(id));
  for (const id of switchesOf.keys()) if (!PLAIN.test(id)) notes.push(`switch ${id}: not a name the preview grammar takes -- its business functions were not read`);
  const links = ids.length ? await read('SFW_SW_BF', [{ field: 'SWITCH_ID', op: 'IN', value: ids }, active]) : [];
  const functions = new Map();
  for (const row of links) {
    const sw = switchesOf.get(upper(row.SWITCH_ID));
    const name = upper(row.BFUNCTION);
    if (!sw || !name) continue;
    const fn = { name, type: SWITCH_TYPE[upper(row.SWITCHTYPE)] ?? (upper(row.SWITCHTYPE) || 'unknown'), active: null };
    sw.functions.push(fn);
    if (!functions.has(name)) functions.set(name, []);
    functions.get(name).push(fn);
  }
  if (!functions.size) return { byPackage, notes };

  // 3. is the business function active in this client? A name may carry a character the grammar
  // refuses (`COMMODITY_MGMT_&_BULK_LOGISTIC`, measured): it is reached with LIKE on its longest
  // plain prefix and matched exactly here.
  const names = [...functions.keys()];
  const plain = names.filter((n) => PLAIN.test(n));
  const rows = plain.length ? await read('SFW_ACTIVE_BFUNC', [{ field: 'BFUNCTION', op: 'IN', value: plain }, active]) : [];
  for (const n of names.filter((x) => !PLAIN.test(x))) {
    const prefix = /^[A-Z0-9_/]*/.exec(n)[0].slice(0, 29);
    if (!prefix) {
      notes.push(`business function ${n}: no prefix the preview grammar takes -- whether it is active was not read`);
      continue;
    }
    rows.push(...(await read('SFW_ACTIVE_BFUNC', [{ field: 'BFUNCTION', op: 'LIKE', value: `${prefix}*` }, active])));
  }
  const readNames = new Set([...plain, ...names.filter((n) => !PLAIN.test(n) && /^[A-Z0-9_/]/.test(n))]);
  const activeRows = new Map(rows.map((r) => [upper(r.BFUNCTION), r]));
  for (const [name, fns] of functions) {
    if (!readNames.has(name)) continue;
    const row = activeRows.get(name);
    for (const fn of fns) {
      if (!row) fn.active = false;
      else if (String(row.X_OFF ?? '').trim()) {
        // Never observed set (0 of 169 rows, measured): reported raw, not interpreted.
        fn.active = null;
        fn.note = `X_OFF is '${String(row.X_OFF).trim()}' -- a value never observed, not interpreted`;
      } else fn.active = true;
    }
  }
  return { byPackage, notes };
}

/** The lines `propose:table` prints for one package. Evidence, phrased as such. */
export function describeChain(entry) {
  if (!entry) return ['switch chain: package unknown -- nothing to look up'];
  if (!entry.switches.length) {
    return [`package ${entry.package}: assigned to no switch (SFW_PACKAGE) -- whatever keeps these fields out, it is not read here`];
  }
  const lines = [];
  for (const sw of entry.switches) {
    if (!sw.functions.length) {
      lines.push(`package ${entry.package} -> switch ${sw.id}, which belongs to NO business function (SFW_SW_BF)`);
      continue;
    }
    for (const fn of sw.functions) {
      const state = fn.active === true ? 'active in this client' : fn.active === false ? 'NOT active in this client' : `not read${fn.note ? ` (${fn.note})` : ''}`;
      lines.push(`package ${entry.package} -> switch ${sw.id} -> business function ${fn.name} (${fn.type} switch): ${state}`);
    }
  }
  return lines;
}
