// lib/object-structure.mjs and lib/xml.mjs: the object document in the shape abap-adt-api gave,
// and where the source of an object lives. Fixtures: measured replies, anonymised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseObjectStructure, mainInclude, classIncludes, followUrl } from '../lib/object-structure.mjs';
import { parseXml, typedAttrs, typedValue, decode, XmlError } from '../lib/xml.mjs';
import { ownReads } from '../lib/adt-reads.mjs';

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'object-structure', name), 'utf8');
const CLASS = '/sap/bc/adt/oo/classes/zcl_demo';
const PROG = '/sap/bc/adt/programs/programs/zdemo_report';
const CDS = '/sap/bc/adt/ddic/ddl/sources/zdemo_i_rate';

test('a class: typed metadata, its own links only, five includes each with its links', () => {
  const s = parseObjectStructure(CLASS, fixture('class.xml'));
  assert.equal(s.objectUrl, CLASS);
  assert.equal(s.metaData['adtcore:name'], 'ZCL_DEMO');
  assert.equal(s.metaData['adtcore:type'], 'CLAS/OC');
  assert.equal(s.metaData['class:visibility'], 'public');
  assert.equal(s.metaData['class:final'], true, 'true/false become booleans, as the library typed them');
  assert.equal(s.metaData['adtcore:descriptionTextLimit'], 60);
  assert.equal(s.metaData['adtcore:changedAt'], Date.parse('2026-11-10T18:20:08Z'));
  assert.equal(Object.keys(s.metaData).some((k) => k.startsWith('xmlns')), false);
  assert.equal(s.links.length, 7, 'the link inside abapsource:syntaxConfiguration is not the object\'s');
  assert.deepEqual(s.includes.map((i) => i['class:includeType']), ['definitions', 'implementations', 'macros', 'testclasses', 'main']);
  assert.equal(s.includes[0].links.length, 4);
  assert.equal(typeof s.includes[0].links[1].etag, 'string', 'an etag too large for a number stays exact');
  assert.equal(mainInclude(s), `${CLASS}/source/main`);
  assert.deepEqual([...classIncludes(s)], [
    ['definitions', `${CLASS}/includes/definitions`],
    ['implementations', `${CLASS}/includes/implementations`],
    ['macros', `${CLASS}/includes/macros`],
    ['testclasses', `${CLASS}/includes/testclasses`],
    ['main', `${CLASS}/source/main`],
  ]);
});

test('a program and a CDS view: no includes, the source where the document says', () => {
  const p = parseObjectStructure(PROG, fixture('program.xml'));
  assert.equal(p.includes, undefined);
  assert.equal(p.metaData['adtcore:type'], 'PROG/P');
  assert.equal(mainInclude(p), `${PROG}/source/main`);
  const c = parseObjectStructure(CDS, fixture('cds.xml'));
  assert.equal(c.metaData['adtcore:type'], 'DDLS/DF');
  assert.equal(mainInclude(c), `${CDS}/source/main`);
});

test('mainInclude: a package is its own URI; a link with no type serves a class; the default appends /source/main', () => {
  assert.equal(mainInclude({ objectUrl: '/sap/bc/adt/packages/zdemo_pkg', metaData: { 'adtcore:type': 'DEVC/K' }, links: [] }), '/sap/bc/adt/packages/zdemo_pkg');
  const cls = { objectUrl: CLASS, metaData: { 'class:visibility': 'public' }, includes: [{ 'class:includeType': 'main', links: [{ href: 'source/main' }] }], links: [] };
  assert.equal(mainInclude(cls), `${CLASS}/source/main`);
  const bare = { objectUrl: PROG, metaData: {}, links: [] };
  assert.equal(mainInclude(bare), `${PROG}/source/main`);
  assert.equal(mainInclude(bare, false), PROG);
  assert.equal(mainInclude({ objectUrl: PROG, metaData: {}, links: [{ type: 'text/plain', href: 'source/main' }] }), `${PROG}/source/main`);
  assert.equal(followUrl('/a/b/c', './d'), '/a/b/d');
  assert.equal(followUrl('/a/b/', '/c'), '/a/b/c');
});

test('the XML reader: entities, CDATA, comments; a DOCTYPE, a mismatch or two roots are refused', () => {
  const el = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'q\'><b/>t&lt;<![CDATA[<raw>]]>&#65;&#x42;</a>');
  assert.deepEqual(el.attrs, { x: '1 & 2', y: 'q' });
  assert.equal(el.children[0].name, 'b');
  assert.equal(el.text, 't<<raw>AB');
  assert.equal(decode('&unknown;'), '&unknown;');
  assert.equal(parseXml('<a>x\r\ny\rz</a>').text, 'x\ny\nz', 'CR LF and a lone CR are read as LF');
  for (const bad of ['<!DOCTYPE a [<!ENTITY e "x">]><a/>', '<a><b></a>', '<a/><b/>', '<a>', '<a', '<!-- x']) {
    assert.throws(() => parseXml(bad), XmlError, bad);
  }
  assert.deepEqual(typedAttrs({ attrs: { 'xmlns:a': 'u', n: '7', f: 'false', s: '007x', big: '202611100732370011', d: '1.5' } }), { n: 7, f: false, s: '007x', big: '202611100732370011', d: 1.5 });
  assert.equal(typedValue('1e3'), 1000);
});

test('objectStructure reads the object URI once with the library Accept, and refuses anything else', async () => {
  const calls = [];
  const raw = { httpClient: { request: async (url, opts) => { calls.push({ url, ...opts }); return { status: 200, body: fixture('program.xml'), headers: {} }; } } };
  const s = await ownReads(raw).objectStructure(PROG);
  assert.equal(s.metaData['adtcore:name'], 'ZDEMO_REPORT');
  assert.deepEqual(calls, [{ url: PROG, method: 'GET', headers: { Accept: '*/*' } }]);
  for (const bad of [`${PROG}?version=inactive`, '/sap/opu/odata/x', `${PROG}/../x`, '/sap/bc/adt//x']) {
    await assert.rejects(() => ownReads(raw).objectStructure(bad), (e) => e.name === 'RouteViolation', bad);
  }
});

test('objectStructureElements: the outline of a class as the library gave it, a failure thrown, no outline elsewhere', async () => {
  const calls = [];
  let fail = false;
  const raw = {
    httpClient: {
      request: async (url, opts) => {
        calls.push({ url, ...opts });
        if (fail) throw Object.assign(new Error('HTTP 500'), { err: 500, status: 500 });
        return { status: 200, body: fixture('outline.xml'), headers: {} };
      },
    },
  };
  const els = await ownReads(raw).objectStructureElements(CLASS);
  assert.equal(calls[0].url, `${CLASS}/objectstructure?version=active&withShortDescriptions=true`);
  assert.equal(els.length, 9);
  const add = els.find((e) => e.name === 'ADD');
  assert.equal(add.type, 'CLAS/OM');
  assert.ok(Array.isArray(add.links) && Array.isArray(add.children));
  const local = els.find((e) => e.name === 'LCL_COUNTER');
  assert.deepEqual(local.children.map((c) => c.name), ['CONSTRUCTOR', 'NEXT', 'MV_VALUE'], 'nested elements keep their nesting');
  assert.deepEqual(await ownReads(raw).objectStructureElements(PROG), [], 'a program has no outline, and nothing is asked');
  assert.equal(calls.length, 1);
  fail = true;
  await assert.rejects(() => ownReads(raw).objectStructureElements(CLASS), (e) => e.status === 500, 'a failure is never an empty outline');
});
