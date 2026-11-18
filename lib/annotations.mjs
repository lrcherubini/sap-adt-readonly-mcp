// Reading CDS annotations out of source text.
//
// This exists because the ADT `elementinfo` resource returns an empty `annotations`
// array for every node, at every path shape, with the flags `abap-adt-api` sends (see
// docs/adt-api-reference.md). The resource that would answer it properly --
// /sap/bc/adt/ddic/ddlx/annotation/chain -- has no client wrapper, and reaching it
// would need the generic HTTP call the guard refuses. So annotations come from source.
//
// The consequence is that this parser has to survive real SAP source, not tidy source.
// Every rule below was written against a measured file:
//
//   * grouped and ungrouped syntax mixed in one view (`@ObjectModel: { dataCategory:
//     #VALUE_HELP, ... }` next to `@Search.searchable: true`)
//   * `@ObjectModel:{` with no space, and `dataClass:#CUSTOMIZING` with none either
//   * COMMENTED-OUT annotations that must not count: I_PlantVH carries
//     `//@AbapCatalog:{ ... }` and `//@ClientHandling.algorithm:` verbatim, and a
//     parser that ignores comments would read a dead annotation as live
//   * `define view` and `define view entity`, plus DDLX `annotate entity`
//   * fields as `key werks as Plant`, `cast(name1 as werks_name) as PlantName`,
//     `cast(X as t preserving type ) as Y`, bare `PlantName,`, and `_Assoc,`
//   * multi-line array values (`@Consumption.valueHelpDefinition: [ { entity: {...} } ]`)
//
// Values are kept as RAW TEXT, deliberately. A value like `[#VALUE_HELP_PROVIDER,
// #SEARCHABLE_ENTITY]` is matched, not evaluated, and inventing a typed model for
// annotation values would be a second source of truth to keep in sync with the DDLA.

const IDENT = /[A-Za-z0-9_]/;

/**
 * Remove comments, preserving string literals and the byte offsets of everything
 * else (comments become spaces) so positions stay comparable to the original.
 */
