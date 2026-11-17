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
import { parseOpenRequests } from '../lib/open-requests.mjs';
import { parseConfigurations, parseConfiguration } from '../lib/transport-search.mjs';
import {
  collectObjectKeys,
  MAX_KEY_LOOKUPS,
  KEY_LOOKUPS_CEILING,
  MAX_KEYS_PER_OBJECT,
  KEYS_PER_OBJECT_CEILING,
  keyDecision,
} from '../lib/object-keys.mjs';
import { finish, page } from '../lib/completeness.mjs';
import { isoOfStamp } from '../lib/timestamps.mjs';
import { invalidArguments } from '../lib/tool-error.mjs';

/** From the measured envelope: 6 requests / 672 objects / 270 138 bytes in one dump. */
const MAX_REQUESTS = 50;
const MAX_OBJECTS_PER_REQUEST = 300;
/** The most requests, and objects per request, one answer lists; the offsets page the rest. */
const REQUESTS_CEILING = 500;
const OBJECTS_CEILING = 5000;

/** The drift of an answer as one incomplete entry: the shape measured no longer describes it. */
const driftEntry = (list, drift) => (drift.length ? [{ list, code: 'PARSE_FAILED', count: drift.length, reason: 'the reply carries what the measured shape does not describe: see drift' }] : []);

const NUMBER = /^[A-Z][A-Z0-9]{2}K[0-9]{6}$/;

/** A class publishes five version feeds (measured); nothing measured publishes more. */
const MAX_VERSION_FEEDS = 8;

