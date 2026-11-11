// The DDLX annotation chain, parsed against a payload measured on the development system on 2026-09-09.
//
// This answers the question a CDS working tree cannot: an annotation reached this element
// from SOMEWHERE, and when a field vanishes from a Fiori app with no activation error and
// no /IWFND/ERROR_LOG entry, the cause is usually that two layers wrote the same key and
// the wrong one won. The source text of any single view cannot show that, because the
// layer that lost is in a different object.
//
// Shape, verbatim from the measurement (docs/adt-api-reference.md):
//
//   <abapsource:elementInfo>              root, with an EMPTY <abapsource:properties/>
//     <abapsource:elementInfo adtcore:type="ANNO" adtcore:name="UI.LINEITEM$1$.POSITION">
//       <abapsource:properties>
//         <abapsource:entry abapsource:key="SOURCE_TYPE">DDLX/EX</abapsource:entry>
//         ...
//
// Two facts about that shape are load-bearing, and both would have been guessed wrong:
//
//   1. THE PROPERTY SET DEPENDS ON THE SOURCE KIND. A contribution from a metadata
//      extension (`DDLX/EX`) carries LAYER, LAYER_NAME, SWITCH_ID and the TRANSLATED_*
//      trio. A contribution from the CDS source itself (`DDLS/DF`) carries none of those,
//      and carries STATEMENT_TYPE instead. Reading `LAYER` as always-present would make
//      every annotation written in the view itself look like a layer-less anomaly.
//   2. The keys arrive in DIFFERENT ORDER between the two kinds, so everything here is
//      read by key and never by position.
//
// `LAYER` arrives space-padded from the kernel (`"5500 "`) and is trimmed.
// `ANNOTATION_VALUE` keeps ABAP quoting verbatim -- `'I_UnitOfMeasureStdVH'` with the
// quotes, `#LOW` for an enum, `60` bare for a number -- and is NOT unquoted here: the
// quoting is what tells a string apart from an enum, and dropping it loses information.

/** Array subscripts arrive encoded as `$1$`: `UI.FACET$1$.ID` is `UI.facet[1].id`. */
const ARRAY_INDEX = /\$(\d+)\$/g;

/** Decode the entity encoding of a payload this small; no XML dependency is worth it. */
const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** The `<abapsource:entry key="X">v</entry>` pairs of one node, including the empty ones. */
function entriesOf(xml) {
  const out = {};
  const re =
    /<abapsource:entry\s+abapsource:key="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/abapsource:entry>)/g;
  for (const m of xml.matchAll(re)) out[m[1]] = m[2] === undefined ? '' : unescapeXml(m[2]);
  return out;
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? undefined : s;
};

/**
 * One contribution to one annotation key.
 *
 * `active` is the kernel's own verdict (`IS_ACTIVE`), not a re-derivation from the layer
 * number -- the switch framework and the extension order both feed it, and guessing the
 * winner from LAYER alone would be wrong wherever a switch is off.
 */
function contribution(name, props) {
  return {
    annotation: name,
    path: name.replace(ARRAY_INDEX, '[$1]').toLowerCase(),
    value: clean(props.ANNOTATION_VALUE),
    active: props.IS_ACTIVE === 'X',
    source: {
      name: clean(props.SOURCE_NAME),
      type: clean(props.SOURCE_TYPE),
      // Present on DDLX/EX only. `undefined` here means "written in the view itself".
      layer: clean(props.LAYER),
      layerName: clean(props.LAYER_NAME),
      uri: clean(props.SOURCE_URI),
    },
    // Present on DDLS/DF only.
    statementType: clean(props.STATEMENT_TYPE),
    // A switch that is off silences a contribution without removing it from the chain.
    switchId: clean(props.SWITCH_ID),
    switchDisabled: props.SWITCH_DISABLED === 'X',
    translated: clean(props.TRANSLATED_ANNOTATION_VALUE)
      ? {
          value: clean(props.TRANSLATED_ANNOTATION_VALUE),
          language: clean(props.TRANSLATED_ANNOTATION_VALUE_LANGUAGE),
          languageKey: clean(props.TRANSLATED_ANNOTATION_VALUE_LANGUAGE_KEY),
        }
      : undefined,
  };
}

