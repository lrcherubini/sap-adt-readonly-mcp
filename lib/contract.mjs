// Which expose aliases are load-bearing, and what breaks in silence if one is renamed.
//
// `expose <entity> as <alias>` in a `.srvd.srvdsrv` looks like a cosmetic choice. It is
// not: the alias becomes the EntitySet name verbatim and the EntityType name with `Type`
// appended, and a CPI message mapping addresses that EntityType BY XPATH
// (`/DemoInventoryMapping/DemoInventoryMappingType/BaseKey`), while a Fiori
// annotation addresses it by `Target="cds_<service>.<alias>Type"`. Renaming the alias
// re-activates cleanly on the SAP side and the field simply arrives empty on the other.
// The `.srvd` format accepts no comment at all, so the file cannot even carry a warning.
//
// THREE SOURCES, and the middle one is evidence rather than a rule:
//
//   1. the .srvd            what is exposed today
//   2. the cached $metadata what the consumer was built against  (lib/edmx.mjs)
//   3. the consumers        which names are actually cited, and where
//
// ⚠️ The hard part is not parsing, it is ATTRIBUTION. Our ZAPI_DEMO_ERP deliberately exposes
// `I_ProductPlantBasic as A_ProductPlant` so that mappings written against SAP's
// API_PRODUCT_SRV keep working -- so `A_ProductPlantType` is a name in BOTH contracts,
// in the same repository. A token is attributed to our contract only when the scope that
// holds it (the CPI bundle, the Fiori app) caches OUR service's metadata. In the DEMOERP
// repository that splits the three bundles correctly: the live one talks to ZAPI_DEMO_ERP,
// the two older ones still talk to SAP -- which is the half-finished migration, visible
// as a fact rather than as a guess.

import { parseService } from './srvd-check.mjs';

/**
 * The names one `expose` generates, measured against the cached $metadata of this
 * workspace rather than assumed.
 *
 *   EntityType   ALWAYS `<alias>Type`. This is the invariant, in V2 and in V4, for a
 *                parameterised entity and a plain one. It is the name a CPI mapping puts
 *                in its XPath and a Fiori annotation puts in its Target.
 *   EntitySet    `<alias>` -- and in OData V2 a PARAMETERISED entity produces two more:
 *                `<alias>Set` for the result set and `<alias>Parameters` for the
 *                parameter type. Measured in cds_zui_demoitemrating:
 *                  DemoItemMasterRatingSet -> DemoItemMasterRatingType
 *                  DemoItemMasterRating    -> DemoItemMasterRatingParameters
 *                while the parameterless DemoUnitPackSpec has only DemoUnitPackSpec ->
 *                DemoUnitPackSpecType. Treating `DemoItemMasterRatingSet` as a name nothing
 *                generates -- which a first pass did -- reports the V2 shape of a
 *                working service as a broken consumer.
 */
export function namesOfExpose(entity, alias) {
  const set = alias || entity;
  return {
    entitySet: set,
    entityType: `${set}Type`,
    /** Everything the gateway may derive from this alias. Accepted, never demanded. */
    generated: [set, `${set}Type`, `${set}Set`, `${set}Parameters`],
  };
}

/**
 * Names the gateway adds on its own, which no `expose` accounts for.
 *
 * `SAP__*` is the V2 print/annotation infrastructure (12 sets in every V2 service here),
 * and a value help reached through `@Consumption.valueHelpDefinition` is auto-added to a
 * V2 service without appearing in the service definition at all -- measured in
 * cds_zui_demoitemrating, which serves I_Plant and I_SalesOrganization while its
 * .srvd exposes three entities, none of them those. Neither is a defect, and counting
 * them would make the check cry wolf on every V2 service in the workspace.
 */
const isGatewayGenerated = (name) => /^SAP__/i.test(String(name ?? ''));

/**
 * The contract every service definition publishes.
 *
 * @param {{file:string, source:string}[]} services
 * @returns {{service:string, file:string, entity:string, alias:string|null,
 *            entitySet:string, entityType:string}[]}
 */
