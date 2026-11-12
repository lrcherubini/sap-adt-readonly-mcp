// This repository is public, English-only, and its CLAUDE.md does not grow.
//
// tests/no-hardcode.test.mjs keeps landscape values out of the code that runs. This file widens
// the same promise to EVERY file the repository carries -- README, docs/, data/, tests and their
// fixtures, CLAUDE.md, .claude/ -- because a measurement transcribed into a doc or a reply
// captured as a fixture leaks a landscape just as well as a constant does.
//
// The rules are generic shapes, never a list of real values: a list of what must not appear
// would itself publish what it protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const SKIP = /^(node_modules|\.git|logs|coverage|cache|local)$/;
const BINARY = /\.(png|jpe?g|gif|ico|zip|gz|db|sqlite)$/i;

/** Every file git would carry (tracked + untracked-not-ignored); a directory walk without git. */
function repoFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (SKIP.test(e.name)) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

const FILES = repoFiles()
  .filter((f) => !BINARY.test(f) && f !== 'package-lock.json')
  .map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }))
  .filter(({ text }) => !text.includes('\0'));

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
function offenders(re, allow = () => false, files = FILES) {
  const out = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(re)) {
      if (!allow(m[0], file)) out.push(`${file}:${lineOf(text, m.index)} ${m[0]}`);
    }
  }
  return out;
}

test('the scan sees the whole repository, docs and fixtures included', () => {
  const names = new Set(FILES.map((f) => f.file));
  for (const f of ['README.md', 'CLAUDE.md', 'docs/security.md', 'tests/public-repo.test.mjs']) {
    assert.ok(names.has(f), `${f} not scanned`);
  }
  assert.ok(FILES.some((f) => f.file.startsWith('tests/fixtures/')), 'fixtures not scanned');
});

test('no text file carries a NUL byte: one would leave it out of every rule of this file', () => {
  // FILES drops what holds a NUL (it is how a binary without a listed extension is told apart),
  // and lib/journal.mjs once went unscanned for a raw NUL inside a string literal.
  const withNul = repoFiles().filter((f) => !BINARY.test(f) && fs.readFileSync(path.join(ROOT, f)).includes(0));
  assert.deepEqual(withNul, [], 'write the character as an escape (\\u0000), never as the raw byte');
});

// Letters English does not use, built from code points so that this file does not match itself.
// A test that needs non-ASCII input uses the loanword "cafe" with its acute e, or another script
// (a Cyrillic letter) -- never a sentence in another language.
const chars = (...cps) => String.fromCodePoint(...cps);
const FOREIGN = `[${chars(
  0xe3, 0xf5, 0xe7, 0xc3, 0xd5, 0xc7, 0xe1, 0xe9, 0xed, 0xf3, 0xfa, 0xe2, 0xea, 0xf4, 0xe0,
  0xc1, 0xc9, 0xcd, 0xd3, 0xda, 0xc2, 0xca, 0xd4, 0xc0, 0xe4, 0xf6, 0xfc, 0xc4, 0xd6, 0xdc, 0xdf
)}]`;
const FOREIGN_WORD = new RegExp(`\\S*${FOREIGN}\\S*`, 'g');
const HAS_FOREIGN = new RegExp(FOREIGN);
const LOANWORD = new RegExp(`Caf${chars(0xe9)}(?![A-Za-z${chars(0xc0)}-${chars(0xff)}])`, 'g');
// Portuguese written without accents: words with no English homograph.
const PORTUGUESE_ASCII =
  /\b(?:nao|voce|tambem|entao|porque|nenhum|nenhuma|objetivo|ainda|falta|busca|achados|aqui|pesquisa|ajuda|medido|vazio|exibir|criar|relatorios|pedido|cliente|verificar|carregando|removido|sumido|itens|nicht|vorhanden|contabilidade|dados|mestre|partidas|estoque|viajante|administrador|recurso|conteudo)\b/gi;

test('English only: no Portuguese or German text is stored in the repository', () => {
  assert.deepEqual(
    offenders(FOREIGN_WORD, (w) => !HAS_FOREIGN.test(w.replace(LOANWORD, ''))),
    [],
    'translate it: the repository is English-only (a reply captured in another logon language ' +
      'is translated before it becomes a fixture)'
  );
  // This file spells the list out; it is the rule, not an instance of it.
  assert.deepEqual(offenders(PORTUGUESE_ASCII, (w, f) => f === 'tests/public-repo.test.mjs'), []);
});

