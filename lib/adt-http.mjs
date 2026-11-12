// The HTTP client of this server: the logon, the session cookie, the CSRF token -- and nothing
// else between this server and the SAP system.
//
// MEASURED 2026-11-10 without any library (docs/adt-api-reference.md, "The logon on the wire"):
//
//   GET /sap/bc/adt/compatibility/graph?sap-client=<c>&sap-language=<l>
//     Authorization: Basic …, x-csrf-token: fetch, X-sap-adt-sessiontype: stateless,
//     Accept: */*, Cache-Control: no-cache
//   -> 200, x-csrf-token: <token>, set-cookie sap-usercontext and SAP_SESSIONID_<SID>_<client>
//   The cookie alone authenticates every later request; a POST also needs the token, and without
//   it is refused loudly: 403, x-csrf-token: Required. GET /sap/public/bc/icf/logoff ends the
//   session (the old cookie then answers 401).
//
// The rules this file holds, each with a test in tests/adt-http.test.mjs:
//   - ONE logon is asked by lib/session.mjs. A session that later expires (401 after a logon that
//     succeeded) logs on again ONCE with the password the system already accepted -- decided by
//     the owner, 2026-11-11 (docs/security.md). If that logon is refused, the client is dead: no
//     further request is sent, so a changed password cannot be tried twice. Requests that meet
//     the same expiry together share that ONE logon: each waits for it and none starts its own.
//   - A 403 that says `x-csrf-token: Required` fetches a new token once and repeats the request
//     once. Any other 4xx/5xx is thrown.
//   - The password lives in this closure only, and is dropped at logout. No error, header map or
//     message this file hands out carries a cookie, a token or an Authorization value.
//   - The errors keep the shape the callers already read: `err` and `status` (the HTTP status),
//     `response: {status, body, headers}`, `body`, `localizedMessage`, `type`.

import https from 'node:https';

export const LOGON_PATH = '/sap/bc/adt/compatibility/graph';
export const LOGOFF_PATH = '/sap/public/bc/icf/logoff';
const TOKEN_HEADER = 'x-csrf-token';
const SESSION_HEADER = 'X-sap-adt-sessiontype';
const DEFAULT_TIMEOUT_MS = 120000;
/** Reply headers never handed out: they carry the session. */
const SECRET_HEADERS = new Set(['set-cookie', TOKEN_HEADER, 'authorization']);

export class AdtHttpError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'AdtHttpError';
    Object.assign(this, fields);
  }
}

/** A reply's headers without the ones that carry the session. */
export function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!SECRET_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * The error of one refused request, in the shape the callers read. An ADT exception document
 * (`exc:exception`) gives its type and its localized message; a plain-text reply gives its text.
 */
export function httpError(status, body, headers, url) {
  const text = String(body ?? '');
  const ctype = String(headers?.['content-type'] ?? '');
  let said = '';
  let type = null;
  if (/<exc:exception\b/.test(text)) {
    said = unescapeXml(/<localizedMessage[^>]*>([^<]*)</.exec(text)?.[1] ?? '').trim();
    type = /<type\s+id="([^"]*)"/.exec(text)?.[1] ?? null;
  } else if (/text\/plain/i.test(ctype)) {
    said = text.trim().slice(0, 300);
  }
  const message = `HTTP ${status}${said ? `: ${said}` : ''}`;
  return new AdtHttpError(message, {
    err: status,
    status,
    url,
    type,
    localizedMessage: said || message,
    body: text,
    response: { status, body: text, headers: safeHeaders(headers) },
  });
}

