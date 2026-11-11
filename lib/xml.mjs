// A small XML reader: elements, attributes, text. No dependency, no DTD, no external entity.
//
// It exists because abap-adt-api leaves (docs/security.md, "Removing abap-adt-api") and its
// parsers stood on fast-xml-parser. The ADT answers plain namespaced XML: elements with
// attributes, text, CDATA in source bodies, comments rarely. That is all this reads. A DOCTYPE
// is refused, so no entity can be declared and none is ever expanded beyond the five predefined
// ones and numeric character references.

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** The five predefined entities and numeric references; anything else is left as written. */
export function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITY[e] ?? all;
  });
}

/**
 * Parse a document. Returns the root element: `{name, attrs, children, text}`, where `attrs`
 * holds every attribute as written (decoded) and `text` the concatenated character data of the
 * element itself.
 */
export function parseXml(xml) {
  const s = String(xml ?? '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decode(s.slice(i));
      break;
    }
    if (lt > i) top.text += decode(s.slice(i, lt));
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt);
      if (end < 0) throw new XmlError('unterminated processing instruction');
      i = end + 2;
    } else if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt);
      if (end < 0) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt);
      if (end < 0) throw new XmlError('unterminated CDATA');
      top.text += s.slice(lt + 9, end);
      i = end + 3;
    } else if (s.startsWith('<!', lt)) {
      throw new XmlError('a DOCTYPE or declaration is not read');
    } else if (s[lt + 1] === '/') {
      const end = s.indexOf('>', lt);
      if (end < 0) throw new XmlError('unterminated closing tag');
      const name = s.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError(`closing </${name}> does not match <${open?.name}>`);
      i = end + 1;
    } else {
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(s.slice(lt, lt + 65536));
      if (!m) throw new XmlError(`malformed tag at offset ${lt}`);
      const attrs = {};
      for (const a of m[2].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const el = { name: m[1], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[3]) stack.push(el);
      i = lt + m[0].length;
    }
  }
  if (stack.length !== 1) throw new XmlError(`unclosed <${stack[stack.length - 1].name}>`);
  const elements = root.children;
  if (elements.length !== 1) throw new XmlError(`expected one root element, found ${elements.length}`);
  return elements[0];
}

/** The direct children of `el` named `name`. */
export const childrenOf = (el, name) => (el?.children ?? []).filter((c) => c.name === name);
/** The first direct child of `el` named `name`, or undefined. */
export const childOf = (el, name) => (el?.children ?? []).find((c) => c.name === name);

/**
 * The attributes of `el` the way abap-adt-api handed them out (fast-xml-parser with
 * parseAttributeValue): namespace declarations dropped, `true`/`false` as booleans, a number as
 * a number. Unlike the library, an integer too large to hold exactly stays a string.
 */
export function typedAttrs(el) {
  const out = {};
  for (const [k, v] of Object.entries(el?.attrs ?? {})) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
    out[k] = typedValue(v);
  }
  return out;
}

export function typedValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[-+]?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (/^[-+]?\d*\.\d+([eE][-+]?\d+)?$/.test(v) || /^[-+]?\d+[eE][-+]?\d+$/.test(v)) return Number(v);
  return v;
}
