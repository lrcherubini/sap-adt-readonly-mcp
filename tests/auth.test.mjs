// The loopback auth path, offline. It has produced two operator-facing bugs already,
// so both are pinned here: the OAuth misdeclaration and the unexpanded shell command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authFailure } from '../lib/auth.mjs';

const TOKEN = 'a'.repeat(64);

test('the right token is accepted', () => {
  assert.equal(authFailure(`Bearer ${TOKEN}`, TOKEN), null);
  assert.equal(authFailure(`bearer ${TOKEN}`, TOKEN), null, 'scheme is case-insensitive');
  assert.equal(authFailure(`Bearer  ${TOKEN}\n`, TOKEN), null, 'surrounding whitespace is tolerated');
});

test('a wrong or absent token is refused, with a reason', () => {
  assert.match(authFailure(undefined, TOKEN), /no Authorization header/);
  assert.match(authFailure('', TOKEN), /no Authorization header/);
  assert.match(authFailure('Basic dXNlcjpwdw==', TOKEN), /not "Bearer/);
  assert.match(authFailure('Bearer ', TOKEN), /empty token/);
  assert.match(authFailure(`Bearer ${'b'.repeat(64)}`, TOKEN), /does not match/);
  assert.match(authFailure('Bearer short', TOKEN), /token length/);
});

test('an unexpanded shell command is named as such, not called a bad token', () => {
  // What actually happens when the registration line is pasted where the shell does
  // not run command substitution.
  const cases = [
    "Bearer $(Get-Content 'C:\\Users\\x\\AppData\\Local\\sap-adt\\token')",
    "Bearer $(cat '/c/Users/x/AppData/Local/sap-adt/token')",
    'Bearer <content of %LOCALAPPDATA%\\sap-adt\\token>',
  ];
  for (const header of cases) {
    assert.match(authFailure(header, TOKEN), /shell did not expand/, header);
  }
});

test('the reason never contains the expected token', () => {
  for (const header of [undefined, 'Bearer wrong', 'Basic x', `Bearer ${'c'.repeat(64)}`]) {
    const reason = authFailure(header, TOKEN) ?? '';
    assert.ok(!reason.includes(TOKEN), 'the token must not leak into a message');
  }
});

// The regression that produced "Dynamic Client Registration rejected (HTTP 404)":
// a 401 carrying `WWW-Authenticate: Bearer` tells an MCP client this server speaks
// OAuth 2.0, so it runs discovery and DCR instead of just sending the token.
test('a 401 must not advertise OAuth', async () => {
  const server = http.createServer((req, res) => {
    const failure = authFailure(req.headers.authorization, TOKEN);
    if (failure) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end(`unauthorized: ${failure}`);
      return;
    }
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const unauth = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(unauth.status, 401);
  assert.equal(
    unauth.headers.get('www-authenticate'),
    null,
    'WWW-Authenticate on a 401 makes MCP clients start an OAuth flow this server does not implement'
  );

  const ok = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(ok.status, 200);

  await new Promise((r) => server.close(r));
});
