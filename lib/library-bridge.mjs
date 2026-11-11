// TEMPORARY -- removed with abap-adt-api (docs/security.md, "Removing abap-adt-api").
//
// While the guard's members still come from the library, the library rides on this server's own
// HTTP client (lib/adt-http.mjs) instead of axios: one logon, one session, one cookie jar. The
// library accepts an object in place of a base URL (AdtHTTP: `isString(baseURLOrClient) ? Axios
// : baseURLOrClient`) and calls its `request(config)`; this module is that object.
//
// What it does, and why:
//   - builds the URL from `url` and `qs` the way axios did (its `encode`), so every request the
//     library makes reads exactly as before;
//   - drops the session headers the library adds (Cookie, x-csrf-token, Authorization, the
//     session type) and its `auth`: the own client owns the session;
//   - hands a refused request BACK as a response (status, body, headers), so the library builds
//     the very exceptions it built over axios (`AdtErrorException`, `err` = the status), and a
//     request that got no reply as its own HttpClientException, as axios did.
// `libraryOver` tells the library its session exists, so it never sends a logon of its own.

import { ADTClient, session_types } from 'abap-adt-api';
// Not re-exported by the package index; the same module instance the library checks against.
import { HttpClientException } from 'abap-adt-api/build/AdtHTTP.js';

/** The token value the library holds once it is told the session exists. Never sent: stripped here. */
export const MANAGED = 'managed-by-lib-adt-http';
const SESSION_HEADERS = new Set(['cookie', 'x-csrf-token', 'authorization', 'x-sap-adt-sessiontype']);

/** axios's own parameter encoding (helpers/buildURL.js `encode`). */
export const axiosEncode = (v) =>
  encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%24/g, '$').replace(/%2C/gi, ',').replace(/%20/g, '+');

/** `url` plus `qs`, serialised as axios serialised it: null and undefined dropped, arrays as key[]. */
export function urlWithQuery(url, qs) {
  const parts = [];
  for (const [k, v] of Object.entries(qs ?? {})) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) parts.push(`${axiosEncode(`${k}[]`)}=${axiosEncode(String(item))}`);
    else parts.push(`${axiosEncode(k)}=${axiosEncode(v instanceof Date ? v.toISOString() : String(v))}`);
  }
  if (!parts.length) return url;
  const base = String(url).split('#')[0];
  return `${base}${base.includes('?') ? '&' : '?'}${parts.join('&')}`;
}

/** The library's HTTP client, over the own one. */
export function asLibraryHttp(own) {
  return {
    async request(config = {}) {
      const headers = {};
      for (const [k, v] of Object.entries(config.headers ?? {})) {
        if (!SESSION_HEADERS.has(k.toLowerCase()) && v !== undefined && v !== null) headers[k] = String(v);
      }
      const url = urlWithQuery(config.url, config.qs);
      try {
        const res = await own.httpClient.request(url, { method: config.method ?? 'GET', headers, body: config.body });
        return { status: res.status, statusText: '', body: res.body, headers: res.headers };
      } catch (e) {
        if (e?.response && Number.isInteger(e.response.status)) {
          return { status: e.response.status, statusText: '', body: e.response.body ?? '', headers: e.response.headers ?? {} };
        }
        throw new HttpClientException(e?.message ?? String(e), e?.code, undefined, undefined, config, undefined, e);
      }
    },
  };
}

/** An ADTClient whose every request goes through the own client, already logged on. */
export function libraryOver(own, { user, client, language }) {
  const lib = new ADTClient(asLibraryHttp(own), user, '', client ?? '', language ?? '');
  lib.stateful = session_types.stateless;
  lib.httpClient.csrfToken = MANAGED;
  return lib;
}
