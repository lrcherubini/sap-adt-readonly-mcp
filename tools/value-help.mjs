// adt_value_help -- which released value help fits this field, and with what element.
//
// The question that opened this cycle: "I have a Z CDS view using several standard
// fields and I want to add the right value helps -- how do I find the VH CDS?". Today
// that is manual and fails silently: any entity may be named in a
// `@Consumption.valueHelpDefinition`, including one that is NOT released (a Clean Core
// violation no local check catches) or one that is not a value help at all.
//
// The catalogue filters FIRST, before the system is touched; everything else is read from the
// system itself -- no local checkout, no documentation mirror:
//
//   0  annotation definitions: the system's own DDLA                ADT: 1
//   1  field inventory                  ADT: 1 + 2 per distinct data element
//   1b the entity's own source: which fields are already bound      ADT: 3
//   2  concepts (defaultComponentName > domain > element name > data element)   local
//   3  candidates, RELEASED ONLY, from the Clean Core catalogue                 local
//   3b if that found nothing: ask the system         ADT: 1, +2 for the value table
//   5  signal check on the candidates that survived            ADT: 3 per candidate
//   6  tiering A/B/C with the evidence, both profiles                           local
//   7  precedent: who else binds the winner, capped and filtered  ADT: 2+, opt-in
//   8  emission, every key validated against this release's DDLA                local
//   9  exposure: the service definitions that use the entity    ADT: 1 + 1 per SRVD (max 3)
//
// Step 3 is the important one: filtering to released BEFORE the round trip makes it
// impossible to recommend a non-released entity, and costs nothing. I_PlantVH is
// eliminated there, not after a call.
//
// Nothing here writes. Everything it reports carries where it came from, because the
// rule that these annotations identify a value help is observational -- see
// lib/vh-signals.mjs.

import { record } from '../lib/audit.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { loadCatalog, catalogStatus, catalogMissingGap, CatalogMissing } from '../lib/catalog.mjs';
import { inventory, resolveDataElement } from '../lib/ddic.mjs';
import {
  conceptsFor,
  candidateNames,
  catalogCandidate,
  hasFixedValues,
  semanticsFromAnnotations,
} from '../lib/vh-candidates.mjs';
import {
  searchConceptEntities,
  conceptFromValueTable,
  conceptFromName,
} from '../lib/concept-search.mjs';
import { classifyVhSignals, tierLabel } from '../lib/vh-signals.mjs';
import { parseAnnotations } from '../lib/annotations.mjs';
import { fromDdla, noDefs } from '../lib/annotation-defs.mjs';
import { edgesFromText } from '../lib/precedent.mjs';
import { sourceUriOf } from '../lib/package-sources.mjs';
import { checkExposure } from '../lib/srvd-check.mjs';
import { summarizeUsage, precedentCandidates } from '../lib/usage.mjs';
import { emit, renderOwnVhProposal } from '../lib/emit.mjs';

/**
 * The catalogue, loaded once per server run. Missing, it is fatal (lib/catalog.mjs says why:
 * no catalogue would look exactly like "there is no value help", which is a lie).
 */
export function loadSources(cfg, overrides = {}) {
  const paths = cfg.paths ?? {};
  const catalogInfo = overrides.catalog ? null : catalogStatus(paths.catalog, { release: cfg.catalogRelease ?? null });
  if (catalogInfo && !catalogInfo.installed) throw new CatalogMissing(catalogInfo);
  const catalog = overrides.catalog ?? loadCatalog(paths.catalog);
  return { catalog, catalogInfo, naming: cfg.valueHelp ?? {} };
}

/** The api with every method call counted into `spent.calls`: the cost reported is the cost made. */
const counted = (api, spent) =>
  new Proxy(api, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === 'function'
        ? (...args) => {
            spent.calls++;
            return v.apply(target, args);
          }
        : v;
    },
  });

