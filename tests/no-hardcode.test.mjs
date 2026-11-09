// No value of a particular SAP landscape lives in the code.
//
// Everything an installation chooses -- host, client, customer tables, ATC variants, service paths,
// sibling repositories -- comes from the environment store (lib/environment.mjs), and
// SAP-standard lists come from data/defaults/. This test keeps it that way with GENERIC rules, so
// that it can be public: it names no real object, only the shapes a landscape value takes.
//
// Scope: the code that runs -- lib/, tools/, scripts/, server.mjs. Tests and fixtures carry demo
// data on purpose and are not scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const FILES = [
  ...['lib', 'tools', 'scripts'].flatMap((d) =>
    fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(d, f))
  ),
  'server.mjs',
].map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
function offenders(re, allow = () => false) {
  const out = [];
  for (const { file, text } of FILES) {
    for (const m of text.matchAll(re)) if (!allow(m[0])) out.push(`${file}:${lineOf(text, m.index)} ${m[0]}`);
  }
  return out;
}

/**
 * A customer object named in code is a landscape value. What may appear: demo names (they say
 * DEMO), placeholders an explanation needs (`ZI_X`, `ZC_X`, a bare prefix such as `ZI_`), and
 * English words that merely start with Z or Y.
 */
const ALLOWED_Z = new Set([
  'ZERO', 'Zero', 'YES', 'Yield', // words, not objects
  'ZI_X', 'ZC_X', 'ZCL_X', 'ZSD_X', 'ZFOO', 'ZSAP_TC_X', 'ZI_', 'ZZ1_', 'ZDE', 'ZCL_SD', 'Z_PREFIX', 'Z_PARAM', // placeholders
  'ZTERM', // a standard field (T052)
]);

test('no customer object is named in the code -- only demo names and placeholders', () => {
  const re = /(?<![A-Za-z0-9_/$.-])[ZY][A-Za-z0-9_]{2,}(?![A-Za-z0-9_])/g;
  assert.deepEqual(
    offenders(re, (t) => /demo/i.test(t) || ALLOWED_Z.has(t) || t === 'ZA_Product'),
    [],
    'a Z/Y name in the code is a value of one landscape: move it to the store (npm run config) or to a test fixture'
  );
});

test('no transport number of a real system is written in the code', () => {
  // The demo SID is DEV; any other <SID>K<6 digits> is somebody's transport.
  assert.deepEqual(offenders(/\b[A-Z][A-Z0-9]{2}K\d{6}\b/g, (t) => t.startsWith('DEVK')), []);
});

test('no SAP client is written in the code -- it comes from the store or the IDE project', () => {
  assert.deepEqual(offenders(/\b(?:client|mandt|mandante|sap-client|clnt)\W{0,6}\d{3}\b|client-\d{3}\b/gi), []);
});

test('no host, no e-mail, no Windows user path is written in the code', () => {
  const hosts = offenders(/https?:\/\/[^\s'"`)]+/g, (u) =>
    // SAP's catalogue upstream (API, raw files, viewer) is the one public source sync:catalog reads.
    /^(https?:\/\/)(127\.0\.0\.1|localhost|www\.sap\.com|www\.w3\.org|schemas\.microsoft\.com|docs\.oasis-open\.org|github\.com|help\.sap\.com|api\.github\.com\/repos\/\$\{UPSTREAM\}|raw\.githubusercontent\.com\/\$\{UPSTREAM\}|sap\.github\.io\/abap-atc-cr-cv-s4hc\/|\$\{)/.test(u)
  );
  assert.deepEqual(hosts, []);
  assert.deepEqual(offenders(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\.[A-Za-z]{2,})?/g, (m) => /^@?(modelcontextprotocol|anthropic)/.test(m)), []);
  assert.deepEqual(offenders(/[A-Za-z]:\\\\?Users\\\\?[A-Za-z]/g), []);
});
