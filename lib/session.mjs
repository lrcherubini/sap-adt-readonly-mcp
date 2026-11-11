// Session handling. Two rules matter more than the rest:
//
// 1. ONE login attempt per process start. A wrong password is a failed SAP logon and
//    repeated failures lock the user -- which takes the IDE, abapGit and transports
//    down with it, not just this server. On 401 we mark the credential bad and refuse
//    to try again until the operator restarts.
// 2. Stateless session only. A stateful ADT session is what holds locks and enqueues.

import readline from 'node:readline';
import { readOnly } from './guard.mjs';
import { recordLogonRefused, recordRelogon } from './audit.mjs';
import { createAdtHttp } from './adt-http.mjs';
import { libraryOver } from './library-bridge.mjs';
import { mixedApi, ownReads } from './adt-reads.mjs';
import { refusedSinceLastStart } from './audit-runs.mjs';
import { confirmSystem } from './system-check.mjs';

/** Prompt without echoing. Returns '' if stdin is not a TTY (no silent fallback to env). */
function askSecret(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'No TTY: this server must be started by a human in a terminal, because the ' +
        'password is typed per session and never stored.'
      ));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onKeypress = () => { /* muted below */ };
    process.stdout.write(promptText);
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl._writeToOutput = function (s) {
      // Echo only the prompt itself, never the typed characters.
      if (s.includes(promptText)) process.stdout.write(promptText);
    };
    rl.on('SIGINT', () => { rl.close(); reject(new Error('Aborted.')); });
    void onKeypress;
  });
}

export async function connect(cfg, { confirm = confirmSystem } = {}) {
  // Before anything is typed: is this the system the configuration means? (lib/system-check.mjs)
  console.log((await confirm(cfg)).message);
  const user = cfg.user ?? await new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('SAP user: ', (a) => { rl.close(); res(a.trim()); });
  });
  // Before the one attempt: what earlier processes ran into. The rule above holds per process,
  // and only the trail sees across them (docs/security.md, "The trail also records a refused logon").
  const prior = refusedSinceLastStart({ host: cfg.host, client: cfg.client, user });
  if (prior.count) {
    console.log(
      `WARNING: ${prior.count} refused logon(s) of ${user} on record since ` +
        `${prior.since ? `its last successful start (${prior.since})` : 'the trail began'}. ` +
        'SAP locks the user after the number set in login/fails_to_user_lock. Check the password ' +
        'in the IDE before typing it here.'
    );
  }
  // Say out loud that the input is blind. A prompt that echoes nothing looks exactly
  // like a hung process, and the reflex -- pressing Enter a few times to see if it is
  // alive -- sends empty passwords, which are failed SAP logons.
  console.log(`SAP logon: type the password and press Enter.`);
  console.log(`Nothing is echoed while you type -- no asterisks, no cursor movement. That is expected.`);
  const password = await askSecret(`Password for ${user}@${cfg.host}:${cfg.port} client ${cfg.client} (never stored): `);
  if (!password) throw new Error('Empty password: refusing to send it. An empty password still counts as a failed logon.');

  // The own client (lib/adt-http.mjs): the password stays in its closure. A session that
  // expires later logs on again once with it, and the trail records that; a refusal then is a
  // refused logon like any other.
  const http = createAdtHttp(cfg, {
    user,
    password,
    onRelogon: ({ status }) => recordRelogon(cfg, { status, user }),
    onRelogonRefused: ({ status }) => recordLogonRefused(cfg, { status, user }),
  });

  await logonWith(cfg, http, user);
  // The guard's members still come from abap-adt-api, riding on the own client: one logon, one
  // session (lib/library-bridge.mjs, removed with the library).
  const library = libraryOver(http, { user, client: cfg.client, language: cfg.language });
  return { raw: http, api: readOnly(mixedApi(library, ownReads(http))), user };
}

/**
 * `connect`, for a process that cannot go on without it: the server and the scripts that log on.
 *
 * A failed logon prints its message and exits 1. The messages are written to be read by a
 * person -- the 401 one says why nothing is retried -- and a stack trace on top of it, which is
 * what a script used to print, buries that sentence under lines that help nobody.
 */
export async function connectOrExit(cfg, { connectWith = connect, log = (m) => console.error(m), exit = (code) => process.exit(code) } = {}) {
  try {
    return await connectWith(cfg);
  } catch (e) {
    log(`\n${e?.message ?? e}`);
    return exit(1);
  }
}

/**
 * The one logon attempt, separate from the prompt so it can be tested without a TTY.
 *
 * A refusal the system ANSWERED (an HTTP status) is written to the audit trail before the
 * error leaves, so the next process -- the server restarted, or a script -- can see it
 * (lib/audit.mjs, recordLogonRefused). A failure with no status never reached the logon
 * (DNS, TLS, a refused socket) and is not a failed logon, so it writes nothing.
 */
export async function logonWith(cfg, client, user) {
  try {
    await client.login();
  } catch (e) {
    const status = [e?.err, e?.status, e?.response?.status].find((s) => Number.isInteger(s) && s >= 100);
    if (Number.isInteger(status)) recordLogonRefused(cfg, { status, user });
    if (status === 401) {
      throw new Error(
        'SAP rejected the credentials (401). NOT retrying: repeated failures lock the ' +
        'SAP user and take the IDE, abapGit and transports with it. Check the password ' +
        'in the IDE first, then start this server again.'
      );
    }
    throw e;
  }
}

/**
 * Drop the ADT session, and SAY WHETHER IT WORKED, within a deadline.
 *
 * Two changes from best-effort-and-silence, both learned from the terminal that would not
 * come back: a `dropSession()` against a host that stopped answering never settles, so
 * without a deadline the whole shutdown waits for a network that is gone, `Ctrl+C` looks
 * like a hang, and the way out becomes closing the window -- which leaks the session it
 * was trying to drop. And a caller that cannot tell success from failure cannot say
 * anything true to the operator.
 *
 * What is left behind when it times out is an IDLE STATELESS SESSION, which SAP expires on
 * its own. No lock, no enqueue: lib/session.mjs only ever asks for session_types.stateless.
 * That is what makes the deadline safe, and why the server prints exactly that instead of
 * implying an incident.
 *
 * @returns {Promise<boolean>} true when both calls returned before the deadline.
 */
export async function disconnect(session, { timeoutMs = 5000 } = {}) {
  let timer;
  // NOT unref'ed. An unref'ed deadline does not fire when nothing else is pending, and the
  // caller then exits at whatever moment the event loop empties -- skipping the stop line
  // and the exit code it was about to set. It is cleared in the `finally` below, so a
  // logout that answers never leaves it holding anything open.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const goodbye = (async () => {
    // Each call is still best effort -- an already-dropped session throws, and the throw
    // carries nothing to act on -- but the PAIR now reports.
    let ok = true;
    try {
      await session.raw.dropSession();
    } catch {
      ok = false;
    }
    try {
      await session.raw.logout();
    } catch {
      ok = false;
    }
    return ok;
  })();
  try {
    return await Promise.race([goodbye, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