/** Read the source of an entity, or null with the reason. Usually 3 ADT calls, each one counted. */
async function entitySource(api, name, spent) {
  const c = counted(api, spent);
  try {
    const { hit } = await resolveObject(c, name, undefined, 'source');
    const structure = await c.objectStructure(hit['adtcore:uri']);
    const url = structure.objectUrl ? `${structure.objectUrl}/source/main` : null;
    const source = await c.getObjectSource(url ?? structure.objectUrl);
    return { source, hit };
  } catch (e) {
    return { source: null, reason: `${name}: ${e.message ?? e}` };
  }
}

/**
 * The released *StdVH / *VH sibling of an entity, if the catalogue actually has one.
 *
 * Returns null for an entity that is already a variant, and for one whose sibling does
 * not exist -- the point is to name a real object or say nothing.
 */
function variantOf(entity, catalog) {
  const name = String(entity ?? '');
  if (!name || /(StdVH|VH)$/i.test(name)) return null;
  for (const suffix of ['StdVH', 'VH']) {
    const candidate = `${name}${suffix}`;
    if (catalog?.isReleased?.(candidate)) {
      return {
        entity: candidate,
        why:
          `${candidate} is released and is the value-help variant of ${name}: it is ` +
          'shaped for F4 (fewer columns, its own text association) and does not carry ' +
          "the business entity's authorisation surface",
      };
    }
  }
  return null;
}

/**
 * Step 9: the service definitions that expose the entity, found by asking the system who uses
 * it (the SRVD rows of its where-used) and read from the system -- at most three. No file name,
 * no checkout: a service that lives in another package is found just the same.
 */
async function servicesOf(ctx, entityHit) {
  const uri = entityHit?.['adtcore:uri'];
  if (!uri) return { services: [], note: 'the entity was not resolved, so its services were not looked up' };
  let rows;
  try {
    rows = await ctx.api.usageReferences(uri);
    ctx.spent.calls++;
  } catch (e) {
    ctx.spent.calls++;
    ctx.spent.failures = ctx.spent.failures ?? [];
    ctx.spent.failures.push({ call: 'usageReferences', subject: entityHit['adtcore:name'], reason: `${e.message ?? e}` });
    return { services: [], note: 'the where-used call failed: exposure NOT checked' };
  }
  const srvd = summarizeUsage(rows, { types: ['SRVD/SRV'], cap: 3, requireProductive: false });
  const services = [];
  for (const r of srvd.rows) {
    try {
      const source = await ctx.api.getObjectSource(sourceUriOf({ type: 'SRVD/SRV', name: r.name }));
      ctx.spent.calls++;
      services.push({ file: `${r.package || '?'}/${String(r.name).toLowerCase()}.srvd`, source: String(source) });
    } catch (e) {
      ctx.spent.calls++;
      ctx.spent.failures = ctx.spent.failures ?? [];
      ctx.spent.failures.push({ call: 'getObjectSource', subject: r.name, reason: `${e.message ?? e}` });
    }
  }
  return { services, note: srvd.truncated ? `${srvd.total} service definitions use it; the first ${srvd.returned} were read` : null };
}

/**
 * Step 7, opt-in: ask the system who else binds this entity, and read ONE of them.
 *
 * Never the raw list. Measured: where-used on I_PlantStdVH is 1,531 rows / 356 KB and
 * blew the reply budget outright, so it is filtered to direct productive CDS consumers,
 * ranked, and capped before a single source is read.
 */
async function livePrecedent(ctx, entity) {
  const read = ctx.cache.get(entity);
  const uri = read?.hit?.['adtcore:uri'];
  if (!uri) return null;
  let rows;
  try {
    rows = await ctx.api.usageReferences(uri);
    ctx.spent.calls++;
  } catch (e) {
    ctx.spent.calls++;
    // This used to return null with nothing written anywhere, which made "the system
    // has no other binding of this entity" and "the where-used call failed" the same
    // answer. They are opposite answers: the first justifies proposing a binding, the
    // second means nobody looked.
    ctx.spent.failures = ctx.spent.failures ?? [];
    ctx.spent.failures.push({ call: 'usageReferences', subject: entity, reason: `${e.message ?? e}` });
    return null;
  }
  const summary = summarizeUsage(rows, { cap: 20 });
  for (const consumer of precedentCandidates(summary, 1)) {
    const src = await entitySource(ctx.api, consumer.name, ctx.spent);
    if (!src.source) continue;
    const edge = edgesFromText(src.source, consumer.name).find(
      (e) => e.entity?.toUpperCase() === entity.toUpperCase() && e.additionalBinding?.length
    );
    if (edge) return { ...edge, cite: `${consumer.name} (read from the system)` };
  }
  return null;
}

