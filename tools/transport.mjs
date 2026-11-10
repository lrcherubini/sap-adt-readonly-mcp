// adt_transport -- which objects moved together, when, and by whom.
//
// The question behind the tool is the one the working tree structurally cannot answer.
// An abapGit repository serialises the STATE of an object; a transport request is the
// only record of the CHANGE, and no `.abapgit.xml` carries a transport number. So
// "what did this delivery consist of" -- the question you have to answer to document a
// solution on demand -- has no answer in any file on disk.
//
// Two modes, and neither is a default:
//
//   number: 'DEVK900117'  one request, in full, with its tasks
//   recent: true          the list the server is willing to give: RELEASED ONLY, LAST
//                         TWO WEEKS, both halves, no paging
//
// MEASURED 2026-09-09 on the development system, three probe rounds, recorded in
// docs/adt-api-reference.md. Three measurements drive the code rather than the comments:
//
//  1. ⚠️ The list answers ONLY on the bare URL with the tree media type. Any query string
//     -- `?user=`, `?targets=` -- comes back 200 with an empty root. A wrong Accept is
//     loud (406); a query string is SILENT. This is why `transportList` in
//     lib/adt-get.mjs declares no parameters at all: the mistake is inexpressible.
//  2. ⚠️ A task's objects reach the request only when the task is RELEASED, so the
//     request's own object list is not the answer. Measured: DEVK900117 is a customizing
//     request with four objects and an EMPTY own list. lib/transport-requests.mjs
//     recomputes the union; here it is only reported.
//  3. ⚠️ There is no paging and no date filter on this route. The caps below are applied
//     AFTER the bytes arrive -- 270 138 of them in the measured dump -- so the tool says
//     "truncated locally" instead of pretending to have asked for less.
//  4. ⚠️ `keys: true` answers WHICH ROWS of a configuration table moved -- the E071K key
//     rows, decoded against the layout the CTS declares, which was measured to be the
//     DDIC's own. It is opt-in and costs ONE ADT CALL PER OBJECT, so it is capped and the
//     cap is reported. It reads only in detail mode: the recent list carried 672 objects
//     in the measured dump, and a sweep by omission is the shape this server refuses.

import { record } from '../lib/audit.mjs';
import { namedGet, derivedGet, transportFor } from '../lib/adt-get.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { isClasenh, clasenhGap, CLASENH_WHERE } from '../lib/object-properties.mjs';
import { parseVersionFeed, versionLinks, unionByTransport } from '../lib/object-versions.mjs';
import { parseTransportDocument, unionObjects, DRIFT_CODE } from '../lib/transport-requests.mjs';
import { parseRequestLog } from '../lib/request-logs.mjs';
import {
  collectObjectKeys,
  MAX_KEY_LOOKUPS,
  keyDecision,
} from '../lib/object-keys.mjs';

/** From the measured envelope: 6 requests / 672 objects / 270 138 bytes in one dump. */
const MAX_REQUESTS = 50;
const MAX_OBJECTS_PER_REQUEST = 300;

const NUMBER = /^[A-Z][A-Z0-9]{2}K[0-9]{6}$/;

/** A class publishes five version feeds (measured); nothing measured publishes more. */
const MAX_VERSION_FEEDS = 8;

