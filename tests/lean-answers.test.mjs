// How a reply travelled is not part of the answer. The route, URL, HTTP status, content type,
// size and duration of each ADT call go to the journal (logs/calls) and the audit trail; copied
// into an answer they are characters the model reads on every call and can act on none of.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TOOLS = new URL('../tools/', import.meta.url);
const files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs')).map((f) => ({ f, text: fs.readFileSync(new URL(f, TOOLS), 'utf8') }));

// `key: out.key` (or reply., res.) copies a reply's metadata into whatever object is being built.
const COPIED = /\b(route|url|status|contentType|bytes|ms|executedQuery|shapeObserved|measured)\s*:\s*(out|reply|res)\??\.(route|url|status|contentType|bytes|ms|executedQuery|shapeObserved)\b/;
// `measured: '2026-...'`, `measured: true`: the date of a measurement is the reference's.
// A key, at the start of the line or after `{` / `,` -- not the word inside a sentence.
const DATED = /(^\s*|[{,]\s*)measured\s*:\s*('|true\b)/;

test('no tool copies the metadata of an ADT reply into its answer', () => {
  const found = [];
  for (const { f, text } of files) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (COPIED.test(line) || DATED.test(line)) found.push(`tools/${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

// A page object copying the cut flag of page() (`truncated: p.truncated`): the cut is said once,
// in `incomplete`, and the page carries only where it is and its `next`.
const PAGE_FLAG = /\btruncated\s*:\s*[a-z]\w*\.truncated\b/;

test('no page object repeats the cut that incomplete states', () => {
  const found = [];
  for (const { f, text } of files) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (!/^\s*(\/\/|\*)/.test(line) && PAGE_FLAG.test(line)) found.push(`tools/${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