/** `url` with `sap-client`, unless it already names one. */
export function withClient(url, client) {
  if (!client || /[?&]sap-client=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sap-client=${encodeURIComponent(client)}`;
}

/**
 * The client. `cfg` gives host, port, client, language and allowUnauthorizedTls; `request` is
 * node's https.request, injectable for the tests. Nothing is sent until `login()`.
 */
export function createAdtHttp(cfg, { user, password, request = https.request, timeoutMs = DEFAULT_TIMEOUT_MS, onRelogon, onRelogonRefused } = {}) {
  if (!cfg?.host || !user || !password) throw new AdtHttpError('the ADT client needs a host, a user and a password.');
  let secret = password;
  const jar = new Map();
  let token = null;
  let loggedIn = false;
  let dead = null; // the reason no request is sent any more
  let epoch = 0; // the logons that succeeded: a reply belongs to the session it was sent in
  let relogging = null; // the one logon again in progress, shared by every request that needs it

  const cookieHeader = () => [...jar.values()].join('; ');

  function keepCookies(setCookie) {
    for (const c of [].concat(setCookie ?? [])) {
      const [pair, ...attrs] = String(c).split(';');
      const name = pair.split('=')[0].trim();
      if (!name) continue;
      const expires = attrs.map((a) => a.trim()).find((a) => /^expires=/i.test(a));
      const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
      const gone = (expires && Date.parse(expires.slice(8)) < Date.now()) || (maxAge && Number(maxAge.slice(8)) <= 0);
      if (gone) jar.delete(name);
      else jar.set(name, pair.trim());
    }
  }

  /**
   * One exchange on the wire. Resolves {status, body, headers}; rejects only when no reply came.
   * `keep()` says whether the reply's cookies still belong to the session in the jar.
   */
  function send(method, path, headers, body, keep = () => true) {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: cfg.host,
          port: cfg.port,
          path,
          method,
          headers,
          rejectUnauthorized: !cfg.allowUnauthorizedTls,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
          res.on('end', () => {
            if (keep()) keepCookies(res.headers?.['set-cookie']);
            resolve({ status: res.statusCode, headers: res.headers ?? {}, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', (e) => reject(networkError(e, path)));
        }
      );
      req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (e) => reject(networkError(e, path)));
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
  }

  const networkError = (e, url) =>
    new AdtHttpError(`no reply from the SAP system: ${e?.code ?? e?.message ?? e}`, { err: null, status: null, url, code: e?.code ?? null });

  async function logon() {
    jar.clear();
    token = null;
    const path = `${LOGON_PATH}?sap-client=${encodeURIComponent(cfg.client ?? '')}${cfg.language ? `&sap-language=${encodeURIComponent(cfg.language)}` : ''}`;
    const res = await send('GET', path, {
      Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`,
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      [TOKEN_HEADER]: 'fetch',
      [SESSION_HEADER]: 'stateless',
    });
    if (res.status >= 400) throw httpError(res.status, res.body, res.headers, LOGON_PATH);
    const t = res.headers?.[TOKEN_HEADER];
    token = typeof t === 'string' && !/^(fetch|required)$/i.test(t) ? t : null;
    loggedIn = true;
    epoch += 1;
  }

  async function refetchToken() {
    const res = await send('GET', withClient(LOGON_PATH, cfg.client), {
      Accept: '*/*',
      Cookie: cookieHeader(),
      [TOKEN_HEADER]: 'fetch',
      [SESSION_HEADER]: 'stateless',
    });
    const t = res.headers?.[TOKEN_HEADER];
    if (res.status < 400 && typeof t === 'string' && !/^(fetch|required)$/i.test(t)) token = t;
  }

  async function relogon(status) {
    try {
      await logon();
    } catch (e) {
      dead = `the session expired and the logon again was refused (HTTP ${e?.status ?? '?'}): restart the server`;
      loggedIn = false;
      secret = null;
      onRelogonRefused?.({ status: e?.status ?? null });
      throw e;
    }
    onRelogon?.({ status });
  }

  /**
   * The logon again for a request that was answered 401 in the session `sentIn`. ONE logon serves
   * every request that met the same expiry: a second one in parallel would be a second attempt
   * with a password the system may no longer accept, and repeated refusals lock the user.
   */
  function loggedOnAgain(sentIn, status, url) {
    if (dead) return Promise.reject(new AdtHttpError(dead, { err: null, status: null, url }));
    // Another request logged on again after this one was sent: the new session is there already.
    if (epoch !== sentIn) return Promise.resolve();
    relogging ??= relogon(status).finally(() => {
      relogging = null;
    });
    return relogging;
  }

  async function exchange(url, { method = 'GET', headers = {}, body } = {}) {
    const path = withClient(url, cfg.client);
    const merged = {
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      [SESSION_HEADER]: 'stateless',
      ...headers,
      Cookie: cookieHeader(),
      ...(token ? { [TOKEN_HEADER]: token } : {}),
    };
    // A reply that arrives after a logon again was sent in the session before it: its cookies
    // must not touch the new session's.
    const sentIn = epoch;
    const res = await send(String(method).toUpperCase(), path, merged, body, () => epoch === sentIn);
    return { ...res, sentIn };
  }

  async function requestOne(url, opts = {}) {
    // A logon again in progress has emptied the jar: wait for it instead of sending without a
    // session. Its refusal is not this request's error; `dead` below says it.
    if (relogging) await relogging.catch(() => {});
    if (dead) throw new AdtHttpError(dead, { err: null, status: null, url });
    if (!loggedIn) throw new AdtHttpError('not logged on: lib/session.mjs logs on once before any request.', { err: null, status: null, url });
    let res = await exchange(url, opts);
    if (res.status === 403 && /^required$/i.test(String(res.headers?.[TOKEN_HEADER] ?? ''))) {
      await refetchToken();
      res = await exchange(url, opts);
    } else if (res.status === 401) {
      await loggedOnAgain(res.sentIn, 401, url);
      res = await exchange(url, opts);
    }
    if (res.status >= 400) throw httpError(res.status, res.body, res.headers, url);
    return { status: res.status, body: res.body, headers: safeHeaders(res.headers) };
  }

  return {
    /** The one logon. Throws the refusal (with `status`) and sends nothing else. */
    async login() {
      if (dead) throw new AdtHttpError(dead, { err: null, status: null });
      await logon();
    },
    get loggedin() {
      return loggedIn && !dead;
    },
    /** The seam every route and fixed POST already uses: request(url, {method, headers, body}). */
    httpClient: Object.freeze({ request: (url, opts) => requestOne(url, opts) }),
    /** Stateless already: there is no stateful session to drop. */
    async dropSession() {},
    /** Ends the session on the server and forgets the password: no logon follows. */
    async logout() {
      if (!loggedIn) return;
      try {
        await send('GET', withClient(LOGOFF_PATH, cfg.client), { Accept: '*/*', Cookie: cookieHeader() });
      } finally {
        loggedIn = false;
        dead = 'logged off';
        secret = null;
        token = null;
        jar.clear();
      }
    },
  };
}
