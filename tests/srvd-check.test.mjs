// Exposure of value helps in the service definition.
//
// Both service definitions in tests/fixtures/srvd/ are synthetic: the one that is right (zdemo_employee_ui, which exposes the four own
// value helps and the standard I_CompanyCodeVH) and the one that is wrong
// (zui_demoitemrating, which exposes none of the five its parameters bind) -- the
// defect the check exists to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseService, checkExposure } from '../lib/srvd-check.mjs';
import { edgesFromText } from '../lib/precedent.mjs';

const srvd = (name) => ({
  file: `tests/fixtures/srvd/${name}`,
  source: fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'srvd', name), 'utf8'),
});

const EMP = srvd('zdemo_employee_ui.srvd.srvdsrv');
const CLEAN = srvd('zui_demoitemrating.srvd.srvdsrv');

/** Every value-help edge in the fixture sources -- the texts the system would return for them. */
function fixtureEdges(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(...edgesFromText(fs.readFileSync(full, 'utf8'), path.relative(path.join(import.meta.dirname, '..'), full).split(path.sep).join('/')));
    }
  };
  walk(dir);
  return out;
}

const ALL = fixtureEdges(path.join(import.meta.dirname, 'fixtures', 'precedent'));
const edgesOf = (file) => ALL.filter((e) => e.file.includes(file));

test('a service definition parses into its exposures, aliases included', () => {
  const s = parseService(EMP.source);
  assert.equal(s.service, 'ZDEMO_EMPLOYEE_UI');
  assert.equal(s.exposed.length, 15);
  assert.deepEqual(
    s.exposed.find((e) => e.entity === 'I_CompanyCodeVH'),
    { entity: 'I_CompanyCodeVH', alias: 'CompanyCodeVH' }
  );
});

test('an exposure with an alias satisfies the binding', () => {
  const edges = [
    { entity: 'ZI_DemoRosterTaxIdVH', element: 'Stcd2' },
    { entity: 'I_CompanyCodeVH', element: 'CompanyCode' },
  ];
  const r = checkExposure(edges, [EMP]);
  assert.equal(r.conclusive, true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.exposed, [
    { entity: 'ZI_DemoRosterTaxIdVH', as: 'DemoRosterTaxNoVH', service: 'ZDEMO_EMPLOYEE_UI' },
    { entity: 'I_CompanyCodeVH', as: 'CompanyCodeVH', service: 'ZDEMO_EMPLOYEE_UI' },
  ]);
  assert.match(r.note, /all 2 value-help entities are exposed/);
});

test('the real defect in zui_demoitemrating is reported, with its effect', () => {
  const edges = edgesOf('zc_demoitemrating');
  assert.equal(edges.length, 5, 'five parameters bind a value help');
  const r = checkExposure(edges, [CLEAN]);
  assert.equal(r.conclusive, true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.entity), [
    'I_Plant',
    'I_StorageLocation',
    'I_SalesOrganization',
    'I_DistributionChannel',
    'I_MRPArea',
  ]);
  assert.equal(r.missing[0].boundOn, 'P_Plant');
  assert.match(r.missing[0].at, /zc_demoitemrating\.ddls\.asddls:\d+/);
  assert.match(r.missing[0].effect, /no activation error/);
  assert.match(r.missing[0].fix, /^add `expose I_Plant as Plant;` to ZUI_DemoItemRating$/);
  assert.match(r.note, /5 value-help entities are bound but not exposed/);
});

test('a standard entity is not exempt: released does not mean exposed', () => {
  const r = checkExposure([{ entity: 'I_UnitOfMeasureStdVH', element: 'BaseUnit' }], [CLEAN]);
  assert.equal(r.ok, false, 'this is the zui_demo_invmap_o4 defect, in miniature');
  assert.equal(r.missing[0].entity, 'I_UnitOfMeasureStdVH');
});

test('no service definition is INCONCLUSIVE, never a defect', () => {
  const r = checkExposure(edgesOf('zc_demoitemrating'), []);
  assert.equal(r.conclusive, false);
  assert.equal(r.ok, true, 'an unchecked thing is not a failing thing');
  assert.deepEqual(r.missing, []);
  assert.match(r.note, /inconclusive, not a defect/);
});

test('several services in one package are searched together', () => {
  const r = checkExposure(
    [{ entity: 'ZC_DemoItemRating' }, { entity: 'ZI_DemoRosterTaxIdVH' }],
    [CLEAN, EMP]
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.services, ['ZUI_DemoItemRating', 'ZDEMO_EMPLOYEE_UI']);
});

test('the same entity bound twice is reported once', () => {
  const r = checkExposure(
    [
      { entity: 'I_Plant', element: 'P_Plant' },
      { entity: 'I_Plant', element: 'Plant' },
    ],
    [CLEAN]
  );
  assert.equal(r.missing.length, 1);
});

test('a commented-out expose does not count as an exposure', () => {
  const r = checkExposure([{ entity: 'I_Plant' }], [
    { file: 'x.srvdsrv', source: 'define service X {\n// expose I_Plant as Plant;\n}' },
  ]);
  assert.equal(r.ok, false);
});

test('no edges at all is a pass, not a claim about the service', () => {
  const r = checkExposure([], [CLEAN]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.exposed, []);
  assert.match(r.note, /all 0 value-help entities are exposed/);
});