test('no control character is stored: an escape a shell ate is a broken regex, not text', () => {
  // A `\b` that passed through an inline shell script once reached a parser as a backspace
  // (U+0008): the code still parsed, and the regex matched nothing. Tab, CR and LF are text.
  assert.deepEqual(
    offenders(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g).map((o) => o.replace(/[\u0000-\u001F\u007F]/g, (c) => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`)),
    []
  );
});

test('no transport number of a real system is stored -- only DEVK900nnn placeholders', () => {
  assert.deepEqual(offenders(/\b[A-Z][A-Z0-9]{2}K\d{6}\b/g, (t) => /^DEVK900\d{3}$/.test(t)), []);
});

test('no host of a landscape, private address, e-mail or user path is stored', () => {
  const PUBLIC_WITH_PORT =
    /^https?:\/\/(?:[a-z0-9.-]+\.example(?:\.com|\.org)?:|127\.0\.0\.1:|localhost:|<host>:|\$\{)/;
  assert.deepEqual(offenders(/https?:\/\/[^\s/'"`)<>]+:\d+/g, (u) => PUBLIC_WITH_PORT.test(u)), []);
  assert.deepEqual(
    offenders(/(?<![\d.])(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/g),
    []
  );
  assert.deepEqual(
    offenders(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|io|de|br|pt|eu|co|corp|local)\b/g,
      (m) => /@(?:anthropic\.com|example\.(?:com|org))$/.test(m)
    ),
    []
  );
  assert.deepEqual(
    offenders(/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s'"]+/g, (p) => /Users[\\/]+(?:x|<user>)$/.test(p)),
    []
  );
});

/**
 * Every word that starts with Z or Y, in every file, is one of:
 *   - a demo name (it says DEMO, in any case) -- the convention for anything shaped like a real object;
 *   - a short placeholder (`ZC_X`, `ZI_A`, `ZNOPE`, `ZTEST`: at most 12 characters);
 *   - one of the few names below, each with its reason.
 * Anything else is presumed to be an object of somebody's landscape: rename it to a demo name.
 */
const Z_ALLOWED = new Map([
  ...['YES', 'YYYY', 'YYYYMMDD', 'Yield', 'You', 'ZERO', 'Zero'].map((w) => [w, 'an English word or a format']),
  ...['ZTERM', 'ZTAGG', 'ZAEHK'].map((w) => [w, 'an SAP-standard field (T052, T683S)']),
  ...['ZA_ProductParameters', 'ZA_ProductSet', 'ZA_ProductType', 'ZBADI_IMPL', 'ZC_OrderItem', 'ZC_Region_VH',
    'ZCL_NOT_CDS', 'ZE_ProductExt', 'ZE_SOME_EXTENSION', 'ZENH_SD_ORDER_CHECK', 'ZI_MaterialGroup1VH',
    'ZI_SalesChannelVH', 'ZSD_TEST_SUB', 'ZTBL_OTHER', 'ZTBL_STOCK', 'ZZZ_NOPE_17', 'ZMY_CLEAN_CORE',
    'ZMY_DEV_PRACTICE', 'ZI_Whatever', 'ZC_NotHere', 'ZSAP_TC_X', 'ZDE_UNKNOWN', 'ZOTHER_SERVICE',
  ].map((w) => [w.toUpperCase(), 'a synthetic placeholder a test or an example needs']),
]);

test('every Z/Y word is a demo name, a short placeholder or a listed exception', () => {
  // Lower-case words are checked only when shaped like an object name (an underscore or a digit),
  // so `zero`, `yields` and `your` stay plain English.
  const re = /(?<![A-Za-z0-9_$.\/-])(?:[ZY][A-Za-z0-9_]{2,}|[zy][a-z0-9]*[_0-9][a-z0-9_]*)(?![A-Za-z0-9_])/g;
  assert.deepEqual(
    offenders(re, (w) =>
      /demo/i.test(w) || w.length <= 12 || Z_ALLOWED.has(w) || Z_ALLOWED.has(w.toUpperCase())
    ),
    [],
    'a Z/Y name that is neither DEMO nor a short placeholder may be a real object: rename it'
  );
});

test('no path into a private sibling repository is stored', () => {
  // The server is self-contained (docs/security.md): a citation of another checkout is a pointer
  // the public reader cannot follow, and it describes the author's machine.
  assert.deepEqual(offenders(/\bsibling-(?:a|b)\b|\b[a-z-]+\/doc\/[a-z-]+\.md\b/g), []);
});

test('CLAUDE.md stays a short rulebook: no history, no dates, no counts', () => {
  const claude = FILES.find((f) => f.file === 'CLAUDE.md');
  assert.ok(claude, 'CLAUDE.md is missing');
  const lines = claude.text.split('\n').length;
  assert.ok(lines <= 150, `CLAUDE.md has ${lines} lines; the cap is 150 -- cut, do not raise the cap`);
  const only = [claude];
  assert.deepEqual(offenders(/\b\d{4}-\d{2}-\d{2}\b/g, undefined, only), [], 'a date is history: git keeps it');
  assert.deepEqual(
    offenders(/^#+ .*\b(?:changelog|change log|history|release notes|what'?s new|log)\b.*$/gim, undefined, only),
    [],
    'CLAUDE.md is not a log'
  );
  assert.deepEqual(
    offenders(/\b\d+ (?:tools|tests|routes|members|codes|lines of)\b/gi, undefined, only),
    [],
    'a count goes stale on the next change: say where to find it instead'
  );
});
