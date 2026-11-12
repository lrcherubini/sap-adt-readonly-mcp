// The switch state (lib/switch-chain.mjs): package -> switch -> the state the system stores.
// The shapes are the ones measured on KNA1 and SAPMV45A (docs/adt-api-reference.md, "The switch
// state"); the names are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchChain, describeChain, packagesOf, previewQuery } from '../lib/switch-chain.mjs';

/** A query double over fixed tables, recording what was asked. */
function tables(data, asked = []) {
  return async ({ table, fields, where = [] }) => {
    asked.push({ table, fields, where });
    const rows = (data[table] ?? []).filter((row) =>
      where.every(({ field, op, value }) => {
        const v = String(row[field] ?? '');
        if (op === '=') return v === value;
        if (op === 'IN') return value.includes(v);
        throw new Error(`op ${op}`);
      })
    );
    return { rows, count: rows.length, totalRows: rows.length, truncated: false };
  };
}

const MEASURED_SHAPE = {
  SFW_PACKAGE: [
    { SWITCH_ID: 'ZDEMO_SW_ON', VERSION: 'A', DEVCLASS: 'ZDEMO_PKG_ON' },
    { SWITCH_ID: 'ZDEMO_SW_NOROW', VERSION: 'A', DEVCLASS: 'ZDEMO_PKG_NOROW' },
    { SWITCH_ID: 'ZDEMO_SW_OFF', VERSION: 'A', DEVCLASS: 'ZDEMO_PKG_OFF' },
    { SWITCH_ID: 'ZDEMO_SW_CLIENT', VERSION: 'A', DEVCLASS: 'ZDEMO_PKG_CLIENT' },
  ],
  SFW_SWITCH_STATE: [
    { SWITCH_ID: 'ZDEMO_SW_ON', CLIENT: '', VERSION: 'A', USERNAME: '', STATE: 'T' },
    { SWITCH_ID: 'ZDEMO_SW_OFF', CLIENT: '', VERSION: 'A', USERNAME: '', STATE: 'F' },
    // A client-dependent switch: one row per client, and the logon client's row decides.
    { SWITCH_ID: 'ZDEMO_SW_CLIENT', CLIENT: '000', VERSION: 'A', USERNAME: '', STATE: 'F' },
    { SWITCH_ID: 'ZDEMO_SW_CLIENT', CLIENT: '001', VERSION: 'A', USERNAME: '', STATE: 'T' },
  ],
};

test('the measured case: on, off, no stored row, and no switch at all', async () => {
  const asked = [];
  const pkgs = ['zdemo_pkg_on', 'ZDEMO_PKG_OFF', 'ZDEMO_PKG_NOROW', 'ZDEMO_PKG_PLAIN'];
  const { byPackage, notes } = await switchChain(pkgs, tables(MEASURED_SHAPE, asked), { client: '001' });
  assert.deepEqual(notes, []);
  const state = (p) => byPackage.get(p).switches.map((s) => [s.id, s.state, s.raw]);
  assert.deepEqual(state('ZDEMO_PKG_ON'), [['ZDEMO_SW_ON', 'on', 'T']]);
  assert.deepEqual(state('ZDEMO_PKG_OFF'), [['ZDEMO_SW_OFF', 'off', 'F']]);
  assert.deepEqual(state('ZDEMO_PKG_NOROW'), [['ZDEMO_SW_NOROW', null, null]]);
  assert.deepEqual(byPackage.get('ZDEMO_PKG_PLAIN').switches, []);

  assert.match(describeChain(byPackage.get('ZDEMO_PKG_ON'))[0], /switch ZDEMO_SW_ON: ON \(SFW_SWITCH_STATE T\)/);
  // Measured 3 of 3 (KNA1, VBAP): a switch with no stored row behaves as off, and says why.
  assert.match(describeChain(byPackage.get('ZDEMO_PKG_NOROW'))[0], /switch ZDEMO_SW_NOROW: OFF \(no row in SFW_SWITCH_STATE; measured as off/);
  assert.match(describeChain(byPackage.get('ZDEMO_PKG_OFF'))[0], /OFF \(SFW_SWITCH_STATE F\)/);
  assert.match(describeChain(byPackage.get('ZDEMO_PKG_PLAIN'))[0], /behind no switch/);

  // USERNAME is only a filter (blank = the system setting) and never a selected field.
  const state_q = asked.find((q) => q.table === 'SFW_SWITCH_STATE');
  assert.ok(state_q.where.some((w) => w.field === 'USERNAME' && w.value === ''));
  assert.equal(state_q.fields.includes('USERNAME'), false);
  assert.ok(asked.every((q) => q.where.some((w) => w.field === 'VERSION' && w.value === 'A')), 'active versions only');
});

test('the logon client decides a client-dependent switch; another client says nothing', async () => {
  const at = async (client) =>
    (await switchChain(['ZDEMO_PKG_CLIENT'], tables(MEASURED_SHAPE), { client })).byPackage.get('ZDEMO_PKG_CLIENT').switches[0].state;
  assert.equal(await at('001'), 'on');
  assert.equal(await at('000'), 'off');
  assert.equal(await at('002'), null, 'no row of this client and no cross-client row: no stored state');
  assert.equal(await at(undefined), null);
});

test('a truncated read is said, nothing is asked for no package, and a failure leaves to the caller', async () => {
  const asked = [];
  assert.deepEqual((await switchChain([null, ''], tables(MEASURED_SHAPE, asked))).notes, []);
  assert.equal(asked.length, 0);
  const short = async () => ({ rows: [], count: 200, totalRows: 450, truncated: true });
  assert.match((await switchChain(['ZDEMO_PKG_ON'], short)).notes[0], /SFW_PACKAGE: 200 of 450 rows read/);
  await assert.rejects(() => switchChain(['ZDEMO_PKG_ON'], async () => { throw new Error('not in the customizing allow-list'); }), /allow-list/);
});

test('packagesOf reads TADIR by name and says which names it could not ask', async () => {
  const data = { TADIR: [{ PGMID: 'R3TR', OBJECT: 'ENHO', OBJ_NAME: 'ZDEMO_ENH_A', DEVCLASS: 'ZDEMO_PKG_ON' }] };
  const { packages, notes } = await packagesOf('ENHO', ['zdemo_enh_a', 'ZDEMO_ENH_B', 'Z(BAD'], tables(data));
  assert.equal(packages.get('ZDEMO_ENH_A'), 'ZDEMO_PKG_ON');
  assert.equal(packages.has('ZDEMO_ENH_B'), false);
  assert.match(notes[0], /ENHO Z\(BAD: not a name the preview grammar takes/);
});

test('previewQuery goes through the closed list and the echo check', async () => {
  const audits = [];
  const raw = { httpClient: { request: async () => ({ status: 200, body: '', headers: {} }) } };
  const q = previewQuery(raw, { audit: (t, n) => audits.push([t, n]) });
  // A table outside the list is refused before any request.
  await assert.rejects(() => q({ table: 'ZDEMO_NOT_LISTED' }), /not in the customizing allow-list/);
  // USERNAME of SFW_SWITCH_STATE cannot be selected, whoever asks.
  await assert.rejects(() => q({ table: 'SFW_SWITCH_STATE', fields: ['USERNAME'] }), /may be read only for/);
  assert.deepEqual(audits, []);
});
