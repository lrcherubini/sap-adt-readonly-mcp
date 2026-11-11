// adt_used_objects -- what does one class use, and is each of those objects released?
//
// The context an object consumes (decision D6, confirmed by the owner 2026-11-10): one level
// deep, the objects the server lists as "Used Objects" (lib/object-relations.mjs), each with its
// package and package path, and the API release state of each object of a measured family, at
// most `maxReleaseReads` of them (default and ceiling 25).
//
// The ceiling must never read as a clean answer. Every used object is LISTED (the network reply
// names them all in one call); only the release reads are capped. An object whose state was not
// read -- past the cap, a family not measured, a failed read -- is named with the reason, the
// counts cover only what was read, and `complete` is false whenever anything was not read.

import { record } from '../lib/audit.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { namedGet, transportFor } from '../lib/adt-get.mjs';
import { API_RELEASE_OBJECT, parseApiRelease } from '../lib/api-release.mjs';
import { buildNetworkRequest, networkPost, parseNetwork, ObjectRelationsViolation } from '../lib/object-relations.mjs';

const TOOL = 'adt_used_objects';
export const MAX_RELEASE_READS = 25;
const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const capOf = (value) => {
  if (value === undefined || value === null) return MAX_RELEASE_READS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RELEASE_READS) {
    throw new ObjectRelationsViolation(`maxReleaseReads must be an integer from 0 to ${MAX_RELEASE_READS}; got ${value}.`);
  }
  return n;
};

