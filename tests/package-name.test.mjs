// The package alphabet (lib/package-name.mjs), measured on the system: every name shape the
// quick search answered is admitted and encoded for where it goes; nothing else is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, packageNameOf, packageSegmentOf, packageXml } from '../lib/package-name.mjs';
import { nodeStructureRequest } from '../lib/repository-posts.mjs';
import { buildVirtualFoldersBody } from '../lib/virtual-folders.mjs';
import { buildUrl } from '../lib/adt-get.mjs';

// The measured shapes, with demo names: a hyphen, a namespace with a hyphen, `&`, `+`, `.`,
// a local `$` package and a local package in a namespace.
const MEASURED = ['ZDEMO-PKG-A', '/ZDEMO/RBD-TOOL', 'ZDEMO_E&C', 'ZDEMO+G', '/ZDEMO/RELEASE4.5', '$ZDEMO_LOCAL', '$/1DEMO/BBEA', 'ZDEMO_PKG'];

test('every package name shape the system uses is admitted, upper-cased', () => {
  for (const n of MEASURED) assert.equal(packageNameOf(n.toLowerCase()), n, n);
  for (const bad of ['', 'ZDEMO PKG', 'Z'.repeat(31), '/AB/X', '/ZDEMOTOOLONG/X', 'ZDEMO#1', "ZDEMO'1", 'ZDEMO%20', 'ZDEMO,1', 'ZDEMO(1)', 'ZDEMO:1', '../ZDEMO']) {
    assert.equal(packageNameOf(bad), null, bad);
  }
  assert.ok(PACKAGE_NAME.test('/ZDEMO/' + 'A'.repeat(23)), 'thirty with the namespace');
  assert.equal(PACKAGE_NAME.test('/ZDEMO/' + 'A'.repeat(24)), false);
});

test('a package name leaves encoded: percent in a URL, escaped in XML', () => {
  assert.equal(packageSegmentOf('/ZDEMO/RBD-TOOL'), '%2fzdemo%2frbd-tool');
  assert.equal(packageSegmentOf('ZDEMO_E&C'), 'zdemo_e%26c');
  assert.equal(packageSegmentOf('ZDEMO+G'), 'zdemo%2bg');
  assert.equal(packageSegmentOf('$/1DEMO/BBEA'), '%24%2f1demo%2fbbea');
  assert.equal(packageXml('ZDEMO_E&C'), 'ZDEMO_E&amp;C');
  assert.match(nodeStructureRequest('DEVC/K', 'zdemo_e&c').url, /parent_name=ZDEMO_E%26C$/);
  assert.match(nodeStructureRequest('DEVC/K', 'zdemo-pkg-a').url, /parent_name=ZDEMO-PKG-A$/);
  assert.match(buildVirtualFoldersBody('zdemo_e&c'), /<vfs:value>ZDEMO_E&amp;C<\/vfs:value>/);
});

test('the package document route takes every measured name as its segment, and nothing else', () => {
  for (const n of MEASURED) {
    const seg = packageSegmentOf(n);
    assert.equal(buildUrl('packageDocument', { name: seg }).split('?')[0], `/sap/bc/adt/packages/${seg}`, n);
  }
  for (const bad of ['zdemo%20x', 'zdemo/x', '%2fab%2fx', 'zdemo%27']) assert.throws(() => buildUrl('packageDocument', { name: bad }), bad);
});