export function transportTool(cfg, session, journal) {
  // WHICH TRANSPORTS carried one object: the version feed(s) the server publishes for
  // it, read as raw Atom under the object's own URI. lib/object-versions.mjs carries
  // the three measured ways this feed lies; this function only sequences the reads.
  async function objectHistory(spec) {
    const name = String(spec?.name ?? '').trim();
    const type = spec?.type ? String(spec.type).trim().toUpperCase() : undefined;
    if (!name) throw new Error('adt_transport `object` needs a `name`.');

    const resolved = await resolveObject(session.api, name, type, 'metadata');
    const { hit, foundBy } = resolved;
    const objectUri = hit['adtcore:uri'];
    const subjectOf = `${hit['adtcore:type']} ${hit['adtcore:name']}`;
    if (!resolved.structure && isClasenh(hit['adtcore:type'])) {
      // The structure of a class / interface enhancement dumps the server (3 of 3,
      // 2026-09-14): nothing is read, and the history is asked of a neighbour instead.
      clasenhGap(journal, hit['adtcore:name'], `adt_transport object on ${objectUri}: no structure read (the resource dumps the server)`);
      return json({
        mode: 'object',
        object: { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: objectUri, foundBy },
        feedsRead: [],
        transports: [],
        copies: [],
        activeVersion: [],
        clasenh: true,
        rule:
          'a class enhancement (CLASENH) or function-module interface enhancement (FUGRENH) publishes ' +
          'no version feed the ADT can read without dumping; nothing was read and no history is claimed. ' +
          'Ask the history of the object that USES the added methods or parameters (measured: ' +
          'the request that created the ENHO also carries its caller), or SE03. ' + CLASENH_WHERE,
      });
    }
    const structure = resolved.structure ?? (await session.api.objectStructure(objectUri));
    const links = versionLinks(structure);

    if (!links.length) {
      // No published link is a fact about this object type on this server, not an
      // empty history: nothing was read, and the answer says so.
      if (journal?.enabled) {
        journal.gap({
          code: 'NO_VERSION_FEED',
          subject: subjectOf,
          detail: `objectStructure(${objectUri}) publishes no atom:link rel=.../relations/versions`,
          impact:
            'which transports carried this object is unknown by this route -- this is ' +
            'NOT evidence that it was never transported',
          fallback:
            'SE03 -> "Search for objects in requests/tasks", or the version management of ' +
            'the object in the IDE; measured shapes (CLAS, PROG, DOMA) in docs/adt-api-reference.md',
        });
      }
      return json({
        mode: 'object',
        object: { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: objectUri, foundBy },
        feedsRead: [],
        transports: [],
        copies: [],
        activeVersion: [],
        rule: 'no version feed is published for this object; nothing was read and no history is claimed',
      });
    }

    const transport = transportFor(session.raw);
    const wanted = links.slice(0, MAX_VERSION_FEEDS);
    const feeds = [];
    const drift = [];
    let bytes = 0;
    for (const { where, href } of wanted) {
      let out;
      try {
        out = await derivedGet(transport, objectUri, href);
      } catch (e) {
        if (e?.name !== 'RouteViolation' && journal?.enabled) {
          journal.gap({
            code: 'ADT_ERROR',
            subject: `${subjectOf} versions (${where})`,
            detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? href}`,
            impact:
              `the ${where} history of this object is unknown -- the transports named by ` +
              'the other feeds are still an UNDERCOUNT',
            fallback: 'the version management of the object in the IDE',
          });
        }
        throw e;
      } finally {
        // One line per ADT call: the object and the link, never a transport description.
        record(cfg, 'adt_transport', `${subjectOf} versions ${href}`, out?.bytes ?? 0);
      }
      bytes += out.bytes;
      const parsed = parseVersionFeed(out.body);
      for (const d of parsed.drift) drift.push({ ...d, where: `${where}: ${d.where}` });
      feeds.push({ where, href, url: out.url, bytes: out.bytes, entries: parsed.entries, feedTitle: parsed.feedTitle });
    }

    if (drift.length && journal?.enabled) {
      journal.gap({
        code: DRIFT_CODE,
        subject: `${subjectOf} versions`,
        detail: drift
          .map((d) => (d.attribute ? `${d.node}/@${d.attribute} x${d.count} (${d.where})` : `<${d.node}> x${d.count} (${d.where})`))
          .join('; '),
        impact:
          'the answer stands, but the feed shape measured no longer describes ' +
          'this system fully: something undeclared is being dropped',
        fallback: 're-read the raw feed and update lib/object-versions.mjs and docs/adt-api-reference.md',
      });
    }

    const history = unionByTransport(feeds);
    return json({
      mode: 'object',
      object: { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: objectUri, foundBy },
      bytes,
      measured: true,
      feedsRead: feeds.map((f) => ({ where: f.where, href: f.href, entries: f.entries.length, title: f.feedTitle })),
      rule:
        'transports = every request a version of this object was written by, over EVERY ' +
        'feed the server publishes (a class keeps five, and three of them undercount). ' +
        'copies = the same, where the server flags the entry adtcore:isTestTransport -- ' +
        'a transport of copies, never a request that moved the object on. activeVersion ' +
        'is version 00000 of each feed; its holder is the OPEN request the object sits ' +
        'in now, null when it is not in one. Every entry carries the URI of that ' +
        'version\'s content (contentSrc in the raw feed); adt_read_source reads it ' +
        '(`version`, `compareTo`).',
      transports: history.transports,
      copies: history.copies,
      activeVersion: history.activeVersion,
      versionsWithoutTransport: history.withoutLink,
      truncated: { feeds: Math.max(0, links.length - wanted.length) },
      ...(drift.length ? { drift } : {}),
    });
  }

  // The two logs of one request, one GET each. A log that could not be read says so with
  // `read: false`; it never reads as an empty log.
  async function requestLogs(transport, number, drift) {
    const out = {
      rule:
        'actions: what was done to the request (flat). transport: how it moved, per system ' +
        'and step, with the return code read from each step text (rc). Separator lines, ' +
        'empty spacer entries and every link are dropped; the links to the log files and ' +
        'to the request-independent steps are not followed.',
    };
    for (const [part, route] of [
      ['actions', 'transportActionLogs'],
      ['transport', 'transportLogs'],
    ]) {
      let reply;
      try {
        reply = await namedGet(transport, route, { number });
      } catch (e) {
        if (e?.name === 'RouteViolation') throw e;
        // Not swallowed: the gap is filed and the part says it was not read.
        if (journal?.enabled) {
          journal.gap({
            code: 'ADT_ERROR',
            subject: `transport ${number} ${part} log`,
            detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? route}`,
            impact: `the ${part} log of this request is unknown -- NOT an empty log`,
            fallback: 'the request in SE09/SE10 (Goto -> Logs), or the Transport Organizer in the IDE',
          });
        }
        out[part] = { read: false, reason: String(e?.message ?? e).slice(0, 200) };
        continue;
      } finally {
        record(cfg, 'adt_transport', `${number} ${route}`, reply?.bytes ?? 0);
      }
      const parsed = parseRequestLog(reply.body);
      for (const d of parsed.drift) drift.push({ ...d, where: `${route} ${number}` });
      out[part] = {
        read: true,
        bytes: reply.bytes,
        entries: parsed.entries,
        ...(part === 'transport' ? { highestReturnCode: parsed.highestReturnCode } : {}),
      };
    }
    return out;
  }

  return {
    definition: {
      name: 'adt_transport',
      description:
        'Which objects moved together in a transport request. One mode per call: `number` ' +
        '(the request with every task, owner, description; one call; `logs: true` adds its ' +
        'action and transport logs), `recent: true` (the ' +
        'server\'s list: released, last two weeks), or `object: {name, type}` (every request ' +
        'that carried it, from its version history; one GET per version feed).',
      inputSchema: {
        type: 'object',
        properties: {
          number: {
            type: 'string',
            description: 'One transport request, e.g. DEVK900123.',
          },
          recent: {
            type: 'boolean',
            description: 'The server\'s scope: released only, two weeks, no paging or filter.',
          },
          maxRequests: {
            type: 'number',
            description: `List mode: local cut (default ${MAX_REQUESTS}).`,
          },
          maxObjectsPerRequest: {
            type: 'number',
            description: `Local cut per request (default ${MAX_OBJECTS_PER_REQUEST}).`,
          },
          keys: {
            type: 'boolean',
            description:
              'With `number`: also the E071K table keys of each object, decoded (which rows ' +
              `moved). One call per object, ${MAX_KEY_LOOKUPS} by default.`,
          },
          logs: {
            type: 'boolean',
            description: 'With `number`: also its action log and transport log (two more calls).',
          },
          maxKeyLookups: {
            type: 'number',
            description: `With \`keys\`: how many objects to ask about (default ${MAX_KEY_LOOKUPS}).`,
          },
          object: {
            type: 'object',
            description: 'One object: `{name, type?}`, type an ADT facet (CLAS/OC, PROG/P, ...).',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
    },
    async handler(args = {}) {
      // Refused before the call, even though buildUrl refuses it again: two independent
      // statements of one rule, the way namedGet re-asserts GET. A sweep by omission is
      // the shape this whole server refuses -- so no mode is a default.
      const wantsDetail = args.number !== undefined && args.number !== null && String(args.number).trim() !== '';
      const wantsList = args.recent === true;
      const wantsObject = args.object !== undefined && args.object !== null;
      if ([wantsDetail, wantsList, wantsObject].filter(Boolean).length > 1) {
        throw new Error(
          'adt_transport takes `number` OR `recent` OR `object`, never two: one reads a ' +
            'request you name, one reads a list whose scope the server decides, one reads ' +
            'the history of an object you name. Ask twice.'
        );
      }
      if (!wantsDetail && !wantsList && !wantsObject) {
        throw new Error(
          'adt_transport has no default mode. Pass `number` for one request, ' +
            '`recent: true` for the recent released list, or `object: {name, type}` for ' +
            'the version history of one object. Omitting all three would be a sweep ' +
            'nobody asked for.'
        );
      }
      const wantsLogs = args.logs === true;
      if (wantsObject) {
        if (wantsLogs) {
          throw new Error(
            'adt_transport reads the logs of a request you name by `number`; the object ' +
              'history carries none.'
          );
        }
        if (args.keys === true) {
          throw new Error(
            'adt_transport reads table keys for a request you name by `number`; the ' +
              'version feed of an object carries no keys.'
          );
        }
        return objectHistory(args.object);
      }
      if (wantsLogs && !wantsDetail) {
        throw new Error(
          'adt_transport reads the logs of a request you name by `number`; the recent list ' +
            'and the object history carry none.'
        );
      }
      const wantsKeys = args.keys === true;
      if (wantsKeys && !wantsDetail) {
        throw new Error(
          'adt_transport reads table keys only for a request you name. The recent list ' +
            'carried 672 objects in the measured dump, and keys cost one ADT call per ' +
            'object -- ask by `number`.'
        );
      }
      if (wantsDetail && !NUMBER.test(String(args.number).trim())) {
        throw new Error(
          `'${args.number}' is not a transport request number: expected the measured shape ` +
            'DEVK900123 (system, K, six digits).'
        );
      }

      const route = wantsDetail ? 'transportDetail' : 'transportList';
      const subject = wantsDetail ? String(args.number).trim() : 'recent released requests';

      const transport = transportFor(session.raw);

      let out;
      try {
        out = await namedGet(
          transport,
          route,
          wantsDetail ? { number: String(args.number).trim() } : {}
        );
      } catch (e) {
        // A RouteViolation never reached the network: a caller error, not an ADT gap.
        if (e?.name !== 'RouteViolation' && journal?.enabled) {
          journal.gap({
            code: 'ADT_ERROR',
            subject: `transport ${subject}`,
            detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? route}`,
            impact:
              'which objects moved in this transport is unknown -- this is NOT evidence ' +
              'that the request is empty',
            fallback: 'open the request in SE09/SE10, or in the Eclipse Transport Organizer',
          });
        }
        throw e;
      }

      // The number and the byte count, never the description: what a developer typed into
      // tm:desc is the one field of this answer that is free text about the business.
      record(cfg, 'adt_transport', subject, out.bytes);

      const doc = parseTransportDocument(out.body);

      // An attribute the measured projection does not declare, or a union that disagrees
      // with the system's own -- the answer still stands, the MEASUREMENT is what aged.
      const drift = [...doc.drift];

      const maxRequests = capOf(args.maxRequests, MAX_REQUESTS);
      const maxObjects = capOf(args.maxObjectsPerRequest, MAX_OBJECTS_PER_REQUEST);

      const kept = doc.requests.slice(0, maxRequests);
      const requests = kept.map((r) => {
        const u = unionObjects(r);
        if (u.unionMatchesSystem === false) {
          drift.push({
            node: 'tm:all_objects',
            attribute: null,
            kind: 'union mismatch',
            where: `request ${r.number}`,
            recomputed: u.unionCount,
            systemSaid: u.systemUnion,
          });
        }
        return {
          number: r.number,
          kind: r.kind,
          kindCode: r.kindCode,
          status: r.status,
          statusCode: r.statusCode,
          ...(r.statusText ? { statusText: r.statusText } : {}),
          // The only human statement of WHY those objects moved together. Carried in the
          // answer, never in the audit trail.
          desc: r.desc,
          owner: r.owner,
          target: r.target,
          targetDesc: r.targetDesc,
          ctsProject: r.ctsProject,
          lastChanged: r.lastChanged,
          counts: {
            own: u.ownCount,
            inTasks: u.taskCount,
            union: u.unionCount,
            systemUnion: u.systemUnion,
            // null in list mode: the list carries no tm:all_objects, so "not checked"
            // must not read as "checked and agreed".
            unionMatchesSystem: u.unionMatchesSystem,
          },
          tasks: r.tasks.map((t) => ({
            number: t.number,
            owner: t.owner,
            desc: t.desc,
            // A localised text on a task, a code on a request. Named differently here so
            // no caller can compare the two.
            taskTypeText: t.taskType,
            status: t.status,
            statusCode: t.statusCode,
            objectCount: t.objects.length,
          })),
          objects: u.objects.slice(0, maxObjects),
          truncated: {
            objects: Math.max(0, u.objects.length - maxObjects),
          },
        };
      });

      // WHICH ROWS moved. One ADT call per object, so: opt-in, budgeted, and every object
      // the budget did not reach is named rather than quietly missing.
      let keySweep = null;
      if (wantsKeys) {
        const budget = capOf(args.maxKeyLookups, MAX_KEY_LOOKUPS);
        let spent = 0;
        let unasked = 0;
        const skipped = new Map();
        let bytes = 0; // reported, so the cost of the sweep is visible in the answer too

        // The detail resource answers with one request, so this loop runs once today. It
        // is a loop because `requests` is what the projection produces, and a budget that
        // silently restarts per request would be no budget at all.
        for (const r of requests) {
          if (spent >= budget) {
            unasked += r.objects.filter((o) => keyDecision(o).ask).length;
            continue;
          }
          const got = await collectObjectKeys(
            async (carrier, obj) => {
              let reply;
              try {
                reply = await namedGet(transport, 'transportObjectKeys', {
                  number: carrier,
                  objName: obj.name,
                  objType: obj.type,
                });
                bytes += reply.bytes ?? 0;
                return reply;
              } finally {
                // ONE LINE PER ADT CALL, answered or refused. An aggregate line would
                // under-count the read budget by a factor of the sweep, and a budget that
                // does not count the calls it authorised is not a budget. The carrier and
                // the object are named; nothing decoded from a key ever is.
                record(
                  cfg,
                  'adt_transport',
                  `${carrier} objectkeys ${obj.type} ${obj.name}`,
                  reply?.bytes ?? 0
                );
              }
            },
            r.objects,
            r.number,
            { maxLookups: budget - spent, maxKeysPerObject: args.maxKeysPerObject }
          );
          spent += got.lookups;
          unasked += got.notAttempted;
          for (const sk of got.skipped) {
            const k = `${sk.type}|${sk.by}`;
            const row = skipped.get(k) ?? { type: sk.type, by: sk.by, count: 0 };
            row.count += sk.count;
            skipped.set(k, row);
          }
          for (const d of got.drift) drift.push({ ...d, where: `${d.where} in ${r.number}` });
          r.keys = got.objects;
        }

        keySweep = {
          lookups: spent,
          bytes,
          budget,
          objectsNotAsked: unasked,
          skippedTypes: [...skipped.values()],
          rule:
            'A key with `transported: true` is a row that moved (E071K). One without it is ' +
            'the key TEMPLATE of the object and moved nothing -- an ACGR role answers with ' +
            '28 of those while E071K holds none. Only that flag separates the two.',
          note:
            'An object is asked where its own tm:obj_func is K ("has rows in the key ' +
            'list", domain OBJFUNC, measured; askedBy: objFunc). One with ' +
            "another value is skipped on the system's word (by: objFunc); one with no " +
            'attribute is skipped when its type was measured to answer 400 ' +
            'for every carrier (by: census) and asked otherwise (askedBy: unmeasured). ' +
            'A 400 on an individual object means the keys were not resolvable for the ' +
            'carriers tried -- the same status a wrong carrier earns -- and never that ' +
            'the object carries no keys.',
        };
      }

      const logs = wantsLogs ? await requestLogs(transport, String(args.number).trim(), drift) : null;

      if (drift.length && journal?.enabled) {
        journal.gap({
          code: DRIFT_CODE,
          subject: `cts/transportrequests (${doc.resource})`,
          detail: drift
            .map((d) => {
              if (d.kind === 'undeclared value') {
                return `${d.node}/@${d.attribute}="${d.value}" x${d.count ?? 1}`;
              }
              if (d.kind && d.attribute) return `${d.kind} (${d.where})`;
              if (d.attribute) return `${d.node}/@${d.attribute} x${d.count ?? 1}`;
              if (d.kind === 'union mismatch') {
                return `${d.node} recomputed ${d.recomputed} vs system ${d.systemSaid} (${d.where})`;
              }
              return `undeclared element <${d.node}> x${d.count ?? 1}`;
            })
            .join('; '),
          impact:
            'the answer stands, but the shape measured no longer describes ' +
            'this system fully: an undeclared attribute is being dropped, or the union ' +
            'rule no longer reproduces the system\'s own tm:all_objects',
          fallback:
            're-read the raw payload and update the projection in lib/transport-requests.mjs ' +
            'and the CTS section of docs/adt-api-reference.md',
        });
      }

      return json({
        route: out.route,
        url: out.url,
        status: out.status,
        contentType: out.contentType,
        bytes: out.bytes,
        measured: out.shapeObserved,
        mode: wantsDetail ? 'detail' : 'recent',
        ...(keySweep ? { keys: keySweep } : {}),
        ...(logs ? { logs } : {}),
        resource: doc.resource,
        // Structured, not a footnote: what this answer does and does not cover is part of
        // the data, because a list that silently omits open requests reads exactly like a
        // developer with no open requests.
        ...(wantsList ? { scope: listScope(doc) } : {}),
        rule:
          'objects = (the request\'s own list minus CORR comments) union (every task\'s ' +
          'objects). A task\'s objects move up into the request only when the task is ' +
          'released, so `objects` is the answer and `counts.own` is not.',
        requests,
        truncated: {
          requests: Math.max(0, doc.requests.length - kept.length),
          objects: requests.reduce((n, r) => n + r.truncated.objects, 0),
        },
        ...(drift.length ? { drift } : {}),
      });
    },
  };
}

function listScope(doc) {
  const s = doc.listScope ?? {};
  return {
    serverStated: s.serverStated ?? [],
    releasedOnly: s.openRequestsIncluded === false,
    window: 'last 2 weeks',
    halves: s.buckets ?? [],
    includesOthers: true,
    owners: s.owners ?? [],
    note:
      (s.note ?? '') +
      ' The window and the released-only cut are the server\'s: this route takes no ' +
      'parameter that widens either, and sending one empties the reply instead of ' +
      'erroring. For an open request, or one older than two weeks, ask by number.',
  };
}

const capOf = (given, fallback) => {
  const n = Number(given);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const json = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
