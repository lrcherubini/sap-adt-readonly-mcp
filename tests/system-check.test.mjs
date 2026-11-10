// The system is confirmed before the password is asked: one GET without credentials, and the
// 401 it answers names the system (docs/phase0-report.md, section 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { askWithoutCredentials, identityOf, judgeSystem, confirmSystem, SYSTEM_CHECK_PATH } from '../lib/system-check.mjs';
import { connect } from '../lib/session.mjs';

const cfg = { host: 'vhdemohost.example', port: 44300, client: '001', system: 'DEV', allowUnauthorizedTls: false };
const answer401 = (sid = 'DEV', client = '001') => ({
  status: 401,
  headers: { 'sap-system': sid, 'www-authenticate': `Basic realm="SAP NetWeaver Application Server [${sid}/${client}]"` },
});

/** A stand-in for https.request: records the options, answers as told. */
function fakeRequest(reply) {
  const sent = [];
  const request = (options, onResponse) => {
    sent.push(options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => {
        if (reply.error) req.emit('error', Object.assign(new Error('boom'), { code: reply.error }));
        else if (reply.timeout) req.emit('timeout');
        else onResponse({ statusCode: reply.status, headers: reply.headers, resume: () => {} });
      });
    };
    return req;
  };
  return { request, sent };
}

test('the check is one GET at a fixed path, with the client, and with no credential of any kind', async () => {
  const { request, sent } = fakeRequest(answer401());
  const a = await askWithoutCredentials(cfg, { request });
  assert.equal(a.status, 401);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].path, `${SYSTEM_CHECK_PATH}?sap-client=001`);
  assert.equal(sent[0].host, 'vhdemohost.example');
  assert.equal(sent[0].rejectUnauthorized, true, 'TLS is verified unless the installation opted out');
  assert.equal(sent[0].headers, undefined, 'no header at all, so no Authorization header');
  assert.equal(sent[0].auth, undefined);
  const lax = fakeRequest(answer401());
  await askWithoutCredentials({ ...cfg, allowUnauthorizedTls: true }, { request: lax.request });
  assert.equal(lax.sent[0].rejectUnauthorized, false);
});

test('a socket error or a timeout is an answer with an error, never a throw', async () => {
  assert.deepEqual(await askWithoutCredentials(cfg, fakeRequest({ error: 'ECONNREFUSED' })), { error: 'ECONNREFUSED' });
  assert.match((await askWithoutCredentials(cfg, fakeRequest({ timeout: true }))).error, /no answer within 8 s/);
});

test('identityOf reads the SID from the header and SID and client from the realm', () => {
  assert.deepEqual(identityOf(answer401().headers), { sid: 'DEV', realmSid: 'DEV', client: '001' });
  assert.deepEqual(identityOf({ 'www-authenticate': 'Basic realm="x [DEV/001]"' }), { sid: 'DEV', realmSid: 'DEV', client: '001' }, 'no header: the realm says it');
  assert.deepEqual(identityOf({}), { sid: null, realmSid: null, client: null });
  assert.deepEqual(identityOf(), { sid: null, realmSid: null, client: null });
});

test('the expected system passes and says how it was confirmed', () => {
  const v = judgeSystem(cfg, answer401());
  assert.equal(v.ok, true);
  assert.equal(v.message, 'system confirmed: DEV client 001 (asked without credentials)');
});

test('another system, another client, or a header and realm that disagree are refused, naming both values', () => {
  const sid = judgeSystem(cfg, answer401('QAS'));
  assert.equal(sid.ok, false);
  assert.match(sid.message, /system QAS, expected DEV/);
  assert.match(sid.message, /Nothing was asked and no SAP session was opened/);
  assert.match(judgeSystem(cfg, answer401('DEV', '100')).message, /client 100, expected 001/);
  const split = { status: 401, headers: { 'sap-system': 'DEV', 'www-authenticate': 'Basic realm="x [QAS/001]"' } };
  assert.equal(judgeSystem(cfg, split).ok, false);
});

test('without an expected system the server does not start, and says which value the host answers', () => {
  const v = judgeSystem({ ...cfg, system: null }, answer401('DEV'));
  assert.equal(v.ok, false);
  assert.match(v.message, /`system` is required/);
  assert.match(v.message, /npm run config -- set system <SID>/);
  assert.match(v.message, /answers as DEV client 001/);
  assert.doesNotMatch(judgeSystem({ ...cfg, system: null }, { error: 'ENOTFOUND' }).message, /answers as/);
});

test('what cannot confirm the system refuses: no answer, not a 401, a 401 that names nothing', () => {
  assert.match(judgeSystem(cfg, { error: 'ENOTFOUND' }).message, /Could not confirm the system at vhdemohost.example:44300 \(ENOTFOUND\)/);
  assert.match(judgeSystem(cfg, { status: 302, headers: {} }).message, /answered HTTP 302/);
  assert.match(judgeSystem(cfg, { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } }).message, /names no system/);
});

test('confirmSystem asks once and throws the verdict; connect stops before the password prompt', async () => {
  let asked = 0;
  assert.equal((await confirmSystem(cfg, { ask: async () => (asked++, answer401()) })).ok, true);
  await assert.rejects(() => confirmSystem(cfg, { ask: async () => (asked++, answer401('QAS')) }), /Unexpected system/);
  assert.equal(asked, 2);
  // `confirm` refuses: the prompt (which would fail with "No TTY" here) is never reached.
  await assert.rejects(
    () => connect({ ...cfg, user: 'DEVUSER1' }, { confirm: async () => { throw new Error('Unexpected system'); } }),
    /^Error: Unexpected system$/
  );
});
