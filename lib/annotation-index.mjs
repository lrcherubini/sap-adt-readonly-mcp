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
        // First writer of a key in a layer wins within that layer; the layers
        // themselves are kept apart, because "who wrote it" is half the answer.
        if (!slot.keys.has(`${layer}|${nk}`)) {
          slot.keys.set(`${layer}|${nk}`, { key: k, value, layer, file: rel, repo, line });
        }
      }
      entity.elements.set(element.toLowerCase(), slot);
    }

    if (!isExtension) {
      entity.lineage = dataSourcesFrom(text, rel)
        .filter((d) => PROPAGATING.has(d.kind))
        .map((d) => ({ name: d.name.toUpperCase(), kind: d.kind }));
      entity.ignorePropagated = /@Metadata\.ignorePropagatedAnnotations\s*:\s*true/i.test(stripped);
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
 * Every annotation that reaches `entity.element`, own layers first then upstream.
 *
 * This is the source-reading half of the question `adt_annotation_chain` answers per element. It
 * says where each key was written; it does NOT say which one wins.
 */
export function reaching(index, entityName, elementName, opts = {}) {
  const wantKey = opts.key ? normalizeAnnotationKey(opts.key) : null;
  const rows = [];
  const collect = (holder, from, depth) => {
    const slot = holder?.elements?.get(String(elementName ?? '').toLowerCase());
    if (!slot) return;
    for (const entry of slot.keys.values()) {
      if (wantKey && !normalizeAnnotationKey(entry.key).startsWith(wantKey)) continue;
      rows.push({ ...entry, element: slot.name, from, depth });
    }
  };
  const own = index.entities.get(String(entityName ?? '').toUpperCase());
  if (!own) return rows;
  collect(own, own.name, 0);
  for (const up of upstreamOf(index, entityName)) {
    const holder = index.entities.get(up.name);
    // Report the name as the source DECLARES it, not the uppercase lookup key. Own
    // layers already came out cased, and one column carrying two conventions is how a
    // downstream grep silently misses half its rows.
    collect(holder, holder?.name ?? up.name, up.depth);
  }
  return rows;
}
