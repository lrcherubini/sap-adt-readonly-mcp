// Stopping the server: the deadline, and the report of whether it worked.
//
// The scenario these guard is the one that produced the restarts: Ctrl+C with the system not
// answering used to wait for a call that never settles, so the terminal looked hung and the
// way out was closing the window -- which leaks the session the shutdown was trying to drop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disconnect } from '../lib/session.mjs';

const never = () => new Promise(() => {});

test('a logout that answers is reported as clean', async () => {
  const calls = [];
  const session = {
    raw: {
      dropSession: async () => calls.push('drop'),
      logout: async () => calls.push('logout'),
    },
  };
  assert.equal(await disconnect(session, { timeoutMs: 500 }), true);
  assert.deepEqual(calls, ['drop', 'logout'], 'the session is dropped before the logon is ended');
});

test('a logout that never answers returns FALSE within the deadline', async () => {
  const session = { raw: { dropSession: never, logout: never } };
  const started = Date.now();
  const clean = await disconnect(session, { timeoutMs: 150 });
  const spent = Date.now() - started;
  assert.equal(clean, false, 'silence must not be reported as a successful logout');
  assert.ok(spent < 1000, `the deadline did not hold: waited ${spent}ms`);
});

test('a throwing logout is survived, and still reported as not clean', async () => {
  const session = {
    raw: {
      dropSession: async () => {
        throw new Error('session already dropped');
      },
      logout: async () => {},
    },
  };
  // Best effort per call is kept -- the throw carries nothing to act on -- but the PAIR
  // now reports, because a caller that cannot tell success from failure cannot tell the
  // operator anything true.
  assert.equal(await disconnect(session, { timeoutMs: 500 }), false);
});

test('the logout is attempted even when dropSession fails', async () => {
  const calls = [];
  const session = {
    raw: {
      dropSession: async () => {
        calls.push('drop');
        throw new Error('nope');
      },
      logout: async () => calls.push('logout'),
    },
  };
  await disconnect(session, { timeoutMs: 500 });
  assert.deepEqual(calls, ['drop', 'logout'], 'a failed drop must not skip the logon ending');
});

test('a logout that answers does not wait out its own deadline', async () => {
  // The timer is cleared, not unref'ed: an unref'ed one would silently fail to fire when
  // nothing else is pending, and the caller would exit without writing its stop line.
  const session = { raw: { dropSession: async () => {}, logout: async () => {} } };
  const started = Date.now();
  await disconnect(session, { timeoutMs: 30_000 });
  assert.ok(Date.now() - started < 1000);
});
