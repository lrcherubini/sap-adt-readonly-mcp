// adt_transport_routes: the transport domain and the routes of the STMS, as the system holds them.
//
// What it answers: "where does a request released here go?" -- which systems the domain has, which
// transport layer each system develops in, the consolidation target per layer, and the delivery
// routes beyond it. TMS_CFG_READ_CONFIGURATION returns the domain and its systems (TMSCDOM,
// TMSCSYS); the routes are the configuration versions of package STMA_CTWAY. Every table is read
// through the data preview, with the field allowlists of data/defaults/customizing-tables.json:
// no route of its own, no function module called (docs/security.md, "The transport routes of the
// STMS"). Shapes measured 2026-11-12 (docs/adt-api-reference.md).
//
// Measured, and therefore relied on: the active version is the one TCEVERS row with ACTIVE = A.
// Not understood, and therefore passed through as read: TCERELE-ORICON and the delivery columns.

import { record } from '../lib/audit.mjs';
import { buildSelect, previewPost, parsePreview, assertRanAsSent, cutCodeOf, MAX_ROWS } from '../lib/data-preview.mjs';
import { finish } from '../lib/completeness.mjs';
import { isoOfStamp } from '../lib/timestamps.mjs';
import { asText } from './common.mjs';
import { invalidArguments, notApplicable } from '../lib/tool-error.mjs';

const VERSION = /^\d{4}$/;
/** TMSCSYS-SYSTYP as measured: R a real system, V a virtual one. Any other value is shown as read. */
const SYSTEM_TYPES = Object.freeze({ R: 'real', V: 'virtual' });
const blank = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim());

/**
 * The chain a request of one layer travels: the integration system, its consolidation target,
 * then every delivery route from there on, breadth first and each system once.
 */
export function chainOf(route, delivery) {
  const chain = [route.from, route.to].filter(Boolean);
  const seen = new Set(chain);
  const deliveries = [];
  for (let i = 1; i < chain.length; i++) {
    for (const d of delivery.filter((x) => x.from === chain[i] && !x.inactive)) {
      deliveries.push(d);
      if (!seen.has(d.to)) {
        seen.add(d.to);
        chain.push(d.to);
      }
    }
  }
  return { layer: route.layer, systems: chain, deliveries };
}