/**
 * Step 3b: the active search, run ONLY when name matching came back with nothing.
 *
 * Two routes, cheapest first (lib/concept-search.mjs carries the measurements). Both
 * hand back NAMES, which go through `catalogCandidate` -- the same release gate as a
 * generated name -- and then through the same signal check as everything else.
 *
 * Order matters for cost: the type-filtered search is one call and ~3 KB, the value
 * table hop is two calls and a reply that reached 3.4 MB on T006. So the table is only
 * consulted when the concept word itself is the problem, which is the BaseUnit case:
 * nothing starting with BASEUNIT or MEINS exists, because the VDM calls it
 * UnitOfMeasure and only the value table says so.
 */
async function activeSearch(ctx, field, concepts) {
  const { sources, opts } = ctx;
  const budget = () => ctx.spent.calls < (opts.maxCalls ?? 40);
  const steps = [];
  const found = [];

  const harvest = (names, concept, from, strength) => {
    for (const name of names) {
      const c = catalogCandidate(name, sources.catalog, {
        concept,
        from,
        strength,
        kind: `found in the system by ${from}`,
      });
      if (c && !found.some((f) => f.name === c.name)) found.push(c);
    }
  };

  // Route 1 -- anchored, type-filtered repository search, per concept, strongest first.
  for (const c of concepts.slice(0, opts.searchConcepts ?? 2)) {
    if (!budget()) break;
    const r = await searchConceptEntities(ctx.api, c.concept, sources.catalog, ctx.spent);
    steps.push({ route: 'repository search', ...r });
    if (r.ok) harvest(r.names, c.concept, `a type:ddls search for ${r.queries.join(' / ')}`, c.strength);
  }
  if (found.length) return { found, steps };

  // Route 2 -- the value table, and the concept name it yields re-enters route 1 and
  // the offline forms. This is the only route that can rename the concept.
  if (field.valueTable && budget()) {
    const r = await conceptFromValueTable(ctx.api, field.valueTable, sources.catalog, ctx.spent, {
      resolve: resolveObject,
    });
    steps.push({ route: 'value table where-used', ...r, views: r.views?.slice(0, 5) });
    if (r.ok) {
      const concept = conceptFromName(r.concept);
      // Weaker than every offline signal on purpose: the system said this table models
      // this concept, not that this concept is what the FIELD is about.
      const from = `the released CDS entity that reads the value table ${r.table} (${r.concept})`;
      harvest([r.concept], concept, from, 7);
      for (const c of candidateNames([{ concept, from, strength: 7 }], sources.catalog, { max: 6 })) {
        if (!found.some((f) => f.name === c.name)) found.push(c);
      }
      if (budget()) {
        const s = await searchConceptEntities(ctx.api, concept, sources.catalog, ctx.spent);
        steps.push({ route: 'repository search', ...s });
        if (s.ok) harvest(s.names, concept, `a type:ddls search for ${s.queries.join(' / ')}`, 7);
      }
    }
  }
  return { found, steps };
}

const TIER_RANK = { A: 0, B: 1, unverified: 2, C: 3 };

/**
 * Candidates best first: how good a value help it is, THEN how well the concept fits,
 * and only then how popular it is.
 *
 * Concept strength before popularity is not cosmetic. Measured live on
 * ZC_DemoItemRating/ProductType, ranking on precedent alone put `I_PRODUCTSTDVH`
 * (concept PRODUCT, from a truncated element name) ahead of `I_PRODUCTTYPE` (the exact
 * match), because the Product value help is bound all over the place. Both are tier A,
 * so the tier could not separate them, and the emitted annotation offered a list of
 * products for a field that holds a product TYPE.
 *
 * Popularity stays as the last word only: between two candidates that fit the concept
 * equally well, the one the system's own consumers already use is the better bet.
 */
