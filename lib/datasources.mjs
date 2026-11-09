// What a CDS source actually reads.
//
// This is the input to the Clean Core scan, and it is a parsing job over the source text the
// system returns: the `select from`, the joins, the association targets and the
// extended view are all written in it. What the source cannot do is say
// whether each of those names is released -- that is lib/clean-core.mjs, over the
// catalogue.
//
// Every rule here comes from a measurement over the 450 .ddls.asddls in a measured workspace:
//
//   * comments are BOTH `--` and `//`, in production, sometimes in the same repository,
//     and one real file carries `as select from` inside a comment. stripComments now
//     handles both; getting this wrong invents a data source that does not exist.
//   * `redirected to` is NOT an association: it repoints an inherited one in a
//     projection. Folding it into the association bucket (as a first measurement did)
//     overstates the dependency count.
//   * `extend view` / `extend view entity` names the view being extended -- 151 files
//     do this, and extending a standard view is exactly the kind of coupling the sweep
//     is looking for, so it is captured as its own kind.
//   * names are written with NON-CANONICAL casing in real sources (`I_Productqm`,
//     `I_Businesspartnertaxnumber`). Everything downstream compares case-insensitively.
//   * a parameterised source (`from ZI_X( p : ... )`) yields the entity, not the
//     parameters.

import { stripComments } from './annotations.mjs';
// One definition of "ours", shared with the classifier: Z/Y only. A /NAMESPACE/
// object belongs to SAP or to an add-on partner (/SCWM/ is EWM, /GIB/ is a vendor),
// so it is judged against the catalogue like any other standard name.
import { isCustomName } from './clean-core.mjs';

/** An identifier as CDS writes it, namespace slashes included (`/SCWM/S_X`). */
const NAME = '([A-Za-z_/][A-Za-z0-9_/]*)';

/**
 * Each rule is [kind, regex]. The capture group named by `group` is the entity.
 * Order does not matter: every rule scans the whole (comment-stripped) text.
 */
const RULES = [
  ['from', new RegExp(`\\bfrom\\s+${NAME}`, 'gi'), 1],
  ['join', new RegExp(`\\bjoin\\s+${NAME}`, 'gi'), 1],
  ['association', new RegExp(`\\bassociation\\s*(?:\\[[^\\]]*\\])?\\s*to\\s+(?:parent\\s+)?${NAME}`, 'gi'), 1],
  ['composition', new RegExp(`\\bcomposition\\s*(?:\\[[^\\]]*\\])?\\s*of\\s+(?:parent\\s+)?${NAME}`, 'gi'), 1],
  ['projection', new RegExp(`\\bprojection\\s+on\\s+${NAME}`, 'gi'), 1],
  [
    'redirected',
    new RegExp(`\\bredirected\\s+to\\s+(?:composition\\s+child\\s+|parent\\s+)?${NAME}`, 'gi'),
    1,
  ],
  ['extend', new RegExp(`\\bextend\\s+view\\s+(?:entity\\s+)?${NAME}`, 'gi'), 1],
  ['annotate', new RegExp(`\\bannotate\\s+(?:entity|view)\\s+${NAME}`, 'gi'), 1],
];

/**
 * `projection on X` is also matched by the `from` rule? No -- but `as projection on`
 * has no `from`, while `extend view X with` would be caught by nothing else. These are
 * the keywords that introduce a source and are NOT entity names themselves.
 */
const NOT_A_SOURCE = new Set(['select', 'distinct', 'parent', 'child', 'composition', 'entity']);

/** Line number (1-based) of a byte offset. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The name this source defines, and how, so a caller can report the consumer. */
export function definitionOf(source) {
  const s = stripComments(String(source ?? ''));
  const m =
    /\bdefine\s+(root\s+)?(abstract\s+entity|custom\s+entity|table\s+function|view\s+entity|view)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      s
    ) ??
    /\b(extend)\s+view\s+(?:entity\s+)?[A-Za-z_][A-Za-z0-9_]*\s+with\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      s
    ) ??
    /\b(annotate)\s+(?:entity|view)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(s);
  if (!m) return { name: null, kind: null };
  if (m[1] && /^(extend|annotate)$/i.test(m[1])) {
    return { name: m[2], kind: m[1].toLowerCase() };
  }
  const kind = String(m[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
  return { name: m[3], kind: /\bprojection\s+on\b/i.test(s) ? 'projection' : kind };
}

/**
 * Every data source a CDS file reads.
 *
 * @param {string} source the .ddls.asddls / .ddlx.asddlxs text
 * @param {string} [file] path, carried into each hit so a finding can point at it
 * @returns {{name:string, kind:string, line:number, file:string|null, custom:boolean}[]}
 *          deduplicated by name+kind+line, in file order
 */
export function dataSourcesFrom(source, file = null) {
  const text = stripComments(String(source ?? ''));
  const lineOf = lineIndex(text);
  const seen = new Set();
  const hits = [];
  for (const [kind, regex, group] of RULES) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const name = m[group];
      if (!name || NOT_A_SOURCE.has(name.toLowerCase())) continue;
      const line = lineOf(m.index);
      const key = `${name.toUpperCase()}|${kind}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        name,
        kind,
        line,
        file,
        custom: isCustomName(name),
      });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/**
 * Collapse hits to one entry per distinct name, keeping every place it appears.
 * The sweep asks about names, and the report has to point at the lines.
 */
export function byName(hits) {
  const out = new Map();
  for (const h of hits) {
    const key = h.name.toUpperCase();
    const entry = out.get(key) ?? { name: h.name, custom: h.custom, kinds: new Set(), at: [] };
    entry.kinds.add(h.kind);
    entry.at.push({ file: h.file, line: h.line, kind: h.kind });
    out.set(key, entry);
  }
  return [...out.values()].map((e) => ({ ...e, kinds: [...e.kinds].sort() }));
}
