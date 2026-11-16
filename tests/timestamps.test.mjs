// lib/timestamps.mjs: a 14-digit ABAP timestamp as ISO 8601, with a Z only where UTC is measured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoOfStamp } from '../lib/timestamps.mjs';

test('UTC where measured, no offset (system-local) otherwise, null for no time', () => {
  assert.equal(isoOfStamp('20261112121759', { utc: true }), '2026-11-12T12:17:59Z');
  assert.equal(isoOfStamp('20260319173046'), '2026-03-19T17:30:46', 'local: no zone is claimed');
  assert.equal(isoOfStamp('00000000000000'), null);
  assert.equal(isoOfStamp(''), null);
  assert.equal(isoOfStamp(null), null);
  assert.equal(isoOfStamp('2026-03-19T17:30:46Z'), '2026-03-19T17:30:46Z', 'anything else is left as it came');
});