export function rankCandidates(candidates) {
  return [...candidates].sort(
    (a, b) =>
      (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) ||
      (a.strength ?? 99) - (b.strength ?? 99) ||
      (b.precedent?.count ?? 0) - (a.precedent?.count ?? 0)
  );
}

/**
 * Analyse one field: candidates, tiers, the annotation to write.
 *
 * @param {object} ctx { api, sources, defs, spent, cache, opts }
 */
async function analyseField(ctx, field) {
  const { sources, defs, opts } = ctx;
  const out = {
    field: field.name,
    dataElement: field.dataElement ?? null,
    domain: field.domain ?? null,
    valueTable: field.valueTable ?? null,
    evidence: [],
  };
  // A step of the DDIC chain that failed is carried into the answer. Losing it here
  // would turn "I could not resolve this field" into "this field needs no value help".
  if (field.reason) out.degraded = field.reason;

  // Already bound? The entity's own source (read from the system) says, and proposing a
  // duplicate would be noise at best and a conflicting second definition at worst.
  const already = (ctx.ownEdges ?? []).find(
    (e) => e.element && field.name && e.element.toLowerCase() === field.name.toLowerCase()
  );
  if (already) {
    out.status = 'already covered';
    out.boundTo = already.entity;
    out.at = `${already.file}:${already.line}`;
    // Bound is not the same as bound WELL. The VDM publishes a dedicated value-help
    // variant next to many business views (`I_UnitOfMeasure` / `I_UnitOfMeasureStdVH`),
    // and the variant is the one shaped for F4: fewer columns, its own text association,
    // no authorisation surface of the business entity.
    //
    // ⚠️ This is a catalogue LOOKUP, never a naming guess: the variant is reported only
    // when a released object with that exact name exists. Nothing is inferred from the
    // suffix convention alone.
    const variant = variantOf(already.entity, sources.catalog);
    if (variant) out.variantAvailable = variant;
    return out;
  }

  if (hasFixedValues(field)) {
    out.status = 'no value help wanted';
    out.reason =
      `the domain ${field.domain} carries ${field.fixValues} fixed values: DDIC renders ` +
      'them as a dropdown already, and a value help would add a round trip and a second ' +
      'source of truth';
    return out;
  }

  const concepts = conceptsFor(field);
  out.concepts = concepts;
  if (!concepts.length) {
    out.status = 'no candidate';
    out.reason =
      field.reason ??
      'nothing about this field names a concept (no data element, no domain, no ' +
        'recognisable element name), so no candidate can be generated without guessing';
    return out;
  }

  let candidates = candidateNames(concepts, sources.catalog, { max: opts.maxCandidates ?? 6 });

  // Name matching came back empty. That is not the answer -- it is the point where the
  // system has to be asked, because the VDM may simply call the concept something else.
  if (!candidates.length && opts.deepSearch !== false) {
    const active = await activeSearch(ctx, field, concepts);
    out.activeSearch = active.steps;
    candidates = active.found.slice(0, opts.maxCandidates ?? 6);
  }

  if (!candidates.length) {
    out.status = 'no candidate';
    out.reason =
      `no entity in the Clean Core catalogue matches ${concepts
        .map((c) => c.concept)
        .join(', ')}` +
      (out.activeSearch?.length
        ? ', and asking the system directly found none either: ' +
          out.activeSearch.map((s) => `${s.route} -- ${s.reason ?? 'nothing released'}`).join('; ')
        : opts.deepSearch === false
          ? '. The active search was switched off (deepSearch: false), so the system was not asked'
          : '. Name matching does not close the set: the VDM may call this concept something ' +
            `else${field.valueTable ? ` (its value table is ${field.valueTable})` : ''}`);
    // ⚠️ The source of a proposed own view is NEVER guessed. An earlier version wrote
    // `I_${field.name}` here, which for BaseUnit emitted a view selecting from
    // `I_BaseUnit` -- an entity that exists nowhere -- inside a block shaped to be
    // pasted. A name that LOOKS verified and is not is worse than an admitted gap, so
    // the placeholder stays a placeholder unless a released entity was actually found.
    const confirmed = (out.activeSearch ?? [])
      .flatMap((s) => (s.route === 'value table where-used' && s.ok ? [s.concept] : []))
      .find((n) => sources.catalog.isReleased(n));
    out.proposal = renderOwnVhProposal(
      {
        concept: field.name,
        source: confirmed ?? undefined,
        key: field.name,
        text: field.label ?? undefined,
      },
      ctx.sources.naming ?? {}
    );
    out.proposal.notes.unshift(
      confirmed
        ? `the source ${confirmed} is released in the Clean Core catalogue, and it was found ` +
            'by where-used on the value table, not by guessing a name'
        : 'the source is left as a placeholder ON PURPOSE: no released entity was confirmed ' +
            'for this concept, and naming an unverified one would put a name that does not ' +
            'exist into a block shaped to be pasted. Pick the source, then confirm it in the ' +
            'release catalogue before writing the view'
    );
    return out;
  }

  // Verify the candidates that are recommendable. A candidate the catalogue already
  // rejects is reported with its reason and costs no call.
  for (const c of candidates) {
    if (!c.recommendable) {
      c.tier = 'C';
      c.reasons = [c.reason];
      continue;
    }
    if (ctx.spent.calls >= (opts.maxCalls ?? 40)) {
      c.tier = 'unverified';
      c.reasons = ['the ADT call budget for this run was reached before this candidate'];
      continue;
    }
    if (!ctx.cache.has(c.name)) {
      const read = await entitySource(ctx.api, c.name, ctx.spent);
      ctx.cache.set(c.name, read);
    }
    const read = ctx.cache.get(c.name);
    if (!read.source) {
      c.tier = 'unverified';
      c.reasons = [`its source could not be read (${read.reason})`];
      continue;
    }
    const parsed = parseAnnotations(read.source);
    const verdict = classifyVhSignals(parsed.entity, {
      profile: /^[ZY]/i.test(c.name) ? 'z' : 'standard',
      released: true,
      name: c.name,
    });
    Object.assign(c, verdict, { label: tierLabel(verdict.tier) });
  }

  out.candidates = candidates;
  const best = rankCandidates(candidates)[0];

  if (!best || (best.tier !== 'A' && best.tier !== 'B')) {
    out.status = 'no recommendation';
    out.reason =
      'candidates exist but none of them is a released value help: ' +
      candidates.map((c) => `${c.name} (${c.reasons?.[0] ?? c.tier})`).join('; ');
    return out;
  }

  out.status = 'recommended';
  out.recommended = best.name;
  // Which concept won, and where that concept came from: without it the reader cannot
  // see that a recommendation rests on a weak signal (a truncated element name, say)
  // rather than on the data element itself.
  out.matchedConcept = { concept: best.concept, from: best.from, strength: best.strength };
  out.tier = best.tier;
  out.why = best.signals;
  out.provenance = best.provenance;

  // The element to bind: what the entity itself says (representativeKey). Never the field
  // name by assumption -- when the value help states none, the answer says CHECK THIS.
  const element = best.representativeKey ?? field.defaultComponentName ?? field.name;
  out.elementSource = best.representativeKey
    ? 'ObjectModel.representativeKey of the value help'
    : 'the field itself -- the value help states no representative key, so CHECK THIS';

  let binding = null;
  if (opts.precedent && ctx.spent.calls + 4 <= (opts.maxCalls ?? 40)) {
    binding = await livePrecedent(ctx, best.name);
    if (binding) out.evidence.push(`binding taken from the system's own consumers: ${binding.cite}`);
  }
  const rec = {
    entity: { name: best.name, element },
    ...(binding
      ? { additionalBinding: binding.additionalBinding.map((b) => ({ ...b, precedent: binding.cite })) }
      : {}),
  };
  const emitted = emit(rec, defs, { scope: field.isParameter ? 'PARAMETER' : 'ELEMENT' });
  out.annotation = emitted.text;
  out.emissionNotes = [...(emitted.notes ?? []), ...(emitted.omitted ?? [])];
  out.warnings = emitted.warnings;
  out.validatedAgainst = emitted.validation.source;
  return out;
}

