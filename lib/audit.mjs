// Audit trail: which tool touched which object, and how much came back.
// Never the payload -- source code and business text stay out of the log by design.
//
// Two kinds of line, and the difference is deliberate:
//
//   a CALL line    one per ADT read, naming the tool and the
//                  target object. This is the trail docs/security.md promises.
//   a RUN line     `event: 'start' | 'stop'`, one pair per process -- or `'logon-refused'`,
//                  the one line of a process the system turned away, or `'relogon'`, a session
//                  that expired and was logged on again once. That the server ran,
//                  and how it stopped, is EVIDENCE -- what it read is what would be
//                  content, and none of that is here. Before these existed, a restart had
//                  to be inferred from the read counter falling back to 1, and the
//                  inference is wrong whenever two processes append to the same file.
//
// Every line carries `run`, the same id the journal writes, so the two artefacts can be
// joined. That is the only thing the id says: same process. Not who, not where.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stateDir } from './config.mjs';

let reads = 0;

export function budgetLeft(cfg) {
  return cfg.budget.reads - reads;
}

/** How many ADT reads this process has made. The audit trail's own counter. */
export function readsSoFar() {
  return reads;
}

/**
 * Test seam. `record` used to be hardwired to appendFileSync into stateDir(), and
 * stateDir() resolves %LOCALAPPDATA% at module load -- so a test that called a tool
 * handler wrote into the real state directory and spawned a `git rev-parse` per call.
 * A cfg carrying `auditSink` keeps the handlers testable offline without weakening the
 * default: no sink means the file, exactly as before.
 */
function write(cfg, line) {
  if (typeof cfg?.auditSink === 'function') {
    cfg.auditSink(line);
    return;
  }
  fs.appendFileSync(path.join(stateDir(), 'audit.log'), line + '\n');
}

/** Reset the session read counter. For tests only -- the server never calls this. */
export function resetBudget() {
  reads = 0;
}

export function record(cfg, tool, target, resultSize) {
  reads++;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    run: cfg?.run ?? null,
    tool,
    target,
    resultSize,
    reads,
    // Written on BOTH paths so that a missing field stops meaning two different things.
    // A reader of an old file could not tell "this predates adtCalls" from "this
    // read touched the system"; now the 0 and the 1 say it.
    adtCalls: 1,
  });
  write(cfg, line);
  // `>=`, not `===`. On the equality alone the notice was one line at one exact read, so
  // a counter reset or any path that advanced it by more than one swallowed it entirely.
  //
  // And it says what it is. `record` runs AFTER the read -- it takes the result size --
  // so this counter is a ledger, not a gate: it cannot refuse a call that already went
  // out. A real cap would have to sit before the route and would change what this server
  // promises, which is a docs/security.md decision and not a flag. Until then the word
  // "budget" describes a notice, and the notice says so rather than leaving the reader to
  // discover it by reading the source (measured, in the middle of a 21-table run).
  if (reads >= cfg.budget.reads && reads - 1 < cfg.budget.reads) {
    process.stderr.write(
      `[sap-adt] ${cfg.budget.reads} reads this session -- a NOTICE, not a limit: ` +
        'nothing is refused and no answer is shortened.\n'
    );
  }
}

/** Metadata only -- never an argument, never a target, never a result. */
const runLine = (cfg, event, meta) =>
  JSON.stringify({
    ts: new Date().toISOString(),
    run: cfg?.run ?? null,
    event,
    pid: process.pid,
    host: cfg?.host ?? null,
    client: cfg?.client ?? null,
    user: cfg?.user ?? null,
    machine: os.hostname(),
    ...meta,
  });

/** The server logged on and is about to serve. One line per process. */
export function recordStart(cfg, meta = {}) {
  write(cfg, runLine(cfg, 'start', meta));
}

/**
 * A logon the system answered with a refusal. One line, written before the process exits.
 *
 * Why the trail carries it (docs/security.md, "The trail also records a refused logon"): the
 * one-attempt rule of lib/session.mjs holds per process, and repeated failures lock the SAP user.
 * Only this file sees across processes. `status` is the HTTP status the system answered -- never
 * its message, never the password. `user` is passed because it may have been typed at the
 * prompt rather than configured.
 */
export function recordLogonRefused(cfg, { status, user } = {}) {
  write(cfg, runLine(cfg, 'logon-refused', {
    status: Number.isInteger(status) ? status : null,
    ...(user ? { user } : {}),
  }));
}

/**
 * A session that expired and was logged on again, once, with the password the system had
 * already accepted (lib/adt-http.mjs; docs/security.md, "The client of its own"). One line, so
 * a logon the operator did not type is never invisible.
 */
export function recordRelogon(cfg, { status, user } = {}) {
  write(cfg, runLine(cfg, 'relogon', {
    status: Number.isInteger(status) ? status : null,
    ...(user ? { user } : {}),
  }));
}

/**
 * The server stopped, and whether it managed to say goodbye to the system.
 *
 * `clean: false` is not an incident: the ADT session is stateless, so what stays behind
 * is an idle session that SAP times out, never a lock. It is recorded because "the
 * process ended" and "the process was killed mid-answer" are different facts, and until
 * now the trail could not tell them apart -- or notice a stop at all.
 */
export function recordStop(cfg, { reason, clean, ...meta } = {}) {
  write(cfg, runLine(cfg, 'stop', { reason: reason ?? null, clean: clean === true, reads, ...meta }));
}
