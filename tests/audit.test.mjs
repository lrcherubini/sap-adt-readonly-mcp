// The audit trail as an artefact with a shape, and the run lines that were missing from it.
//
// The promise this file is guarding is the one docs/security.md makes: the trail says WHAT
// was touched and HOW MUCH came back, never what it said. A run line is metadata about the
// process, and the test that matters is the negative one -- that nothing else got in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, recordStart, recordStop, recordLogonRefused, recordRelogon, resetBudget } from '../lib/audit.mjs';
import { httpError } from '../lib/adt-http.mjs';
import { logonWith, connectOrExit } from '../lib/session.mjs';
import { runsFromAudit, renderRuns, refusedSinceLastStart } from '../lib/audit-runs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A cfg whose sink is an array, so nothing touches %LOCALAPPDATA%. */
function sink(extra = {}) {
  const lines = [];
  return [
    {
      run: 'abc123',
      host: 'dev.example',
      client: '001',
      user: 'TESTER',
      budget: { reads: 200 },
      auditSink: (l) => lines.push(JSON.parse(l)),
      ...extra,
    },
    lines,
  ];
}

test('every line carries the run id, so the trail can be joined to the journal', () => {
  resetBudget();
  const [cfg, lines] = sink();
  recordStart(cfg);
  record(cfg, 'adt_read_source', 'ZCL_X', 1200);
  record(cfg, 'adt_clean_core_scan', 'DDLS/DF ZI_X', 40);
  recordStop(cfg, { reason: 'SIGINT', clean: true });
  assert.equal(lines.length, 4);
  assert.equal(
    lines.every((l) => l.run === 'abc123'),
    true,
    'a line with no run id cannot be attributed to a session -- which is the whole point'
  );
});

test('every read line says it touched the system', () => {
  resetBudget();
  const [cfg, lines] = sink();
  record(cfg, 'adt_read_source', 'ZCL_X', 10);
  assert.equal(lines[0].adtCalls, 1);
});

test('a run line is metadata, and carries nothing that could be content', () => {
  resetBudget();
  const [cfg, lines] = sink();
  recordStart(cfg);
  recordStop(cfg, { reason: 'SIGTERM', clean: false });
  const allowed = new Set([
    'ts', 'run', 'event', 'pid', 'host', 'client', 'user', 'machine', 'reason', 'clean', 'reads', 'note',
  ]);
  for (const line of lines) {
    const extra = Object.keys(line).filter((k) => !allowed.has(k));
    assert.deepEqual(extra, [], `a run line grew a field: ${extra.join(', ')}`);
  }
  assert.equal(lines[0].event, 'start');
  assert.equal(lines[1].event, 'stop');
  assert.equal(lines[1].clean, false);
});

test('clean is a fact, not a default: anything but true reads as not confirmed', () => {
  resetBudget();
  const [cfg, lines] = sink();
  recordStop(cfg, { reason: 'SIGINT' });
  // A logout whose result nobody reported must not be recorded as a logout that worked.
  assert.equal(lines[0].clean, false);
});

test('the notice fires once, and says it refuses nothing', () => {
  resetBudget();
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => (written.push(String(s)), true);
  try {
    const [cfg] = sink({ budget: { reads: 3 } });
    for (let i = 0; i < 6; i++) record(cfg, 'adt_read_source', `OBJ${i}`, 1);
  } finally {
    process.stderr.write = original;
  }
  const notices = written.filter((w) => w.includes('reads this session'));
  assert.equal(notices.length, 1, 'one notice per session, not one per read past the line');
  assert.match(notices[0], /NOTICE, not a limit/);
  assert.match(notices[0], /nothing is refused/);
});

// --- reading it back -------------------------------------------------------------------

const tempFile = (lines) => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-audit-')),
    'audit.log'
  );
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
};

test('a run is one row, with its reads counted and its ending named', () => {
  const file = tempFile([
    { ts: '2026-09-23T10:00:00.000Z', run: 'aaa', event: 'start', pid: 1, user: 'T' },
    { ts: '2026-09-23T10:00:01.000Z', run: 'aaa', tool: 'adt_read_source', target: 'X', reads: 1, adtCalls: 1 },
    { ts: '2026-09-23T10:00:02.000Z', run: 'aaa', tool: 'adt_read_source', target: 'Y', reads: 2, adtCalls: 1 },
    { ts: '2026-09-23T10:00:30.000Z', run: 'aaa', event: 'stop', reason: 'SIGINT', clean: true },
  ]);
  const out = runsFromAudit(file);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].reads, 2, 'the start and stop lines are not reads');
  assert.equal(out.runs[0].stop.clean, true);
  assert.equal(out.runs[0].stop.reason, 'SIGINT');
});

