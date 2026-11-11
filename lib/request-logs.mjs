// The logs of one transport request: what happened to it, and what happened when it moved.
//
// Two resources under the request, both `application/vnd.sap.adt.logs+xml`, MEASURED
// 2026-11-10 (docs/adt-api-reference.md, "Backlog reads"):
//
//   actionlogs     FLAT. One log:entry per action on the request (created, linked to a task,
//                  release started), the text in the logon language with a message key
//                  `TK(nnn)`. The dates are inside the text, in the user's format.
//   transportlogs  A TREE. The request, then each system, then each step (operating-system
//                  checks, export preprocessing, export, import marking). A step's text ends
//                  with its date, time and return code: `(0) Ended successfully`.
//
// What is dropped, on purpose, and said in the answer's rule:
//   - the separator lines of the action log (a key `TO(009)` and a row of `=`);
//   - entries with no text and no child (the tree uses them as spacers);
//   - every atom:link: the long-text link carries the message variables again, and the
//     transport log link carries the transport directory path of the application server,
//     a file this server does not read.
//
// The return code is read out of the step text, never guessed: a step without a `(n)` has
// `rc: null`, and `highestReturnCode` is null when no step said one.

const KNOWN = new Set(['log:log', 'log:type', 'log:name', 'log:entry', 'log:message', 'log:messageText', 'atom:link']);

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
};

const SEPARATOR = /^=+$/;
const RETURN_CODE = /\((\d+)\)\s*\S.*$/;

/**
 * Parse one logs document into a tree of entries.
 * @returns {{type:string|null, entries:object[], count:number, dropped:number, highestReturnCode:number|null, drift:object[]}}
 */
export function parseRequestLog(xml) {
  const body = String(xml ?? '');
  const roots = [];
  const stack = [];
  const unknown = new Map();
  let count = 0;
  let dropped = 0;
  let highest = null;
  const type = /<log:type>([^<]*)<\/log:type>/.exec(body)?.[1] ?? null;

  // A message text up to its own closing tag, markup inside it included: a text that carries a
  // tag is still the entry's text, never an entry dropped for having none.
  const tags = body.matchAll(/<log:messageText([^>]*)(?<!\/)>((?:(?!<\/?log:(?:messageText|entry)\b)[\s\S])*)<\/log:messageText>|<(\/?)([\w]+:[\w]+)([^>]*?)(\/?)>/g);
  for (const m of tags) {
    if (m[1] !== undefined) {
      // A message text with content: it belongs to the innermost open entry.
      const top = stack[stack.length - 1];
      if (top) {
        top.text = unescapeXml(m[2].replace(/<[^>]*>/g, '')).replace(/\s{2,}/g, '  ').trim();
        top.key = attr(m[1], 'key') || null;
      }
      continue;
    }
    const [, , , closing, name, rest, selfClosed] = m;
    if (!KNOWN.has(name)) {
      unknown.set(name, (unknown.get(name) ?? 0) + 1);
      continue;
    }
    if (name === 'log:messageText' && !closing) {
      const top = stack[stack.length - 1];
      if (top) top.key = attr(rest, 'key') || null;
      continue;
    }
    if (name !== 'log:entry') continue;
    if (closing) {
      const done = stack.pop();
      if (!done) continue;
      const kept = keep(done);
      const parent = stack[stack.length - 1];
      if (kept) (parent ? parent.children : roots).push(kept);
      continue;
    }
    const entry = { id: attr(rest, 'id'), severity: attr(rest, 'severity'), text: '', key: null, children: [] };
    count += 1;
    if (selfClosed) {
      const kept = keep(entry);
      const parent = stack[stack.length - 1];
      if (kept) (parent ? parent.children : roots).push(kept);
    } else stack.push(entry);
  }

  function keep(entry) {
    if (entry.key === 'TO(009)' || SEPARATOR.test(entry.text) || (!entry.text && !entry.children.length)) {
      dropped += 1;
      return null;
    }
    const rc = RETURN_CODE.exec(entry.text);
    const out = { id: entry.id, severity: entry.severity, text: entry.text };
    if (entry.key) out.key = entry.key;
    if (rc) {
      out.rc = Number(rc[1]);
      highest = highest === null ? out.rc : Math.max(highest, out.rc);
    }
    if (entry.children.length) out.children = entry.children;
    return out;
  }

  const drift = [...unknown].map(([node, n]) => ({ node, attribute: null, count: n }));
  // `count` is every entry of the reply; `dropped` the separators and spacers left out.
  return { type, entries: roots, count, dropped, highestReturnCode: highest, drift };
}
