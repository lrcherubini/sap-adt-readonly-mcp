// The DDIC header of a table, read out of the source ADT returns for a `TABL/DT`.
//
// WHY THIS EXISTS, AND WHAT IT IS NOT. It is evidence for a human deciding whether a table
// belongs in `CUSTOMIZING_TABLES` (lib/data-preview.mjs) -- never a gate. The proposal to
// replace that closed list with a RULE ("any delivery class C table, any Z*/Y*") was measured
// on 2026-09-22 and refused; docs/security.md carries the record. Two measurements killed it:
//
//   - the rule does not even cover the list that exists: `T683S` is `C`, but `TFRM` and
//     `TVCPA` are `G` and `T681` is `W` (a SYSTEM table);
//   - delivery class `C` does not mean "configuration, not business data": a customer table of
//     class `C` can carry first and last name, date of birth, gender and ethnicity -- personal
//     data, some of it sensitive under any data-protection law.
//
// So: no verdict here classifies personal data, and none ever should by a name heuristic.
// A table named after an HR infotype can hold harmless constants, and a table with a harmless
// name can hold sensitive personal data. THE NAME PROVES
// NOTHING, IN EITHER DIRECTION. What this module does is print the fields so a reviewer reads
// them, and refuse the two classes that are business data BY DEFINITION.
//
// MEASURED 2026-09-22 on the development system -- `adt_read_source` on a `TABL/DT` returns the DDIC source
// with the header annotations: `@EndUserText.label`, `@AbapCatalog.tableCategory`,
// `@AbapCatalog.deliveryClass`, `@AbapCatalog.dataMaintenance`,
// `@AbapCatalog.enhancement.category`, then `define table <name> { ... }`.

/** CONTFLAG, as the SAP fixed values read -- what the class actually promises about content. */
export const DELIVERY_CLASSES = new Map([
  ['A', 'Application table (master and transaction data)'],
  ['C', 'Customizing table, maintenance only by customer, not SAP import'],
  ['L', 'Table for storing temporary data, delivered empty'],
  ['G', 'Customizing table, protected against SAP Upd., only INS allowed'],
  ['E', 'Control table, SAP and customer have separate key areas'],
  ['S', 'System table, maint. only by SAP, change = modification'],
  ['W', 'System table, contents transportable via separate TR objects'],
]);

/** The classes that ARE business data by definition: no review can make them customizing. */
export const REFUSED_CLASSES = new Set(['A', 'L']);

const annotation = (source, name) => {
  const m = new RegExp(`@${name.replace(/\./g, '\\.')}\\s*:\\s*(?:#([A-Z_]+)|'([^']*)'|(\\S+))`).exec(source);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
};

/**
 * Header + field list of a DDIC table source. Every value is `null` when the annotation is
 * NOT in the source -- never a default. A `deliveryClass` of `null` means *not read*, which is
 * a different answer from any class, and the caller has to say so rather than assume `A`.
 *
 * @param {string} source the DDIC source as `adt_read_source` returns it for a `TABL/DT`
 * @returns {{kind: 'table'|'structure'|null, name: string|null, label: string|null, tableCategory: string|null,
 *            deliveryClass: string|null, deliveryClassText: string|null,
 *            dataMaintenance: string|null, enhancementCategory: string|null,
 *            fields: Array<{name: string, type: string, isKey: boolean}>,
 *            includes: string[]}}
 *
 * `includes` names the structures the table pulls fields in from. Those fields are NOT in
 * `fields`, and a caller that prints the list without saying so shows a short list that reads
 * as the whole table.
 */
