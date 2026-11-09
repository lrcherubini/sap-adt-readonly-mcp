// What has already been bound to what: the value-help edges of a CDS source.
//
// The most useful evidence for "which value help does this field want" is not a rule -- it is
// what a source already binds. adt_value_help reads that from the system: the analysed entity's
// own source (which fields are already covered) and, opt-in, the source of another consumer of
// the recommended value help (to copy its additionalBinding instead of inventing one).
//
// It does not treat another consumer as a rule: it is quoted as a precedent with its object and
// line, never as a norm.
//
// Element attribution is positional, because that is how CDS works: annotations precede
// the element they belong to. The same parser therefore serves a view source and a plain-text
// excerpt, which a view parser would choke on.

import { stripComments, elementName } from './annotations.mjs';

/** Read a balanced `[...]` or `{...}` starting at `from`, returning [text, end]. */
function readBalanced(text, from, open, close) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      i++;
      while (i < text.length && !(text[i] === "'" && text[i + 1] !== "'")) {
        i += text[i] === "'" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [text.slice(from, i + 1), i + 1];
    }
    i++;
  }
  return [text.slice(from), text.length];
}

/**
 * The records inside a `valueHelpDefinition` value.
 *
 * Values stay raw text, as in lib/annotations.mjs: `element: 'grund'` keeps its lower
 * case, and nothing is normalised into a shape SAP did not write.
 *
 * @param {string} raw e.g. `[{ entity: { name: 'ZI_X', element: 'Stcd2' } }]`
 */
export function parseVhdValue(raw) {
  const text = String(raw ?? '');
  const out = [];
  let i = text.indexOf('{');
  while (i >= 0) {
    const [block, end] = readBalanced(text, i, '{', '}');
    // additionalBinding is a nested array of records; take it out before reading the
    // scalars, so its own `element:` is not read as the entity's.
    const bindings = [];
    const abAt = block.search(/additionalBinding\s*:/i);
    let scalars = block;
    if (abAt >= 0) {
      const bracket = block.indexOf('[', abAt);
      if (bracket >= 0) {
        const [arr, arrEnd] = readBalanced(block, bracket, '[', ']');
        scalars = block.slice(0, abAt) + block.slice(arrEnd);
        let j = arr.indexOf('{');
        while (j >= 0) {
          const [b, bEnd] = readBalanced(arr, j, '{', '}');
          const rec = {};
          for (const [, k, v] of b.matchAll(/([A-Za-z]\w*)\s*:\s*('(?:[^']|'')*'|#\w+|\w+)/g)) {
            rec[k] = v.replace(/^'|'$/g, '').replace(/''/g, "'");
          }
          if (Object.keys(rec).length) bindings.push(rec);
          j = arr.indexOf('{', bEnd);
        }
      }
    }
    const entityBlock = /entity\s*:\s*\{([^}]*)\}/i.exec(scalars);
    const pick = (src, key) =>
      new RegExp(`${key}\\s*:\\s*'((?:[^']|'')*)'`, 'i').exec(src ?? '')?.[1]?.replace(/''/g, "'");
    const rec = {
      entity: {
        name: pick(entityBlock?.[1], 'name'),
        element: pick(entityBlock?.[1], 'element'),
      },
      ...(bindings.length ? { additionalBinding: bindings } : {}),
    };
    for (const key of ['qualifier', 'label', 'presentationVariantQualifier']) {
      const v = pick(scalars.replace(/entity\s*:\s*\{[^}]*\}/i, ''), key);
      if (v !== undefined) rec[key] = v;
    }
    if (rec.entity.name) out.push(rec);
    i = text.indexOf('{', end);
  }
  return out;
}

/**
 * Every `valueHelpDefinition` edge in one text, with the element each belongs to.
 *
 * @param {string} source file contents (CDS source or a text dump of one)
 * @param {string} [file] shown in the citation
 * @returns {{file?:string, line:number, element:string|null, entity:string,
 *            entityElement?:string, additionalBinding?:object[], raw:string}[]}
 */
export function edgesFromText(source, file) {
  const s = stripComments(String(source ?? ''));
  const out = [];
  const re = /@\s*Consumption\.valueHelpDefinition\s*:/gi;
  for (const m of s.matchAll(re)) {
    const valueAt = s.indexOf('[', m.index + m[0].length - 1);
    if (valueAt < 0) continue;
    const [raw, end] = readBalanced(s, valueAt, '[', ']');

    // The element this annotation belongs to is the next one declared: skip any further
    // annotations, then read up to the statement separator.
    let j = end;
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] !== '@') break;
      const nextValue = s.slice(j).search(/[\n;]/);
      if (nextValue < 0) break;
      // An annotation value can itself be a block: step over it if one starts first.
      const brace = s.indexOf('{', j);
      const bracket = s.indexOf('[', j);
      const nl = j + nextValue;
      const first = [brace, bracket].filter((p) => p > j && p < nl).sort((a, b) => a - b)[0];
      if (first !== undefined) {
        const [, after] = readBalanced(s, first, s[first], s[first] === '{' ? '}' : ']');
        j = after;
      } else {
        j = nl + 1;
      }
    }
    const stop = (() => {
      let k = j;
      let depth = 0;
      while (k < s.length) {
        const c = s[k];
        // A `{` at depth 0 opens the select list or the DDLX body -- it ends the
        // statement, it is not part of it. That is the DDLX parameter case:
        // `parameters @... p_channel` and then `{` on the next line.
        if (c === '{' && depth === 0) break;
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') {
          if (depth === 0) break;
          depth--;
        } else if (c === ',' && depth === 0) break;
        k++;
      }
      return k;
    })();
    const statement = s.slice(j, stop);
    // A PARAMETER is declared `P_Plant : werks_d` (or, in a DDLX, is a bare name under
    // `parameters`), which is not a select-list element and elementName does not see it.
    // Five of a measured workspace's edges sit on parameters, so this is the common case, not
    // an edge case -- and the two forms are reported apart, because a binding copied
    // from a parameter to an element is not the same annotation.
    const asParameter = /^\s*([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_$]|$)/.exec(statement.trim());
    // elementName returns '' (not null) when it finds no select-list element, so `??`
    // would keep the empty string and the parameter form would never be tried.
    const asElement = elementName(statement) || null;
    const element = asElement ?? asParameter?.[1] ?? null;
    // In a DDLX a parameter is a bare name, indistinguishable from an element by shape
    // alone -- `p_channel` reads as both. What separates them is position: everything
    // between the `parameters` keyword and the `{` that opens the body is a parameter.
    const before = s.slice(0, m.index);
    const inParameters = before.search(/\bparameters\b(?![\s\S]*\{)/i) >= 0;
    const kind = inParameters || (!asElement && asParameter) ? 'parameter'
      : asElement ? 'element'
      : 'unknown';
    const line = s.slice(0, m.index).split('\n').length;

    for (const rec of parseVhdValue(raw)) {
      out.push({
        ...(file ? { file } : {}),
        line,
        element,
        kind,
        entity: rec.entity.name,
        entityElement: rec.entity.element,
        ...(rec.additionalBinding ? { additionalBinding: rec.additionalBinding } : {}),
        ...(rec.qualifier ? { qualifier: rec.qualifier } : {}),
        raw: raw.replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return out;
}
