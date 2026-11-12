// The two example environments -- config.example.json for a developer, the ConfigMap of
// deploy/kubernetes.example.yaml for a hosted server -- declare every setting, validate, and
// carry the same tables and variants. They drifted once: each grew the keys of its own case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, fromFileFormat, validateEnvironment } from '../lib/environment.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const example = JSON.parse(read('config.example.json'));
const configMap = (() => {
  const yaml = read('deploy/kubernetes.example.yaml').replace(/\r\n/g, '\n');
  const m = /\n {2}config\.json: \|\n((?: {4}.*\n|\n)+)/.exec(yaml);
  assert.ok(m, 'the ConfigMap holds config.json');
  return JSON.parse(m[1].split('\n').map((l) => l.slice(4)).join('\n'));
})();

/** The settings a file names: nested blocks are dotted keys; `$key` is a key explained, not set. */
const declared = (doc) => {
  const keys = new Set(Object.keys(fromFileFormat(doc).settings));
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('$') && SETTINGS[k.slice(1)]) keys.add(k.slice(1));
    // A block may explain one of its keys the same way: { "atc": { "$defaultVariant": "..." } }.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sk of Object.keys(v)) if (sk.startsWith('$') && SETTINGS[`${k}.${sk.slice(1)}`]) keys.add(`${k}.${sk.slice(1)}`);
    }
  }
  return keys;
};

for (const [name, doc] of [['config.example.json', example], ['the Kubernetes ConfigMap', configMap]]) {
  test(`${name} declares every setting and is a valid environment`, () => {
    const missing = Object.keys(SETTINGS).filter((k) => !declared(doc).has(k));
    assert.deepEqual(missing, [], 'a setting added to lib/environment.mjs is shown in both examples');
    assert.doesNotThrow(() => validateEnvironment(fromFileFormat(doc)));
  });
}

test('the two examples carry the same tables and variants, and the tables show every option', () => {
  assert.deepEqual(configMap.customizingTables, example.customizingTables);
  assert.deepEqual(configMap.atcVariants, example.atcVariants);
  const options = new Set(example.customizingTables.flatMap((t) => Object.keys(t)));
  for (const option of ['name', 'why', 'keyColumns', 'routineColumns', 'fields', 'filterOnly']) {
    assert.ok(options.has(option), `an example table shows ${option}`);
  }
});

test('the hosted example is a hosted configuration, the developer one is not', () => {
  assert.equal(configMap.bindHost, '0.0.0.0');
  assert.ok(configMap.publicHosts.length && configMap.passwordFile);
  assert.ok(configMap.limits.callsPerMinute > 0, 'a hosted server limits each caller');
  assert.equal(example.bindHost, '127.0.0.1');
  assert.equal(example.passwordFile, undefined, 'a developer types the password');
});