/**
 * Opt-in: read the entity's own source once and attach the SEMANTIC annotations its
 * fields carry.
 *
 * Off by default, and the reason is cost against yield. The DDIC type already answers
 * the same question for free -- a UNIT field is a unit key whatever the source says --
 * so this pays 3 ADT calls to reach the residue the type cannot express: a calculated
 * element (which has no data element at all, and today comes back as "no concept to
 * match on") or a plain CHAR that carries its meaning by annotation.
 *
 * ⚠️ It reads the source of the entity as WRITTEN. In a projection the annotation is
 * usually inherited from the interface view and is not restated, so an empty result
 * here means "this file does not say", never "the field has no semantics". That is
 * reported, not swallowed.
 */
function applySemanticAnnotations(entity, fields, { source, reason }) {
  if (!source) {
    return `semantic annotations NOT read for ${entity} (${reason}). Fields keep the ` +
      'signals their DDIC type gives; this is not evidence that they carry none.';
  }
  const parsed = parseAnnotations(source);
  const semantics = semanticsFromAnnotations(parsed.elements);
  if (!semantics.size) {
    return `${entity} states no semantic annotation on any field in its own source. In a ` +
      'projection these are inherited from the interface view and not restated, so this ' +
      'is what the file says, not what the model says.';
  }
  const byLower = new Map([...semantics].map(([k, v]) => [k.toLowerCase(), v]));
  const hit = [];
  for (const f of fields) {
    const found = byLower.get(String(f.name).toLowerCase());
    if (!found) continue;
    f.semantics = found;
    hit.push(`${f.name} (${found.concept})`);
  }
  return hit.length
    ? `semantic annotations read from ${entity}: ${hit.join(', ')}`
    : `${entity} carries semantic annotations, but on none of the fields analysed`;
}