export function transportTool(cfg, session, journal) {
  // The OPEN requests that hold one object now: one GET, read beside the version history
  // because the feed's version 00000 names only one holder and some objects publish no feed.
  async function openRequestsOf(objectUri, subjectOf) {
    let reply;
    try {
      reply = await namedGet(transportFor(session.raw), 'objectTransports', { uri: objectUri });
    } catch (e) {
      if (e?.name === 'RouteViolation') {
        return { read: false, reason: `the object URI is outside the route's alphabet: ${e.message}`.slice(0, 200) };
      }
      // Not swallowed: the gap is filed and the part says it was not read.
      if (journal?.enabled) {
        journal.gap({
          code: 'ADT_ERROR',
          subject: `${subjectOf} open requests`,
          detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? 'objectTransports'}`,
          impact: 'which open requests hold this object is unknown -- NOT "in none"',
          fallback: 'the object in SE03 ("Search for objects in requests/tasks") or in the IDE',
        });
      }
      return { read: false, reason: String(e?.message ?? e).slice(0, 200) };
    } finally {
      record(cfg, 'adt_transport', `${subjectOf} open requests`, reply?.bytes ?? 0);
    }
    const parsed = parseOpenRequests(reply.body);
    if (parsed.drift.length && journal?.enabled) {
      journal.gap({
        code: DRIFT_CODE,
        subject: `${subjectOf} open requests`,
        detail: parsed.drift.map((d) => (d.attribute ? `${d.node}/@${d.attribute} x${d.count}` : `<${d.node}> x${d.count}`)).join('; '),
        impact: 'the answer stands, but something undeclared in the reply is being dropped',
        fallback: 're-read the raw reply and update lib/open-requests.mjs and docs/adt-api-reference.md',
      });
    }
    return { read: true, requests: parsed.requests, ...(parsed.drift.length ? { drift: parsed.drift } : {}) };
  }

  /** The incomplete entries of an open-requests part. */
  const openIncomplete = (o) => (!o.read ? [{ list: 'openRequests', code: 'NOT_READ', reason: o.reason }] : driftEntry('openRequests', o.drift ?? []));

  // The list the IDE's saved search selects: the user's own configuration, read and never
  // created, then the tree it drives. Requests and tasks only: every object arrives inline
  // (874 KB for 858 measured), and is counted here, never listed -- ask by number for those.
  async function savedSearch(args) {
    const transport = transportFor(session.raw);
    const get = async (route, params, subject) => {
      let reply;
      try {
        reply = await namedGet(transport, route, params);
        return reply;
      } catch (e) {
        if (e?.name !== 'RouteViolation' && journal?.enabled) {
          journal.gap({
            code: 'ADT_ERROR',
            subject: `transport saved search (${subject})`,
            detail: `HTTP ${e?.status ?? '?'} on ${e?.url ?? route}`,
            impact: 'the saved search could not be read -- this is NOT "no requests"',
            fallback: 'the Transport Organizer view of the IDE, or SE09/SE10',
          });
        }
        throw e;
      } finally {
        record(cfg, 'adt_transport', `saved search ${subject}`, reply?.bytes ?? 0);
      }
    };
    const list = await get('transportSearchConfigurations', {}, 'configurations');
    const configurations = parseConfigurations(list.body);
    if (!configurations.length) {
      if (journal?.enabled) {
        journal.gap({
          code: 'SAVED_SEARCH_NOT_FOUND',
          subject: 'transport saved search',
          detail: 'searchconfiguration/configurations listed no configuration for the logged-on user',
          impact: 'nothing was read, and none was created: this is NOT "no requests"',
          fallback: 'open the Transport Organizer view in the IDE once (it saves the search), or use recent / number',
        });
      }
      const reason = 'the server lists no saved search configuration for this user; none is created here';
      return json(finish({ mode: 'saved', read: false, reason, requests: [] }, [{ list: 'requests', code: 'NOT_READ', reason }]));
    }
    const chosen = configurations[0];
    const doc = await get('transportSearchConfiguration', { id: chosen.id }, 'configuration');
    const properties = parseConfiguration(doc.body);
    const out = await get('transportListByConfiguration', { configUri: chosen.href }, 'list');
    const tree = parseTransportDocument(out.body);
    if (tree.drift.length && journal?.enabled) {
      journal.gap({
        code: DRIFT_CODE,
        subject: 'cts/transportrequests (saved search)',
        detail: tree.drift
          .map((d) => (d.attribute ? `${d.node}/@${d.attribute}` : `<${d.node}>`))
          .join('; ')
          .slice(0, 400),
        impact: 'the answer stands, but the shape measured no longer describes this system fully',
        fallback: 're-read the raw payload and update lib/transport-requests.mjs and docs/adt-api-reference.md',
      });
    }
    const p = page(tree.requests, { max: args.maxRequests, offset: args.offset, defaultMax: MAX_REQUESTS, ceiling: REQUESTS_CEILING });
    const kept = p.items;
    const incomplete = [...driftEntry('requests', tree.drift)];
    if (p.truncated) incomplete.push({ list: 'requests', code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { ...p.next, costsCalls: 3 } });
    return json(finish({
      mode: 'saved',
      read: true,
      configuration: {
        id: chosen.id,
        ...(configurations.length > 1 ? { others: configurations.length - 1 } : {}),
        properties,
      },
      scope: {
        serverStated: tree.listScope?.serverStated ?? [],
        owners: tree.listScope?.owners ?? [],
        note:
          'what the saved configuration selects (its properties above), modifiable and released. ' +
          'It is the configuration the IDE saved; this tool never creates or changes one.',
      },
      requests: kept.map((r) => ({
        number: r.number,
        kind: r.kind,
        status: r.status,
        statusCode: r.statusCode,
        desc: r.desc,
        owner: r.owner,
        target: r.target,
        // System-local, not UTC (lib/timestamps.mjs): written without an offset.
        lastChanged: isoOfStamp(r.lastChanged),
        objectCount: unionObjects(r).unionCount,
        tasks: r.tasks.map((t) => ({
          number: t.number,
          owner: t.owner,
          desc: t.desc,
          status: t.status,
          objectCount: t.objects.length,
        })),
      })),
      requestsPage: pageOf(p, 3),
      ...(tree.drift.length ? { drift: tree.drift } : {}),
    }, incomplete));
  }

  // WHICH TRANSPORTS carried one object: the version feed(s) the server publishes for
  // it, read as raw Atom under the object's own URI. lib/object-versions.mjs carries
  // the three measured ways this feed lies; this function only sequences the reads.
  async function objectHistory(spec) {
    const name = String(spec?.name ?? '').trim();
    const type = spec?.type ? String(spec.type).trim().toUpperCase() : undefined;
    if (!name) throw invalidArguments('adt_transport `object` needs a `name`.');

    const resolved = await resolveObject(session.api, name, type, 'metadata');
    const { hit, foundBy } = resolved;
    const objectUri = hit['adtcore:uri'];
    const subjectOf = `${hit['adtcore:type']} ${hit['adtcore:name']}`;
    if (!resolved.structure && isClasenh(hit['adtcore:type'])) {
      // The structure of a class / interface enhancement dumps the server (3 of 3,
      // 2026-09-14): nothing is read, and the history is asked of a neighbour instead.
      clasenhGap(journal, hit['adtcore:name'], `adt_transport object on ${objectUri}: no structure read (the resource dumps the server)`);
      const openRequests = await openRequestsOf(objectUri, subjectOf);
      return json(finish({
        mode: 'object',
        object: { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: objectUri, foundBy },
        feedsRead: [],
        transports: [],
        copies: [],
        activeVersion: [],
        clasenh: true,
        feeds: { read: false },
        openRequests,
        rule:
          'a class enhancement (CLASENH) or function-module interface enhancement (FUGRENH) publishes ' +
          'no version feed the ADT can read without dumping; nothing was read and no history is claimed. ' +
          'Ask the history of the object that USES the added methods or parameters (measured: ' +
          'the request that created the ENHO also carries its caller), or SE03. ' + CLASENH_WHERE,
      }, [{ list: 'transports', code: 'NOT_READ', reason: 'a class enhancement publishes no version feed the ADT reads without dumping' }, ...openIncomplete(openRequests)]));
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
      const openRequests = await openRequestsOf(objectUri, subjectOf);
      return json(finish({
        mode: 'object',
        object: { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: objectUri, foundBy },
        feeds: { read: false, published: 0 },
        feedsRead: [],
        transports: [],
        copies: [],
        activeVersion: [],
        openRequests,
        rule: 'no version feed is published for this object; nothing was read and no history is claimed',
      }, [{ list: 'transports', code: 'NOT_READ', reason: 'the object publishes no version feed' }, ...openIncomplete(openRequests)]));
    }

    const transport = transportFor(session.raw);
    const wanted = links.slice(0, MAX_VERSION_FEEDS);
    const feeds = [];
    const drift = [];
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
      const parsed = parseVersionFeed(out.body);
      for (const d of parsed.drift) drift.push({ ...d, where: `${where}: ${d.where}` });
      feeds.push({ where, href, entries: parsed.entries, feedTitle: parsed.feedTitle });
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
    const openRequests = await openRequestsOf(objectUri, subjectOf);
    const feedsNotRead = links.length - wanted.length;
    const incomplete = [...driftEntry('transports', drift), ...openIncomplete(openRequests)];
    if (feedsNotRead) incomplete.push({ list: 'feeds', code: 'CAP_REACHED', count: feedsNotRead, reason: `at most ${MAX_VERSION_FEEDS} version feeds per object` });
    return json(finish({
      mode: 'object',
      object: { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: objectUri, foundBy },
      feedsRead: feeds.map((f) => ({ where: f.where, href: f.href, entries: f.entries.length, title: f.feedTitle })),
      transports: history.transports,
      copies: history.copies,
      activeVersion: history.activeVersion,
      openRequests,
      versionsWithoutTransport: history.withoutLink,
      feeds: { read: true, published: links.length, asked: wanted.length, notRead: feedsNotRead },
      ...(drift.length ? { drift } : {}),
    }, incomplete));
  }

  // The two logs of one request, one GET each. A log that could not be read says so with
  // `read: false`; it never reads as an empty log.
  async function requestLogs(transport, number, drift) {
    const out = {
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
        count: parsed.count,
        dropped: parsed.dropped,
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
        'that carried it, from its version history; one GET per version feed; plus the open ' +
        'requests holding it now, one GET), or `saved: true` (what your saved IDE search ' +
        'selects, open and released: requests and tasks, objects counted). Empty openRequests ' +
        'is in no open request, never "never transported".',
      inputSchema: {
        type: 'object',
        properties: {
          number: {
            type: 'string',
            description: 'One transport request, e.g. DEVK900123.',
          },
          saved: {
            type: 'boolean',
            description: 'The list your saved IDE search selects (open and released): requests and tasks.',
          },
          recent: {
            type: 'boolean',
            description: 'The server\'s scope: released only, two weeks, no paging or filter.',
          },
          maxRequests: {
            type: 'integer',
            minimum: 1,
            maximum: REQUESTS_CEILING,
            description: `recent / saved: requests per page (default ${MAX_REQUESTS}, at most ${REQUESTS_CEILING}).`,
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'recent / saved: first request of the page: `requestsPage.next.offset` of the previous answer.',
          },
          maxObjectsPerRequest: {
            type: 'integer',
            minimum: 1,
            maximum: OBJECTS_CEILING,
            description: `Objects listed per request (default ${MAX_OBJECTS_PER_REQUEST}, at most ${OBJECTS_CEILING}).`,
          },
          objectsOffset: {
            type: 'integer',
            minimum: 0,
            description: 'With `number`: first object of the page: `objectsPage.next.objectsOffset` of the previous answer.',
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
            type: 'integer',
            minimum: 1,
            maximum: KEY_LOOKUPS_CEILING,
            description: `With \`keys\`: lookups, one ADT call each (default ${MAX_KEY_LOOKUPS}, at most ${KEY_LOOKUPS_CEILING}).`,
          },
          keysOffset: {
            type: 'integer',
            minimum: 0,
            description: 'With `keys`: first object to ask: `keys.next.keysOffset` of the previous answer.',
          },
          maxKeysPerObject: {
            type: 'integer',
            minimum: 1,
            maximum: KEYS_PER_OBJECT_CEILING,
            description: `With \`keys\`: keys listed per object (default ${MAX_KEYS_PER_OBJECT}, at most ${KEYS_PER_OBJECT_CEILING}).`,
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
      const wantsSaved = args.saved === true;
      if ([wantsDetail, wantsList, wantsObject, wantsSaved].filter(Boolean).length > 1) {
        throw invalidArguments(
          'adt_transport takes `number` OR `recent` OR `object` OR `saved`, never two: one ' +
            'reads a request you name, one a list whose scope the server decides, one the ' +
            'history of an object you name, one the list your saved search selects. Ask twice.'
        );
      }
      if (!wantsDetail && !wantsList && !wantsObject && !wantsSaved) {
        throw invalidArguments(
          'adt_transport has no default mode. Pass `number` for one request, ' +
            '`recent: true` for the recent released list, `object: {name, type}` for ' +
            'the version history of one object, or `saved: true` for the list your saved ' +
            'search selects. Omitting all of them would be a sweep nobody asked for.'
        );
      }
      if (wantsSaved) {
        if (args.keys === true || args.logs === true) {
          throw invalidArguments(
            'adt_transport reads keys and logs only for a request you name by `number`; the ' +
              'saved search answers requests and tasks.'
          );
        }
        return savedSearch(args);
      }
      const wantsLogs = args.logs === true;
      if (wantsObject) {
        if (wantsLogs) {
          throw invalidArguments(
            'adt_transport reads the logs of a request you name by `number`; the object ' +
              'history carries none.'
          );
        }
        if (args.keys === true) {
          throw invalidArguments(
            'adt_transport reads table keys for a request you name by `number`; the ' +
              'version feed of an object carries no keys.'
          );
        }
        return objectHistory(args.object);
      }
      if (wantsLogs && !wantsDetail) {
        throw invalidArguments(
          'adt_transport reads the logs of a request you name by `number`; the recent list ' +
            'and the object history carry none.'
        );
      }
      const wantsKeys = args.keys === true;
      if (wantsKeys && !wantsDetail) {
        throw invalidArguments(
          'adt_transport reads table keys only for a request you name. The recent list ' +
            'carried 672 objects in the measured dump, and keys cost one ADT call per ' +
            'object -- ask by `number`.'
        );
      }
      if (wantsDetail && !NUMBER.test(String(args.number).trim())) {
        throw invalidArguments(
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

      const incomplete = [];
      const p = page(doc.requests, { max: args.maxRequests, offset: wantsList ? args.offset : 0, defaultMax: MAX_REQUESTS, ceiling: REQUESTS_CEILING });
      const kept = p.items;
      if (p.truncated) incomplete.push({ list: 'requests', code: 'CAP_REACHED', returned: p.returned, total: p.total, next: { ...p.next, costsCalls: 1 } });

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
          lastChanged: isoOfStamp(r.lastChanged),
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
          ...objectsOf(r.number, u.objects),
        };
      });
      function objectsOf(number, objects) {
        // The objects of a request, paged: `objectsOffset` applies to a request asked by number.
        const o = page(objects, { max: args.maxObjectsPerRequest, offset: wantsDetail ? args.objectsOffset : 0, defaultMax: MAX_OBJECTS_PER_REQUEST, ceiling: OBJECTS_CEILING });
        const next = o.next ? (wantsDetail ? { objectsOffset: o.next.offset, costsCalls: 1 } : { number, objectsOffset: o.next.offset }) : null;
        if (o.truncated) incomplete.push({ list: `requests.${number}.objects`, code: 'CAP_REACHED', returned: o.returned, total: o.total, next });
        return { objects: o.items, objectsPage: { total: o.total, returned: o.returned, offset: o.offset, limit: o.limit, truncated: o.truncated, ...(next ? { next } : {}) } };
      }

      // WHICH ROWS moved. One ADT call per object, so: opt-in, budgeted, and every object
      // the budget did not reach is named rather than quietly missing.
      let keySweep = null;
      if (wantsKeys) {
        const budget = Math.min(capOf(args.maxKeyLookups, MAX_KEY_LOOKUPS), KEY_LOOKUPS_CEILING);
        let spent = 0;
        let unasked = 0;
        let nextOffset = null;
        const skipped = new Map();

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
            { maxLookups: budget - spent, maxKeysPerObject: args.maxKeysPerObject, offset: args.keysOffset }
          );
          spent += got.lookups;
          unasked += got.notAttempted;
          if (got.nextOffset !== null) nextOffset = got.nextOffset;
          for (const sk of got.skipped) {
            const k = `${sk.type}|${sk.by}`;
            const row = skipped.get(k) ?? { type: sk.type, by: sk.by, count: 0 };
            row.count += sk.count;
            skipped.set(k, row);
          }
          for (const d of got.drift) drift.push({ ...d, where: `${d.where} in ${r.number}` });
          r.keys = got.objects;
        }

        const results = requests.flatMap((r) => r.keys ?? []);
        const byReason = (reason) => results.filter((o) => o.reason === reason).length;
        if (byReason('400')) incomplete.push({ list: 'keys', code: 'NOT_READ', count: byReason('400'), reason: 'every carrier tried answered 400: not evidence of no keys' });
        if (byReason('error')) incomplete.push({ list: 'keys', code: 'NOT_READ', count: byReason('error'), reason: 'an error other than 400' });
        if (unasked || byReason('budget')) {
          incomplete.push({ list: 'keys', code: 'BUDGET_REACHED', count: unasked + byReason('budget'), next: { keysOffset: nextOffset, costsCalls: 1 }, narrowBy: ['maxKeyLookups'] });
        }
        const cutKeys = results.filter((o) => o.truncated === true).length;
        if (cutKeys) incomplete.push({ list: 'keys.keys', code: 'CAP_REACHED', count: cutKeys, narrowBy: ['maxKeysPerObject'] });
        keySweep = {
          lookups: spent,
          budget,
          objectsNotAsked: unasked,
          ...(args.keysOffset ? { offset: args.keysOffset } : {}),
          ...(nextOffset !== null ? { next: { keysOffset: nextOffset } } : {}),
          skippedTypes: [...skipped.values()],
        };
      }

      const logs = wantsLogs ? await requestLogs(transport, String(args.number).trim(), drift) : null;
      for (const part of ['actions', 'transport']) {
        if (logs && !logs[part].read) incomplete.push({ list: `logs.${part}`, code: 'NOT_READ', reason: logs[part].reason });
      }
      incomplete.push(...driftEntry('requests', drift));

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

      return json(finish({
        mode: wantsDetail ? 'detail' : 'recent',
        ...(keySweep ? { keys: keySweep } : { keys: { asked: false } }),
        ...(logs ? { logs } : { logs: { asked: false } }),
        // Structured, not a footnote: what this answer does and does not cover is part of
        // the data, because a list that silently omits open requests reads exactly like a
        // developer with no open requests.
        ...(wantsList ? { scope: listScope(doc, kept) } : {}),
        requestsPage: pageOf(p, 1),
        requests,
        ...(drift.length ? { drift } : {}),
      }, incomplete));
    },
  };
}

function listScope(doc, kept) {
  const s = doc.listScope ?? {};
  // The owners of the requests in THIS answer: an owner whose only requests were cut is not
  // named as if the answer showed them.
  const owners = [...new Set(kept.flatMap((r) => [r.owner, ...(r.tasks ?? []).map((t) => t.owner)]).filter(Boolean))].sort();
  return {
    serverStated: s.serverStated ?? [],
    releasedOnly: s.openRequestsIncluded === false,
    window: 'last 2 weeks',
    halves: s.buckets ?? [],
    includesOthers: true,
    owners,
    ownersInList: (s.owners ?? []).length,
    note:
      (s.note ?? '') +
      ' The window and the released-only cut are the server\'s: this route takes no ' +
      'parameter that widens either, and sending one empties the reply instead of ' +
      'erroring. For an open request, or one older than two weeks, ask by number.',
  };
}

/** A list page as the answer shows it; the next page re-reads the list (`costsCalls`). */
const pageOf = (p, costsCalls) => ({ total: p.total, returned: p.returned, offset: p.offset, limit: p.limit, truncated: p.truncated, ...(p.next ? { next: { ...p.next, costsCalls } } : {}) });

const capOf = (given, fallback) => {
  const n = Number(given);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const json = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
