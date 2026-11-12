// The two limits that sit BEFORE the work, for a server several people use at once
// (docs/security.md, "Limits that refuse, for a hosted server").
//
// `budget.reads` counts reads after they return: it is a ledger and can refuse nothing. A hosted
// server needs what a ledger cannot give, and both are here:
//
//   a gate   on the requests in flight to the SAP system, whoever asked for them. The system
//            answers each from a work process, and a team's scans started together would take
//            as many as there are requests. A request past the gate waits; nothing is refused.
//   a rate   of tool calls per caller and minute. A call past it is answered at once with the
//            reason and the wait, as a tool result the model can read -- never queued, because
//            a queue would hide from the caller that it is being held back.

/**
 * At most `max` runs of `fn` in flight; the others wait their turn, first come first served.
 * A slot is handed to the next waiter rather than freed and taken again, so a newcomer cannot
 * slip in between and make it `max + 1`.
 */
export function createGate(max) {
  let active = 0;
  const waiting = [];
  const run = async (fn) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
  run.inFlight = () => active;
  run.waiting = () => waiting.length;
  return run;
}

const WINDOW_MS = 60_000;

/**
 * Tool calls per caller in the last minute. `refusal(caller)` records the call and returns null,
 * or returns why it is refused and records nothing. `perMinute` 0 switches the limit off.
 */
export function createCallRate(perMinute, { now = () => Date.now() } = {}) {
  const calls = new Map();
  return {
    perMinute,
    refusal(caller) {
      if (!perMinute) return null;
      const key = caller ?? '(unnamed)';
      const at = now();
      const recent = (calls.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
      if (recent.length >= perMinute) {
        calls.set(key, recent);
        const waitSeconds = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - at) / 1000));
        return {
          waitSeconds,
          message:
            `Rate limit: ${perMinute} tool calls per minute for one caller of this server, and '${key}' has made ` +
            `${recent.length} in the last minute. Nothing was asked of the SAP system. Try again in ${waitSeconds} s, ` +
            'and prefer one call with a wider page to many small ones.',
        };
      }
      recent.push(at);
      calls.set(key, recent);
      return null;
    },
  };
}
