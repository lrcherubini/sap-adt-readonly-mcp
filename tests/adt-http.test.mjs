// lib/adt-http.mjs: the logon, the session cookie and the CSRF token as measured, offline. A fake
// `request` plays the system: each exchange is recorded, each answer comes from a script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdtHttp, httpError, safeHeaders, withClient, LOGON_PATH, LOGOFF_PATH } from '../lib/adt-http.mjs';

const CFG = { host: 'vhdemohost.example', port: 44300, client: '001', language: 'EN', allowUnauthorizedTls: false };
const SESSION = 'SAP_SESSIONID_DEV_001=s3ss10nv4lue; path=/; secure; HttpOnly';
const USERCTX = 'sap-usercontext=sap-client=001; path=/';
const TOKEN = 'T0k3nT0k3nT0k3nT0k3n==';

/** A fake https.request. `answer(call)` returns {status, headers, body} or throws for a network error. */
function fakeRequest(answer) {
  const calls = [];
  const request = (options, onResponse) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (chunk) => {
      body += String(chunk);
    };
    req.destroy = (e) => req.emit('error', e);
    req.end = () => {
      const call = { method: options.method, path: options.path, headers: { ...options.headers }, body, tls: options.rejectUnauthorized };
      calls.push(call);
      setImmediate(() => {
        let reply;
        try {
          reply = answer(call, calls.length);
        } catch (e) {
          req.emit('error', e);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = reply.status;
        res.headers = reply.headers ?? {};
        onResponse(res);
        if (reply.body) res.emit('data', Buffer.from(reply.body));
        res.emit('end');
      });
    };
    return req;
  };
  return { request, calls };
}

const LOGON_OK = { status: 200, headers: { 'x-csrf-token': TOKEN, 'set-cookie': [USERCTX, SESSION], 'content-type': 'application/xml' }, body: '<graph/>' };
const isLogon = (c) => c.path.startsWith(LOGON_PATH) && c.headers.Authorization;