// ENTITY and ELEMENT repeat identically on every node; the first occurrence answers for
// the document, and reading it from a node rather than from the request means the reply
// says what it is about even when the request is not at hand.
const firstEntry = (text, key) =>
  text.match(
    new RegExp(`<abapsource:entry\\s+abapsource:key="${key}"\\s*>([\\s\\S]*?)</abapsource:entry>`)
  )?.[1];

/**
 * Parse one `application/vnd.sap.adt.ddlx.annotation.chain.v2+xml` document.
 *
 * @returns {{entity?:string, element?:string, contributions:object[], annotations:object[],
 *            conflicts:object[], sources:object[], counts:object}}
 */
export function parseAnnotationChain(xml) {
  const text = String(xml ?? '');
  const contributions = [];
  // Only the CHILD elementInfo nodes carry an adtcore:name; the root has none, so this
  // regex skips it without needing to model nesting.
  const re =
    /<abapsource:elementInfo\s+adtcore:type="ANNO"\s+adtcore:name="([^"]+)"[^>]*>([\s\S]*?)<\/abapsource:elementInfo>/g;
  for (const m of text.matchAll(re)) {
    contributions.push(contribution(unescapeXml(m[1]), entriesOf(m[2])));
  }

  const byName = new Map();
  for (const c of contributions) {
    byName.set(c.annotation, [...(byName.get(c.annotation) ?? []), c]);
  }

  const annotations = [];
  const conflicts = [];
  for (const [name, list] of byName) {
    const winner = list.find((c) => c.active) ?? null;
    const losers = list.filter((c) => c !== winner);
    annotations.push({
      annotation: name,
      path: list[0].path,
      value: winner?.value,
      from: winner?.source,
      contributions: list.length,
      // No active contribution at all: the key is in the chain and reaches nothing. The
      // usual cause is a switch, and it is exactly the "field disappeared" symptom.
      silenced: !winner,
    });
    // More than one source wrote the same key. That is not a defect by itself -- an
    // extension overriding the view is the designed mechanism -- but it IS the thing to
    // look at first when a value is not what the source in front of you says.
    if (list.length > 1 || !winner) {
      conflicts.push({
        annotation: name,
        path: list[0].path,
        winner: winner ? { value: winner.value, ...winner.source } : null,
        overridden: losers.map((c) => ({ value: c.value, ...c.source })),
      });
    }
  }
  annotations.sort((a, b) => a.annotation.localeCompare(b.annotation));

  const bySource = new Map();
  for (const c of contributions) {
    const key = `${c.source.name ?? '?'}|${c.source.type ?? '?'}`;
    const row = bySource.get(key) ?? {
      name: c.source.name,
      type: c.source.type,
      layer: c.source.layer,
      layerName: c.source.layerName,
      contributions: 0,
      active: 0,
    };
    row.contributions++;
    if (c.active) row.active++;
    bySource.set(key, row);
  }

  return {
    entity: clean(firstEntry(text, 'ENTITY')),
    element: clean(firstEntry(text, 'ELEMENT')),
    contributions,
    annotations,
    conflicts,
    sources: [...bySource.values()].sort((a, b) => b.contributions - a.contributions),
    counts: {
      contributions: contributions.length,
      annotations: annotations.length,
      conflicts: conflicts.length,
      silenced: annotations.filter((a) => a.silenced).length,
      sources: bySource.size,
    },
  };
}

/** One line per annotation, for a person reading the answer rather than a parser. */
export function renderChain(parsed) {
  const out = [];
  out.push(
    `${parsed.entity ?? '?'}${parsed.element ? `.${parsed.element}` : ''} — ` +
      `${parsed.counts.annotations} annotations from ${parsed.counts.sources} source(s)` +
      (parsed.counts.conflicts ? `, ${parsed.counts.conflicts} written by more than one` : '') +
      (parsed.counts.silenced ? `, ${parsed.counts.silenced} SILENCED` : '')
  );
  for (const a of parsed.annotations) {
    const from = a.from
      ? `${a.from.name} (${a.from.type}${a.from.layerName ? `, ${a.from.layerName}` : ''})`
      : 'NOTHING ACTIVE';
    out.push(`  ${a.path} = ${a.value ?? '—'}  ←  ${from}`);
  }
  for (const c of parsed.conflicts) {
    out.push(
      `  ! ${c.path}: won by ${c.winner?.name ?? 'nobody'}; also written by ` +
        c.overridden.map((o) => `${o.name} (${o.value ?? '—'})`).join(', ')
    );
  }
  return out.join('\n');
}

