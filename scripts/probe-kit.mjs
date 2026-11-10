// The skeleton every temporary probe imports, so no probe re-invents the logon, the output
// folder or the transcript.
//
// A probe measures a route BEFORE it is built (docs/security.md, "Probes"). It lives in
// scripts/probes/, which is git-ignored, and imports this file:
//
//   import { args, probe } from '../probe-kit.mjs';
//   await probe('my-measurement', async (kit) => {
//     await kit.get('discovery', '/sap/bc/adt/discovery', 'application/atomsvc+xml');
//   });
//
// THE FENCE. This file is versioned, so it must not be a door the route table does not know
// about. kit.get sends GET only, to a relative path under /sap/bc/adt/, with no body and no
// header but Accept. assertProbeUrl refuses everything else before a socket opens. There is no
// kit.post: a POST is rare, each one needs a dated decision in docs/security.md, and its
// measurement is written by hand inside the ignored probe. tests/probe-kit.test.mjs holds the
// fence, and asserts that nothing the server loads imports this file.
//
// Logon goes through connectOrExit (lib/session.mjs): one attempt, a refusal recorded in the
// audit trail, the warning about earlier refusals before the password prompt. Every reply is
// saved whole into a new folder, <stateDir>/measurements/<name>-<UTC stamp>/, with summary.json.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, newMeasurementDir } from '../lib/config.mjs';
import { connectOrExit, disconnect } from '../lib/session.mjs';

const PROBE_PREFIX = '/sap/bc/adt/';

/** The fence: a relative ADT path, nothing that can climb out of it or smuggle a header. */
export function assertProbeUrl(url) {
  const s = String(url ?? '');
  const reasons = [];
  if (!s.startsWith(PROBE_PREFIX)) reasons.push(`does not start with ${PROBE_PREFIX}`);
  const pathPart = s.split('?')[0];
  if (/(^|\/)\.\.?(\/|$)/.test(pathPart) || /%2e%2e/i.test(pathPart)) reasons.push('climbs');
  if (s.includes('\\')) reasons.push('has a backslash');
  if (/[\u0000-\u001f\u007f\s]/.test(s)) reasons.push('has a control or blank character');
  if (reasons.length) {
    throw new Error(`probe-kit refuses '${s.slice(0, 120)}': ${reasons.join(', ')}`);
  }
  return s;
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else {
        out[a.slice(2)] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const fileFor = (n, label) =>
  `${String(n).padStart(2, '0')}-${String(label).replace(/[^a-z0-9.]+/gi, '_').slice(0, 80)}.txt`;

/**
 * Log on, run `body(kit)`, write summary.json, log off. `deps` are test seams; a probe passes
 * none.
 */
export async function probe(name, body, deps = {}) {
  const {
    config = loadConfig,
    connectWith = (cfg) => connectOrExit(cfg),
    logoff = disconnect,
    root,
    log = (m) => console.log(m),
  } = deps;
  // A new timestamped folder per run: a second run never overwrites the first.
  const out = newMeasurementDir(name, root ? { root } : {});
  const session = await connectWith(config());
  const http = session.raw.httpClient;
  const summary = [];
  let n = 0;

  async function get(label, url, accept = '*/*') {
    assertProbeUrl(url);
    n++;
    const row = { n, method: 'GET', label, url, accept };
    const file = fileFor(n, label);
    try {
      const res = await http.request(url, { method: 'GET', headers: { Accept: String(accept) } });
      const text = String(res?.body ?? '');
      Object.assign(row, {
        status: res?.status,
        contentType: res?.headers?.['content-type'] ?? null,
        bytes: text.length,
        file,
      });
      fs.writeFileSync(path.join(out, file), text);
      summary.push(row);
      return text;
    } catch (e) {
      // Not swallowed: the status and the message go into the summary row, and the body the
      // server sent with the error is saved like any other reply. A probe measures refusals too.
      const text = e?.response?.body ?? e?.body;
      Object.assign(row, {
        status: e?.err ?? e?.status ?? e?.response?.status ?? '?',
        error: String(e?.message ?? e).slice(0, 300),
      });
      if (text) {
        row.file = file;
        fs.writeFileSync(path.join(out, file), String(text));
      }
      summary.push(row);
      return null;
    }
  }

  const kit = Object.freeze({
    out,
    get,
    save: (file, data) =>
      fs.writeFileSync(
        path.join(out, path.basename(String(file))),
        typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      ),
    skip: (what) => {
      log(`skipped: no ${what}`);
      summary.push({ label: `skipped: no ${what}` });
    },
  });

  try {
    await body(kit);
  } finally {
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    await logoff(session);
  }
  log(`\n${summary.length} row(s):`);
  for (const r of summary) {
    log(
      `  ${String(r.status ?? '-').padEnd(4)} ${(r.method ?? '').padEnd(4)} ` +
        `${r.label.slice(0, 60).padEnd(60)} ${r.bytes ?? ''} ${r.contentType ?? r.error ?? ''}`,
    );
  }
  log(`\ntranscripts: ${out}\nAnonymise before anything leaves this machine (names, host, user).`);
  return { out, summary };
}

/** Collections in the discovery document whose title or href matches `re`. */
export function collections(discovery, re) {
  const rx = /<app:collection\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/app:collection>/g;
  return [...String(discovery ?? '').matchAll(rx)]
    .map(([, href, inner]) => ({
      href,
      title: (inner.match(/<atom:title>([^<]*)</) ?? [])[1] ?? '',
      accept: [...inner.matchAll(/<app:accept>([^<]*)</g)].map((m) => m[1]),
      templates: [...inner.matchAll(/<adtcomp:templateLink\b([^>]*)\/?>/g)].map(([, a]) => ({
        rel: (a.match(/\brel="([^"]*)"/) ?? [])[1] ?? null,
        template: (a.match(/\btemplate="([^"]*)"/) ?? [])[1] ?? null,
        type: (a.match(/\btype="([^"]*)"/) ?? [])[1] ?? null,
      })),
    }))
    .filter((c) => re.test(c.href) || re.test(c.title));
}
