// lib/call-context.mjs: what belongs to one tool call while several are in flight.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inCall, currentCall, countAdtCall } from '../lib/call-context.mjs';
import { openJournal } from '../lib/journal.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('outside every call there is no call, and a read is counted for none', () => {
  assert.equal(currentCall(), null);
  countAdtCall();
  assert.equal(currentCall(), null);
});

test('each call counts its own reads, however the calls interleave', async () => {
  const one = async (reads) =>
    inCall(async () => {
      for (let i = 0; i < reads; i++) {
        await tick();
        countAdtCall();
      }
      return currentCall().adtCalls;
    });
  assert.deepEqual(await Promise.all([one(3), one(1), one(2)]), [3, 1, 2]);
});

test('a call started inside another counts for both, and keeps its own codes', async () => {
  const journal = openJournal({ journalSink: () => {} });
  const result = await inCall(async () => {
    const outer = journal.collect();
    countAdtCall();
    const inner = await inCall(async () => {
      const frame = journal.collect();
      countAdtCall();
      journal.gap({ code: 'SEARCH_AT_CAP', subject: 'inner' });
      return { codes: frame.end(), adtCalls: currentCall().adtCalls };
    });
    journal.gap({ code: 'CATALOG_MISS', subject: 'outer' });
    return { inner, codes: outer.end(), adtCalls: currentCall().adtCalls };
  });
  assert.deepEqual(result.inner, { codes: ['SEARCH_AT_CAP'], adtCalls: 1 });
  assert.deepEqual(result.codes, ['CATALOG_MISS']);
  assert.equal(result.adtCalls, 2, 'the read of the inner call is a read of the outer one too');
});

test('a frame closed after its call ended still closes its own stack', async () => {
  const journal = openJournal({ journalSink: () => {} });
  const frame = await inCall(async () => {
    const f = journal.collect();
    journal.gap({ code: 'SEARCH_AT_CAP', subject: 'x' });
    return f;
  });
  assert.deepEqual(frame.end(), ['SEARCH_AT_CAP']);
  // Nothing of that call is left on the stack used outside every call.
  const outside = journal.collect();
  journal.gap({ code: 'CATALOG_MISS', subject: 'y' });
  assert.deepEqual(outside.end(), ['CATALOG_MISS']);
});
