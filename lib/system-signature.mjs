// The environment signature: which system, which client, what kind of client, and the role the
// installation gives the system -- on every answer (docs/security.md, "The environment signature").
//
// An answer read from a quality or production system looks exactly like one read from
// development. With one server per system, and a team that may register several, the answer has
// to say where it comes from, in fields a client can test, not in the name of a registration.
//
//   sid       the system id the server confirmed before the logon (lib/system-check.mjs)
//   client    the logon client
//   category  T000-CCCATEGORY of that client, read once at start (P production, T test,
//             C customizing, D demo, E training, S SAP reference); a failed read says so
//   role      the installation's own word (`systemRole`: DEV, QAS, PRD, ...), or null. The
//             category says what the CLIENT is for; which system of the landscape this is, the
//             system does not say anywhere this server reads, so it is the installation's word.

import { buildSelect, previewPost, parsePreview, assertRanAsSent } from './data-preview.mjs';
import { record } from './audit.mjs';

/** The fixed values of domain CCCATEGORY (measured 2026-11-12, docs/adt-api-reference.md). */
export const CLIENT_CATEGORIES = Object.freeze({
  P: 'production',
  T: 'test',
  C: 'customizing',
  D: 'demo',
  E: 'training',
  S: 'SAP reference',
});

/**
 * Read the category of the logon client: one data-preview POST on T000, at start. Never throws:
 * a failure is `{read: false, reason}` and a CLIENT_CATEGORY_NOT_READ gap.
 */
export async function readClientCategory(cfg, session, journal) {
  const fail = (reason) => {
    journal?.gap?.({
      code: 'CLIENT_CATEGORY_NOT_READ',
      subject: `T000 ${cfg?.client ?? '?'}`,
      detail: reason,
      impact: 'every answer of this run says the client category was not read: it does NOT say the client is not a production one',
      fallback: 'SCC4 in the SAP GUI; restart the server to read it again',
    });
    return { read: false, reason };
  };
  if (!session?.raw) return fail('this session has no raw client: T000 cannot be read');
  const built = buildSelect({ table: 'T000', fields: ['MANDT', 'CCCATEGORY'], where: [{ field: 'MANDT', value: String(cfg.client) }], rows: 1 });
  let out;
  try {
    out = await previewPost(session.raw, built.sql, built.rows);
  } catch (e) {
    return fail(`HTTP ${e?.status ?? '?'}: ${e?.message}`.slice(0, 300));
  } finally {
    record(cfg, 'environment signature', `T000 ${cfg.client}`, out?.bytes ?? 0);
  }
  try {
    const parsed = parsePreview(out.body);
    assertRanAsSent(built.sql, parsed.executedQuery);
    const row = parsed.rows[0];
    if (!row) return fail(`T000 has no row for client ${cfg.client}`);
    const code = String(row.CCCATEGORY ?? '').trim();
    return { read: true, code, meaning: CLIENT_CATEGORIES[code] ?? (code ? 'not a value of domain CCCATEGORY' : 'not set') };
  } catch (e) {
    return fail(`${e?.name ?? 'Error'}: ${e?.message}`.slice(0, 300));
  }
}

/** The signature every answer carries. `category` is what readClientCategory returned. */
export function signatureOf(cfg, category) {
  return Object.freeze({
    sid: cfg?.system ?? null,
    client: cfg?.client ?? null,
    category: category ?? { read: false, reason: 'not read at start' },
    role: cfg?.systemRole ?? null,
  });
}

/** One line for a person: the start banner and the header of a source. */
export function signatureLine(sig) {
  const c = sig.category;
  const kind = c?.read ? `${c.code || '-'} ${c.meaning}` : 'category not read';
  return `${sig.sid ?? '?'}/${sig.client ?? '?'} (${kind}${sig.role ? `, ${sig.role}` : ''})`;
}

const stampJson = (text, sig) => {
  if (typeof text !== 'string' || !text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify({ system: sig, ...value }) : null;
  } catch {
    // Text that merely starts with a brace (a source, a message) is not an answer object: it
    // stays as it is, and the structured content still carries the signature.
    return null;
  }
};

/**
 * The result with the signature in front of its structured content and of every text block that
 * is a JSON answer object. A failure (`isError`) is left as it is: it reads nothing.
 */
export function withSignature(result, sig) {
  if (!result || result.isError || !sig) return result;
  const content = (result.content ?? []).map((block) => {
    const stamped = block?.type === 'text' ? stampJson(block.text, sig) : null;
    return stamped ? { ...block, text: stamped } : block;
  });
  return {
    ...result,
    content,
    ...(result.structuredContent ? { structuredContent: { system: sig, ...result.structuredContent } } : {}),
  };
}
