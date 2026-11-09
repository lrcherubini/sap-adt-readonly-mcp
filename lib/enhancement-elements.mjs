// WHICH append structures extend a table or a structure, by name.
//
// This is the one question no other read answers. An append is invisible in the base object's
// source BY DESIGN -- that is what an append is -- and `ddicElement`, which does see the append
// FIELDS of a table, marks them with anonymous `.append` separators and answers an empty tree for
// any `TABL/DS`. So for a structure there was no route at all until this one: `KOMG` includes
// `KOMPAZ`, and it is `KOMPAZ` that carries `ZDEMO_KOMPAZ` (`ZZDEMOFLD`).
//
// MEASURED 2026-09-22 on the development system, 7 objects (docs/adt-api-reference.md). What the reply is:
//
//   * the ROOT `abapsource:elementInfo` is the object asked about; its `adtcore:uri` is the object
//     (`/sap/bc/adt/ddic/structures/incl_eew_kna1`), with no `/source/main`;
//   * each CHILD is one append, and its `adtcore:uri` DOES end in `/source/main`. That suffix is
//     the robust separator -- nesting alone would need a real parser, and the root is only "first"
//     by serialisation order;
//   * a child usually carries an `abapsource:documentation` shorttext, and the one that does not
//     is the key-user append `zz1_demo7x2kq9mbt4wpl3rncy8hfa`. A parser keyed on the shorttext
//     loses precisely the Custom Fields app case, which is the case this exists to catch;
//   * there is NO field list. The name is the answer; the fields cost one source read each.
//
// ⚠️ Absence of the link is NOT absence of an append. Both negative controls publish no
// enhancements link, and both are `#NOT_EXTENSIBLE` -- the two conditions are confounded in the
// measurement, so a caller reports "nothing to enumerate", never "there is no append".

/** Attributes of one opening tag, as the other regex parsers in this repo read them. */
function attrsOf(fragment) {
  const out = {};
  if (!fragment) return out;
  for (const m of String(fragment).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** `%2f` is how the ADT writes a namespace inside a name; give the caller the readable form too. */
const decodeName = (name) => String(name ?? '').replace(/%2[fF]/g, '/');

/**
 * Parse one `application/vnd.sap.adt.elementinfo+xml` reply.
 *
 * @returns {{subject: {name: string|null, type: string|null}, appends: Array<{name: string, raw: string, type: string|null, uri: string|null, shortText: string|null}>, drift: Array<object>}}
 */
export function parseEnhancementElements(xml) {
  const s = String(xml ?? '');
  const drift = [];
  const appends = [];
  let subject = { name: null, type: null };

  // Each `elementInfo` opening tag, with whatever follows up to the next one -- that window holds
  // the element's own documentation and nothing of its siblings.
  const opens = [...s.matchAll(/<abapsource:elementInfo(\s[^>]*)?>/g)];
  for (let i = 0; i < opens.length; i += 1) {
    const a = attrsOf(opens[i][1]);
    const uri = a['adtcore:uri'] ?? null;
    const name = a['adtcore:name'] ?? null;
    const window = s.slice(opens[i].index, opens[i + 1]?.index ?? s.length);
    const doc = /<abapsource:documentation[^>]*>([^<]*)</.exec(window);

    // The root is the object: its uri does not point at a source.
    if (!uri || !/\/source\/main$/.test(uri)) {
      if (i === 0) {
        subject = { name: decodeName(name), type: a['adtcore:type'] ?? null };
      } else {
        // A non-root element that is not a source: unmeasured shape, reported rather than guessed.
        drift.push({ node: 'elementInfo without /source/main', name, uri, where: 'enhancementElements' });
      }
      continue;
    }
    if (i === 0) drift.push({ node: 'root elementInfo pointed at a source', uri, where: 'enhancementElements' });
    appends.push({
      name: decodeName(name),
      raw: String(name ?? ''),
      type: a['adtcore:type'] ?? null,
      uri,
      // Absent on the key-user append. Never used to decide whether an entry is one.
      shortText: doc ? doc[1].trim() || null : null,
    });
  }

  return { subject, appends, drift };
}

/**
 * The route to ask, from the object's DDIC kind. Two templates, never one with a chosen prefix:
 * `/ddic/tables` and `/ddic/structures` are different resources.
 */
export function enhancementRouteFor(kind) {
  if (kind === 'table') return 'tableEnhancements';
  if (kind === 'structure') return 'structureEnhancements';
  return null;
}

/**
 * The path segment for an object name, in the alphabet the two routes declare.
 *
 * A namespaced name is written the way the ADT writes it INSIDE a segment (`%2fisdfps%2fx`);
 * anything else that contains a slash is not a name this route can address, and returning null
 * makes the caller say so instead of sending a path it guessed.
 */
export function segmentFor(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  if (!n.includes('/')) return /^[a-z0-9_]{1,30}$/.test(n) ? n : null;
  const m = /^\/([a-z0-9_]{1,10})\/([a-z0-9_]{1,30})$/.exec(n);
  return m ? `%2f${m[1]}%2f${m[2]}` : null;
}