/**
 * The whole analysis. Separated from the tool definition so it can be driven with a
 * doubled `api` and asserted on both its output AND the calls it made.
 */
export async function analyseValueHelp(api, sources, params = {}) {
  const opts = { maxCandidates: 6, maxFields: 25, maxCalls: 40, ...params };
  const spent = { calls: 0 };
  const cache = new Map();

  // Annotation definitions: the system's own DDLA, exact for its release. Without it the
  // emission says "not validated" -- never validated against another release's documentation.
  let defs = noDefs(params.validate === false ? 'validation switched off (validate: false)' : 'the system DDLA was not read');
  if (params.validate !== false && api?.annotationDefinitions) {
    try {
      const ddla = await api.annotationDefinitions();
      spent.calls++;
      defs = fromDdla(ddla);
    } catch (e) {
      spent.calls++;
      defs = noDefs('the system DDLA could not be read');
      spent.failures = spent.failures ?? [];
      spent.failures.push({ call: 'annotationDefinitions', subject: 'system DDLA', reason: `${e.message ?? e}` });
    }
  }

  let fields = [];
  const notes = [];
  let own = null;
  if (params.entity) {
    const inv = await inventory(api, params.entity, {
      only: params.fields ?? (params.field ? [params.field] : undefined),
      max: opts.maxFields,
    });
    fields = inv.fields;
    spent.calls += inv.calls;
    notes.push(...inv.notes);
    // The entity's own source, once: which fields are already bound, and (opt-in) the
    // semantic annotations. Read from the system, so it is the active version, not a copy.
    own = await entitySource(api, params.entity, spent);
    if (!own.source) notes.push(`the source of ${params.entity} was NOT read (${own.reason}): fields already bound cannot be recognised`);
    if (params.readAnnotations) notes.push(applySemanticAnnotations(params.entity, fields, own));
  } else if (params.dataElement || params.field) {
    const chain = params.dataElement
      ? await resolveDataElement(api, params.dataElement)
      : { ok: false, calls: 0 };
    spent.calls += chain.calls ?? 0;
    fields = [{ name: params.field ?? params.dataElement, ...chain }];
  } else {
    throw new Error('Give an entity, or a field/dataElement to look up.');
  }

  const results = [];
  for (const field of fields) {
    results.push(await analyseField({ api, sources, defs, spent, cache, opts, ownEdges: own?.source ? edgesFromText(own.source, params.entity) : [] }, field));
  }

  // Exposure: every entity we recommend has to be exposed in the service, standard
  // included -- an omission makes the F4 come up empty with no error anywhere.
  let exposure = null;
  if (params.entity) {
    const edges = results
      .filter((r) => r.recommended || r.boundTo)
      .map((r) => ({ entity: r.recommended ?? r.boundTo, element: r.field }));
    if (edges.length && params.exposure !== false) {
      const found = await servicesOf({ api, spent }, own?.hit);
      exposure = { ...checkExposure(edges, found.services), ...(found.note ? { lookup: found.note } : {}) };
    }
  }

  return {
    entity: params.entity ?? null,
    fields: results,
    exposure,
    adtCalls: spent.calls,
    // Measured: maxCalls: 8 on a dataElement lookup produced 9. That is not a
    // leak -- resolving the field to its data element and domain, and reading the DDLA,
    // happen before any discretionary work and cannot be skipped without answering
    // nothing at all. But a stated ceiling that is silently exceeded is the same defect
    // class as a swallowed error, so the overshoot is reported rather than left to be
    // noticed.
    ...(spent.calls > opts.maxCalls
      ? {
          adtCallsNote:
            `${spent.calls} calls against a maxCalls of ${opts.maxCalls}: the ceiling ` +
            'bounds the discretionary search (candidates, concept search, precedent), ' +
            'not the setup reads that resolve the field to its data element and domain.',
        }
      : {}),
    // ADT calls that failed and were absorbed rather than raised. Absorbing them is
    // right -- a partial answer beats no answer -- but hiding them is not: each one
    // makes some part of the reply weaker than it looks.
    ...(spent.failures?.length ? { degraded: spent.failures } : {}),
    sources: {
      catalogue:
        `${sources.catalog.count} objects (${sources.catalog.releaseInfoCount} release info + ` +
        `${sources.catalog.classificationCount} classifications), ${sources.catalog.file}` +
        (sources.catalog.note ? ` -- DEGRADED: ${sources.catalog.note}` : ''),
      annotationDefinitions: defs.available ? defs.source : `unavailable (${defs.note}) -- emitted keys are NOT validated`,
      precedent: params.precedent ? 'the system: who else binds the recommended entity' : 'not asked (precedent: true reads who else binds the winner)',
    },
    notes,
  };
}

