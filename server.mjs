#!/usr/bin/env node
// sap-adt: read-only MCP server over the SAP ADT REST API.
//
// Transport is HTTP on the loopback interface, not stdio, for one reason: the SAP
// password is typed once per session and never stored, and a stdio server owns stdin
// as its protocol channel, so it cannot prompt. This mirrors how SAP's own ADT MCP
// servers work (localhost:2234 / :2236) -- and this one deliberately never touches
// their ports or their tokens.
//
// Start it in a terminal:  npm run adt

import http from 'node:http';
import path from 'node:path';
import { loadConfig, loopbackToken, stateDir } from './lib/config.mjs';
import { connect, disconnect } from './lib/session.mjs';
import { recordStart, recordStop, readsSoFar } from './lib/audit.mjs';
import { buildTools } from './tools/index.mjs';
import { allowedMethods } from './lib/guard.mjs';
import { createRequestHandler } from './lib/mcp-server.mjs';
import { catalogStatus } from './lib/catalog.mjs';

const cfg = loadConfig();
const token = loopbackToken();

const endpoint = `http://127.0.0.1:${cfg.mcpPort}/mcp`;
const tokenFile = path.join(stateDir(), 'token');

console.log(`sap-adt (read-only)   ->  ${cfg.baseUrl} client ${cfg.client}`);
console.log(`state directory       ->  ${stateDir()}`);
console.log(`reachable ADT methods ->  ${allowedMethods().length} (allowlist; everything else throws)`);
console.log(`MCP endpoint          ->  ${endpoint}   (starts listening after logon)`);
const catalog = catalogStatus(cfg.paths.catalog, { release: cfg.catalogRelease });
console.log(
  `Clean Core catalogue  ->  ${catalog.installed ? `${catalog.release}, ${catalog.ageDays ?? '?'} day(s) old${(catalog.ageDays ?? 0) > 35 ? ' -- refresh: npm run sync:catalog' : ''}` : `NOT INSTALLED (${catalog.reason}) -- value help and Clean Core scans will refuse`}`
);

// Printed BEFORE the password prompt on purpose: the registration command does not
// depend on the SAP logon, and needing it is the likeliest reason to be reading this
// banner. The token is substituted by the shell, so it never lands in scrollback or
// in a pasted transcript.
console.log('\nRegister once in Claude Code, in ANOTHER terminal (leave this one running):');
console.log('  PowerShell:');
console.log(
  `    claude mcp add --scope user --transport http sap-adt ${endpoint} ` +
    `--header \"Authorization: Bearer $(Get-Content '${tokenFile}')\"`
);
console.log('  bash:');
console.log(
  `    claude mcp add --scope user --transport http sap-adt ${endpoint} ` +
    `--header \"Authorization: Bearer $(cat '${tokenFile.split(path.sep).join('/')}')\"`
);
console.log('  Then check:  claude mcp list\n');

/**
 * Is the port already taken -- ASKED BEFORE THE PASSWORD PROMPT.
 *
 * The old order typed the password, opened a SAP session, and only then called `listen`,
 * which had no error handler: EADDRINUSE crashed the process and the logon it had just
 * made stayed open at the system. With the server restarted as often as it is, starting a
 * second instance over a live one is the ordinary case, not the exotic one. Asking first
 * costs one bind and makes the common failure cost nothing at all.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', (e) => resolve(e?.code === 'EADDRINUSE'));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

if (await portInUse(cfg.mcpPort)) {
  console.error(
    `\nPort ${cfg.mcpPort} is already in use on 127.0.0.1 -- another sap-adt is probably ` +
      `still running.\nStop that one first (Ctrl+C in its terminal). Nothing was asked and ` +
      `no SAP session was opened.`
  );
  process.exit(1);
}

let session;
try {
  session = await connect(cfg);
} catch (e) {
  // The message is written to be read by a person -- the 401 one especially, since it says
  // why this server refuses to try again. A stack on top of it helps nobody.
  console.error(`\n${e?.message ?? e}`);
  process.exit(1);
}
console.log(`logged on as ${session.user}; session is stateless, so no lock can be taken.`);
recordStart(cfg, {});

const tools = buildTools(cfg, session);

let inFlight = 0;

// Path, then Host/Origin (DNS-rebinding protection), then the bearer token, then MCP
// (lib/mcp-server.mjs). Counted so a shutdown can wait for the answers already in flight.
const httpServer = http.createServer(
  createRequestHandler({
    tools,
    token,
    port: () => cfg.mcpPort,
    log: (m) => console.error(m),
    onOpen: () => inFlight++,
    onClose: () => inFlight--,
  })
);

// Loopback only. This port must never be reachable from the network.
httpServer.listen(cfg.mcpPort, '127.0.0.1', () => {
  console.log(`
Listening on ${endpoint} -- ${tools.length} read-only adt_* tools are available now.`);
  console.log('Ctrl+C to stop (the ADT session is dropped on exit).');
});

/**
 * Stop once, in order, and always within a deadline.
 *
 * The order is the point. Closing the listener first means no new request can arrive to
 * use an ADT session that is about to be dropped; draining means the answers already in
 * flight finish; only then is the system told goodbye; and only then are the sockets that are
 * still open cut, because `httpServer.close()` alone waits for keep-alive connections that
 * an MCP client has no reason to release -- which is how Ctrl+C came to look like a hang.
 * A hard timer sits over the whole thing, so a step that never settles cannot keep the
 * process alive. It is cleared on the normal path, so it never delays a stop that worked.
 *
 * Re-entrant by design: the second Ctrl+C -- the reflex, when the first appears to do
 * nothing -- must not start a second logout against a session already being dropped.
 */
