// A failed tool call as an answer an agent can act on: a code it can branch on, the message a
// person reads, and -- where one exists -- the call that would answer instead.
//
//   { system, error: { code, message, next?: { tool, arguments } } }
//
// It travels as structuredContent and as the same JSON in text, with isError: true (the MCP
// specification: a tool failure is a result, never a protocol error). The signature is in front
// of it like on any answer: a refusal from a production system must say so as clearly as an
// answer does.

/**
 * The codes this server gives its own refusals: a closed set, like the journal's and the
 * completeness codes (tests/no-silent-errors.test.mjs). Codes derived from an error (its own
 * `code`, an HTTP status, the class name) are not listed: they name what the system said.
 */
export const ERROR_CODES = new Map([
  ['INVALID_ARGUMENTS', 'the arguments break the input schema or contradict each other; nothing was asked of the system'],
  ['NOT_APPLICABLE', 'the arguments are valid, but not for the object they name (a method of a program, a version that does not exist)'],
  ['RATE_LIMITED', 'this caller passed limits.callsPerMinute; next.waitSeconds says when to try again'],
  ['NOT_FOUND', 'the name resolves to nothing on any route; next names the search that lists near names'],
  ['NOT_RESOLVED', 'the name could not be resolved and a route failed on the way: NOT a proof of absence'],
  ['STANDARD_OBJECT', 'where-used on a standard object needs allowStandard; next is the same call with it'],
]);

/** An error that carries its own code and, optionally, the call to make instead. */
export class ToolError extends Error {
  constructor(message, { code, next } = {}) {
    super(message);
    this.name = 'ToolError';
    if (code) this.code = code;
    if (next) this.next = next;
  }
}

/** A refusal of the arguments themselves: the caller fixes the call, not the system. */
export const invalidArguments = (message, next) => new ToolError(message, { code: 'INVALID_ARGUMENTS', next });

/** Arguments that fit the schema but not the object found: the message says what fits it. */
export const notApplicable = (message, next) => new ToolError(message, { code: 'NOT_APPLICABLE', next });

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** `SelectViolation` -> `SELECT_VIOLATION`. */
const fromName = (name) =>
  String(name ?? '')
    .replace(/Error$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();

/**
 * The code of any error a handler throws: its own `code` when it is one (`NOT_FOUND`,
 * `ENOTFOUND`), else `HTTP_<status>` for a reply the system refused, else the class name in upper
 * snake case, else FAILED.
 */
export function errorCodeOf(e) {
  if (typeof e?.code === 'string' && CODE.test(e.code)) return e.code;
  if (e?.notFound === true) return 'NOT_FOUND';
  const status = [e?.err, e?.status, e?.response?.status].map(Number).find((n) => Number.isInteger(n) && n >= 100);
  if (status) return `HTTP_${status}`;
  const named = fromName(e?.name);
  return named && named !== 'TOOL' && CODE.test(named) ? named : 'FAILED';
}

/** The MCP result of a failure: structured, stamped with the signature when there is one. */
export function errorResult(e, signature = null) {
  const message = String(e?.message ?? e ?? 'unknown failure');
  const next = e?.next && typeof e.next === 'object' ? { next: e.next } : {};
  const body = { ...(signature ? { system: signature } : {}), error: { code: errorCodeOf(e), message, ...next } };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}