export function parseTableMeta(source) {
  const s = String(source ?? '');
  const deliveryClass = annotation(s, 'AbapCatalog.deliveryClass');
  // Three DDL forms reach this parser, and the third one carries the answer this module exists
  // for:
  //
  //   define table <n> { ... }           a table
  //   define structure <n> { ... }       a structure, an include structure included
  //   extend type <t> with <n> { ... }   an APPEND -- measured on CRMS4_BP_KNA1,
  //                                      ZZ1_DEMO7X2KQ9MBT4WPL3RNCY8HFA and ZDEMO_STR_EXIT
  //
  // The third was missing while no route could name an append, and its absence failed in the
  // worst available way: the append resolved, its source came back, and the field list parsed
  // EMPTY -- so the report printed a named append with no fields under it, which reads as an
  // append that adds nothing.
  const define =
    /define\s+(table|structure)\s+([a-zA-Z0-9_\/]+)\s*\{([\s\S]*)\}/.exec(s) ??
    (() => {
      const e = /extend\s+type\s+([a-zA-Z0-9_\/]+)\s+with\s+([a-zA-Z0-9_\/]+)\s*\{([\s\S]*)\}/.exec(s);
      // Shaped exactly like the `define` match so nothing downstream changes; the object it
      // extends rides along as a property and is returned separately.
      return e ? Object.assign(['', 'append', e[2], e[3]], { extendsTarget: e[1] }) : null;
    })();

  const fields = [];
  const includes = [];
  if (define) {
    // Annotation lines carry `:` too (`@AbapCatalog.foreignKey.keyType : #KEY`) and end with no
    // `;`, so they would glue onto the next statement. Drop them before splitting.
    const body = define[3]
      .split('\n')
      .filter((line) => !line.trim().startsWith('@'))
      .join('\n');
    for (const chunk of body.split(';')) {
      // The declaration is the first line of the statement; `with foreign key` / `where` lines
      // that follow it inside the same statement carry `=`, not `:`, and never match.
      for (const line of chunk.split('\n')) {
        // An include brings fields in from elsewhere, and they are NOT in this source. VBAK
        // has eight of them (`include vbak_status;`, `tech_fields : include vbak_tech_fields;`).
        // Both forms are recorded so the caller can say the field list is incomplete instead of
        // printing a short one that reads as the whole table -- an append is exactly where a Z
        // field nobody remembers would be hiding.
        // NOT anchored at the end, and that is the whole point: KNA1 declares
        // `include si_kna1 not null;` and SI_KNA1 declares `include kna1brazil extend crtn : ...`.
        // An end-anchored pattern matched neither, so the biggest include of KNA1 (~150 fields)
        // was dropped in SILENCE -- neither a field nor a reported include. Measured.
        // The alias may be QUOTED, and then it is not an identifier at all: the RAP draft
        // generator writes `"%admin" : include sych_bdl_draft_admin_inc;`. An alias pattern made
        // of identifier characters matched neither that form nor the bare one, so six draft
        // fields were dropped in silence -- present in the DDIC, absent from the source list, and
        // then reported as "from outside the source", which names the wrong mechanism entirely.
        // Measured: ZDEMO_INVMAP_D writes it quoted, ZDEMO_CTR_MAN_D does not.
        const inc = /^\s*(?:(?:"[^"]*"|[a-zA-Z0-9_\/]+)\s*:\s*)?include\s+([a-zA-Z0-9_\/]+)\b/.exec(line.trim());
        if (inc) {
          includes.push(inc[1].toUpperCase());
          break;
        }
        // The length belongs to the type: a Z table often types its fields on a built-in
        // (`invoice : abap.char(20)`) instead of a data element, and `ABAP.CHAR` without the 20
        // tells a reviewer less than the source did.
        const m = /^\s*(key\s+)?([a-zA-Z0-9_\/]+)\s*:\s*([a-zA-Z0-9_\/.]+(?:\([0-9, ]+\))?)/.exec(line);
        if (m) {
          fields.push({ name: m[2].toUpperCase(), type: m[3].toUpperCase(), isKey: Boolean(m[1]) });
          break;
        }
      }
    }
  }

  return {
    kind: define ? define[1] : null,
    // Only an append has one: the object it extends. Null everywhere else.
    extendsTarget: define?.extendsTarget ? String(define.extendsTarget).toUpperCase() : null,
    name: define ? define[2].toUpperCase() : null,
    label: annotation(s, 'EndUserText.label'),
    tableCategory: annotation(s, 'AbapCatalog.tableCategory'),
    deliveryClass,
    deliveryClassText: deliveryClass ? DELIVERY_CLASSES.get(deliveryClass) ?? null : null,
    dataMaintenance: annotation(s, 'AbapCatalog.dataMaintenance'),
    enhancementCategory: annotation(s, 'AbapCatalog.enhancement.category'),
    fields,
    includes,
  };
}

/**
 * What the evidence supports, and nothing more. `REVIEW` is the best this function can say:
 * whether a table is configuration or business data is read off its FIELDS by a person, which
 * is why the caller prints them. `UNKNOWN` is never folded into `REVIEW` -- an unread class is
 * not a permissive one.
 */
export function verdictOf(meta) {
  // A structure has no delivery class BY DEFINITION, so reporting one as "not read" would be a
  // lie about a gap that does not exist. KOMG is `define structure` and was accepted as a
  // candidate until this check existed (measured).
  if (meta?.kind === 'structure') {
    return {
      verdict: 'REFUSE',
      why: 'this is a STRUCTURE (TABL/DS), not a table: it has no rows and no delivery class, and the data preview selects from a table. Its fields are still listed above, which is what makes it useful to read.',
    };
  }
  if (meta?.kind === 'append') {
    return {
      verdict: 'REFUSE',
      why: `this is an APPEND structure (\`extend type ${meta.extendsTarget ?? '?'} with ...\`), not a table. It has no rows of its own -- its fields live in ${meta.extendsTarget ?? 'the object it extends'}, which is what to ask about instead.`,
    };
  }
  const cls = meta?.deliveryClass ?? null;
  if (!cls) {
    return {
      verdict: 'UNKNOWN',
      why: 'the source carries no @AbapCatalog.deliveryClass: it was NOT read, which is not the same as class A. Read the table in the IDE (SE11 > Delivery and Maintenance) before deciding.',
    };
  }
  if (REFUSED_CLASSES.has(cls)) {
    return {
      verdict: 'REFUSE',
      why: `delivery class ${cls} -- ${DELIVERY_CLASSES.get(cls)}. That is business data by definition, and docs/security.md keeps it on the other side of the fence.`,
    };
  }
  if (meta.tableCategory && meta.tableCategory !== 'TRANSPARENT') {
    return {
      verdict: 'REFUSE',
      why: `tableCategory ${meta.tableCategory}: the data preview reads a transparent table, and this is not one.`,
    };
  }
  return {
    verdict: 'REVIEW',
    why:
      `delivery class ${cls} -- ${DELIVERY_CLASSES.get(cls) ?? 'unknown class'}. ` +
      'The class does NOT decide: read the field list above. A customer table of class C can hold ' +
      'personal data (a recruitment record with date of birth, gender and ethnicity, for instance).',
  };
}

/**
 * WHAT A TABLE SOURCE DOES NOT SHOW, measured on the development system 2026-09-22. This is not a caveat, it is
 * the shape of the problem: a field list built from the source alone is incomplete by
 * construction, and three layers behave differently.
 *
 *   1. a classic INCLUDE is named in the source (`include si_kna1 not null;`) and the structure
 *      is readable as a `TABL/DS` by the same path -- `expandIncludes` below resolves it, and it
 *      NESTS (KNA1 -> SI_KNA1 -> KNA1BRAZIL / TWTAX_S_KNA1 / PHI_KNA1_I);
 *   2. a classic APPEND is attached from OUTSIDE and appears nowhere in the base source -- not
 *      even by name. Reference case, measured: `ZDEMO_MM_FIELDS` (`TABL/DS`, package `ZDEMO_MM`,
 *      `/sap/bc/adt/ddic/structures/`) appends `MEREP_OUTTAB_PURCHDOC`, whose source names
 *      neither it nor its fields. Others here: `ZDEMO_APKOMKCV` on `KOMKCV`, `ZDEMO_KOMPAZ` on `KOMPAZ`,
 *      `ZDEMO_STR_EXIT` on `WBRF`;
 *   3. a field added through the Custom Fields app is likewise invisible here, and it is ALSO a
 *      repository object of its own: `ZZ1_DEMODELIVERY` reads as `CFDF/FLD` under
 *      `/sap/bc/adt/customfields/objects/`.
 *
 * ⚠️ CASE 3 IS NOT A RULE ABOUT NAMES OR TYPES -- it is a consequence of how that one field was
 * created, and the first draft of this comment got that backwards. Measured on this system,
 * 2026-09-22, in both directions:
 *
 *   - `ZDEMO_MM_FIELDS` is case 2, has NO `CFDF` object at all, and its fields are NAMED
 *     `ZZ1_DEMOFLAG_PDH`, `ZZ1_DEMODISC_PDH` -- the `ZZ1_` namespace inside a hand-named append;
 *   - and the field name is not even reliably in the customer namespace, because nothing forces
 *     it: `ZDEMO_APKOMKCV` appends `KOMKCV` with a field called **`FKART`**, `ZDEMO_STR_EXIT` appends
 *     `WBRF` with **`DT_COMP`** and **`ST_COMP`**, `ZDEMO_ST_003` appends `J_1BPRNFLI` with
 *     **`BASE`**. No `ZZ`, and no `Z` at all.
 *
 * The Custom Fields app's own appends are generated onto the `*_INCL_EEW_*` includes under a
 * hashed name (`ZZ1_` + 26 characters), which is a way to RECOGNISE one already in hand -- never
 * a way to find them. So neither the object type, nor the append name, nor the FIELD name
 * enumerates customer fields, and nothing here should try: the only honest answer from a source
 * read is that the list is short by an unknown amount, which is what `NOT_IN_SOURCE` says.
 *
 * So 2 and 3 are NOT resolved by this module, and a caller must say so for EVERY table rather
 * than only when an include happened to be found -- otherwise a list that is missing exactly the
 * customer fields reads as the whole table. `NOT_IN_SOURCE` is that sentence, and it names the
 * MECHANISM rather than a namespace, because the namespace does not enumerate anything.
 */
/**
 * `@AbapCatalog.enhancement.category`, with the meanings the ABAP Keyword Documentation gives
 * (7.58, `ABENDDICDDL_DEFINE_STRUCT_PROPS`; the system kernel is 7.58). This is the ONE thing that
 * turns "the list may be short" into a statement per node: a structure that cannot be enhanced
 * cannot carry an append, so its source IS its whole field list.
 *
 * ⚠️ `#NOT_CLASSIFIED` is NOT a synonym for `#NOT_EXTENSIBLE` -- the documentation calls it
 * *not classified*, which excludes nothing. Folding the two would turn "unknown" into "clean",
 * and that is the one direction this file never rounds in.
 */
export const ENHANCEMENT_CATEGORIES = new Map([
  ['NOT_CLASSIFIED', { closed: false, text: 'Not classified -- an append is not excluded' }],
  ['NOT_EXTENSIBLE', { closed: true, text: 'Cannot be enhanced' }],
  ['EXTENSIBLE_CHARACTER', { closed: false, text: 'Can be enhanced (character-like)' }],
  ['EXTENSIBLE_CHARACTER_NUMERIC', { closed: false, text: 'Can be enhanced (character-like or numeric)' }],
  ['EXTENSIBLE_ANY', { closed: false, text: 'Can be enhanced (deep)' }],
]);

/**
 * Can this node carry an append the source does not show?
 * `closed: true` = provably not. `false` = yes. `null` = the annotation was not read, which is
 * not the same as either.
 */
export function appendRisk(meta) {
  const cat = meta?.enhancementCategory ?? null;
  if (!cat) return { closed: null, category: null, text: 'no @AbapCatalog.enhancement.category in the source: not read, which is not "cannot be enhanced"' };
  const known = ENHANCEMENT_CATEGORIES.get(cat);
  if (!known) return { closed: null, category: cat, text: `unknown enhancement category '${cat}' -- not in the documented set, so nothing is concluded` };
  return { closed: known.closed, category: cat, text: known.text };
}

export const NOT_IN_SOURCE =
  'Customer fields added from OUTSIDE the table -- an append structure, or a field from the ' +
  'Custom Fields app -- are NOT in a table source and are NOT listed here, for any table, ' +
  'whatever they are named. Check SE11 (Extras > Append structures) and the Custom Fields app ' +
  'before concluding a field does not exist.';

/**
 * Resolve `meta.includes` into fields, recursively, through an injected reader -- the network
 * stays with the caller so this is testable offline.
 *
 * @param {object} meta a `parseTableMeta` result
 * @param {(names: string[]) => Promise<Map<string, string|null>>} read batch source reader
 * @param {{maxDepth?: number, batch?: number}} [opts]
 * @returns {Promise<{fields: Array<{name,type,isKey,from: string|null}>,
 *                    resolved: string[], unresolved: Array<{name: string, why: string}>}>}
 *
 * An include that cannot be read is REPORTED, never skipped: a short list biases every count
 * towards "this table has no such field", which is the answer that must never be guessed.
 */
export async function expandIncludes(meta, read, { maxDepth = 20, batch = 25 } = {}) {
  const fields = meta.fields.map((f) => ({ ...f, from: null }));
  const resolved = [];
  const unresolved = [];
  // Every node reached, with whether IT can carry an append. The root counts: a table whose own
  // category is extensible is open at level 0, and an include resolved at level 3 is open at
  // level 3. Nesting mixes freely -- `KOMG` includes `KOMPAZ`, and `KOMPAZ` carries the append
  // `ZDEMO_KOMPAZ` (field `ZZDEMOFLD`), so the gap is not at the table at all.
  const nodes = [{ name: meta.name, depth: 0, ...appendRisk(meta) }];
  const seen = new Set([meta.name].filter(Boolean));
  let frontier = meta.includes.filter((n) => !seen.has(n));

  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const names = [...new Set(frontier)].filter((n) => !seen.has(n));
    for (const n of names) seen.add(n);
    const next = [];
    for (let i = 0; i < names.length; i += batch) {
      const chunk = names.slice(i, i + batch);
      let sources;
      try {
        sources = await read(chunk);
      } catch (e) {
        for (const n of chunk) unresolved.push({ name: n, why: `read failed: ${e?.message ?? e}` });
        continue;
      }
      for (const n of chunk) {
        // The reader may answer a bare source (tests do) or `{source, error}` (the script does,
        // so the REASON survives). Both are accepted; the reason is what separates the two cases
        // below, and they are not the same finding at all.
        const got = sources?.get?.(n) ?? null;
        const src = typeof got === 'string' ? got : (got?.source ?? null);
        const err = typeof got === 'string' ? null : (got?.error ?? null);
        if (!src) {
          // A customer include that was never implemented DOES NOT EXIST, and it contributes zero
          // fields -- so the list is not short, and saying it is short by an unknown amount is a
          // false alarm that fires on most large standard structures (KOMG carries four:
          // CI_KOMK_CM, CI_KOMP_CM, CI_KOMPFIC, CI_PRS_CPILS_2). A warning that is always on is a
          // warning nobody reads, and then the one real case goes with it.
          const missing = /not found in the system|does not exist/i.test(err ?? '');
          unresolved.push({
            name: n,
            missing,
            why: missing
              ? 'does not exist in this system (an unimplemented customer include contributes no field)'
              : (err ?? 'no source returned (a failed read is not an empty structure)'),
          });
          continue;
        }
        const sub = parseTableMeta(src);
        resolved.push(n);
        nodes.push({ name: n, depth: depth + 1, ...appendRisk(sub) });
        for (const f of sub.fields) fields.push({ ...f, from: n });
        for (const c of sub.includes) if (!seen.has(c)) next.push(c);
      }
    }
    frontier = next;
  }
  // Depth cap reached with names still pending: say it instead of dropping them.
  for (const n of new Set(frontier)) {
    unresolved.push({ name: n, why: `nesting deeper than maxDepth ${maxDepth}` });
  }
  return { fields, resolved, unresolved, nodes };
}

