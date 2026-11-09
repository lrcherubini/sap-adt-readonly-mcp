// The Fiori launchpad, read: the OData V2 bodies of PAGE_BUILDER_CONF/CUST and the FDM
// repository services, turned into what a person asks about -- a catalog's tiles and target
// mappings, a group's tiles, a space's pages. Used by adt_launchpad.
//
// Every shape here is measured (docs/adt-api-reference.md, "Fiori launchpad, OData V2" and
// "The launchpad and role routes, as built", 2026-10-01/02). Three things the parser does on
// purpose:
//   * the tile/target-mapping content is a JSON inside a JSON string inside a JSON string
//     (`configuration` -> `tileConfiguration`); a level that does not parse is reported as
//     drift and its text kept, never dropped;
//   * the instance's own `tileProperties` bag overrides the configuration (the title shown in
//     the launchpad is the bag's when it has one -- measured on ZDEMO_CAT and Café);
//   * every person-like key is removed before anything leaves (`stripPersons`): the routes
//     select none, and the FDM viz shape is still unmeasured, so the rule is enforced, not
//     assumed.

export const CATALOG_PREFIX = 'X-SAP-UI2-CATALOGPAGE:';
export const GROUP_CATALOG = '/UI2/FLPD_CATALOG';
export const CHIP_TARGET_MAPPING = 'X-SAP-UI2-CHIP:/UI2/ACTION';
export const CHIP_STATIC_TILE = 'X-SAP-UI2-CHIP:/UI2/STATIC_APPLAUNCHER';
export const CHIP_DYNAMIC_TILE = 'X-SAP-UI2-CHIP:/UI2/DYNAMIC_APPLAUNCHER';

const PERSON = /^(createdBy|modifiedBy|changedBy|createdByFullname|modifiedByFullname|.*fullname|username|.*uname|responsible)$/i;

