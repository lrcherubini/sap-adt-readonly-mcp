// What belongs to ONE tool call while several are in flight.
//
// The journal attributes a code to "the call in progress" and the calls stream counts the ADT
// reads of "this call". Both were process-wide state: a stack and a counter read before and
// after. That holds while one call runs at a time, and a client sends several at once -- the
// codes of one call then land on the line of another, and each line counts the reads of all.
//
// An AsyncLocalStorage follows the call through every await, so "this call" is the one whose
// handler the running code descends from, however the calls interleave.

import { AsyncLocalStorage } from 'node:async_hooks';

const calls = new AsyncLocalStorage();

/**
 * Run `fn` as one call. A call started inside another (a tool that composes tools) is a child:
 * it collects its own codes, and its reads count for its parents too.
 */
export function inCall(fn, { caller } = {}) {
  const parent = calls.getStore() ?? null;
  // Who asked (lib/auth.mjs) is known where the request arrives and inherited below it.
  return calls.run({ frames: [], adtCalls: 0, parent, caller: caller ?? parent?.caller ?? null }, fn);
}

/** The call the running code belongs to, or null outside every call (a script, the start-up). */
export const currentCall = () => calls.getStore() ?? null;

/** One ADT read, counted for the running call and for every call it runs inside. */
export function countAdtCall() {
  for (let call = currentCall(); call; call = call.parent) call.adtCalls += 1;
}