let stopping = false;
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`\nstopping (${reason}): refusing new requests...`);

  const hard = setTimeout(() => {
    console.error('[sap-adt] shutdown deadline passed; exiting anyway.');
    try {
      recordStop(cfg, { reason, clean: false, note: 'deadline' });
    } catch (e) {
      // The trail is on a disk that is not answering either; exiting still has to happen,
      // and the reason goes to stderr because the place it would normally go is the one
      // that just failed.
      process.stderr.write(`[sap-adt] could not write the stop line: ${e?.message ?? e}\n`);
    }
    process.exit(code || 1);
  }, (cfg.shutdownMs ?? 5000) * 2);

  httpServer.close();
  httpServer.closeIdleConnections?.();

  // A short drain, not a promise to wait: an answer mid-read gets a moment to land, and a
  // client holding a connection open for nothing does not get to delay the exit.
  const drainUntil = Date.now() + 2000;
  while (inFlight > 0 && Date.now() < drainUntil) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (inFlight > 0) console.log(`  ${inFlight} request(s) still in flight; not waiting further.`);

  console.log('  dropping the ADT session...');
  const clean = await disconnect(session, { timeoutMs: cfg.shutdownMs ?? 5000 });
  if (!clean) {
    // Said plainly, because the reflex on reading "logout failed" is to go looking for a
    // lock. There is none: the session is stateless, so what stays behind is an idle
    // session the system expires by itself.
    console.warn(
      '  the SAP logout did not answer in time. The session stays open until the SAP system times ' +
        'it out -- it is stateless, so NO LOCK is held and nothing needs unlocking.'
    );
  }
  httpServer.closeAllConnections?.();
  try {
    recordStop(cfg, { reason, clean });
  } catch (e) {
    process.stderr.write(`[sap-adt] could not write the stop line: ${e?.message ?? e}\n`);
  }
  clearTimeout(hard);
  console.log(`stopped after ${readsSoFar()} read(s).`);
  process.exit(code);
}

// SIGHUP is the console window being closed on Windows and the terminal going away on a
// remote shell; SIGBREAK is Ctrl+Break. Both used to kill the process outright, leaving
// the SAP logon open and no record that the server had ever stopped.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// An unhandled throw used to end the process the same way: logon still open at the system,
// nothing in the trail. The error is printed in full -- it is the reason for the stop --
// and the exit code says the stop was not a clean one.
process.on('uncaughtException', (e) => {
  console.error(`[sap-adt] uncaught exception: ${e?.stack ?? e}`);
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (e) => {
  console.error(`[sap-adt] unhandled rejection: ${e?.stack ?? e}`);
  void shutdown('unhandledRejection', 1);
});

// The probe before the logon closes the race window, it does not remove it. Without this
// handler a bind that fails after the logon leaves the SAP session open -- the exact leak
// the probe exists to prevent.
httpServer.on('error', (e) => {
  console.error(`[sap-adt] the listener failed: ${e?.message ?? e}`);
  void shutdown('listen-failed', 1);
});
