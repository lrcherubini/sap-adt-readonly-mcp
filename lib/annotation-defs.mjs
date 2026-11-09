// What does this system say about the annotation I am about to emit?
//
// Emitting `@Consumption.valueHelpDefinition` correctly is not a formatting problem: two
// of its sub-annotations are NOT released in this release, and pointing an app at them is
// a Clean Core violation that no local check catches. So every key is looked up before it
// is written, in ONE source: `fromDdla(text)`, the DDLA of THIS system, from ADT
// `annotationDefinitions()`. Authoritative, because the release is the system's own.
// Measured shape (docs/adt-api-reference.md), 182,092 characters, of which the top is:
//
//   @Scope:[#VIEW, #TABLE_FUNCTION, #HIERARCHY]
//   annotation AccessControl {
//     @API.state: [#RELEASED_FOR_KEY_USER_APPS, #RELEASED_FOR_SAP_CLOUD_PLATFORM]
//     authorizationCheck : String(20) enum { NOT_REQUIRED; ... } default #NOT_REQUIRED;
//
// The nested forms (`x : { ... }`, `x : array of { ... }`) were confirmed by
// `npm run measure:ddla`: 31 of 31 roots and 1,027 keys after the scalar-root fix.
//
// An offline copy of the ABAP Keyword Documentation used to stand behind it, per key. It was
// removed: it describes ONE release, the system describes its own. When the DDLA cannot be read
// the answer is `unknown`, and the caller emits with a stated warning. Silence is the one
// outcome forbidden here: an unvalidated annotation that looks validated is worse than no check.

/** The API state that means "usable in our own code" (ABAP Cloud / SCP contract). */
export const SCP = 'RELEASED_FOR_SAP_CLOUD_PLATFORM';
/** Key User apps only -- released, but not for code we write. */
export const KEY_USER = 'RELEASED_FOR_KEY_USER_APPS';

/**
 * Lookup key for an annotation path: array markers dropped, case folded.
 * `Consumption.valueHelpDefinition[ ].entity.name`,
 * `Consumption.valueHelpDefinition[0].entity.name` and
 * `consumption.valuehelpdefinition.entity.name` are the same annotation.
 */