export function contractOf(services = []) {
  const out = [];
  for (const svc of services) {
    if (!svc || typeof svc.source !== 'string') continue;
    const parsed = parseService(svc.source);
    for (const e of parsed.exposed) {
      out.push({
        service: parsed.service ?? null,
        file: svc.file ?? null,
        entity: e.entity,
        alias: e.alias,
        ...namesOfExpose(e.entity, e.alias),
      });
    }
  }
  return out;
}

const upper = (s) => String(s ?? '').toUpperCase();

/** Is this name derivable from any expose of the service (set, type, Set, Parameters)? */
function accountedFor(service, name) {
  return service.generated.has(upper(name));
}

/**
 * Consumers whose content is GENERATED from the metadata rather than written against it.
 *
 * A manifest.json and a localService mock mirror whatever the service had when the app
 * was scaffolded. They cite nothing independently, so a name found only there is not
 * evidence that anything is wired to it -- and treating it as such produced the first
 * pass's phantom orphans.
 */
const isGeneratedConsumer = (file) =>
  /(^|\/)(manifest\.json|\.appGenInfo\.json|ui5\.yaml)$/i.test(file) ||
  /(^|\/)localService(\/|$)/i.test(file);

/**
 * Compare the three sources.
 *
 * @param {{services:{file:string,source:string}[], metadata:object[],
 *          consumers:{file:string,scope:string,repo:string,tokens:Set<string>}[]}} input
 * @returns {{contract:object[], services:string[], findings:object[], gaps:object[],
 *            loadBearing:object[], scopes:object[]}}
 */