/**
 * The one honest sentence about completeness, from the nodes `expandIncludes` reached.
 * `complete` is true ONLY when every node is provably closed AND every include was resolved --
 * it is the rare case, and it is worth stating because it is the only case where a field list
 * from a source read is the whole truth.
 */
export function completeness({ nodes = [], unresolved = [] } = {}) {
  const open = nodes.filter((n) => n.closed === false);
  const unknown = nodes.filter((n) => n.closed === null);
  // An include that DOES NOT EXIST leaves no gap: it contributes no field, so it cannot make the
  // list short. Only a read that failed for another reason does.
  const gaps = unresolved.filter((u) => !u.missing);
  return {
    complete: open.length === 0 && unknown.length === 0 && gaps.length === 0,
    missing: unresolved.filter((u) => u.missing).map((u) => u.name),
    gaps: gaps.map((u) => u.name),
    open: open.map((n) => n.name),
    unknown: unknown.map((n) => n.name),
    closed: nodes.filter((n) => n.closed === true).map((n) => n.name),
  };
}

/**
 * The entry to add to `data/defaults/customizing-tables.json`, in that file's one-line-per-table
 * form, with `why` left for the person to fill in. The key columns come from the source; the
 * client column is left out, as in every entry already there (the preview reads the logon client).
 */