/** The sixth tool. */
export function valueHelpTool(cfg, api, sources, journal) {
  let loaded = sources ?? null;
  return {
    definition: {
      name: 'adt_value_help',
      description:
        'Which RELEASED value-help CDS entity fits a field: the element to bind and the ' +
        'annotation to paste, classified A/B/C with evidence, keys validated for this release, ' +
        'exposure in the service definition checked. Needs the Clean Core catalogue.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'CDS entity to analyse, e.g. ZC_DemoItemRating' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only these fields (default: all, up to maxFields)',
          },
          field: { type: 'string', description: 'A single field name' },
          dataElement: { type: 'string', description: 'Look up by data element instead, e.g. WERKS_D' },
          maxCandidates: { type: 'integer', description: 'Candidates verified per field (default 6)' },
          maxFields: { type: 'integer', description: 'Fields resolved (default 25)' },
          maxCalls: {
            type: 'integer',
            description: 'Cap on optional calls (default 40); field resolution is extra.',
          },
          readAnnotations: {
            type: 'boolean',
            description: 'Read @Semantics from the source (3 calls); for calculated elements.',
          },
          deepSearch: {
            type: 'boolean',
            description: 'If names match nothing, search the concept and value table. Default true.',
          },
          searchConcepts: {
            type: 'integer',
            description: 'How many concepts the active search may query (default 2)',
          },
          precedent: {
            type: 'boolean',
            description: 'Find who else binds the entity, to copy its binding (2+ calls).',
          },
          exposure: {
            type: 'boolean',
            description: 'Check exposure in the using service definitions (1-4 calls). Default true.',
          },
          validate: {
            type: 'boolean',
            description: 'Validate emitted keys against the annotation definitions. Default true.',
          },
        },
      },
    },
    async handler(params) {
      if (!loaded) {
        try {
          loaded = loadSources(cfg);
        } catch (e) {
          // Not cached: the next call retries, so a catalogue synced meanwhile is picked up.
          if (e instanceof CatalogMissing && journal?.enabled) journal.gap(catalogMissingGap(e.status));
          throw e;
        }
      }
      const result = await analyseValueHelp(api, loaded, params);
      // The pipeline states every degradation in its own reply -- it always did. What it
      // never did was make them countable, so the same limit was rediscovered instead of
      // being fixed. The lib stays pure; the tool is where the journal is written, the
      // same split the package scans use.
      if (journal?.enabled) {
        for (const f of result.degraded ?? []) {
          journal.gap({
            code: 'ADT_ERROR',
            subject: `${f.call} on ${f.subject}`,
            detail: f.reason,
            impact: 'this part of the answer rests on less evidence than the design intends',
            fallback: 'retry, or read the object in the IDE',
          });
        }
        if (loaded.catalog?.note) {
          journal.gap({
            code: 'CATALOG_PARTIAL',
            subject: 'objectClassifications_SAP.json',
            detail: loaded.catalog.note,
            impact: 'a released entity that exists only in that catalogue is invisible to the ranking',
            fallback: 'npm run sync:catalog',
          });
        }
        for (const m of result.exposure?.missing ?? []) {
          // A real defect class, proven live: the ValueList points at an entity the service
          // does not expose, and the F4 comes up empty with no error anywhere. It was already
          // in the answer; now it is in the backlog.
          journal.finding({
            code: 'SRVD_EXPOSURE_MISSING',
            subject: m.entity,
            file: m.at ? String(m.at).split(':')[0] : undefined,
            context: { boundOn: m.boundOn, entity: result.entity ?? undefined },
            effect: m.effect,
            fix: m.fix,
          });
        }
        for (const f of result.fields ?? []) {
          if (f.variantAvailable) {
            journal.finding({
              code: 'VH_VARIANT_AVAILABLE',
              subject: `${result.entity ?? '?'}.${f.field ?? f.name ?? '?'}`,
              file: f.at ? String(f.at).split(':')[0] : undefined,
              context: { boundTo: f.boundTo, variant: f.variantAvailable.entity },
              effect: f.variantAvailable.why,
              fix: `bind ${f.variantAvailable.entity} instead of ${f.boundTo}`,
            });
          }
          if (f.status !== 'no candidate') continue;
          journal.gap({
            code: 'CONCEPT_NO_CANDIDATE',
            subject: `${result.entity ?? '?'}.${f.field ?? f.name ?? '?'}`,
            detail: String(f.reason ?? 'no released candidate found'),
            impact:
              'either the field genuinely needs an own value help, or the concept ' +
              'extraction is too weak to reach the VDM name',
            fallback: 'the proposal in the answer is a placeholder: its source is NOT verified',
          });
        }
      }
      record(
        cfg,
        'adt_value_help',
        params.entity ?? params.field ?? params.dataElement ?? '?',
        result.fields.length
      );
      const out = loaded.catalogInfo ? { ...result, catalog: loaded.catalogInfo } : result;
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      };
    },
  };
}
