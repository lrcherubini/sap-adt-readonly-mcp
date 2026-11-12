// The bearer check of the MCP endpoint: the loopback token, and the named tokens of a hosted
// server.
//
// Two rules that are easy to get wrong, and were:
//
// 1. Never answer with `WWW-Authenticate: Bearer`. Under the MCP spec that header on a
//    401 declares OAuth 2.0 support, so the client runs authorization-server discovery
//    and Dynamic Client Registration, and the operator sees "DCR rejected (HTTP 404)"
//    -- a message about OAuth for what is really a wrong static token. The caller in
//    server.mjs is responsible for not sending it; this module never asks for it.
// 2. Say *why* the token was refused, on the server console only. The failure that
//    actually happens is a shell that did not expand $(Get-Content ...), and a bare
//    "unauthorized" makes that indistinguishable from a stale token.
//
// WHO IS ASKING (docs/security.md, "A token per caller"). One token for a whole team says
// that somebody of the team asked, and cannot be taken from one person without taking it from
// all. A hosted server therefore knows callers: a name and the SHA-256 of a token made by
// `npm run config -- token add <name>`. The token is shown once and never stored; what the
// store holds cannot be turned back into it. The token in the state directory stays what it
// was -- whoever can read that file is the operator of the machine -- and is the caller `local`.

import crypto from 'node:crypto';

/** A caller's name: lower case, so one person is never two callers by spelling. */
export const CALLER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** The caller that presents the token of the state directory. Not a name `token add` accepts. */
export const LOCAL_CALLER = 'local';

export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** A new token for a caller: 32 random bytes, and the hash that is stored in its place. */
export function newCallerToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenSha256: tokenHash(token) };
}

/** The token a header presents, or the reason it presents none. */
function presentedBy(header) {
  if (!header) return { failure: 'no Authorization header' };
  if (!/^Bearer\s+/i.test(header)) return { failure: 'Authorization header is not "Bearer <token>"' };

  const presented = header.replace(/^Bearer\s+/i, '').trim();
  if (!presented) return { failure: 'Bearer with an empty token' };
  // The header carries the command text instead of its result: the shell never ran it.
  if (/\$\(|Get-Content|`|%LOCALAPPDATA%|<content of/i.test(presented)) {
    return { failure: 'the shell did not expand the token: the header holds the command text itself' };
  }
  return { presented };
}

const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/**
 * @param {string|undefined} header  raw Authorization header
 * @param {string} token             expected loopback token
 * @returns {string|null}            null when authorized, else a short reason
 */
export function authFailure(header, token) {
  const { presented, failure } = presentedBy(header);
  if (failure) return failure;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  // Length is compared first because timingSafeEqual throws on a length mismatch. The
  // length of a rejected token is not a useful secret; the token itself never leaks.
  if (a.length !== b.length) return `token length ${a.length}, expected ${b.length}`;
  return crypto.timingSafeEqual(a, b) ? null : 'token does not match';
}

/**
 * Who presents this header: `{caller}` -- `local` for the token of the state directory, else the
 * name of the caller whose token it is -- or `{failure}` with the reason.
 *
 * @param {string|undefined} header
 * @param {{token: string, callers?: {name: string, tokenSha256: string}[]}} known
 */
export function callerOf(header, { token, callers = [] }) {
  const { presented, failure } = presentedBy(header);
  if (failure) return { failure };
  if (sameBytes(Buffer.from(presented), Buffer.from(token))) return { caller: LOCAL_CALLER };
  // Every hash is compared, in constant time each: which caller matched is not told by timing.
  const hash = Buffer.from(tokenHash(presented));
  let caller = null;
  for (const c of callers) {
    if (sameBytes(hash, Buffer.from(String(c.tokenSha256))) && caller === null) caller = c.name;
  }
  if (caller !== null) return { caller };
  // Without callers the only token is the local one: its two reasons are kept, because they
  // tell a stale token from a mistyped registration.
  return { failure: callers.length ? 'the token is neither the local one nor a caller s' : authFailure(header, token) };
}
