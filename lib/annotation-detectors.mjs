// Detectors over the annotation index (CDS sources read from the system).
//
// The index (annotation-index.mjs) judges nothing on purpose. This is where judgement
// lives, and the list is deliberately SHORT: a detector earns its place by having a
// measured case behind it, never by sounding like a good idea. One detector today.
//
// Every detector here reports a SUSPICION, because the source is not the system: a
// switch, a kernel layer or an IS_ACTIVE flag can silence a contribution that reads as
// reads as live in the source. Confirming costs one `adt_annotation_chain` call per element, and
// ranking what deserves that call is the entire value of reading the sources first.

import { hiddenWithUiRole } from './annotation-chain.mjs';
import { normalizeAnnotationKey, reaching } from './annotation-index.mjs';

/**
 * Types that make a `@UI.lineItem` entry a button or a link rather than the field's own
 * column. Same rule the chain detector applies -- kept in one place by feeding it the
 * synthesised `.type` path below rather than by restating it.
 */
const NOT_A_FIELD_TYPE = /#(FOR_[A-Z_]+|WITH_URL)/g;
const ANY_TYPE = /\btype\s*:\s*(#[A-Z_]+)/g;

/**
 * Turn index rows into the shape `hiddenWithUiRole` already consumes.
 *
 * Two shapes have to be reconciled. The ADT chain explodes an array annotation into one
 * path per entry (`ui.lineitem[2].type`); a CDS source carries the whole array as one raw
 * value (`[{ position: 30, type: #FOR_ACTION }]`). So for each role key we read the
 * `type:` tokens out of the raw text and synthesise the `.type` path the detector looks
 * for -- but ONLY when every entry in the array is a non-field type. A lineItem holding
 * one button and one real column still displays the field, and calling that "not a field"
 * would hide a genuine contradiction.
 *
 * `silenced` is always false here: a source cannot say what the kernel switched off.
 * That is stated rather than assumed, and it is why these are suspicions.
 */
function asChain(rows, entity, element) {
  const annotations = [];
  for (const row of rows) {
    const path = normalizeAnnotationKey(row.key);
    const from = { name: row.from, type: row.layer === 'ddlx' ? 'DDLX/EX' : 'DDLS/DF' };
    annotations.push({ path, value: String(row.value ?? '').trim(), silenced: false, from });

    const raw = String(row.value ?? '');
    const types = [...raw.matchAll(ANY_TYPE)].map((m) => m[1]);
    const nonField = raw.match(NOT_A_FIELD_TYPE) ?? [];
    // Every entry typed, and every one of them a button or a link.
    const entries = (raw.match(/\{/g) ?? []).length || 1;
    if (types.length && types.length === nonField.length && types.length >= entries) {
      annotations.push({ path: `${path}.type`, value: types[0], silenced: false, from });
    }
  }
  return { entity, element, annotations };
}

/**
 * @UI.hidden upstream while a downstream layer gives the element a display role.
 *
 * Cross-key, so no conflict check sees it: the two annotations do not contest each other,
 * they are simply incompatible. Measured live on 2026-09-09 -- the chain returned
 * `conflicts: 0` for a field that does not render.
 *
 * Two outcomes, and the difference matters:
 *   ARMED  nothing is holding the upstream hide back; the field is gone.
 *   HELD   the consuming view carries @Metadata.ignorePropagatedAnnotations: true, which
 *          is holding it. NOT clean -- the hide is still written upstream, and removing
 *          that one line re-arms it.
 */
export function detectHiddenWithRole(index) {
  const out = [];
  for (const [key, entity] of index.entities) {
    for (const slot of entity.elements.values()) {
      // A row that cannot reach the element (a parameter projection on the way) neither hides
      // it nor gives it a role: measured, the chain does not carry it at all.
      const rows = reaching(index, key, slot.name).filter((r) => !r.unreachable);
      if (!rows.length) continue;
      const hits = hiddenWithUiRole(asChain(rows, entity.name, slot.name));
      if (!hits.length) continue;

      for (const hit of hits) {
        // Match the key the detector actually fired on, not `ui.hidden` by assumption:
        // `@Consumption.hidden` hides a field too, and looking for the wrong key here
        // would leave the finding with no location and no layer.
        const hides = rows.filter(
          (r) =>
            normalizeAnnotationKey(r.key) === hit.hiddenKey && String(r.value).trim() === 'true'
        );
        // One hide that is not held is enough to arm it.
        const hiddenRow = hides.find((r) => !r.heldBy) ?? hides[0];
        // The row to point a backlog line at is one that carries a DISPLAY role -- not
        // just any `ui.*`. Measured on ZI_DemoStockRecon/Channel: the first `ui.*` row
        // there is a `UI.facet`, which this very detector excludes from being a role.
        // Pointing the finding at it would send a reader to an unrelated line.
        const roleRow = rows.find((r) => hit.roles.includes(normalizeAnnotationKey(r.key)));
        // Held only makes sense for a hide that PROPAGATES: a hide written on the view itself is
        // never marked. The view that holds it may be this one or one in between (measured).
        const heldBy = hiddenRow?.heldBy?.entity;
        out.push({
          entity: entity.name,
          element: slot.name,
          state: heldBy ? 'HELD' : 'ARMED',
          ...(heldBy ? { heldBy } : {}),
          hiddenKey: hit.hiddenKey,
          hiddenBy: hit.hiddenBy?.name ?? hiddenRow?.from,
          hiddenByLayer: hiddenRow?.layer,
          hiddenByFile: hiddenRow?.file,
          roles: hit.roles,
          roleSources: hit.roleSources.map((s) => s.name),
          // How far upstream the hide was written. This is the STRENGTH of the suspicion,
          // and it is reported rather than thresholded: depth 0 means the hide sits on the
          // view itself, while depth 4 means four propagating hops matched on element NAME
          // -- the index does not verify the element is projected at every hop, so a deep
          // row is a weaker claim. Ranking is the reader's, and the confirmation is one
          // adt_annotation_chain call either way.
          depth: hiddenRow?.depth ?? null,
          repo: roleRow?.repo ?? entity.files[0]?.repo,
          file: roleRow?.file ?? entity.files[0]?.file,
          line: roleRow?.line ?? null,
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      (a.state === b.state ? 0 : a.state === 'ARMED' ? -1 : 1) ||
      (a.depth ?? 99) - (b.depth ?? 99) ||
      a.entity.localeCompare(b.entity) ||
      a.element.localeCompare(b.element)
  );
}

/** `ui.hidden` -> `UI.hidden`. The finding is read by people, and the lower-cased
 *  comparison key is not what anybody writes in a CDS source. */
const asWritten = (key) =>
  key === 'consumption.hidden' ? 'Consumption.hidden' : key === 'ui.hidden' ? 'UI.hidden' : key;

/** The finding a detector row becomes. ARMED and HELD are different codes on purpose. */
export function findingForHidden(row) {
  const where = row.hiddenBy ?? 'an upstream layer';
  const by = row.roleSources.join(', ') || 'another layer';
  const hides = `@${asWritten(row.hiddenKey ?? 'ui.hidden')}: true`;
  return {
    code: row.state === 'HELD' ? 'ANNOTATION_HIDDEN_HELD' : 'ANNOTATION_HIDDEN_WITH_ROLE',
    subject: `${row.entity}.${row.element}`,
    repo: row.repo,
    file: row.file,
    line: row.line ?? undefined,
    effect:
      row.state === 'HELD'
        ? `${where} sets ${hides} and ${by} gives the element ${row.roles.join(', ')}; ` +
          `${row.heldBy ?? row.entity} carries @Metadata.ignorePropagatedAnnotations: true, which is holding ` +
          'the hide back. Removing that line re-arms it and the field disappears, with no error'
        : `${where} sets ${hides} while ${by} gives it ${row.roles.join(', ')} -- ` +
          'the field does not render, and no error is raised anywhere',
    context: {
      state: row.state,
      hiddenKey: asWritten(row.hiddenKey ?? 'ui.hidden'),
      depth: row.depth,
      ...(row.heldBy ? { heldBy: row.heldBy } : {}),
      hiddenBy: row.hiddenBy,
      hiddenByLayer: row.hiddenByLayer,
      hiddenByFile: row.hiddenByFile,
      roles: row.roles.join(', '),
      roleSources: row.roleSources.join(', '),
      basis: 'source only -- not confirmed against the system; adt_annotation_chain decides',
    },
  };
}
