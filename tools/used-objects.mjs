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
import { parsePackageDocument } from '../lib/package-document.mjs';
import { finish } from '../lib/completeness.mjs';
import { packageSegmentOf } from '../lib/package-name.mjs';

const TOOL = 'adt_used_objects';
export const MAX_RELEASE_READS = 25;
/** Package documents read for `boundary`: the class's own, plus at most this many used ones. */
export const MAX_PACKAGE_READS = 10;

/** A package name as the packageDocument route takes it, or null when it is not a package name. */
const packageSegment = packageSegmentOf;
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
  /** One package document, or {read:false, reason}. A failure is a gap, never "declares nothing". */
  async function readPackage(name) {
    const segment = packageSegment(name);
    if (!segment) return { read: false, reason: `package '${name}' is not a package name (lib/package-name.mjs)` };
    let out;
    try {
      out = await namedGet(transportFor(session.raw), 'packageDocument', { name: segment });
      return { read: true, ...parsePackageDocument(out.body) };
    } catch (e) {
      journal?.gap?.({
        code: 'ADT_ERROR',
        subject: `DEVC/K ${name}`,
        detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? 'packageDocument'}`,
        impact: 'what this package declares about its boundary is unknown -- NOT "declares nothing"',
        fallback: 'the package in the IDE or in SE21',
      });
      return { read: false, reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) };
    } finally {
      record(cfg, TOOL, `DEVC/K ${name} document`, out?.bytes ?? 0);
    }
  }

  /**
   * The package boundary of each use into another package: what the class's package declares
   * (its use accesses) next to what the used package declares (encapsulated, the interfaces it
   * publishes). Never a verdict: the interface members, which decide, are not in ADT.
   */
  async function boundaryOf(object, used, subject) {
    const rule =
      'what each side DECLARES, never a verdict: whether the used object is a member of one of ' +
      'those interfaces is not readable over ADT (the IDE opens an interface in SAP GUI), and ' +
      'whether the system enforces the package check (a system-wide setting) is not read here.';
    const own = object.package ? await readPackage(object.package) : { read: false, reason: 'the search named no package for this class' };
    const crossing = [...new Set(used.filter((u) => u.crossesPackage && u.package).map((u) => u.package))];
    const docs = new Map();
    const notRead = [];
    for (const [i, p] of crossing.entries()) {
      if (i >= MAX_PACKAGE_READS) {
        notRead.push({ package: p, code: 'CAP_REACHED', reason: `past the ceiling of ${MAX_PACKAGE_READS} package documents` });
        continue;
      }
      const d = await readPackage(p);
      docs.set(p, d);
      if (!d.read) notRead.push({ package: p, code: 'NOT_READ', reason: d.reason });
    }
    if (crossing.length > MAX_PACKAGE_READS) {
      journal?.gap?.({
        code: 'SCAN_AT_CAP',
        subject: `${TOOL} ${subject} boundary`,
        detail: `${crossing.length - MAX_PACKAGE_READS} of ${crossing.length} used package(s) not read`,
        impact: 'the boundary of the uses into those packages is not described: unread is not allowed or refused',
        fallback: 'the package documents in the IDE, or SE21',
      });
    }
    const declared = own.read ? own.useAccesses : [];
    const uses = used
      .filter((u) => u.crossesPackage && u.package)
      .map((u) => {
        const d = docs.get(u.package);
        const path = u.packagePath?.length ? u.packagePath : [u.package];
        // A use access names an interface and, when the system knows it, its owning package: it
        // relates to this use when that package is the used object's package or one of its parents,
        // or when the interface is one the used package publishes.
        const useAccesses = declared
          .filter((a) => (a.package && path.includes(a.package)) || (d?.read && d.interfaces.includes(a.interface)))
          .map((a) => a.interface);
        return {
          object: `${u.type} ${u.name}`,
          package: u.package,
          packagePath: path,
          encapsulated: d?.read ? d.isEncapsulated : null,
          publishedInterfaces: d?.read ? d.interfaces : null,
          useAccessesDeclared: own.read ? useAccesses : null,
          ...(d?.read ? {} : { notRead: d ? d.reason : 'package document not read (ceiling)' }),
        };
      });
    return {
      ownPackage: own.read
        ? { name: own.name, encapsulated: own.isEncapsulated, useAccesses: own.useAccesses }
        : { name: object.package, read: false, reason: own.reason },
      uses,
      ...(notRead.length ? { notRead } : {}),
      complete: own.read && notRead.length === 0,
      rule,
    };
  }

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
          boundary: {
            type: 'boolean',
            description: 'Also the package boundary of each use into another package (package documents, at most 11)',
          },
          maxReleaseReads: {
            type: 'integer',
            minimum: 0,
            maximum: MAX_RELEASE_READS,
            description: `Release states read, one call each (default ${MAX_RELEASE_READS})`,
          },
          releaseOffset: {
            type: 'integer',
            minimum: 0,
            description: 'First readable object whose release state is read: `next.releaseOffset` of the previous answer',
          },
        },
        required: ['objectName'],
      },
    },
    async handler({ objectName, objectType, maxReleaseReads, releaseOffset, boundary }, extra = {}) {
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
        const reason = `the server answered context ${net.activeContext ?? 'none'}, not "Used Objects": nothing is claimed`;
        return asText(finish({ object, read: false, reason, contexts: net.contexts }, [{ list: 'used', code: 'NOT_READ', reason }]));
      }

      // The used objects: the reply's references minus the class itself, de-duplicated by URI (or,
      // for a reference without one, by type and name). A reference without a URI is listed too:
      // dropping it would make the list shorter than the server's.
      const used = [];
      const keyOf = (o) => o.uri ?? `${o.type}|${o.name}`;
      for (const o of net.objects) {
        if (o.uri === built.uri || used.some((u) => keyOf(u) === keyOf(o))) continue;
        used.push({ ...o, uri: o.uri ?? null, crossesPackage: Boolean(object.package && o.package && o.package !== object.package) });
      }

      // The release state, at most `cap` reads, in list order, from `releaseOffset` on (counted
      // over the readable objects). Every object not read says why, with its completeness code.
      const from = Number.isInteger(releaseOffset) && releaseOffset > 0 ? releaseOffset : 0;
      let readable = 0;
      let reads = 0;
      let lastAsked = from;
      const notRead = [];
      for (const u of used) {
        const position = API_RELEASE_OBJECT.test(String(u.uri ?? '')) ? readable++ : -1;
        if (!u.uri) {
          u.apiRelease = { read: false, code: 'NOT_READ', reason: 'the server listed this use without a URI: its release state cannot be asked' };
        } else if (position < 0) {
          u.apiRelease = { read: false, code: 'OUT_OF_SCOPE', reason: 'the release state is measured for classes, interfaces, CDS, tables, data elements and function modules only' };
        } else if (position < from) {
          u.apiRelease = { read: false, code: 'CAP_REACHED', reason: 'before releaseOffset: read by an earlier page' };
        } else if (extra.signal?.aborted) {
          u.apiRelease = { read: false, code: 'CANCELLED', reason: 'cancelled before this read' };
        } else if (reads >= cap) {
          u.apiRelease = { read: false, code: 'CAP_REACHED', reason: `past maxReleaseReads (${cap})` };
        } else {
          lastAsked = position + 1;
          reads += 1;
          let out;
          try {
            out = await namedGet(transportFor(session.raw), 'apiRelease', { uri: u.uri });
            const parsed = parseApiRelease(out.body);
            // A reply without its root is not "not released": it is a reply this parser does not know.
            u.apiRelease = parsed.drift.some((d) => d.where === 'root missing')
              ? { read: false, code: 'PARSE_FAILED', reason: 'the reply has no ars:apiRelease root' }
              : {
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
            u.apiRelease = { read: false, code: 'NOT_READ', reason: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 200) };
          } finally {
            record(cfg, TOOL, `${u.type} ${u.name}#apirelease`, out?.bytes ?? 0);
          }
        }
        if (!u.apiRelease.read) notRead.push({ object: `${u.type} ${u.name}`, code: u.apiRelease.code, reason: u.apiRelease.reason });
      }
      const pastCap = notRead.filter((n) => /^past maxReleaseReads/.test(n.reason)).length;

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
      const packageBoundary = boundary === true ? await boundaryOf(object, used, subject) : null;
      // One entry per code; the cap names the next page.
      const incomplete = [];
      const byCode = (code) => notRead.filter((n) => n.code === code);
      for (const code of ['NOT_READ', 'PARSE_FAILED', 'OUT_OF_SCOPE', 'CANCELLED']) {
        if (byCode(code).length) incomplete.push({ list: 'releaseState', code, count: byCode(code).length, reason: 'see releaseState.notRead' });
      }
      if (pastCap) incomplete.push({ list: 'releaseState', code: 'CAP_REACHED', count: pastCap, total: readable, next: { releaseOffset: lastAsked } });
      if (from) incomplete.push({ list: 'releaseState', code: 'CAP_REACHED', count: Math.min(from, readable), reason: 'before releaseOffset: read by an earlier page' });
      if (net.drift.length) incomplete.push({ list: 'used', code: 'PARSE_FAILED', count: net.drift.length, reason: 'nodes the measured shape does not describe: see drift' });
      if (packageBoundary) {
        if (packageBoundary.ownPackage.read === false) incomplete.push({ list: 'packageBoundary.ownPackage', code: 'NOT_READ', reason: packageBoundary.ownPackage.reason });
        for (const code of ['NOT_READ', 'CAP_REACHED']) {
          const n = (packageBoundary.notRead ?? []).filter((x) => x.code === code).length;
          if (n) incomplete.push({ list: 'packageBoundary.uses', code, count: n, ...(code === 'CAP_REACHED' ? { reason: `at most ${MAX_PACKAGE_READS} package documents per call` } : {}) });
        }
      }
      return asText(finish({
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
        ...(packageBoundary ? { packageBoundary } : { packageBoundary: { asked: false } }),
        rule:
          'every object the server lists as used is here; the release counts cover only the ' +
          'objects whose state was read. An object in notRead has NO verdict -- never released, ' +
          'never unreleased. crossesPackage compares packages only: whether a use is allowed by a ' +
          'package interface is not read here.',
        ...(net.drift.length ? { drift: net.drift } : {}),
      }, incomplete));
    },
  };
}