export function transportRoutesTool(cfg, session, journal) {
  return {
    definition: {
      name: 'adt_transport_routes',
      description:
        'The STMS transport domain and routes as the system holds them: the systems of the domain, ' +
        'the active configuration version, the layer each system develops in, the consolidation ' +
        'target per layer, the delivery routes, and per layer the chain of systems a request ' +
        'travels. Read from the TMS tables through the data preview (about 9 calls). ' +
        '`version` reads another configuration version than the active one.',
      inputSchema: {
        type: 'object',
        properties: {
          version: { type: 'string', pattern: '^[0-9]{4}$', description: 'Configuration version (TCEVERS), e.g. 0002; default the active one' },
        },
      },
    },
    async handler({ version } = {}) {
      if (!session?.raw) throw new Error('this session has no raw client: the TMS tables cannot be read.');
      const incomplete = [];
      const notRead = [];
      // One table, one POST. A failure is an entry in `incomplete`, never an empty list.
      const read = async (list, table, where = []) => {
        const built = buildSelect({ table, where, rows: MAX_ROWS });
        let out;
        try {
          out = await previewPost(session.raw, built.sql, built.rows);
          const parsed = parsePreview(out.body);
          assertRanAsSent(built.sql, parsed.executedQuery);
          const cut = cutCodeOf(parsed, built.rows);
          if (cut) incomplete.push({ list, code: cut, returned: parsed.rows.length, total: parsed.totalRows, narrowBy: ['version'] });
          if (parsed.drift.length) incomplete.push({ list, code: 'PARSE_FAILED', count: parsed.drift.length, reason: 'the data preview reply had an unmeasured shape' });
          return parsed.rows;
        } catch (e) {
          const reason = `${e?.name ?? 'Error'}: ${e?.message}`.slice(0, 300);
          notRead.push({ table, reason });
          incomplete.push({ list, code: 'NOT_READ', reason: `${table}: ${reason}` });
          journal?.gap?.({
            code: 'TRANSPORT_ROUTES_NOT_READ',
            subject: table,
            detail: reason,
            impact: `the ${list} of the transport routes are unknown; this is NOT a landscape without them`,
            fallback: 'STMS in the SAP GUI (Transport Routes, graphic editor)',
          });
          return null;
        } finally {
          record(cfg, 'adt_transport_routes', `${table} rows<=${built.rows}`, out?.bytes ?? 0);
        }
      };

      const versionRows = await read('versions', 'TCEVERS');
      const versions = (versionRows ?? []).map((r) => ({
        version: r.VERSION,
        active: r.ACTIVE === 'A',
        state: blank(r.ACTIVE),
        // The zone of these stamps is not measured: ISO without an offset (lib/timestamps.mjs).
        changed: isoOfStamp(blank(r.CHANGED)),
        activated: isoOfStamp(blank(r.ACTIVATION)),
        deactivated: isoOfStamp(blank(r.DEACTIVAT)),
        controller: blank(r.CONTROLER),
      }));
      const active = versions.filter((v) => v.active);
      let chosen = null;
      if (version !== undefined && version !== null) {
        if (!VERSION.test(String(version))) throw invalidArguments(`version must be four digits, got '${version}'.`);
        chosen = String(version);
        if (versionRows && !versions.some((v) => v.version === chosen)) {
          throw notApplicable(`configuration version ${chosen} does not exist here. Versions: ${versions.map((v) => v.version).join(', ') || 'none'}.`);
        }
      } else if (active.length === 1) {
        chosen = active[0].version;
      } else if (versionRows) {
        // Measured: one row with ACTIVE = A. Anything else is not guessed at.
        incomplete.push({ list: 'routes', code: 'NOT_READ', reason: `${active.length} configuration versions are marked active (ACTIVE = A): name one with \`version\`` });
      }

      const byVersion = chosen ? [{ field: 'VERSION', value: chosen }] : null;
      const [layerRows, layerTexts, systemRows, systemTexts, consolidationRows, deliveryRows] = byVersion
        ? await Promise.all([
            read('layers', 'TCETRAL', byVersion),
            read('layers', 'TCETRALT', byVersion),
            read('systems', 'TCESYST', byVersion),
            read('systems', 'TCESYSTT', byVersion),
            read('consolidation', 'TCERELE', byVersion),
            read('delivery', 'TCEDELI', byVersion),
          ])
        : [null, null, null, null, null, null];
      const [domainRows, domainSystems] = await Promise.all([read('domain', 'TMSCDOM'), read('domain', 'TMSCSYS')]);

      const textsOf = (rows, key, value, field) =>
        Object.fromEntries((rows ?? []).filter((r) => r[key] === value).map((r) => [r.SPRAS, r[field]]));
      const layers = (layerRows ?? []).map((r) => ({ layer: r.TRANSLAYER, texts: textsOf(layerTexts, 'TRANSLAYER', r.TRANSLAYER, 'CTEXT') }));
      const routeSystems = new Map((systemRows ?? []).map((r) => [r.SYSNAME, r]));
      const domainBySystem = new Map((domainSystems ?? []).map((r) => [r.SYSNAM, r]));
      const names = [...new Set([...routeSystems.keys(), ...domainBySystem.keys()])].sort();
      const systems = names.map((sid) => {
        const route = routeSystems.get(sid);
        const dom = domainBySystem.get(sid);
        return {
          sid,
          text: blank(dom?.SYSTXT) ?? Object.values(textsOf(systemTexts, 'SYSNAME', sid, 'DDTEXT'))[0] ?? null,
          type: dom ? SYSTEM_TYPES[dom.SYSTYP] ?? blank(dom.SYSTYP) : null,
          inRoutes: Boolean(route),
          inDomain: Boolean(dom),
          developmentLayer: blank(route?.TRANSLAYER),
          devType: blank(route?.DEVTYPE),
          release: blank(dom?.SAPREL),
          transportGroup: blank(dom?.NFSGRP),
          communicationSystem: blank(dom?.COMSYS),
          isThisSystem: sid === cfg?.system,
        };
      });
      const consolidation = (consolidationRows ?? []).map((r) => ({ layer: r.TRANSLAYER, from: r.INTSYS, to: blank(r.CONSYS), oricon: blank(r.ORICON) }));
      const delivery = (deliveryRows ?? []).map((r) => ({ from: r.FROMSYSTEM, fromClient: blank(r.FROMCLIENT), to: r.TOSYSTEM, inactive: Boolean(blank(r.INACTIVE)) }));
      const domain = (domainRows ?? []).map((r) => ({ name: r.DOMNAM, text: blank(r.DOMTXT), controller: blank(r.DOMCTL), backupController: blank(r.DOMBCK) }));

      return asText(
        finish(
          {
            version: chosen,
            versions,
            domain,
            systems,
            layers,
            consolidation,
            delivery,
            chains: consolidation.map((c) => chainOf(c, delivery)),
            ...(notRead.length ? { notRead } : {}),
            notes: [
              'ORICON is passed through as the system holds it: its meaning was not measured.',
              'A layer text with no layer (blank TRANSLAYER) is the text of local, untransported development, not a route.',
            ],
          },
          incomplete
        )
      );
    },
  };
}
