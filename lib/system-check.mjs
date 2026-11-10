// Which system is this -- asked BEFORE the password prompt (docs/security.md, "The system is
// confirmed before the password is asked").
//
// A configuration pointed at the wrong host would otherwise cost a typed password, a logon and
// reads against a system nobody meant to read. The answer is free: an ADT node asked without
// credentials answers 401, and that 401 names the system twice -- the `sap-system` header and
// the Basic realm `[<SID>/<client>]` (measured, docs/phase0-report.md, section 1). So one GET
// with NO Authorization header, at a fixed path built from validated settings, is enough to
// stop before anything is typed. It is not a logon: no credential is sent, so it can never
// count towards a user lock. It runs outside the guard because there is no session yet; the
// body is drained unread, only the status and two headers are kept.

import https from 'node:https';

export const SYSTEM_CHECK_PATH = '/sap/bc/adt/discovery';
const TIMEOUT_MS = 8000;

/** The one unauthenticated GET. Resolves `{status, headers}` or `{error}`; never throws. */
export function askWithoutCredentials(cfg, { request = https.request } = {}) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: cfg.host,
        port: cfg.port,
        path: `${SYSTEM_CHECK_PATH}?sap-client=${encodeURIComponent(cfg.client)}`,
        method: 'GET',
        rejectUnauthorized: !cfg.allowUnauthorizedTls,
        timeout: TIMEOUT_MS,
        // No Authorization header, ever: this request must not be a logon.
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers ?? {} });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: `no answer within ${TIMEOUT_MS / 1000} s` });
    });
    req.on('error', (e) => resolve({ error: e?.code ?? e?.message ?? String(e) }));
    req.end();
  });
}

/** What a 401 says about the system: the SID from the header, SID and client from the realm. */
export function identityOf(headers = {}) {
  const header = String(headers['sap-system'] ?? '').trim().toUpperCase() || null;
  const realm = /\[([A-Za-z0-9]{3})\/(\d{3})\]/.exec(String(headers['www-authenticate'] ?? ''));
  return {
    sid: header ?? realm?.[1]?.toUpperCase() ?? null,
    realmSid: realm?.[1]?.toUpperCase() ?? null,
    client: realm?.[2] ?? null,
  };
}

/**
 * The verdict, as a sentence a person can act on. `ok: false` always says what was found and
 * what to change; nothing here decides on a value it did not read.
 */
export function judgeSystem(cfg, answer) {
  const fix = 'Nothing was asked and no SAP session was opened.';
  if (!cfg.system) {
    const found = answer?.status ? identityOf(answer.headers) : {};
    return {
      ok: false,
      message:
        `No expected system id: the server confirms the system before it asks for a password, so ` +
        `\`system\` is required. Run \`npm run config -- set system <SID>\`` +
        (found.sid ? ` (the host answers as ${found.sid}${found.client ? ` client ${found.client}` : ''})` : '') +
        `. ${fix}`,
    };
  }
  if (answer?.error) {
    return { ok: false, message: `Could not confirm the system at ${cfg.host}:${cfg.port} (${answer.error}). ${fix}` };
  }
  if (answer.status !== 401) {
    return {
      ok: false,
      message:
        `Could not confirm the system: ${cfg.host}:${cfg.port}${SYSTEM_CHECK_PATH} answered HTTP ${answer.status} ` +
        `to a request without credentials, where an ADT node answers 401 with Basic authentication. ${fix}`,
    };
  }
  const id = identityOf(answer.headers);
  if (!id.sid) {
    return {
      ok: false,
      message: `Could not confirm the system: the 401 names no system (no sap-system header, no [SID/client] realm). ${fix}`,
    };
  }
  const problems = [];
  if (id.sid !== cfg.system || (id.realmSid && id.realmSid !== cfg.system)) problems.push(`system ${id.sid}, expected ${cfg.system}`);
  if (id.client && id.client !== cfg.client) problems.push(`client ${id.client}, expected ${cfg.client}`);
  if (problems.length) {
    return {
      ok: false,
      message:
        `Unexpected system at ${cfg.host}:${cfg.port}: ${problems.join('; ')}. Fix the host or ` +
        `the expected values with \`npm run config\`. ${fix}`,
    };
  }
  return { ok: true, sid: id.sid, client: id.client, message: `system confirmed: ${id.sid}${id.client ? ` client ${id.client}` : ''} (asked without credentials)` };
}

/** Ask and judge. Throws the verdict's message when the system is not the expected one. */
export async function confirmSystem(cfg, { ask = askWithoutCredentials } = {}) {
  // Asked even without an expected id: the answer names the system the host is, so the message
  // can say which value to set.
  const verdict = judgeSystem(cfg, await ask(cfg));
  if (!verdict.ok) throw new Error(verdict.message);
  return verdict;
}