export function listEntryLine(table, fields = []) {
  const keyColumns = fields
    .filter((f) => f.isKey && !/^(MANDT|CLIENT|RCLNT)$/i.test(f.name))
    .map((f) => String(f.name).toUpperCase());
  const entry = {
    name: String(table).toUpperCase(),
    why: '<what needs this table, and for which consumer>',
    routineColumns: {},
    ...(keyColumns.length ? { keyColumns } : {}),
  };
  return `    ${JSON.stringify(entry)}`;
}

// ---------------------------------------------------------------------------------------------
// The SECOND view of a table's fields: the DDIC-active list, folded out of `ddicElement`.
//
// The source read above answers WHERE a field comes from, by name, and it cannot see an append
// at all -- an append is invisible in the base source, by design. `ddicElement` answers the
// complementary half: the flat, active field list WITH the append fields in it, but it names no
// append. Neither view is a superset of the other, so both are read and the difference between
// them is exactly the set of fields that arrived from outside the source.
//
// MEASURED 2026-09-22 on the development system (docs/adt-api-reference.md, "On a TABLE the answer is FLAT"):
//
//   * `.append` / `.include` children are POSITIONAL SEPARATORS. They carry `elementProps: false`,
//     an empty `children` and the literal name `.append`; the fields that block contributes follow
//     it as siblings, until the next marker. Reconciled 4 of 4 on WBRF against the source of each
//     append.
//   * A marker may own ZERO fields. `WBRF_ADDON_GT` contributes none directly because its whole
//     body is `include wb2b_cond_key` -- which is the `.include` marker that follows it. So a
//     block is "the fields until the next marker", never "the next field".
//   * The LAST child is the PACKAGE (`type: 'DEVC/K'`), not a field. `AGR_TIMEB` answers 13
//     children for 12 fields for exactly this reason.
//   * A `TABL/DS` answers `{children: []}`. That is the object type, not a failure and not the
//     URI defect: asked by NAME, after the fix, four structures still answered empty while both
//     tables answered full. `ok: false` here means "this view is not available", never "no fields".

