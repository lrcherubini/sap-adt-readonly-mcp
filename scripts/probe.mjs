#!/usr/bin/env node
// Phase 0 probe: proves whether the ADT REST endpoint is reachable and which
// authentication scheme the ICM offers -- WITHOUT ever sending credentials.
//
// Why credential-less: a wrong password against SAP counts as a failed logon and
// repeated failures lock the user (an API test collection sending an empty password is
// the classic way to lose one). An unauthenticated GET returns 401 + WWW-Authenticate and
// costs nothing.
//
// Usage:  node scripts/probe.mjs [--host H] [--port P] [--client <nnn>] [--strict-tls]
// Without --host it uses the host, port and client of the environment store (npm run config).

import https from 'node:https';
import { readEnvironment } from '../lib/environment.mjs';

const DEFAULT_PORTS = [44300, 8000];

function parseArgs(argv) {
  const out = { insecure: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--insecure') out.insecure = true;
    else if (a === '--strict-tls') out.insecure = false;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function head(host, port, client, insecure) {
  const query = client ? `?sap-client=${encodeURIComponent(client)}` : '';
  return new Promise((resolve) => {
    const req = https.request(
      {
        host,
        port,
        path: `/sap/bc/adt/discovery${query}`,
        method: 'GET',
        rejectUnauthorized: !insecure,
        timeout: 8000,
        // No Authorization header. Ever. That is the whole point of this probe.
      },
      (res) => {
        res.resume(); // drain, we only care about status + headers
        resolve({ status: res.statusCode, headers: res.headers });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

const args = parseArgs(process.argv.slice(2));
let stored = {};
try {
  stored = readEnvironment().settings;
} catch (e) {
  // A broken store must not stop a probe that was given --host: it only loses the defaults.
  if (!args.host) console.error(`environment store not usable (${e?.message ?? e}); pass --host.`);
}
const host = args.host ?? stored.host;
const client = args.client ?? stored.client;
if (!args.port && stored.port) args.port = String(stored.port);

if (!host) {
  console.error('No host. Pass --host, or set it once: npm run config -- set host <host>.');
  process.exit(2);
}

console.log(`ADT probe -- host ${host}, client ${client ?? '(default)'}, tls ${args.insecure ? 'insecure' : 'strict'}`);

const ports = args.port ? [Number(args.port)] : DEFAULT_PORTS;
let verdict = null;

for (const port of ports) {
  const r = await head(host, port, client, args.insecure);
  if (r.error) {
    console.log(`  port ${port}: unreachable (${r.error})`);
    continue;
  }
  const auth = r.headers['www-authenticate'] ?? '(none)';
  console.log(`  port ${port}: HTTP ${r.status} | sap-system=${r.headers['sap-system'] ?? '?'} | www-authenticate=${auth}`);
  const isSsoRedirect = r.status >= 300 && r.status < 400;
  if (r.status === 401 && /basic/i.test(auth)) {
    verdict = { port, mode: 'basic' };
  } else if (isSsoRedirect || (r.status === 200 && /html/.test(r.headers['content-type'] ?? ''))) {
    verdict = { port, mode: 'sso' };
  }
}

if (!verdict) {
  console.log('\nVERDICT: no ADT HTTP endpoint answered. The plan\'s HTTP design does not apply as-is.');
  process.exit(1);
}
console.log(`\nVERDICT: ADT REST reachable on port ${verdict.port}, auth mode = ${verdict.mode}.`);
if (verdict.mode !== 'basic') {
  console.log('Basic auth is NOT offered -- see docs/phase0-report.md for the SSO fallbacks.');
  process.exit(1);
}
