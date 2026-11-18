// Which annotations reach a CDS element, and from which layer -- read off the CDS sources the
// system returns (a package read by lib/package-sources.mjs, plus upstream views on demand).
//
// WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
//
// This answers "the SOURCE says this". It does NOT answer "the system does this". It has
// no idea about switches, kernel layers or IS_ACTIVE, and two `annotate entity` layers
// that disagree are both reported here with no winner picked. The verdict comes from
// `adt_annotation_chain`, which costs one ADT call. The point of this index is to rank
// what deserves that call: the trap it hunts needs one call per ELEMENT to confirm, so a
// sweep that is not filtered from the sources first is not affordable.
//
// WHY IT IS ANNOTATION-AGNOSTIC
//
// The first version of this was a @UI.hidden scanner, and that was too narrow. ANY
// annotation may be written directly in the CDS source -- the DDLX object is technically
// optional, even though creating it is the right practice. Measured across the workspace
// on 2026-09-09:
//
//   element annotations written inline in .ddls : 93 files
//   element annotations written in .ddlx        : 34 files
//
// and whole families exist ONLY inline: Semantics.* (260 quantity, 69 amount), Search.*
// (60 defaultSearchElement), ObjectModel.text/association/foreignKey/readOnly,
// Aggregation.default, VDM.lifecycle, API.element -- and Consumption.valueHelpDefinition
// (15), which is the very annotation adt_value_help exists to reason about. Reading only
// the DDLX would have been a large blind spot, and indexing only `UI.*` would have passed
// every defect test while still being wrong.
//
// So: the index carries every key it finds, and JUDGES NOTHING. Detectors live next door
// in annotation-detectors.mjs. Nothing here may branch on the name of an element or on
// which layer an annotation was written in -- both are legal, and neither means anything.

import { parseAnnotations, stripComments } from './annotations.mjs';
import { dataSourcesFrom, definitionOf } from './datasources.mjs';

/**
 * Edges an element annotation travels along.
 *
 * Measured and this is the whole reason the list is short: an `association`
 * does NOT carry an element annotation to the consuming view, because it puts no element
 * in the select list. A transitive walk that included associations reported
 * ZC_DemoEmployee/Stcd2 as hit by seven upstream DDLX; the live chain returned 78
 * annotations, 2 sources and no UI.HIDDEN at all. Seven false positives from one edge.
 */
export const PROPAGATING = new Set(['from', 'join', 'projection']);

/** Annotation keys compare case-insensitively: the workspace holds both
 *  `Search.defaultSearchElement` and `Search.DefaultSearchElement`. */
export const normalizeAnnotationKey = (key) => String(key ?? '').trim().toLowerCase();

const MAX_DEPTH = 8;

/**
 * The line an element is declared on.
 *
 * This is the ELEMENT's line, not the annotation's -- an annotation sits above its
 * element and can span many lines, and pinning it exactly would mean a second parser.
 * A backlog row needs somewhere to click, and the element line is that. Returns null
 * rather than 1 when it cannot be found, because a confident wrong line is worse than
 * none.
 */
function lineOfElement(text, element) {
  if (!element) return null;
  const re = new RegExp(`^[ \\t]*(?:key[ \\t]+|virtual[ \\t]+)?${element}\\b`, 'im');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return null;
}

function emptyEntity(name) {
  return {
    name,
    files: [],
    elements: new Map(),
    lineage: [],
    ignorePropagated: false,
  };
}

/** An empty index; `indexSources` fills it, and may be called again to add upstream views. */
export const emptyIndex = () => ({ entities: new Map(), files: 0, unread: [] });

/**
 * Add CDS sources to an index.
 *
 * @param {{file:string, repo:string, layer:'ddls'|'ddlx', text:string}[]} sources  `layer` comes
 *        from the object type (DDLS/DF -> ddls, DDLX/EX -> ddlx), `file` is how a finding cites it
 *        (`<package>/<object>`), `repo` is the package it was read from
 * @param {object} index  an index to extend (default: a new one)
 * @returns {{entities:Map, files:number, unread:object[]}}
 */
export function indexSources(sources = [], index = emptyIndex()) {
  const { entities, unread } = index;
  for (const { file: rel, repo, layer, text } of sources) {
    if (!String(text ?? '').trim()) continue;
    const parsed = parseAnnotations(text);
    if (!parsed.name) continue;
    index.files++;
    const isExtension = layer === 'ddlx';
    const key = parsed.name.toUpperCase();
    const entity = entities.get(key) ?? emptyEntity(parsed.name);

    // A source that declares elements and yields none is a PARSER gap, and it looks
    // exactly like a view with no annotations to everyone downstream. Carry it out so
    // a caller can journal CDS_PARSE_EMPTY instead of answering "no signal".
    if (parsed.unread) {
      unread.push({ file: rel, repo, entity: parsed.name, declares: parsed.declaresElements });
    }

    entity.files.push({ file: rel, repo, layer });

    const stripped = stripComments(text);
    for (const [element, annotations] of Object.entries(parsed.elements)) {
      const slot = entity.elements.get(element.toLowerCase()) ?? { name: element, keys: new Map() };
      const line = lineOfElement(stripped, element);
      for (const [k, value] of Object.entries(annotations)) {
        const nk = normalizeAnnotationKey(k);
        // First writer of a key in a FILE wins within that file; files and layers are kept
        // apart, because "who wrote it" is half the answer: two DDLX of one entity that write
        // the same key are both rows, never one hiding the other.
        if (!slot.keys.has(`${layer}|${rel}|${nk}`)) {
          slot.keys.set(`${layer}|${rel}|${nk}`, { key: k, value, layer, file: rel, repo, line });
        }
      }
      // Where the element comes from is a fact of the view, so only its DDLS says it.
      if (!isExtension && parsed.origins?.[element]) slot.origin = parsed.origins[element];
      entity.elements.set(element.toLowerCase(), slot);
    }

    if (!isExtension) {
      entity.lineage = dataSourcesFrom(text, rel)
        .filter((d) => PROPAGATING.has(d.kind))
        .map((d) => ({ name: d.name.toUpperCase(), kind: d.kind }));
      entity.ignorePropagated = /@Metadata\.ignorePropagatedAnnotations\s*:\s*true/i.test(stripped);
      // The select list was read: an element it does not declare inherits nothing from above.
      // A list with `*` in it declares more than it names, so it does not count as read.
      entity.listRead = Object.keys(parsed.origins ?? {}).length > 0 && !/[{,]\s*\*\s*[,}]/.test(stripped);
      entity.kind = definitionOf(text).kind;
    }

    entities.set(key, entity);
  }
  return index;
}