test('an offline answer is counted apart from a read of the system', () => {
  // Measured: an offline sweep appears in the trail (it was invoked) and cost the
  // system nothing. Counting it as a read made a run that never touched the system read as one
  // that did -- the conflation the quality block exists to avoid, repeated here.
  const file = tempFile([
    { ts: '2026-09-23T10:00:00.000Z', run: 'off', tool: 'adt_annotation_scan', target: 'all', reads: 0, adtCalls: 0 },
    { ts: '2026-09-23T10:00:01.000Z', run: 'off', tool: 'adt_read_source', target: 'X', reads: 1, adtCalls: 1 },
  ]);
  const [row] = runsFromAudit(file).runs;
  assert.equal(row.reads, 1);
  assert.equal(row.offline, 1);
});

test('a process that started and never stopped is NOT reported as a clean stop', () => {
  const file = tempFile([
    { ts: '2026-09-23T10:00:00.000Z', run: 'bbb', event: 'start', pid: 2 },
    { ts: '2026-09-23T10:00:01.000Z', run: 'bbb', tool: 'adt_search', target: 'Z*', reads: 1 },
  ]);
  const out = runsFromAudit(file);
  assert.equal(out.runs[0].stop, null);
  const md = renderRuns(out);
  assert.match(md, /no stop line/);
  // The pid is on the line, but pids are reused, so the row names the possibilities rather
  // than asserting one -- "still running" is the commonest of them and must not be excluded.
  assert.match(md, /still running/);
});

test('a run with no start line is a script, not a crash', () => {
  // Only the server writes the start/stop pair. A sweep script appears in the trail through
  // its calls alone, and reading the missing stop as "killed or crashed" would assert a
  // failure from the absence of a line the thing never writes.
  const file = tempFile([
    { ts: '2026-09-23T10:00:00.000Z', run: 'scr', tool: 'adt_clean_core_scan', target: 'all', reads: 0, adtCalls: 0 },
  ]);
  const out = runsFromAudit(file);
  const row = renderRuns(out)
    .split('\n')
    .find((l) => l.includes('`scr`'));
  assert.match(row, /a script run/);
  assert.equal(/killed or crashed/.test(row), false);
});

test('lines from before the run id are counted apart, never spread over the runs', () => {
  const file = tempFile([
    { ts: '2026-09-20T09:00:00.000Z', tool: 'adt_read_source', target: 'OLD', reads: 1 },
    { ts: '2026-09-20T09:00:01.000Z', tool: 'adt_read_source', target: 'OLD2', reads: 2 },
    { ts: '2026-09-23T10:00:00.000Z', run: 'ccc', event: 'start' },
  ]);
  const out = runsFromAudit(file);
  assert.equal(out.unattributed, 2);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].reads, 0, 'the two old reads must not be charged to this run');
  assert.equal(out.runs[0].offline, 0);
  assert.match(renderRuns(out), /cannot be attributed/);
});

test('an absent trail says so, and does not read as "nothing ran"', () => {
  const out = runsFromAudit(path.join(os.tmpdir(), 'sap-adt-nope', 'audit.log'));
  assert.equal(out.missing, true);
  assert.match(renderRuns(out), /not the same as nothing having run/);
});

test('a half-written line is skipped and counted, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-adt-audit-'));
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(
    file,
    JSON.stringify({ ts: '2026-09-23T10:00:00.000Z', run: 'ddd', event: 'start' }) + '\n{"ts":\n'
  );
  const out = runsFromAudit(file);
  assert.equal(out.unreadable, 1);
  assert.equal(out.runs.length, 1);
});

// --- a refused logon (docs/security.md, "The trail also records a refused logon") ---------

test('a refused logon is one run line: the status, never the message or the password', () => {
  resetBudget();
  const [cfg, lines] = sink({ user: null });
  recordLogonRefused(cfg, { status: 401, user: 'DEVUSER1' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'logon-refused');
  assert.equal(lines[0].status, 401);
  assert.equal(lines[0].user, 'DEVUSER1', 'the user typed at the prompt, not the configured one');
  const allowed = new Set(['ts', 'run', 'event', 'pid', 'host', 'client', 'user', 'machine', 'status']);
  assert.deepEqual(Object.keys(lines[0]).filter((k) => !allowed.has(k)), []);
});

test('logonWith records an answered refusal before the error leaves, and tries once', async () => {
  const [cfg, lines] = sink();
  let logins = 0;
  const refusing = { login: async () => { logins++; throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } }); } };
  await assert.rejects(() => logonWith(cfg, refusing, 'DEVUSER1'), /NOT retrying/);
  assert.equal(logins, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'logon-refused');
  assert.equal(lines[0].status, 401);
  assert.equal(JSON.stringify(lines[0]).includes('Unauthorized'), false, "the server's text stays out");
});

