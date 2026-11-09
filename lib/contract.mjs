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
// This module reads the first of the three sources -- the .srvd, what is exposed today -- and the
// one defect it shows alone (ALIAS_DRIFT). The other two are read live by tools/contract-check.mjs:
// the $metadata the system serves and the Fiori apps that cite it (lib/ui5-repository.mjs).
//
// ⚠️ The hard part there is ATTRIBUTION, not parsing: a service may deliberately expose
// `I_ProductPlantBasic as A_ProductPlant` so that consumers written against SAP's
// API_PRODUCT_SRV keep working, and then `A_ProductPlantType` is a name in BOTH contracts. A
// reference is attributed to a service only through the live namespace of the service it held in.

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

/**
 * The contract of the service definitions, and the one defect it shows on its own.
 *
 * The consumers are checked live, elsewhere: tools/contract-check.mjs reads each named Fiori app
 * and the LIVE $metadata of its services (lib/ui5-repository.mjs), and files UI5_REFERENCE_BROKEN
 * or one UI5_APP_NOT_READ per app. The offline half that used to live here -- cached $metadata and
 * consumer files of a local checkout -- went with the removed `scan:contract`.
 *
 * @param {{services:{file:string,source:string}[]}} input
 * @returns {{contract:object[], services:string[], findings:object[]}}
 */
export function checkContract({ services = [] } = {}) {
  const contract = contractOf(services);
  const ourServices = new Set(contract.map((c) => upper(c.service)).filter(Boolean));
  const findings = [];

  // --- the same entity under two aliases ------------------------------------
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

  return { contract, services: [...ourServices].sort(), findings };
}
