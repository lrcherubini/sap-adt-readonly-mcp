// Loopback bearer check for the MCP endpoint.
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

import crypto from 'node:crypto';

/**
 * @param {string|undefined} header  raw Authorization header
 * @param {string} token             expected loopback token
 * @returns {string|null}            null when authorized, else a short reason
 */
export function authFailure(header, token) {
  if (!header) return 'no Authorization header';
  if (!/^Bearer\s+/i.test(header)) return 'Authorization header is not "Bearer <token>"';

  const presented = header.replace(/^Bearer\s+/i, '').trim();
  if (!presented) return 'Bearer with an empty token';
  // The header carries the command text instead of its result: the shell never ran it.
  if (/\$\(|Get-Content|`|%LOCALAPPDATA%|<content of/i.test(presented)) {
    return 'the shell did not expand the token: the header holds the command text itself';
  }

  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  // Length is compared first because timingSafeEqual throws on a length mismatch. The
  // length of a rejected token is not a useful secret; the token itself never leaks.
  if (a.length !== b.length) return `token length ${a.length}, expected ${b.length}`;
  return crypto.timingSafeEqual(a, b) ? null : 'token does not match';
}
