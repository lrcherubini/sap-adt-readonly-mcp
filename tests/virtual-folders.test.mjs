import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildVirtualFoldersBody,
  parseVirtualFolders,
  virtualFoldersPost,
  VirtualFoldersViolation,
  VIRTUAL_FOLDERS_REQUEST,
  VIRTUAL_FOLDERS_RESULT,
} from '../lib/virtual-folders.mjs';

// A reply measured 2026-11-09, anonymised (docs/adt-api-reference.md, "Virtual folders").
const MEASURED = fs.readFileSync(new URL('./fixtures/virtual-folders-measured.xml', import.meta.url), 'utf8');

test('the body is the measured form, for one validated package', () => {
  assert.equal(
    buildVirtualFoldersBody('zdemo_root'),
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<vfs:virtualFoldersRequest xmlns:vfs="http://www.sap.com/adt/ris/virtualFolders" objectSearchPattern="*">' +
      '<vfs:preselection facet="package"><vfs:value>ZDEMO_ROOT</vfs:value></vfs:preselection>' +
      '<vfs:facetorder><vfs:facet>package</vfs:facet><vfs:facet>group</vfs:facet><vfs:facet>type</vfs:facet></vfs:facetorder>' +
      '</vfs:virtualFoldersRequest>'
  );
  assert.match(buildVirtualFoldersBody('/DMO/FLIGHT'), /<vfs:value>\/DMO\/FLIGHT</);
  assert.match(buildVirtualFoldersBody('$tmp'), /<vfs:value>\$TMP</);
  assert.throws(() => buildVirtualFoldersBody('<x>'), VirtualFoldersViolation);
});

test('the measured reply: the total, the direct objects, each sub-package with its own description', () => {
  const r = parseVirtualFolders(MEASURED);
  assert.equal(r.objectCount, 49);
  assert.equal(r.directObjects, 10);
  assert.deepEqual(r.subPackages.map((p) => [p.name, p.description, p.objectsBelow]), [
    ['ZDEMO_BO', 'Demo business objects', 15],
    ['ZDEMO_RATES', 'Exchange rates', 16],
    ['ZDEMO_PO_LOAD', 'Purchase order upload', 8],
  ]);
  assert.equal(r.directObjects + r.subPackages.reduce((n, p) => n + p.objectsBelow, 0), r.objectCount, 'the counters add up (measured)');
  assert.deepEqual(r.drift, []);
});

test('a folder of another facet is kept apart, and an unknown element is drift', () => {
  const r = parseVirtualFolders(MEASURED.replace('</vfs:virtualFoldersResult>', '<vfs:virtualFolder facet="TYPE" name="CLAS" counter="3"/><vfs:newThing/></vfs:virtualFoldersResult>'));
  assert.deepEqual(r.others, [{ facet: 'TYPE', name: 'CLAS', counter: 3 }]);
  assert.equal(r.subPackages.length, 3);
  assert.deepEqual(r.drift, [{ node: 'vfs:newThing', count: 1, where: 'virtualFolders' }]);
});

test('the POST sends the measured headers, and a failure carries its status', async () => {
  const sent = [];
  const ok = { httpClient: { request: async (url, c) => (sent.push({ url, ...c }), { status: 200, body: MEASURED, headers: {} }) } };
  const out = await virtualFoldersPost(ok, 'ZDEMO_ROOT');
  assert.equal(out.status, 200);
  assert.deepEqual(sent[0].headers, { Accept: VIRTUAL_FOLDERS_RESULT, 'Content-Type': VIRTUAL_FOLDERS_REQUEST });
  const failing = { httpClient: { request: async () => { throw Object.assign(new Error('nope'), { err: 403 }); } } };
  await assert.rejects(() => virtualFoldersPost(failing, 'ZDEMO_ROOT'), (e) => e.status === 403);
  await assert.rejects(() => virtualFoldersPost({}, 'ZDEMO_ROOT'), VirtualFoldersViolation);
});
