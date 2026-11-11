// lib/repository-posts.mjs: the repository reads that are POSTs, as abap-adt-api sent them, built
// here from validated values only, and parsed in the library's shapes. Fixtures: measured replies,
// anonymised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nodeStructureRequest, repositoryPost, RepositoryPostViolation } from '../lib/repository-posts.mjs';
import { ownReads } from '../lib/adt-reads.mjs';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'repository-posts', name), 'utf8');

function fakeRaw(answer) {
  const calls = [];
  return { calls, httpClient: { request: async (url, opts) => { calls.push({ url, ...opts }); return answer(url, opts); } } };
}

test('nodeContents: the tree POST with no body, the parameters in the library order, a package only', async () => {
  const raw = fakeRaw(() => ({ status: 200, body: fixture('nodestructure.xml'), headers: {} }));
  const tree = await ownReads(raw).nodeContents('DEVC/K', 'zdemo_pkg');
  assert.deepEqual(raw.calls, [{ url: '/sap/bc/adt/repository/nodestructure?parent_type=DEVC%2FK&withShortDescriptions=true&parent_name=ZDEMO_PKG', method: 'POST', headers: { Accept: '*/*' } }]);
  const named = tree.nodes.filter((n) => n.OBJECT_NAME);
  assert.deepEqual(named.map((n) => [n.OBJECT_TYPE, n.OBJECT_NAME]), [
    ['CLAS/OC', 'ZCL_DEMO'],
    ['PROG/P', 'ZDEMO_REPORT'],
    ['PROG/P', 'ZDEMO_REPORT2'],
    ['PROG/P', 'ZDEMO_REPORT3'],
    ['PROG/P', 'ZDEMO_REPORT4'],
  ]);
  assert.equal(named[0].OBJECT_URI, '/sap/bc/adt/oo/classes/zcl_demo');
  assert.equal(tree.nodes.find((n) => !n.OBJECT_NAME).OBJECT_NAME, '', 'a type folder keeps its empty name');
  assert.equal(typeof tree.nodes[0].NODE_ID, 'string', 'a row stays text: 000003 is not 3');
  assert.ok(tree.nodes.every((n) => typeof n.DESCRIPTION === 'string'));
  assert.deepEqual(tree.categories.map((c) => c.CATEGORY_LABEL), ['Source Code Library']);
  assert.ok(tree.objectTypes.length >= 2);
  const empty = fakeRaw(() => ({ status: 200, body: '', headers: {} }));
  assert.deepEqual(await ownReads(empty).nodeContents('DEVC/K', '$TMP'), { categories: [], nodes: [], objectTypes: [] });
  assert.match(empty.calls[0].url, /parent_name=%24TMP$/);
});

test('the tree POST refuses anything but a package name, and a body not built here', async () => {
  for (const [type, name] of [['PROG/P', 'ZDEMO'], ['DEVC/K', 'ZDEMO&x=1'], ['DEVC/K', ''], ['DEVC/K', 'A'.repeat(31)]]) {
    assert.throws(() => nodeStructureRequest(type, name), RepositoryPostViolation, `${type} ${name}`);
  }
  const raw = fakeRaw(() => ({ status: 200, body: '', headers: {} }));
  await assert.rejects(() => repositoryPost(raw, { url: '/sap/bc/adt/repository/nodestructure', headers: {} }), RepositoryPostViolation);
  await assert.rejects(() => repositoryPost({}, nodeStructureRequest('DEVC/K', 'ZDEMO')), RepositoryPostViolation);
  assert.equal(raw.calls.length, 0);
});
