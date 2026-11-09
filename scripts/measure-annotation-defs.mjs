#!/usr/bin/env node
// Measure the DDLA this system actually serves (npm run measure:ddla).
//
// WHY A SCRIPT AND NOT A ROUTE OR A TOOL
//
// `annotationDefinitions` is already reachable: it sits in the guard allowlist and
// `adt_value_help` calls it on every run that validates. Adding a named GET template for
// /sap/bc/adt/ddic/cds/annotation/definitions would widen the deliberately-narrow GET
// surface to reach something already reachable, and would hand back the XML envelope --
// one layer ABOVE what this codebase actually consumes. The client wrapper extracts
// `cds:annotation/cds:definitions` and returns DDLA source TEXT, and that text is what
// `fromDdla()` parses. The text is therefore the artefact worth measuring: it is where
// OUR assumptions live. The envelope is the library's contract, not ours.
//
// Putting it on `adt_value_help` behind a flag was the other option and is worse: that
// tool answers a question, and a diagnostic payload does not belong in its answer shape.
//
// WHERE THE OUTPUT GOES, AND WHY NOT THE REPO
//
// DDLA is SAP standard source. The repo's .gitignore says, in its own words, "Never in
// this repo: credentials, session state, cached SAP source, the audit trail." A dump of
// the system DDLA is cached SAP source, so it is written under the state directory
// (%LOCALAPPDATA%\sap-adt\measurements\), outside any git work tree by construction --
// the same place the audit log lives, for the same reason. What may go into
// docs/adt-api-reference.md is a STRUCTURAL description plus a short excerpt, never the
// payload. That is the difference between this measurement and the annotation-chain one:
// that payload described a Z object of ours, this one is SAP's source.
//
// WHAT IT ACTUALLY CHECKS
//
// Recording bytes would be a chore. The measurement worth having is whether `fromDdla()`
// sees what the file contains: it counts `define annotation` roots in the raw text and
// compares that against what the parser returned. A parser that silently reads half the
// DDLA and a parser that reads all of it look identical from inside `adt_value_help`.
//
// Usage:  npm run measure:ddla        (prompts for the SAP password, like `npm run adt`)
//         npm run measure:ddla -- --head 80

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, newMeasurementDir } from '../lib/config.mjs';
import { connect, disconnect } from '../lib/session.mjs';
import { fromDdla } from '../lib/annotation-defs.mjs';

const args = process.argv.slice(2);
const headLines = Number(args[args.indexOf('--head') + 1]) || 40;

/**
 * The roots the text declares.
 *
 * `define` is OPTIONAL in the DDLA this system serves, and that is not a detail: the first
 * run of this script required it and reported 11 roots against the parser's 27, which reads
 * like the parser inventing 16 annotations when the truth was the opposite. Measured
 * 2026-09-09: 31 roots, only 11 of them written with `define`. Anchored to the line start
 * with [ 	] rather than \s so that a `annotation` on a continuation line cannot match.
 */
const DEFINE_ANNOTATION = /^[ 	]*(?:define[ 	]+)?annotation[ 	]+([A-Za-z_][\w.]*)/gm;

const cfg = loadConfig();
console.log(`Measuring the DDLA of ${cfg.host}:${cfg.port} client ${cfg.client}.`);
console.log('This is ONE read. It changes nothing in the SAP system.\n');

const session = await connect(cfg);
let text;
try {
  // Through the guard, not the raw client: this must stay inside the allowlist, and
  // going around it here would make the guard a suggestion.
  text = await session.api.annotationDefinitions();
} finally {
  await disconnect(session);
}

if (typeof text !== 'string' || !text.length) {
  // An empty answer is not "this system defines no annotations". Say which it is.
  console.error(
    `\nThe call returned ${text === undefined ? 'undefined' : `${typeof text}, length ${text?.length ?? 0}`}.\n` +
      'That is NOT evidence that the system has no annotation definitions -- it is an\n' +
      'unread answer. Nothing was written.'
  );
  process.exit(1);
}

const declared = [...text.matchAll(DEFINE_ANNOTATION)].map((m) => m[1]);
const defs = fromDdla(text);
// `keys()` are full annotation paths (`ui.lineitem.position`), the text declares ROOTS
// (`UI`). A root is seen when some key is it, or sits under it.
const parsedKeys = defs.keys();
const roots = new Set(parsedKeys.map((k) => String(k).toLowerCase().split('.')[0]));

// One folder per run (lib/config.mjs, newMeasurementDir): a second run never overwrites the first.
const out = path.join(newMeasurementDir('annotation-definitions'), 'annotation-definitions.ddla');
fs.writeFileSync(out, text, { encoding: 'utf8', flag: 'wx' });

const lines = text.split('\n');
console.log(`\n--- measured ---`);
console.log(`bytes                 : ${Buffer.byteLength(text, 'utf8')}`);
console.log(`lines                 : ${lines.length}`);
console.log(`define annotation     : ${declared.length} root(s) in the raw text`);
console.log(`fromDdla() returned   : ${parsedKeys.length} key(s) under ${roots.size} root(s)`);
console.log(`defs.available        : ${defs.available}`);
console.log(`written to            : ${out}`);
console.log(`  (state dir, outside any git work tree -- DDLA is SAP source)`);

const missed = declared.filter((d) => !roots.has(d.toLowerCase().split('.')[0]));
if (missed.length) {
  console.log(
    `\n! ${missed.length} root(s) declared in the text that fromDdla() did not return:\n  ` +
      `${missed.slice(0, 20).join(', ')}${missed.length > 20 ? ', …' : ''}\n` +
      '  Either the parser misses a form, or these are roots it deliberately skips.\n' +
      '  Check before trusting a "not a known annotation" verdict from adt_value_help.'
  );
} else if (declared.length) {
  console.log(`\nEvery root declared in the text came back from fromDdla().`);
}

console.log(`\n--- first ${headLines} lines, for the shape ---`);
console.log(lines.slice(0, headLines).join('\n'));