/** A child of a ddicElement tree is a field when it carries elementProps; markers and the package do not. */
const isFieldNode = (n) => Boolean(n?.properties?.elementProps);
/** `.append` / `.include`: a block separator, never a name. */
const isMarkerNode = (n) => typeof n?.name === 'string' && n.name.startsWith('.') && !isFieldNode(n);

/**
 * Fold a `ddicElement` reply into blocks. Block 0 is the object's own fields; every later block
 * is one marker and the fields it contributed (possibly none).
 *
 * @returns {{ok: boolean, why?: string, package: string|null, blocks: Array<{marker: string|null, fields: Array<object>}>, fields: Array<object>}}
 */
export function foldDdicElement(root) {
  const children = Array.isArray(root?.children) ? root.children : null;
  if (!children || !children.length) {
    return {
      ok: false,
      why:
        'ddicElement answered no children. On a TABL/DS that is the object type (measured), not a ' +
        'failure; on a TABL/DT it means the read did not resolve. Either way it is NOT evidence of ' +
        'a table without fields.',
      package: null,
      blocks: [],
      fields: [],
    };
  }

  const blocks = [{ marker: null, fields: [] }];
  let pkg = null;
  for (const node of children) {
    if (node?.type === 'DEVC/K') {
      pkg = node.name ?? null;
      continue;
    }
    if (isMarkerNode(node)) {
      blocks.push({ marker: node.name, fields: [] });
      continue;
    }
    if (!isFieldNode(node)) continue;
    const p = node.properties.elementProps;
    blocks[blocks.length - 1].fields.push({
      name: String(node.name ?? '').toUpperCase(),
      dataElement: p.ddicDataElement ? String(p.ddicDataElement).toUpperCase() : null,
      dataType: p.ddicDataType ? String(p.ddicDataType).toUpperCase() : null,
      length: p.ddicLength ?? null,
      decimals: p.ddicDecimals ?? null,
      isKey: Boolean(p.ddicIsKey),
      block: blocks.length - 1,
      marker: blocks[blocks.length - 1].marker,
    });
  }

  return { ok: true, package: pkg, blocks, fields: blocks.flatMap((b) => b.fields) };
}

