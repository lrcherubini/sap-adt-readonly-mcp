// The switch chain (lib/switch-chain.mjs): package -> switch -> business function -> active here.
// The shapes are the ones measured on KNA1 (docs/adt-api-reference.md, "The switch chain"); the
// names are synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchChain, describeChain } from '../lib/switch-chain.mjs';

/** A query double over fixed tables, recording what was asked. */
function tables(data, asked = []) {
  return async ({ table, where = [] }) => {
    asked.push({ table, where });
    const rows = (data[table] ?? []).filter((row) =>
      where.every(({ field, op, value }) => {
        const v = String(row[field] ?? '');
        if (op === '=') return v === value;
        if (op === 'IN') return value.includes(v);
        if (op === 'LIKE') return v.startsWith(value.replace(/\*$/, ''));
        throw new Error(`op ${op}`);
      })
    );
    return { rows, count: rows.length, totalRows: rows.length, truncated: false };
  };
}

const MEASURED_SHAPE = {
  SFW_PACKAGE: [
    { SWITCH_ID: 'ZDEMO_SW_ORPHAN', VERSION: 'A', DEVCLASS: 'ZDEMO_PKG_A', ENHNAME: '' },
    { SWITCH_ID: 'ZDEMO_SW_DS', VERSION: 'A', DEVCLASS: 'ZDEMO_PKG_B', ENHNAME: '' },
  ],
  SFW_SW_BF: [
    { BFUNCTION: 'ZDEMO_BF_BASIS', VERSION: 'A', SWITCH_ID: 'ZDEMO_SW_DS', SWITCHTYPE: 'E' },
    { BFUNCTION: 'ZDEMO_MGMT_&_BULK', VERSION: 'A', SWITCH_ID: 'ZDEMO_SW_DS', SWITCHTYPE: 'A' },
  ],
  SFW_ACTIVE_BFUNC: [{ MANDT: '001', VERSION: 'A', BFUNCTION: 'ZDEMO_BF_OTHER', X_OFF: '' }],
};

test('the measured case: one switch with no business function, one whose functions are off, one package with no switch', async () => {
  const asked = [];
  const { byPackage, notes } = await switchChain(['zdemo_pkg_a', 'ZDEMO_PKG_B', 'ZDEMO_PKG_PLAIN'], tables(MEASURED_SHAPE, asked));
  assert.deepEqual(notes, []);

  const a = byPackage.get('ZDEMO_PKG_A');
  assert.deepEqual(a.switches.map((s) => [s.id, s.functions.length]), [['ZDEMO_SW_ORPHAN', 0]]);
  assert.match(describeChain(a)[0], /switch ZDEMO_SW_ORPHAN, which belongs to NO business function/);
  // Measured: such a switch carried active appends, so the line must never read as "off".
  assert.match(describeChain(a)[0], /does not make it off/);
  assert.equal(/switched off|is off\b/i.test(describeChain(a)[0]), false);

  const b = byPackage.get('ZDEMO_PKG_B');
  assert.deepEqual(
    b.switches[0].functions.map((f) => [f.name, f.type, f.active]),
    [['ZDEMO_BF_BASIS', 'standby', false], ['ZDEMO_MGMT_&_BULK', 'activation', false]]
  );
  assert.match(describeChain(b).join('\n'), /ZDEMO_MGMT_&_BULK \(activation switch\): NOT active in this client/);

  assert.deepEqual(byPackage.get('ZDEMO_PKG_PLAIN').switches, []);
  assert.match(describeChain(byPackage.get('ZDEMO_PKG_PLAIN'))[0], /assigned to no switch.*not read here/);

  // Only active versions are asked, and the name with '&' is reached by LIKE on its prefix.
  assert.ok(asked.every((q) => q.where.some((w) => w.field === 'VERSION' && w.value === 'A')));
  const like = asked.find((q) => q.where.some((w) => w.op === 'LIKE'));
  assert.equal(like.where.find((w) => w.op === 'LIKE').value, 'ZDEMO_MGMT_*');
  assert.ok(asked.every((q) => q.where.every((w) => [].concat(w.value).every((v) => !String(v).includes('&')))), 'no & reaches the grammar');
});

test('an active function says so; a set X_OFF is reported raw, never read as on or off', async () => {
  const data = {
    ...MEASURED_SHAPE,
    SFW_ACTIVE_BFUNC: [
      { VERSION: 'A', BFUNCTION: 'ZDEMO_BF_BASIS', X_OFF: '' },
      { VERSION: 'A', BFUNCTION: 'ZDEMO_MGMT_&_BULK', X_OFF: 'X' },
    ],
  };
  const { byPackage } = await switchChain(['ZDEMO_PKG_B'], tables(data));
  const [basis, mgmt] = byPackage.get('ZDEMO_PKG_B').switches[0].functions;
  assert.equal(basis.active, true);
  assert.equal(mgmt.active, null, 'unobserved, so not interpreted');
  assert.match(describeChain(byPackage.get('ZDEMO_PKG_B')).join('\n'), /not read \(X_OFF is 'X'/);
});

test('a truncated read is said, and nothing is asked for no package', async () => {
  const asked = [];
  assert.deepEqual((await switchChain([null, ''], tables(MEASURED_SHAPE, asked))).notes, []);
  assert.equal(asked.length, 0);

  const short = async () => ({ rows: [], count: 200, totalRows: 450, truncated: true });
  const { notes } = await switchChain(['ZDEMO_PKG_A'], short);
  assert.match(notes[0], /SFW_PACKAGE: 200 of 450 rows read -- the chain below may be short/);
});

test('a failed read is the caller\'s to report: the error leaves, nothing is guessed', async () => {
  const failing = async () => { throw new Error('table SFW_PACKAGE is not in the customizing allow-list'); };
  await assert.rejects(() => switchChain(['ZDEMO_PKG_A'], failing), /allow-list/);
});