export const normalizeKey = (key) =>
  String(key ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase();

// The DDLA decorates its token lists with `#` and the brackets of an array literal (and a
// backtick is tolerated). Brackets are separators here, not content.
const tokens = (text) =>
  String(text ?? '')
    .split(/[\s,;|[\]]+/)
    .map((t) => t.replace(/^[#`]+|`+$/g, '').trim())
    .filter((t) => t && t !== '-')
    .map((t) => t.toUpperCase());

/** Build the queryable object the parser returns. */
function defsFrom(map, source, note = null) {
  const get = (key) => map.get(normalizeKey(key));
  return {
    source,
    note,
    count: map.size,
    available: map.size > 0,
    keys: () => [...map.keys()],
    def: get,
    has: (key) => !!get(key),
    scopes: (key) => get(key)?.scopes ?? [],
    apiStates: (key) => get(key)?.apiStates ?? [],
    enums: (key) => get(key)?.enums ?? [],
    /**
     * Released for code we write ourselves. Key User only is deliberately NOT enough:
     * `Consumption.valueHelp` (singular) carries exactly that and must not be emitted.
     */
    usableInOwnCode: (key) => (get(key)?.apiStates ?? []).includes(SCP),
    /** Why a key cannot be emitted, or null when it can. `undefined` = key unknown. */
    refusalReason: (key) => {
      const d = get(key);
      if (!d) return undefined;
      if (d.apiStates.includes(SCP)) return null;
      if (d.apiStates.includes(KEY_USER)) {
        return `it is released for Key User apps only (${d.apiStates.join(', ')}), not for own code`;
      }
      return 'it is not released (API state is empty in this release)';
    },
  };
}

/** A defs object that answers nothing, carrying the reason it is empty. */
export const noDefs = (note) => defsFrom(new Map(), 'none', note);

// --- DDLA (the system's own annotation definitions) ---------------------------------

/** `@Scope:[#VIEW, #ELEMENT]` / `@API.state: [#RELEASED_FOR_...]` sitting above a member. */
// The `@` is optional because the callers below consume it before slicing.
const ANNOTATION_LINE = /^@?([A-Za-z][A-Za-z0-9.]*)\s*:?\s*([\s\S]*)$/;

/**
 * Parse a DDLA text into the queryable definitions.
 *
 * Handles the three member forms: a leaf (`name : Type ... ;`), a group
 * (`name { ... }` or `name : { ... }`) and an array of a group
 * (`name : array of { ... }`). `@Scope` and `@API.state` are inherited by a member that
 * does not restate them, which is how the DDLA is written.
 *
 * @param {string} text output of ADTClient.annotationDefinitions()
 */
export function fromDdla(text) {
  const src = String(text ?? '');
  const map = new Map();
  let i = 0;

  const skipTrivia = () => {
    for (;;) {
      const before = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
      }
      if (i === before) return;
    }
  };

  /** Read one `@...` line, returning [name, value]. */
  const readAnnotation = () => {
    const start = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === '\n' && depth <= 0) break;
      i++;
    }
    const m = ANNOTATION_LINE.exec(src.slice(start, i).trim());
    return m ? [m[1], m[2]] : null;
  };

  /** Read an identifier. */
  const readName = () => {
    const start = i;
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
    return src.slice(start, i);
  };

  /**
   * Parse the body of a group, recording every leaf reached.
   * @param {string[]} path enclosing annotation names
   * @param {{scopes:string[], apiStates:string[]}} inherited
   */
  /**
   * Consume a declaration from `i` up to its terminating `;`, balancing the braces of an
   * inline `enum { ... }` so the enum body is not mistaken for the end of a group.
   */
  const readDecl = () => {
    const start = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ';' && depth === 0) break;
      i++;
    }
    const decl = src.slice(start, i).trim();
    if (src[i] === ';') i++;
    return decl;
  };

  /** Register one annotation key from its declaration text. First occurrence wins. */
  const defineLeaf = (path, decl, here) => {
    const full = path.join('.');
    const key = normalizeKey(full);
    if (map.has(key)) return;
    const enumBody = /enum\s*\{([^}]*)\}/i.exec(decl);
    map.set(key, {
      key,
      annotation: full,
      scopes: here.scopes ?? [],
      type: (decl.split(/\s+/)[0] ?? '').replace(/[:;]/g, ''),
      // Strip `//` comments before tokenising: the DDLA documents enum members inline
      // (`ENTITY;  // in front of DEFINE ...`), and letting those words through would
      // register prose as valid enum values -- which makes validation PERMISSIVE, the
      // worst direction for a check to fail in. Observed on `Scope` in the measured DDLA.
      enums: enumBody ? tokens(enumBody[1].replace(/\/\/[^\n]*/g, ' ')) : [],
      default: /default\s*#?([A-Za-z0-9_]+)/i.exec(decl)?.[1] ?? '-',
      apiStates: here.apiStates ?? [],
      from: "this system's DDLA, via ADT annotationDefinitions()",
    });
  };

  const parseBody = (path, inherited) => {
    let pending = { scopes: null, apiStates: null };
    for (;;) {
      skipTrivia();
      if (i >= src.length) return;
      if (src[i] === '}') {
        i++;
        return;
      }
      if (src[i] === '@') {
        i++;
        const ann = readAnnotation();
        if (ann) {
          const [name, value] = ann;
          if (/^scope$/i.test(name)) pending.scopes = tokens(value);
          else if (/^api\.state$/i.test(name)) pending.apiStates = tokens(value);
        }
        continue;
      }
      if (src[i] === ';' || src[i] === ',') {
        i++;
        continue;
      }
      const name = readName();
      if (!name) {
        i++; // never spin on an unexpected character
        continue;
      }
      const here = {
        scopes: pending.scopes ?? inherited.scopes,
        apiStates: pending.apiStates ?? inherited.apiStates,
      };
      pending = { scopes: null, apiStates: null };

      skipTrivia();
      // `name : ...` or `name { ... }`
      let isGroup = false;
      if (src[i] === ':') {
        i++;
        skipTrivia();
        const arrayOf = /^array\s+of\s*/i.exec(src.slice(i, i + 24));
        if (arrayOf) {
          i += arrayOf[0].length;
          skipTrivia();
        }
        isGroup = src[i] === '{';
      } else if (src[i] === '{') {
        isGroup = true;
      }

      if (isGroup) {
        i++; // past the opening brace
        parseBody([...path, name], here);
        continue;
      }

      // A leaf: read its declaration and register it.
      defineLeaf([...path, name], readDecl(), here);
    }
  };

  // Top level: a sequence of `[@annotations] annotation <Name> { ... }` blocks.
  for (;;) {
    skipTrivia();
    if (i >= src.length) break;
    let scopes = null;
    let apiStates = null;
    while (src[i] === '@') {
      i++;
      const ann = readAnnotation();
      if (ann) {
        if (/^scope$/i.test(ann[0])) scopes = tokens(ann[1]);
        else if (/^api\.state$/i.test(ann[0])) apiStates = tokens(ann[1]);
      }
      skipTrivia();
    }
    const kw = /^(define\s+)?annotation\s+/i.exec(src.slice(i));
    if (!kw) {
      i++; // not a block start; keep scanning
      continue;
    }
    i += kw[0].length;
    skipTrivia();
    const root = readName();
    skipTrivia();

    // A SCALAR annotation root: `annotation Feature : String(1024);`, with no body block.
    // Measured on the system 2026-09-09: four of the 31 roots in this system's DDLA are declared
    // this way -- Feature, MappingRole, DefaultAggregation and Scope -- and the parser
    // used to drop them whole, along with their @Scope and @API.state. The consequence was
    // not a missing row: `defs.has('Feature')` answered false, so the caller reported "not
    // a known annotation" about an annotation this system defines. `MappingRole` puts the
    // `:` on the NEXT line, so this must be checked after skipTrivia, never on the same
    // line as the name.
    if (src[i] === ':') {
      i++;
      skipTrivia();
      const arrayOf = /^array\s+of\s*/i.exec(src.slice(i, i + 24));
      if (arrayOf) {
        i += arrayOf[0].length;
        skipTrivia();
      }
      if (src[i] !== '{') {
        defineLeaf([root], readDecl(), { scopes: scopes ?? [], apiStates: apiStates ?? [] });
        continue;
      }
    }

    if (src[i] !== '{') continue;
    i++;
    parseBody([root], { scopes: scopes ?? [], apiStates: apiStates ?? [] });
  }

  return defsFrom(map, 'system DDLA');
}