export function checkContract({ services = [], metadata = [], consumers = [] } = {}) {
  const contract = contractOf(services);
  const ourServices = new Set(contract.map((c) => upper(c.service)).filter(Boolean));

  /** service -> what it generates today. */
  const byService = new Map();
  for (const c of contract) {
    const key = upper(c.service);
    if (!byService.has(key)) {
      byService.set(key, { sets: new Map(), types: new Map(), generated: new Set() });
    }
    byService.get(key).sets.set(upper(c.entitySet), c);
    byService.get(key).types.set(upper(c.entityType), c);
    for (const g of c.generated ?? []) byService.get(key).generated.add(upper(g));
  }

  const findings = [];
  const gaps = [];

  // --- 1. the same entity under two aliases ---------------------------------
  const byEntity = new Map();
  for (const c of contract) {
    const key = upper(c.entity);
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(c);
  }
  for (const [, rows] of byEntity) {
    const distinct = [...new Set(rows.map((r) => r.entitySet))];
    if (distinct.length < 2) continue;
    findings.push({
      code: 'ALIAS_DRIFT',
      file: rows[0].file,
      subject: rows[0].entity,
      context: { aliases: distinct.join(', '), services: rows.map((r) => r.service).join(', ') },
      effect:
        `${rows[0].entity} is exposed as ${distinct.join(' and ')}: a consumer written ` +
        'against one service addresses an EntityType the other does not generate',
      fix: 'align the aliases, or record deliberately why the two contracts differ',
    });
  }

  // --- 2. cached metadata against what is exposed today ---------------------
  // Only OUR services are compared. A cached API_PRODUCT_SRV is SAP's document and says
  // nothing about our service definitions.
  const scopeServices = new Map();
  for (const doc of metadata) {
    const svc = upper(doc.service);
    if (!scopeServices.has(doc.scope)) scopeServices.set(doc.scope, new Set());
    scopeServices.get(doc.scope).add(svc);
    if (!ourServices.has(svc)) continue;
    const now = byService.get(svc);
    // Compared on ENTITY TYPES, because that is the invariant name (see namesOfExpose)
    // and the one a consumer addresses. And in ONE DIRECTION only: an expose the cache
    // does not know about means the consumer was built before it existed, which is the
    // actionable half. The reverse -- a cached name no expose accounts for -- has too
    // many legitimate producers (SAP__* infrastructure, V2 parameter entities,
    // auto-added value helps) to be a defect signal, so it is carried as context and
    // becomes a finding only when a consumer actually CITES it, below.
    const cached = new Set(doc.entityTypes.map(upper));
    const missing = [...now.types.keys()].filter((k) => !cached.has(k));
    const unaccounted = [...cached].filter(
      (k) => !isGatewayGenerated(k) && !accountedFor(now, k)
    );
    if (!missing.length) continue;
    findings.push({
      code: 'EDMX_STALE',
      file: doc.file,
      subject: svc,
      context: {
        cachedTypes: cached.size,
        exposedNow: now.types.size,
        missingFromCache: missing.join(', '),
        cachedButNotExposed: unaccounted.join(', ') || undefined,
      },
      effect:
        `the cached $metadata for ${svc} does not contain ${missing.length} entity ` +
        `type(s) the service definition exposes today: ${missing.join(', ')}`,
      fix: 'refresh the cached $metadata from the system before relying on it',
    });
  }

  // --- 3. who cites what ----------------------------------------------------
  const cites = new Map();
  for (const consumer of consumers) {
    const inScope = [...(scopeServices.get(consumer.scope) ?? [])].filter((s) =>
      ourServices.has(s)
    );
    if (!inScope.length) {
      // Either the scope talks to SAP's own service, or it caches no metadata at all.
      // Both are reasons NOT to attribute a name -- never a defect.
      continue;
    }
    const cachedTypes = new Set(
      metadata
        .filter((d) => d.scope === consumer.scope && ourServices.has(upper(d.service)))
        .flatMap((d) => [...d.entityTypes.map(upper), ...d.entitySets.map((e) => upper(e.name))])
    );
    for (const svc of inScope) {
      const now = byService.get(svc);
      for (const token of consumer.tokens) {
        const key = upper(token);
        const hit = now.types.get(key) ?? now.sets.get(key);
        if (hit) {
          const id = `${svc}|${hit.entitySet}`;
          if (!cites.has(id)) {
            cites.set(id, { service: svc, ...hit, citedBy: [] });
          }
          const entry = cites.get(id);
          if (!entry.citedBy.some((c) => c.file === consumer.file)) {
            entry.citedBy.push({
              file: consumer.file,
              repo: consumer.repo,
              as: token,
              // A scaffold echo is not the same evidence as a mapping written by hand:
              // renaming the alias regenerates the first and breaks the second.
              handwritten: !isGeneratedConsumer(consumer.file),
            });
          }
          continue;
        }
        // An orphan is NOT "a token ending in Type". It is a name this scope's own cached
        // metadata says the service used to generate and the service definition does not
        // generate any more. Anything looser would flag ContentType and mediaType.
        if (
          cachedTypes.has(key) &&
          !accountedFor(now, key) &&
          !isGatewayGenerated(key) &&
          !isGeneratedConsumer(consumer.file)
        ) {
          findings.push({
            code: 'CONSUMER_ORPHAN_TYPE',
            repo: consumer.repo,
            file: consumer.file,
            subject: token,
            context: { service: svc, scope: consumer.scope },
            effect:
              `${consumer.file} addresses '${token}', which the cached metadata for ${svc} ` +
              'contains but no current expose generates: the field arrives empty, with no error',
            fix: `re-point the consumer at a name ${svc} exposes today, or restore the expose`,
          });
        }
      }
    }
  }

  const scopesWithoutMetadata = consumers
    .filter((c) => !scopeServices.has(c.scope))
    .map((c) => c.scope);
  for (const scope of new Set(scopesWithoutMetadata)) {
    gaps.push({
      code: 'EXPOSURE_INCONCLUSIVE',
      subject: scope,
      detail: 'this scope caches no $metadata, so its references cannot be attributed',
      impact: 'a rename could break it and this check would not see it',
      fallback: 'cache the $metadata in the bundle, or check the iFlow adapter configuration',
    });
  }

  const handwrittenCount = (c) => c.citedBy.filter((x) => x.handwritten).length;
  const loadBearing = [...cites.values()]
    .filter((c) => c.citedBy.length)
    .map((c) => ({ ...c, handwrittenCitations: handwrittenCount(c) }))
    .sort(
      (a, b) =>
        b.handwrittenCitations - a.handwrittenCitations ||
        b.citedBy.length - a.citedBy.length ||
        a.entitySet.localeCompare(b.entitySet)
    );

  return {
    contract,
    services: [...ourServices].sort(),
    findings,
    gaps,
    loadBearing,
    scopes: [...scopeServices.entries()].map(([scope, svcs]) => ({
      scope,
      services: [...svcs].sort(),
      ours: [...svcs].filter((s) => ourServices.has(s)).sort(),
    })),
  };
}