/** Upstream names the index does not hold yet: the views to read next to follow a chain. */
export function missingUpstream(index) {
  const out = new Set();
  for (const entity of index.entities.values()) {
    for (const l of entity.lineage) if (!index.entities.has(l.name)) out.add(l.name);
  }
  return [...out].sort();
}

/**
 * Entities upstream of `name` along propagating edges only, nearest first.
 * Cycles terminate; depth is capped, and hitting the cap is reported by the caller
 * rather than silently truncating a chain.
 */
export function upstreamOf(index, name, maxDepth = MAX_DEPTH) {
  const start = String(name ?? '').toUpperCase();
  const out = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const current of frontier) {
      for (const edge of index.entities.get(current)?.lineage ?? []) {
        if (seen.has(edge.name)) continue;
        seen.add(edge.name);
        out.push({ name: edge.name, kind: edge.kind, via: current, depth });
        next.push(edge.name);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * What stops an element of `entity` from inheriting from the views above it, checked in this
 * order. Measured on 2026-11-17 against the chain (docs/adt-api-reference.md, "What reaches a
 * CDS element"): a parameter projection receives nothing from its data source, and a view with
 * ignorePropagatedAnnotations silences everything above it -- for the views on top of it too.
 */
function blockAt(entity, origin) {
  if (origin?.kind === 'parameter') return { unreachable: { entity: entity.name, reason: 'parameter' } };
  if (entity.ignorePropagated) return { heldBy: { entity: entity.name, by: 'ignorePropagatedAnnotations' } };
  if (origin?.kind === 'expression') return { unverified: { entity: entity.name, reason: 'expression' } };
  return null;
}

/**
 * Every annotation written for `entity.element`, own layers first then upstream, each upstream row
 * saying whether it can reach the element.
 *
 * The walk follows the ELEMENT, not its name: at each view it reads where the element comes from
 * (lib/annotations.mjs, elementOrigin), so `Werks as Plant` goes on looking for `Werks` above.
 * A row that cannot reach is still listed, with what holds it -- `unreachable` (a parameter),
 * `heldBy` (ignorePropagatedAnnotations), or `unverified` (an expression, never measured) --
 * because "written upstream and held" is half of what a reader needs. A view reached along two
 * paths reaches if one of them is open. `depth` is the number of hops from the asked view.
 *
 * This is the source-reading half of the question `adt_annotation_chain` answers per element. It
 * says where each key was written; it does NOT say which one wins.
 */
export function reaching(index, entityName, elementName, opts = {}) {
  const wantKey = opts.key ? normalizeAnnotationKey(opts.key) : null;
  const rows = [];
  const own = index.entities.get(String(entityName ?? '').toUpperCase());
  if (!own) return rows;

  // Breadth first over (view, element name, block): the first visit of a view is its shortest
  // path, and an open path found later replaces a blocked one.
  const found = new Map();
  const seen = new Set();
  const queue = [{ key: own.name.toUpperCase(), name: String(elementName ?? ''), depth: 0, block: null }];
  while (queue.length) {
    const s = queue.shift();
    const sig = `${s.key}|${s.name.toLowerCase()}|${s.block ? 'held' : 'open'}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const holder = index.entities.get(s.key);
    const at = `${s.key}|${s.name.toLowerCase()}`;
    const before = found.get(at);
    if (!before || (before.block && !s.block)) found.set(at, { ...s, holder, order: before?.order ?? found.size });
    if (!holder || s.depth >= MAX_DEPTH) continue;
    const slot = holder.elements.get(s.name.toLowerCase());
    if (holder.listRead && !slot?.origin) continue;
    const block = s.block ?? blockAt(holder, slot?.origin);
    const name = !block && slot?.origin?.kind === 'field' ? slot.origin.field : s.name;
    for (const edge of holder.lineage) queue.push({ key: edge.name, name, depth: s.depth + 1, block });
  }

  for (const s of [...found.values()].sort((a, b) => a.order - b.order)) {
    const slot = s.holder?.elements?.get(s.name.toLowerCase());
    if (!slot) continue;
    for (const entry of slot.keys.values()) {
      if (wantKey && !normalizeAnnotationKey(entry.key).startsWith(wantKey)) continue;
      // The name as the source DECLARES it, not the uppercase lookup key: one column carrying
      // two conventions is how a downstream grep silently misses half its rows.
      rows.push({ ...entry, element: slot.name, from: s.holder.name, depth: s.depth, ...(s.block ?? {}) });
    }
  }
  return rows;
}
