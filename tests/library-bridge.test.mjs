// lib/library-bridge.mjs (temporary): the library's members ride on the own HTTP client. The real
// ADTClient is used here, over a fake own client, so what reaches the wire is what the library
// would have sent over axios -- minus the session it no longer owns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryOver, urlWithQuery, axiosEncode, MANAGED } from '../lib/library-bridge.mjs';
import { httpError } from '../lib/adt-http.mjs';

function fakeOwn(answer) {
  const calls = [];
  return {
    calls,
    httpClient: {
      request: async (url, opts) => {
        calls.push({ url, ...opts });
        return answer(url, opts);
      },
    },
  };
}

const over = (own) => libraryOver(own, { user: 'DEVUSER1', client: '001', language: 'EN' });

test('the library never logs on by itself and sends no session header: the own client owns the session', async () => {
  const own = fakeOwn(() => ({ status: 200, body: 'REPORT zdemo.', headers: { 'content-type': 'text/plain' } }));
  const lib = over(own);
  assert.equal(lib.httpClient.csrfToken, MANAGED);
  assert.equal(await lib.getObjectSource('/sap/bc/adt/programs/programs/zdemo/source/main'), 'REPORT zdemo.');
  assert.equal(own.calls.length, 1, 'no logon of its own before the read');
  const [call] = own.calls;
  assert.equal(call.url, '/sap/bc/adt/programs/programs/zdemo/source/main');
  assert.equal(call.method, 'GET');
  for (const h of Object.keys(call.headers)) {
    assert.ok(!['cookie', 'x-csrf-token', 'authorization', 'x-sap-adt-sessiontype'].includes(h.toLowerCase()), `${h} is the own client's`);
  }
});

test('the query is serialised as axios serialised it', async () => {
  assert.equal(axiosEncode('a b:c,$/#'), 'a+b:c,$%2F%23');
  assert.equal(urlWithQuery('/x', { a: 'b', skip: undefined, n: null, t: true }), '/x?a=b&t=true');
  assert.equal(urlWithQuery('/x?y=1', { a: ['p', 'q'] }), '/x?y=1&a%5B%5D=p&a%5B%5D=q');
  assert.equal(urlWithQuery('/x', {}), '/x');
  const own = fakeOwn(() => ({ status: 200, body: '<?xml version="1.0"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>', headers: {} }));
  await over(own).searchObject('ZCL_DEMO*', 'CLAS/OC', 5);
  assert.equal(own.calls[0].url, '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=ZCL_DEMO*&maxResults=5&objectType=CLAS');
});

test('a POST of the library goes out as a POST with its body', async () => {
  const own = fakeOwn(() => ({ status: 200, body: '<?xml version="1.0"?><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TREE_CONTENT/></DATA></asx:values></asx:abap>', headers: {} }));
  await over(own).nodeContents('DEVC/K', 'ZDEMO_PKG');
  assert.equal(own.calls[0].method, 'POST');
  assert.match(own.calls[0].url, /^\/sap\/bc\/adt\/repository\/nodestructure\?parent_type=DEVC%2FK&withShortDescriptions=true&parent_name=ZDEMO_PKG$/);
});

test('a refused request becomes the exception the library built before, status in `err`', async () => {
  const exc =
    '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
    '<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/><message lang="EN">Not found</message>' +
    '<localizedMessage lang="EN">Resource ZDEMO_X does not exist</localizedMessage></exc:exception>';
  const own = fakeOwn((url) => {
    throw httpError(404, exc, { 'content-type': 'application/xml' }, url);
  });
  const e = await over(own).objectStructure('/sap/bc/adt/oo/classes/zdemo_x').catch((x) => x);
  assert.equal(e.err, 404);
  assert.equal(e.type, 'ExceptionResourceNotFound');
  assert.equal(e.localizedMessage, 'Resource ZDEMO_X does not exist');
  assert.equal(own.calls.length, 1, 'a 404 is not a logon error: nothing is retried');
});

test('no reply at all is an error, never a 500 that would send the dump lookup after nothing', async () => {
  const own = fakeOwn(() => {
    throw Object.assign(new Error('no reply from the SAP system: ECONNRESET'), { status: null, code: 'ECONNRESET' });
  });
  const e = await over(own).getObjectSource('/sap/bc/adt/programs/programs/zdemo/source/main').catch((x) => x);
  assert.match(e.message, /ECONNRESET/);
  assert.notEqual(e.err, 500);
});