test('the own client refuses with the status in err, and logonWith still records it and stops', async () => {
  const [cfg, lines] = sink();
  const refusing = { login: async () => { throw httpError(401, '<html/>', { 'content-type': 'text/html' }, '/sap/bc/adt/compatibility/graph'); } };
  await assert.rejects(() => logonWith(cfg, refusing, 'DEVUSER1'), /NOT retrying/);
  assert.deepEqual(lines.map((l) => [l.event, l.status]), [['logon-refused', 401]]);
});

test('a session logged on again is one run line, counted per run, with no text of the server', () => {
  const [cfg, lines] = sink();
  recordRelogon(cfg, { status: 401, user: 'DEVUSER1' });
  assert.deepEqual([lines[0].event, lines[0].status, lines[0].user], ['relogon', 401, 'DEVUSER1']);
  const file = tempFile([
    { ts: '2026-11-11T09:00:00.000Z', run: 'r1', event: 'start', user: 'DEVUSER1' },
    { ts: '2026-11-11T11:00:00.000Z', run: 'r1', event: 'relogon', status: 401, user: 'DEVUSER1' },
  ]);
  const run = runsFromAudit(file).runs.find((r) => r.run === 'r1');
  assert.equal(run.relogons, 1);
  assert.equal(run.reads, 0, 'a logon again is not a read');
  assert.match(renderRuns(runsFromAudit(file)), /logged on again 1x/);
});

test('a logon that never reached the system writes nothing; a logon that worked writes nothing', async () => {
  const [cfg, lines] = sink();
  const unreachable = { login: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } };
  await assert.rejects(() => logonWith(cfg, unreachable, 'DEVUSER1'), /ENOTFOUND/);
  await logonWith(cfg, { login: async () => {} }, 'DEVUSER1');
  assert.deepEqual(lines, []);
});

test('--runs names a refused logon and counts them, so restarts add up', () => {
  const file = tempFile([
    { ts: '2026-09-23T09:00:00.000Z', run: 'r1', event: 'logon-refused', status: 401, user: 'DEVUSER1', client: '001' },
    { ts: '2026-09-23T09:01:00.000Z', run: 'r2', event: 'logon-refused', status: 401, user: 'DEVUSER1', client: '001' },
    { ts: '2026-09-23T09:02:00.000Z', run: 'r3', event: 'start', user: 'DEVUSER1' },
  ]);
  const out = runsFromAudit(file);
  assert.equal(out.runs.filter((r) => r.refused).length, 2);
  const md = renderRuns(out);
  assert.match(md, /2 logon\(s\) refused by the system/);
  assert.match(md.split('\n').find((l) => l.includes('`r1`')), /logon refused\*\* \(HTTP 401\)/);
});

test('the refusals before the prompt count since the last successful start of the same user and system', () => {
  const at = (m, extra) => ({ ts: `2026-09-23T09:0${m}:00.000Z`, run: `r${m}`, host: 'vhdemohost.example', client: '001', user: 'DEVUSER1', ...extra });
  const file = tempFile([
    at(0, { event: 'logon-refused', status: 401 }),
    at(1, { event: 'start' }),
    at(2, { event: 'logon-refused', status: 401 }),
    at(3, { event: 'logon-refused', status: 401, user: 'devuser1' }),
    at(4, { event: 'logon-refused', status: 401, user: 'DEVUSER2' }),
    at(5, { event: 'logon-refused', status: 401, client: '002' }),
  ]);
  const mine = refusedSinceLastStart({ host: 'vhdemohost.example', client: '001', user: 'DEVUSER1' }, file);
  assert.deepEqual(mine, { count: 2, since: '2026-09-23T09:01:00.000Z', lastRefused: '2026-09-23T09:03:00.000Z' }, 'the refusal before the start is forgiven; another user or client is not counted');
  assert.deepEqual(refusedSinceLastStart({ host: 'vhdemohost.example', client: '001', user: 'DEVUSER3' }, file), { count: 0, since: null, lastRefused: null });
  assert.deepEqual(
    refusedSinceLastStart({ host: 'vhdemohost.example', client: '001', user: 'DEVUSER1' }, path.join(os.tmpdir(), 'sap-adt-nope', 'audit.log')),
    { count: 0, since: null, lastRefused: null },
    'no trail: no warning, and no failure before the prompt'
  );
});

test('a failed logon prints its message and exits 1 -- no stack trace over the 401 sentence', async () => {
  const said = [];
  const exits = [];
  const refused = async () => { throw new Error('SAP rejected the credentials (401). NOT retrying.'); };
  await connectOrExit({}, { connectWith: refused, log: (m) => said.push(m), exit: (c) => exits.push(c) });
  assert.deepEqual(exits, [1]);
  assert.equal(said.length, 1);
  assert.match(said[0], /NOT retrying/);
  assert.equal(/\n\s+at /.test(said[0]), false, 'no stack frames');
  const session = { user: 'DEVUSER1' };
  assert.equal(await connectOrExit({}, { connectWith: async () => session, exit: () => assert.fail('a logon that worked does not exit') }), session);
});
