import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measurementStamp, newMeasurementDir, measurementFile } from '../lib/config.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
const at = new Date('2026-11-09T17:15:02.123Z');

test('the stamp is UTC to the second and has no colon (a valid Windows file name)', () => {
  assert.equal(measurementStamp(at), '20261109T171502Z');
});

test('a run gets its own folder, named with the stamp', () => {
  const root = tmpRoot();
  const dir = newMeasurementDir('srvb-matrix', { now: at, root });
  assert.equal(path.basename(dir), 'srvb-matrix-20261109T171502Z');
  assert.ok(fs.statSync(dir).isDirectory());
});

test('a second run never reuses the folder of the first, even in the same second', () => {
  const root = tmpRoot();
  const first = newMeasurementDir('probe', { now: at, root });
  fs.writeFileSync(path.join(first, 'summary.json'), 'first run');
  const second = newMeasurementDir('probe', { now: at, root });
  assert.notEqual(second, first);
  assert.equal(path.basename(second), 'probe-20261109T171502Z-2');
  assert.equal(fs.readFileSync(path.join(first, 'summary.json'), 'utf8'), 'first run');
});

test('after nine folders in one second it throws instead of overwriting', () => {
  const root = tmpRoot();
  for (let i = 0; i < 9; i++) newMeasurementDir('probe', { now: at, root });
  assert.throws(() => newMeasurementDir('probe', { now: at, root }), /nothing was overwritten/);
});

test('a name that could leave the measurements folder is refused', () => {
  const root = tmpRoot();
  for (const bad of ['../x', 'a/b', 'Upper', '', 'x'.repeat(62)]) {
    assert.throws(() => newMeasurementDir(bad, { now: at, root }), /must match/);
  }
});

test('an --out transcript lands in a new measurement folder, whatever path was typed', () => {
  // Measured 2026-11-09: `--out vbap.txt` wrote a reading of the system into the repository root.
  const root = tmpRoot();
  const file = measurementFile('propose-table', '../../repo/vbap.txt', { now: at, root });
  assert.equal(path.basename(file), 'vbap.txt');
  assert.equal(path.dirname(file), path.join(root, 'propose-table-20261109T171502Z'));
  assert.throws(() => measurementFile('propose-table', '..', { now: at, root }), /not a file name/);
});