test('the logon is the measured exchange, and later requests carry the cookie and the token, never the password', async () => {
  const { request, calls } = fakeRequest((c) => (isLogon(c) ? LOGON_OK : { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': ['x=1'] }, body: 'REPORT zdemo.' }));
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'secret!', request });
  assert.equal(http.loggedin, false);
  await http.login();
  assert.equal(http.loggedin, true);
  const [logon] = calls;
  assert.equal(logon.method, 'GET');
  assert.equal(logon.path, '/sap/bc/adt/compatibility/graph?sap-client=001&sap-language=EN');
  assert.equal(logon.headers.Authorization, `Basic ${Buffer.from('DEVUSER1:secret!').toString('base64')}`);
  assert.equal(logon.headers['x-csrf-token'], 'fetch');
  assert.equal(logon.headers['X-sap-adt-sessiontype'], 'stateless');
  assert.equal(logon.headers['Cache-Control'], 'no-cache');
  assert.equal(logon.tls, true, 'TLS is verified unless the configuration says otherwise');

  const res = await http.httpClient.request('/sap/bc/adt/programs/programs/zdemo/source/main', { method: 'GET', headers: { Accept: 'text/plain' } });
  assert.deepEqual(res, { status: 200, body: 'REPORT zdemo.', headers: { 'content-type': 'text/plain' } }, 'set-cookie never leaves the client');
  const read = calls[1];
  assert.equal(read.path, '/sap/bc/adt/programs/programs/zdemo/source/main?sap-client=001');
  assert.equal(read.headers.Authorization, undefined, 'after the logon the cookie authenticates');
  assert.match(read.headers.Cookie, /SAP_SESSIONID_DEV_001=s3ss10nv4lue/);
  assert.match(read.headers.Cookie, /sap-usercontext=sap-client=001/);
  assert.equal(read.headers['x-csrf-token'], TOKEN);
  assert.equal(read.headers.Accept, 'text/plain', "the caller's Accept wins");
});

test('a POST without a valid token is refused loudly; the client fetches a new one once and repeats once', async () => {
  let posts = 0;
  const { request, calls } = fakeRequest((c) => {
    if (isLogon(c)) return LOGON_OK;
    if (c.method === 'GET' && c.headers['x-csrf-token'] === 'fetch') return { status: 200, headers: { 'x-csrf-token': 'N3wT0k3n' } };
    posts += 1;
    return posts === 1 ? { status: 403, headers: { 'x-csrf-token': 'Required', 'content-type': 'text/plain' }, body: 'CSRF token validation failed' } : { status: 200, body: '<ok/>' };
  });
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'p', request });
  await http.login();
  const res = await http.httpClient.request('/sap/bc/adt/checkruns?reporters=abapCheckRun', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: '<x/>' });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.headers['x-csrf-token']}`), [`GET fetch`, `POST ${TOKEN}`, 'GET fetch', 'POST N3wT0k3n']);
  assert.equal(calls[3].body, '<x/>', 'the same body is sent again');
  assert.equal(calls[2].headers.Authorization, undefined, 'a token is fetched with the cookie, not the password');
});

test('a session that expired logs on again once with the accepted password, and says so', async () => {
  let reads = 0;
  const relogons = [];
  const { request, calls } = fakeRequest((c) => {
    if (isLogon(c)) return LOGON_OK;
    reads += 1;
    return reads === 1 ? { status: 401, headers: { 'content-type': 'text/html' }, body: '<html>logon</html>' } : { status: 200, body: 'ok' };
  });
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'p', request, onRelogon: (x) => relogons.push(x) });
  await http.login();
  assert.equal((await http.httpClient.request('/sap/bc/adt/discovery')).body, 'ok');
  assert.equal(calls.filter(isLogon).length, 2);
  assert.deepEqual(relogons, [{ status: 401 }]);
});

test('a refused logon again kills the client: no request and no logon is sent after it', async () => {
  let logons = 0;
  const refused = [];
  const { request, calls } = fakeRequest((c) => {
    if (isLogon(c)) {
      logons += 1;
      return logons === 1 ? LOGON_OK : { status: 401, headers: { 'content-type': 'text/html' }, body: '<html/>' };
    }
    return { status: 401, headers: {}, body: '' };
  });
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'p', request, onRelogonRefused: (x) => refused.push(x) });
  await http.login();
  await assert.rejects(() => http.httpClient.request('/sap/bc/adt/discovery'), (e) => e.status === 401);
  assert.deepEqual(refused, [{ status: 401 }]);
  const sent = calls.length;
  await assert.rejects(() => http.httpClient.request('/sap/bc/adt/discovery'), /logon again was refused/);
  await assert.rejects(() => http.login(), /logon again was refused/);
  assert.equal(calls.length, sent, 'nothing more reached the system');
  assert.equal(http.loggedin, false);
});

test('the first logon refused is thrown with its status and nothing is retried', async () => {
  const { request, calls } = fakeRequest(() => ({ status: 401, headers: { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="x"' }, body: '<html/>' }));
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'wrong', request });
  await assert.rejects(() => http.login(), (e) => e.status === 401 && e.err === 401);
  assert.equal(calls.length, 1);
  await assert.rejects(() => http.httpClient.request('/sap/bc/adt/discovery'), /not logged on/);
  assert.equal(calls.length, 1);
});

test('a refused request is thrown in the shape the callers read, with no secret in it', async () => {
  const exc =
    '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
    '<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/><message lang="EN">Not found</message>' +
    '<localizedMessage lang="EN">Resource ZDEMO_X does not exist</localizedMessage></exc:exception>';
  const { request } = fakeRequest((c) => (isLogon(c) ? LOGON_OK : { status: 404, headers: { 'content-type': 'application/xml', 'set-cookie': [SESSION] }, body: exc }));
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'secret!', request });
  await http.login();
  const e = await http.httpClient.request('/sap/bc/adt/oo/classes/zdemo_x').catch((x) => x);
  assert.equal(e.name, 'AdtHttpError');
  assert.equal(e.err, 404);
  assert.equal(e.status, 404);
  assert.equal(e.response.status, 404);
  assert.equal(e.type, 'ExceptionResourceNotFound');
  assert.equal(e.localizedMessage, 'Resource ZDEMO_X does not exist');
  assert.equal(e.message, 'HTTP 404: Resource ZDEMO_X does not exist');
  const all = JSON.stringify({ ...e, message: e.message });
  for (const secret of ['s3ss10nv4lue', TOKEN, 'secret!', Buffer.from('DEVUSER1:secret!').toString('base64')]) {
    assert.equal(all.includes(secret), false, `${secret} must not travel in an error`);
  }
});

test('no reply is an error with no status; the logoff ends the session and forgets the password', async () => {
  const { request, calls } = fakeRequest((c) => {
    if (isLogon(c)) return LOGON_OK;
    if (c.path.startsWith(LOGOFF_PATH)) return { status: 200, headers: { 'set-cookie': ['SAP_SESSIONID_DEV_001=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'] } };
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
  const http = createAdtHttp(CFG, { user: 'DEVUSER1', password: 'p', request });
  await http.login();
  await assert.rejects(() => http.httpClient.request('/sap/bc/adt/discovery'), (e) => e.status === null && e.code === 'ECONNRESET');
  await http.dropSession();
  await http.logout();
  const logoff = calls.at(-1);
  assert.equal(logoff.path, '/sap/public/bc/icf/logoff?sap-client=001');
  assert.match(logoff.headers.Cookie, /SAP_SESSIONID_DEV_001/);
  assert.equal(http.loggedin, false);
  await assert.rejects(() => http.httpClient.request('/sap/bc/adt/discovery'), /logged off/);
  await assert.rejects(() => http.login(), /logged off/);
});

test('the helpers: sap-client once, secret headers dropped, a plain-text refusal keeps its text', () => {
  assert.equal(withClient('/sap/bc/adt/x', '001'), '/sap/bc/adt/x?sap-client=001');
  assert.equal(withClient('/sap/bc/adt/x?a=1', '001'), '/sap/bc/adt/x?a=1&sap-client=001');
  assert.equal(withClient('/sap/bc/adt/x?sap-client=002', '001'), '/sap/bc/adt/x?sap-client=002');
  assert.deepEqual(safeHeaders({ 'Set-Cookie': ['a=b'], 'X-CSRF-Token': 't', 'Content-Type': 'text/plain', ETag: 'e' }), { 'content-type': 'text/plain', etag: 'e' });
  const e = httpError(403, 'CSRF token validation failed', { 'content-type': 'text/plain; charset=utf-8' }, '/x');
  assert.equal(e.localizedMessage, 'CSRF token validation failed');
  assert.equal(httpError(500, '<html/>', { 'content-type': 'text/html' }, '/x').message, 'HTTP 500');
  assert.throws(() => createAdtHttp(CFG, { user: 'DEVUSER1' }), /needs a host, a user and a password/);
});