// --- the cross-key contradiction ----------------------------------------------
//
// `conflicts` above only sees two sources contesting the SAME key. The trap that
// actually costs a day is a CROSS-key contradiction: one layer gives the element a
// display role and ANOTHER layer hides it. Nothing contests anything, so the chain
// reports zero conflicts -- and the field is gone from the app with no error anywhere.
//
// Measured on the development system on 2026-09-09, twice: ZC_DemoShelfStock/Plant and
// ZC_DemoShelfStockDEMO/Plant each carry an ACTIVE `ui.hidden = true` written by the
// metadata extension of ZI_DemoStorageLocation, together with an ACTIVE
// `ui.lineitem[1]` + `ui.selectionfield[1]` written by their own extension. Confirmed
// through a second, independent route: the $metadata the service emits carries
// SAP__UI.Hidden on DemoShelfStockType/Plant while listing Plant in UI.LineItem and
// UI.SelectionFields. A hidden element given a display role is a defect, proven rather
// than suspected.

/** Roles that make the FIELD ITSELF appear. Deliberately excludes `facet`,
 *  `headerinfo` and `presentationvariant`: those are container declarations that are
 *  merely anchored on an element, so hiding the element does not contradict them. */
const DISPLAY_ROLE = /^ui\.(lineitem|selectionfield|fieldgroup|identification|datapoint)(\[|\.|$)/;

/** `ui.lineitem[2].type` -> `ui.lineitem[2]`; the group an annotation belongs to. */
const groupOf = (path) => path.replace(/^(ui\.[a-z]+(?:\[\d+\])?).*$/, '$1');

/**
 * Elements whose chain hides them AND gives them a display role, both active.
 * Returns [] when there is no contradiction, which is the common case.
 */
/**
 * The annotations that make a field not render. There are two, not one.
 *
 * `@Consumption.hidden` hides a field just as `@UI.hidden` does -- it drops it from the
 * OData exposure instead of from the UI, but the field is gone either way, and a display
 * role given downstream contradicts it exactly the same. Measured on real sources: the few
 * `@Consumption.hidden` were all on associations, none with a display role -- so widening the
 * test here reported nothing new, which is the point.
 * It is not a second detector; it is this one no longer being wrong about what "hidden"
 * means.
 */
const HIDER = /^(ui|consumption)\.hidden$/;

export function hiddenWithUiRole(parsed) {
  const active = (parsed?.annotations ?? []).filter((a) => !a.silenced);

  // Only an unconditional literal counts. `@UI.hidden: 'SomeFlag'` binds visibility to a
  // field and is deliberate design, not a contradiction.
  const hiders = active.filter((a) => HIDER.test(a.path) && a.value === 'true');
  const hidden = hiders[0];
  if (!hidden) return [];

  // A role group whose `type` is an action or a link is not the field's own column --
  // it is a button declared on the element, and hiding the element does not contradict
  // it. Observed on ZC_DemoEmployee/Stcd2, where ui.lineitem[2] is #FOR_ACTION.
  const notAField = new Set(
    active
      .filter((a) => /\.type$/.test(a.path) && /^#(FOR_|WITH_URL)/.test(String(a.value ?? '')))
      .map((a) => groupOf(a.path))
  );

  const roles = active.filter(
    (a) => DISPLAY_ROLE.test(a.path) && !notAField.has(groupOf(a.path))
  );
  if (!roles.length) return [];

  return [
    {
      entity: parsed.entity,
      element: parsed.element,
      // WHICH annotation hid it. The two have different remedies -- removing a
      // `@UI.hidden` from a field is a fix, removing a `@Consumption.hidden` from an
      // association is usually a mistake -- so a backlog that does not say which is
      // telling somebody to guess.
      hiddenKey: hidden.path,
      hiddenBy: hidden.from,
      // Every active hide, not only the first: removing one of two leaves the field hidden.
      hiders: hiders.map((h) => ({ key: h.path, by: h.from ?? null })),
      roles: [...new Set(roles.map((r) => groupOf(r.path)))].sort(),
      roleSources: [
        ...new Map(roles.filter((r) => r.from).map((r) => [r.from.name, r.from])).values(),
      ],
    },
  ];
}