export function stripComments(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === "'") {
      // CDS string literal: '' is an escaped quote.
      out.push(c);
      i++;
      while (i < n) {
        if (source[i] === "'" && source[i + 1] === "'") {
          out.push("''");
          i += 2;
          continue;
        }
        out.push(source[i]);
        if (source[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (c === '-' && source[i + 1] === '-') {
      // The SQL-style comment. Measured to be in production use alongside `//` --
      // zdemo_assort writes `--`, zdemo_roster writes `//`, and one file carries an
      // `as select from` inside a comment that a parser ignoring this would read as a
      // live data source.
      while (i < n && source[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (c === '*' && (i === 0 || source[i - 1] === '\n')) {
      // A line starting with * is a comment in DDL as well.
      while (i < n && source[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(source[i] === '\n' ? '\n' : ' ');
        i++;
      }
      out.push('  ');
      i += 2;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * Read a CDS string literal starting at the opening quote. Returns [text, nextIndex].
 * This cannot be readBalanced: with the same character opening and closing it, depth
 * counting never comes back down -- which silently swallowed the rest of the source
 * and made a whole view parse as a single element.
 */
function readLiteral(s, i) {
  const start = i;
  i++;
  while (i < s.length) {
    if (s[i] === "'" && s[i + 1] === "'") {
      i += 2;
      continue;
    }
    if (s[i] === "'") return [s.slice(start, i + 1), i + 1];
    i++;
  }
  return [s.slice(start), s.length];
}

/** Skip whitespace from `i`. */
const skipWs = (s, i) => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/** Read a balanced run starting at an opening bracket. Returns [text, nextIndex]. */
function readBalanced(s, i, open, close) {
  let depth = 0;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      [, i] = readLiteral(s, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [s.slice(start, i + 1), i + 1];
    }
    i++;
  }
  return [s.slice(start), s.length];
}

/**
 * Parse the inside of a `{ ... }` annotation group into flattened dotted keys.
 * `{ usageType: { sizeCategory: #S }, dataCategory: #VALUE_HELP }` with prefix
 * `ObjectModel` yields ObjectModel.usageType.sizeCategory and
 * ObjectModel.dataCategory.
 */
function flattenGroup(inner, prefix, into) {
  let i = 0;
  while (i < inner.length) {
    i = skipWs(inner, i);
    if (i >= inner.length) break;
    if (inner[i] === ',') {
      i++;
      continue;
    }
    let key = '';
    while (i < inner.length && (IDENT.test(inner[i]) || inner[i] === '.')) key += inner[i++];
    if (!key) {
      i++;
      continue;
    }
    i = skipWs(inner, i);
    if (inner[i] !== ':') {
      // A key with no value: record it as present, do not guess a value.
      into[`${prefix}.${key}`] = '';
      continue;
    }
    i++; // ':'
    i = skipWs(inner, i);
    if (inner[i] === '{') {
      const [block, next] = readBalanced(inner, i, '{', '}');
      flattenGroup(block.slice(1, -1), `${prefix}.${key}`, into);
      i = next;
      continue;
    }
    if (inner[i] === '[') {
      const [arr, next] = readBalanced(inner, i, '[', ']');
      into[`${prefix}.${key}`] = arr.replace(/\s+/g, ' ').trim();
      i = next;
      continue;
    }
    let value = '';
    while (i < inner.length && inner[i] !== ',' && inner[i] !== '\n') {
      if (inner[i] === "'") {
        const [lit, next] = readLiteral(inner, i);
        value += lit;
        i = next;
        continue;
      }
      value += inner[i++];
    }
    into[`${prefix}.${key}`] = value.trim();
  }
  return into;
}

/**
 * Parse one annotation starting at `@`. Returns [{key: value, ...}, nextIndex] with
 * keys already flattened.
 */
function parseOne(s, i) {
  i++; // '@'
  let path = '';
  while (i < s.length && (IDENT.test(s[i]) || s[i] === '.')) path += s[i++];
  const found = {};
  i = skipWs(s, i);
  if (s[i] !== ':') {
    found[path] = '';
    return [found, i];
  }
  i++;
  i = skipWs(s, i);
  if (s[i] === '{') {
    const [block, next] = readBalanced(s, i, '{', '}');
    flattenGroup(block.slice(1, -1), path, found);
    return [found, next];
  }
  if (s[i] === '[') {
    const [arr, next] = readBalanced(s, i, '[', ']');
    found[path] = arr.replace(/\s+/g, ' ').trim();
    return [found, next];
  }
  let value = '';
  while (i < s.length && s[i] !== '\n') {
    if (s[i] === "'") {
      const [lit, next] = readLiteral(s, i);
      value += lit;
      i = next;
      continue;
    }
    value += s[i++];
  }
  return [{ [path]: value.trim() }, i];
}

/**
 * Where the element block starts, counting from just after the header.
 *
 * NOT `indexOf('{')`. That assumed the first brace after the header opens the element
 * block, and a brace can just as well belong to the VALUE of an annotation -- which is
 * exactly what a `parameters` clause allows, since it is the one place in the grammar
 * where an annotation legitimately precedes the element block. Measured:
 * three DDLX of the workspace parsed to ZERO elements while declaring 9 to 16, because
 * the search landed inside `@Consumption.valueHelpDefinition: [{ entity: { ... } }]`.
 *
 * The parameters clause is not the culprit and is not special-cased -- it parses fine on
 * its own. Any annotation with a structured value sitting there breaks the naive search,
 * today `@Consumption.valueHelpDefinition`, tomorrow `@ObjectModel` or `@EndUserText`.
 * So the walk consumes annotations with parseOne (which already knows how to read a
 * `{...}` or `[...]` value whole) and only then believes a brace.
 *
 * @returns index of the opening brace, or -1
 */
function elementBlockAt(text) {
  let i = 0;
  while (i < text.length) {
    i = skipWs(text, i);
    if (i >= text.length) break;
    const c = text[i];
    if (c === '@') {
      const [, next] = parseOne(text, i);
      i = next > i ? next : i + 1;
      continue;
    }
    // A literal can carry a brace of its own ('a { b'), and `default 'x'` puts one here.
    if (c === "'") {
      const [, next] = readLiteral(text, i);
      i = next > i ? next : i + 1;
      continue;
    }
    if (c === '{') return i;
    i++;
  }
  return -1;
}

/** The header that separates entity annotations from element annotations. */
const HEADER =
  /\b(define\s+(?:root\s+)?(?:view\s+entity|view|abstract\s+entity|table\s+function|custom\s+entity|hierarchy)|annotate\s+(?:view|entity))\s+([A-Za-z_]\w*)/;

/**
 * Split the element part of a view body into statements. Commas and semicolons at
 * depth zero end a statement; parentheses, braces and brackets nest.
 */
function splitStatements(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") {
      const [lit, next] = readLiteral(body, i);
      cur += lit;
      i = next - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if ((c === ',' || c === ';') && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Drop the leading annotations of a statement, leaving the expression. Done by
 * parsing them rather than by regex: an annotation value can contain braces,
 * brackets, quoted text and newlines, and a regex that tries to skip one either
 * stops too early or eats the field name after it.
 */
function withoutAnnotations(statement) {
  let i = 0;
  for (;;) {
    i = skipWs(statement, i);
    if (statement[i] !== '@') return statement.slice(i);
    [, i] = parseOne(statement, i);
  }
}

/**
 * The name an element is known by. The alias after `as` wins; `key` is stripped;
 * `Mon.Bukrs` keeps only `Bukrs`; an expression with no alias and no plain name
 * yields undefined rather than a guess.
 */
export function elementName(statement) {
  const expr = withoutAnnotations(statement).trim();
  const alias = expr.match(/\bas\s+([A-Za-z_]\w*)\s*$/);
  if (alias) return alias[1];
  const plain = expr
    .replace(/^\s*(key|virtual)\s+/i, '')
    .replace(/^@\S+\s*/, '')
    .trim();
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)?$/.test(plain)) {
    const parts = plain.split('.');
    return parts[parts.length - 1];
  }
  return undefined;
}

/**
 * Where an element's value comes from, which decides whether an annotation written on a data
 * source can reach it:
 *
 *   field      `X`, `src.X`, `X as Y`: the element of a data source named `field` (X). Upstream
 *              annotations travel along it, under the upstream name.
 *   parameter  `$parameters.p` or `:p`. Measured on 2026-11-17 (docs/adt-api-reference.md): the
 *              chain of such an element holds only its own type's labels, nothing from the data
 *              source, even with a same-named element there and no ignorePropagatedAnnotations.
 *   cast       `cast( X as T [preserving type] )` with a plain field operand: `field` is X.
 *   case       a `case ... end`.
 *              Measured on 2026-11-18 (docs/adt-api-reference.md): neither receives anything
 *              written above for its operand, with or without `preserving type`.
 *   expression everything else -- a literal, `$session`, arithmetic, a function, a cast of
 *              anything but a field, a path through an association (`_Assoc.X`). What travels
 *              through these was never measured, so the caller says "not verified".
 */
export function elementOrigin(statement) {
  const expr = withoutAnnotations(statement)
    .trim()
    .replace(/^(key|virtual)\s+/i, '')
    .replace(/\s+as\s+[A-Za-z_]\w*\s*$/i, '')
    .trim();
  return originOf(expr);
}

const CAST = /^cast\s*\(\s*([\s\S]+?)\s+as\s+[A-Za-z_][\w./()]*?(\s+preserving\s+type)?\s*\)$/i;

function originOf(expr) {
  if (/^(\$parameters\.|:)[A-Za-z_]\w*$/i.test(expr)) return { kind: 'parameter' };
  const ref = expr.match(/^(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)$/);
  if (ref && !ref[1]?.startsWith('_')) return { kind: 'field', field: ref[2] };
  const cast = expr.match(CAST);
  if (cast) {
    // The operand is followed above, so the rows written for it are listed as the ones that do
    // not reach. A nested cast takes the innermost field; any other operand stays an expression.
    const inner = originOf(cast[1].trim());
    const field = inner.kind === 'field' || inner.kind === 'cast' ? inner.field : undefined;
    if (field) return { kind: 'cast', field, preservingType: Boolean(cast[2]) || Boolean(inner.preservingType) };
  }
  if (/^case\b/i.test(expr)) return { kind: 'case' };
  return { kind: 'expression' };
}

/**
 * Parse a CDS source into its annotations.
 *
 * @returns {{name?: string, kind: string, entity: Record<string,string>,
 *            elements: Record<string, Record<string,string>>,
 *            origins: Record<string, {kind:string, field?:string}>,
 *            source: {from?: string}}}
 */
export function parseAnnotations(source) {
  const s = stripComments(source);
  const header = s.match(HEADER);
  const headerAt = header ? header.index : s.length;

  const entity = {};
  let i = 0;
  while (i < headerAt) {
    i = skipWs(s, i);
    if (i >= headerAt) break;
    if (s[i] === '@') {
      const [found, next] = parseOne(s, i);
      Object.assign(entity, found);
      i = next;
      continue;
    }
    i++;
  }

  const elements = {};
  const origins = {};
  let name;
  let kind = 'unknown';
  const from = {};
  if (header) {
    name = header[2];
    kind = header[1].replace(/\s+/g, ' ').toLowerCase();
    const afterHeader = s.slice(headerAt + header[0].length);
    const fromMatch = afterHeader.match(/\bas\s+select\s+(?:distinct\s+)?from\s+([A-Za-z_]\w*)/i);
    if (fromMatch) from.from = fromMatch[1];
    const braceAt = elementBlockAt(afterHeader);
    if (braceAt >= 0) {
      const [block] = readBalanced(afterHeader, braceAt, '{', '}');
      for (const statement of splitStatements(block.slice(1, -1))) {
        const annos = {};
        let j = 0;
        while (j < statement.length) {
          j = skipWs(statement, j);
          if (statement[j] === '@') {
            const [found, next] = parseOne(statement, j);
            Object.assign(annos, found);
            j = next;
            continue;
          }
          break;
        }
        const el = elementName(statement);
        if (!el) continue;
        elements[el] = { ...(elements[el] ?? {}), ...annos };
        origins[el] ??= elementOrigin(statement);
      }
    }
  }

  // A parse that read nothing off a source which plainly declares elements is a parser
  // gap, not an annotation-free view -- and the two are indistinguishable to every caller
  // downstream, which is how the `indexOf('{')` defect above survived. Saying so is the
  // whole point: `unread` lets a tool journal CDS_PARSE_EMPTY instead of answering
  // "no signal" about a file it failed to read. Counting element-shaped lines is a
  // deliberately dumb heuristic -- it only has to be right about "this is not empty".
  const declaresElements = header
    ? (stripComments(source).match(/^[ 	]*[A-Za-z_]\w*[ 	]*;[ 	]*$/gm) ?? []).length
    : 0;
  const unread = Object.keys(elements).length === 0 && declaresElements > 2;

  return { name, kind, entity, elements, origins, source: from, unread, declaresElements };
}

/** Every `#TOKEN` inside a raw annotation value, uppercased. */
export const enumTokens = (raw) =>
  [...String(raw ?? '').matchAll(/#([A-Za-z0-9_]+)/g)].map((m) => m[1].toUpperCase());

/** A quoted literal's content, or undefined. */
export const literal = (raw) => {
  const m = String(raw ?? '').match(/^'(.*)'$/s);
  return m ? m[1].replace(/''/g, "'") : undefined;
};

/** `true` only for the literal boolean, so a missing annotation never reads as true. */
export const isTrue = (raw) => String(raw ?? '').trim().toLowerCase() === 'true';