/** A copy without OData plumbing (`__metadata`, `__deferred`) and without any person-like key. */
export function stripPersons(value) {
  if (Array.isArray(value)) return value.map(stripPersons);
  if (!value || typeof value !== 'object') return value;
  if (value.__deferred && Object.keys(value).length === 1) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__metadata' || PERSON.test(k)) continue;
    const s = stripPersons(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** `d` of an OData V2 JSON body; a body without it is drift, not an empty answer. */
export function odataBody(text) {
  let j;
  try {
    j = JSON.parse(String(text ?? ''));
  } catch (e) {
    throw new Error(`the body is not JSON (${e.message}); nothing was interpreted`);
  }
  if (!j || typeof j.d !== 'object' || j.d === null) throw new Error('the body has no OData "d" node; nothing was interpreted');
  return j.d;
}

const results = (d) => (Array.isArray(d?.results) ? d.results : null);

/** A catalog id as the routes want it: a bare `ZDEMO_CAT` gains the catalog page prefix. */
export function catalogPageId(id) {
  const s = String(id ?? '').trim();
  return s.startsWith(CATALOG_PREFIX) ? s : `${CATALOG_PREFIX}${s}`;
}

/** Whose catalog: Z/Y by name (either case), created in the client without a prefix, SAP changed in the client, or SAP's. */
export function catalogOrigin(row) {
  const domain = String(row.domainId || row.id || '').replace(CATALOG_PREFIX, '');
  // Case-insensitive on purpose: customer catalogs can start with a lowercase z
  // (ZDEMO_TC_TRM_APPS, zdemo_apr -- read 2026-10-02); the id itself keeps its case.
  if (/^[ZY]/i.test(domain)) return 'customer';
  // A namespaced id (/UI2/..., /SCWM/...) is a product of SAP or of an SAP partner, never the
  // customer's -- a Z after the namespace included (/UI2/ZDEMO_TEST). Decided by the user on
  // 2026-10-02; in the client it is SAP content there (/UI2/C2GFLPPLUGIN), not a customer one.
  if (domain.startsWith('/')) return row.scope === 'CUSTOMIZING' ? 'sap-changed' : 'sap';
  if (row.scope === 'CUSTOMIZING' && !/^SAP_/.test(domain)) return 'customer-no-prefix';
  if (row.scope === 'CUSTOMIZING') return 'sap-changed';
  return 'sap';
}

export function parseCatalogList(text, layer) {
  const rows = results(odataBody(text));
  if (!rows) throw new Error('the catalog list has no "results"; nothing was interpreted');
  return rows.map((r) => ({
    id: r.id,
    domainId: r.domainId,
    title: r.title,
    type: r.type,
    scope: r.scope,
    chipCount: Number(r.chipCount) || 0,
    ...(r.remoteId ? { remoteId: r.remoteId } : {}),
    ...(r.systemAlias ? { systemAlias: r.systemAlias } : {}),
    layer,
    origin: catalogOrigin(r),
  }));
}

export function parseGroupList(text) {
  const rows = results(odataBody(text));
  if (!rows) throw new Error('the group list has no "results"; nothing was interpreted');
  return rows.map((r) => ({ id: r.id, title: r.title, scope: r.scope, origin: /^[ZY]/i.test(r.id) ? 'customer' : r.scope === 'CUSTOMIZING' ? 'customer-no-prefix' : 'sap' }));
}

/**
 * `configuration` -> `tileConfiguration` -> object. Returns {value, drift}: a level that does
 * not parse is drift with the text kept.
 */
export function tileConfigurationOf(configuration) {
  if (!configuration) return { value: null, drift: null };
  let outer;
  try {
    outer = JSON.parse(configuration);
  } catch (e) {
    return { value: null, drift: { where: `configuration: ${e.message}`, text: String(configuration).slice(0, 400) } };
  }
  const inner = outer?.tileConfiguration;
  if (inner === undefined) return { value: null, drift: { where: 'configuration has no tileConfiguration', text: String(configuration).slice(0, 400) } };
  if (typeof inner !== 'string') return { value: inner, drift: null };
  try {
    return { value: JSON.parse(inner), drift: null };
  } catch (e) {
    return { value: null, drift: { where: `tileConfiguration: ${e.message}`, text: inner.slice(0, 400) } };
  }
}

const bagsOf = (instance) => {
  const out = {};
  for (const b of results(instance?.ChipInstanceBags) ?? []) {
    out[b.id] = Object.fromEntries((results(b.ChipInstanceProperties) ?? []).map((p) => [p.name, p.value]));
  }
  return out;
};

const parametersOf = (signature) =>
  Object.fromEntries(
    Object.entries(signature?.parameters ?? {}).map(([name, p]) => [
      name,
      {
        required: p?.required === true,
        ...(p?.rename_to ? { renameTo: p.rename_to } : {}),
        ...(p?.defaultValue?.value ? { default: p.defaultValue.value } : {}),
        ...(p?.filter?.value ? { filter: p.filter.value } : {}),
      },
    ])
  );

/** A target mapping (/UI2/ACTION) as the intent it serves and the application it starts. */
export function targetMappingOf(c) {
  const provider = c.navigation_provider || null;
  return {
    intent: c.semantic_object && c.semantic_action ? `${c.semantic_object}-${c.semantic_action}` : null,
    semanticObject: c.semantic_object || null,
    action: c.semantic_action || null,
    provider,
    application:
      provider === 'TR'
        ? { transaction: c.transaction?.code || null }
        : provider === 'WDA'
          ? { webDynpro: c.web_dynpro?.application || null, configuration: c.web_dynpro?.configuration || null }
          : provider === 'URL'
            ? { url: c.url || null }
            : c.ui5_component
              ? { ui5Component: c.ui5_component, url: c.url || null }
              : { url: c.url || null, applicationId: c.target_application_id || null },
    ...(c.target_system_alias ? { systemAlias: c.target_system_alias } : {}),
    parameters: parametersOf(c.signature),
    additionalParameters: c.signature?.additional_parameters ?? null,
    ...(c.form_factors ? { formFactors: c.form_factors } : {}),
    ...(c.mapping_signature ? { mappingSignature: c.mapping_signature } : {}),
  };
}

/** A tile (static or dynamic app launcher) as what it shows and where it navigates. */
export function tileOf(c, props = {}) {
  const pick = (k) => props[k] || c[k] || null;
  return {
    title: pick('display_title_text'),
    subtitle: pick('display_subtitle_text'),
    info: pick('display_info_text'),
    keywords: pick('display_search_keywords'),
    icon: c.display_icon_url || null,
    intent:
      c.navigation_use_semantic_object !== false && c.navigation_semantic_object
        ? `${c.navigation_semantic_object}-${c.navigation_semantic_action}`
        : null,
    parameters: c.navigation_semantic_parameters || null,
    targetUrl: c.navigation_target_url || null,
    ...(c.service_url ? { serviceUrl: c.service_url } : {}),
  };
}

/** `X-SAP-UI2-PAGE:X-SAP-UI2-CATALOGPAGE:<catalog>:<instance>` -> {catalog, instance}. */
export function tileReferenceOf(chipId) {
  const m = /^X-SAP-UI2-PAGE:(X-SAP-UI2-CATALOGPAGE:.+):([A-Z0-9]+)$/.exec(String(chipId ?? ''));
  return m ? { catalog: m[1], instance: m[2] } : null;
}

/**
 * A PAGE_BUILDER page -- a catalog (isCatalogPage) or a group -- with its instances classified:
 * target mapping, tile, a group's reference to a catalog tile, or other (kept with its chip id).
 */
export function parsePage(text) {
  const d = odataBody(text);
  const drift = [];
  const instances = [];
  for (const i of results(d.PageChipInstances) ?? []) {
    const chip = i.Chip && typeof i.Chip === 'object' && !i.Chip.__deferred ? i.Chip : null;
    const base = chip?.baseChipId || i.chipId;
    const bags = bagsOf(i);
    const cfg = tileConfigurationOf(i.configuration || chip?.configuration);
    if (cfg.drift) drift.push({ node: i.instanceId, ...cfg.drift });
    const ref = tileReferenceOf(i.chipId);
    const common = { instanceId: i.instanceId, scope: i.scope };
    if (ref) {
      instances.push({
        ...common,
        kind: 'tileReference',
        catalog: ref.catalog,
        catalogInstance: ref.instance,
        ...(chip?.title ? { title: chip.title } : {}),
        ...(chip?.referenceChipId ? { referenceChipId: chip.referenceChipId } : {}),
        ...(cfg.value && /APPLAUNCHER/.test(base) ? { tile: tileOf(cfg.value, bags.tileProperties) } : {}),
      });
    } else if (base === CHIP_TARGET_MAPPING) {
      instances.push({ ...common, kind: 'targetMapping', title: bags.tileProperties?.display_title_text || cfg.value?.display_title_text || i.title || null, ...(cfg.value ? { mapping: targetMappingOf(cfg.value) } : {}) });
    } else if (base === CHIP_STATIC_TILE || base === CHIP_DYNAMIC_TILE) {
      instances.push({ ...common, kind: base === CHIP_STATIC_TILE ? 'tile' : 'dynamicTile', ...(cfg.value ? { tile: tileOf(cfg.value, bags.tileProperties) } : { title: i.title || null }) });
    } else {
      instances.push({ ...common, kind: 'other', chipId: i.chipId, ...(chip?.baseChipId ? { baseChipId: chip.baseChipId } : {}), title: i.title || chip?.title || null });
    }
    if (i.remoteCatalogId) instances.at(-1).remoteCatalogId = i.remoteCatalogId;
    if (i.referencePageId) instances.at(-1).referencePageId = i.referencePageId;
    if (i.referenceChipInstanceId) instances.at(-1).referenceChipInstanceId = i.referenceChipInstanceId;
  }
  let order = null;
  if (d.layout) {
    try {
      order = JSON.parse(d.layout).order ?? null;
    } catch (e) {
      drift.push({ node: 'layout', where: `layout is not JSON: ${e.message}`, text: String(d.layout).slice(0, 200) });
    }
  }
  return {
    page: {
      id: d.id,
      title: d.title,
      catalogId: d.catalogId,
      scope: d.scope,
      isCatalog: d.isCatalogPage === 'X',
      isGroup: d.catalogId === GROUP_CATALOG,
      instanceCount: Number(d.chipInstanceCount) || instances.length,
      ...(d.originalLanguage ? { originalLanguage: d.originalLanguage } : {}),
      ...(order ? { order } : {}),
    },
    instances,
    drift,
  };
}

/** FDM lists, a space and a page: the measured fields, persons stripped, plumbing gone. */
export function parseFdm(text) {
  const d = odataBody(text);
  const rows = results(d);
  if (rows) return { count: d.__count !== undefined ? Number(d.__count) : null, rows: rows.map(stripPersons) };
  const flat = stripPersons(d);
  for (const [k, v] of Object.entries(flat)) if (v && Array.isArray(v.results)) flat[k] = v.results.map(stripPersons);
  if (Array.isArray(flat.sections)) {
    flat.sections = flat.sections.map((s) => ({ ...s, ...(s.viz && Array.isArray(s.viz.results) ? { viz: s.viz.results.map(stripPersons) } : {}) }));
  }
  return { entity: flat };
}

/** The intents a parsed catalog serves and the tiles that point at them. */
export function intentsOf(parsed) {
  const out = new Map();
  for (const i of parsed.instances) {
    const intent = i.mapping?.intent ?? i.tile?.intent;
    if (!intent) continue;
    if (!out.has(intent)) out.set(intent, { intent, targetMappings: 0, tiles: 0 });
    out.get(intent)[i.kind === 'targetMapping' ? 'targetMappings' : 'tiles'] += 1;
  }
  return [...out.values()];
}