/**
 * The two views, compared. `fromOutside` is the answer to the question this whole module exists
 * for: which fields are IN the table and in NO source anyone can read.
 *
 * `appendMarkers` is the count of `.append` blocks. Zero of them, on a view that came back `ok`,
 * is the strongest statement available without a second resource: this table carries no append
 * TODAY. It is not the same as `#NOT_EXTENSIBLE`, which says it can never carry one.
 */
export function compareViews(sourceFields = [], folded) {
  if (!folded?.ok) return { available: false, fromOutside: [], missingFromDdic: [], appendMarkers: 0 };
  const inSource = new Set(sourceFields.map((f) => String(f.name).toUpperCase()));
  const inDdic = new Set(folded.fields.map((f) => f.name));
  return {
    available: true,
    fromOutside: folded.fields.filter((f) => !inSource.has(f.name)),
    // A field the source has and the active table does not: the source read is stale or the
    // include was resolved to the wrong object. Rare, and never silently dropped.
    missingFromDdic: [...inSource].filter((n) => !inDdic.has(n)),
    appendMarkers: folded.blocks.filter((b) => b.marker === '.append').length,
  };
}

/**
 * Read a list of names through a batched reader, in chunks, merging the answers.
 *
 * It exists because the reader's limit is 25 names PER REQUEST, and the obvious way to respect a
 * cap -- `names.slice(0, 25)` -- turns it into a silent wrong answer instead. Measured on `KOMG`,
 * 2026-09-22: it names 28 appends, the three past the cap were reported as "source not read", and
 * one of them was `ZDEMO_KOMPAZ`, the exact object the whole append route was built to reach. A cap
 * that truncates does not fail where it is wrong; it fails where the answer is read.
 *
 * @param {string[]} names
 * @param {(chunk: string[]) => Promise<Map<string, string|null>>} read
 * @returns {Promise<Map<string, string|null>>}
 */
export async function readInChunks(names, read, batch = 25) {
  const out = new Map();
  for (let i = 0; i < names.length; i += batch) {
    for (const [k, v] of await read(names.slice(i, i + batch))) out.set(k, v);
  }
  return out;
}