export function usedObjectsTool(cfg, session, journal) {
  return {
    definition: {
      name: TOOL,
      description:
        'What one class uses, one level deep (the IDE\'s Relation Explorer, "Used Objects"): ' +
        'each object with type, package, package path and its API release state (classes, ' +
        'interfaces, CDS, tables, data elements, function modules; at most 25 read). Every ' +
        'used object is listed; one whose state was not read says why, and complete is false. ' +
        'For a CDS view, adt_clean_core_scan reads what it consumes.',
      inputSchema: {
        type: 'object',
        properties: {
          objectName: { type: 'string', description: 'The class, e.g. ZCL_DEMO' },
          objectType: { type: 'string', description: 'Optional ADT type: CLAS/OC' },
          maxReleaseReads: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_RELEASE_READS,
            description: `Release states read, one call each (default ${MAX_RELEASE_READS})`,
          },
        },
        required: ['objectName'],
      },
    },
    async handler({ objectName, objectType, maxReleaseReads }, extra = {}) {
      const cap = capOf(maxReleaseReads);
      if (!session?.raw) throw new ObjectRelationsViolation('this session has no raw client: the used objects cannot be asked.');
      const name = String(objectName ?? '').trim();
      if (!name) throw new ObjectRelationsViolation(`${TOOL} needs an objectName.`);
      const type = objectType ? String(objectType).trim().toUpperCase() : undefined;
      if (type && type !== 'CLAS/OC') {
        throw new ObjectRelationsViolation(`only a class (CLAS/OC) is measured; got ${type}. For a CDS view, adt_clean_core_scan reads what it consumes.`);
      }
      const { hit, foundBy } = await resolveObject(session.api, name, type, 'metadata');
      const subject = `${hit['adtcore:type']} ${hit['adtcore:name']}`;
      const built = buildNetworkRequest({ uri: hit['adtcore:uri'], type: hit['adtcore:type'], name: hit['adtcore:name'] });
      const object = { name: hit['adtcore:name'], type: hit['adtcore:type'], package: hit['adtcore:packageName'] ?? null, uri: built.uri, foundBy };

      let res;
      try {
        res = await networkPost(session.raw, built);
      } catch (e) {
        journal?.gap?.({
          code: 'USED_OBJECTS_NOT_READ',
          subject,
          detail: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 300),
          impact: 'what this class uses is unknown -- NOT "uses nothing"',
          fallback: 'the Relation Explorer of the IDE (Used Objects), or adt_read_source',
        });
        throw e;
      } finally {
        record(cfg, TOOL, `${subject} network`, res?.bytes ?? 0);
      }
      const net = parseNetwork(res.body);
      if (net.drift.length) {
        journal?.gap?.({
          code: 'SHAPE_DRIFT',
          subject: `${subject} objectrelations network`,
          detail: net.drift.map((d) => `<${d.node}>`).join('; ').slice(0, 300),
          impact: 'the answer stands, but the measured shape no longer describes this reply fully',
          fallback: 're-read the raw reply and update lib/object-relations.mjs and docs/adt-api-reference.md',
        });
      }
      if (net.activeContext !== 'ENV') {
        // Not "uses nothing": the server answered another question, so nothing is claimed.
        journal?.gap?.({
          code: 'USED_OBJECTS_NOT_READ',
          subject,
          detail: `the server chose context ${net.activeContext ?? 'none'}, not ENV (Used Objects)`,
          impact: 'what this class uses is unknown -- NOT "uses nothing"',
          fallback: 'the Relation Explorer of the IDE (Used Objects)',
        });
        return asText({
          object,
          read: false,
          complete: false,
          reason: `the server answered context ${net.activeContext ?? 'none'}, not "Used Objects": nothing is claimed`,
          contexts: net.contexts,
        });
      }

      // The used objects: the reply's references minus the class itself, de-duplicated by URI.
      const used = [];
      for (const o of net.objects) {
        if (!o.uri || o.uri === built.uri || used.some((u) => u.uri === o.uri)) continue;
        used.push({ ...o, crossesPackage: Boolean(object.package && o.package && o.package !== object.package) });
      }

      // The release state, at most `cap` reads, in list order. Every object not read says why.
      let reads = 0;
      const notRead = [];
      for (const u of used) {
        if (!API_RELEASE_OBJECT.test(u.uri)) {
          u.apiRelease = { read: false, reason: 'the release state is measured for classes, interfaces, CDS, tables, data elements and function modules only' };
        } else if (extra.signal?.aborted) {
          u.apiRelease = { read: false, reason: 'cancelled before this read' };
        } else if (reads >= cap) {
          u.apiRelease = { read: false, reason: `past maxReleaseReads (${cap})` };
        } else {
          reads += 1;
          let out;
          try {
            out = await namedGet(transportFor(session.raw), 'apiRelease', { uri: u.uri });
            const parsed = parseApiRelease(out.body);
            u.apiRelease = {
              read: true,
              anyReleased: parsed.anyReleased,
              states: parsed.contracts.map((c) => ({ contract: c.contract, state: c.state })),
            };
          } catch (e) {
            journal?.gap?.({
              code: 'API_RELEASE_NOT_READ',
              subject: `${u.type} ${u.name}`,
              detail: `HTTP ${e?.status ?? '?'}: ${e?.message ?? e}`.slice(0, 300),
              impact: 'whether this object is released for use is unknown: this is NOT "not released"',
              fallback: 'the API State tab of the object in the IDE, or adt_object_info',
            });
            u.apiRelease = { read: false, reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) };
          } finally {
            record(cfg, TOOL, `${u.type} ${u.name}#apirelease`, out?.bytes ?? 0);
          }
        }
        if (!u.apiRelease.read) notRead.push({ object: `${u.type} ${u.name}`, reason: u.apiRelease.reason });
      }

      const read = used.filter((u) => u.apiRelease.read);
      if (notRead.some((n) => /^past maxReleaseReads/.test(n.reason))) {
        journal?.gap?.({
          code: 'SCAN_AT_CAP',
          subject: `${TOOL} ${subject}`,
          detail: `${notRead.filter((n) => /^past maxReleaseReads/.test(n.reason)).length} release state(s) past maxReleaseReads ${cap}`,
          impact: 'those objects are listed without their release state: unread is not released or unreleased',
          fallback: 'adt_object_info on each, or the API State tab in the IDE',
        });
      }
      return asText({
        object,
        context: 'ENV (Used Objects), one level deep',
        count: used.length,
        used,
        releaseState: {
          read: read.length,
          released: read.filter((u) => u.apiRelease.anyReleased === true).length,
          notReleased: read.filter((u) => u.apiRelease.anyReleased === false).length,
          notRead,
        },
        complete: notRead.length === 0,
        rule:
          'every object the server lists as used is here; the release counts cover only the ' +
          'objects whose state was read. An object in notRead has NO verdict -- never released, ' +
          'never unreleased. crossesPackage compares packages only: whether a use is allowed by a ' +
          'package interface is not read here.',
        ...(net.drift.length ? { drift: net.drift } : {}),
      });
    },
  };
}
