// The Transport Organizer, parsed against payloads measured on the development system on 2026-09-09.
//
// This answers what an abapGit checkout structurally cannot: WHICH OBJECTS MOVED
// TOGETHER, WHEN, AND BY WHOM. A repository serialises the state of an object, never the
// change, and no `.abapgit.xml` carries a transport number -- so "what did this delivery
// consist of" has no answer in the working tree, only in CTS.
//
// Two resources, two shapes, and they are NOT the same document with different filters.
// Both are recorded verbatim in docs/adt-api-reference.md; what follows is only what the
// code has to act on.
//
//   DETAIL  /cts/transportrequests/<number>
//     tm:root > tm:request > { tm:abap_object*, tm:all_objects > tm:abap_object*,
//                              tm:task* > tm:abap_object* }
//     14 attributes on tm:request. Carries tm:attributes (97 SAPCOMPONENT rows per
//     released request) and 3 atom:link per object -- all of it dropped here.
//
//   LIST    /cts/transportrequests            (bare url, no query -- see lib/adt-get.mjs)
//     tm:root > tm:workbench|tm:customizing > tm:released > tm:request > tm:task*
//     12 attributes on tm:request: NO tm:status_text, NO tm:source_client.
//     NO tm:all_objects, NO tm:attributes, NO tm:modifiable node at all.
//
// ⚠️ THE RULE THIS FILE EXISTS FOR. A task's objects are merged up into the request only
// when the task is RELEASED. Reading a request's own tm:abap_object children therefore
// under-reports every open request, and in the measured case of DEVK900117 it reports
// NOTHING: a customizing request with four objects whose own list is empty, because its
// single task is still modifiable. The list resource has no tm:all_objects to fall back
// on, so descending into tm:task is not an optimisation, it is the answer.
//
// The invariant, measured on all six requests read, and re-checked at runtime whenever
// the system hands over its own tm:all_objects:
//
//   all objects = (the request's own objects MINUS the CORR pseudo-entries)
//                 UNION (every task's objects), deduplicated
//
// Checked where the two sides differ: DEVK900113 is 13 u 2 = 15, DEVK900117 is 0 u 4 = 4.
//
// ⚠️ Three attribute traps, each of which would be a silent wrong answer:
//
//   1. tm:type is a CODE on tm:request (K/W/T) and a LOCALISED TEXT on tm:task
//      ("Development/Correction", "Repair", "Customizing Task"). Same attribute name,
//      sibling elements, different domains -- so they are read by different functions.
//   2. K is WORKBENCH and W is CUSTOMIZING. W does not mean workbench.
//   3. tm:status has a third value beyond D and R: L, "Protegido" (measured on
//      DEVK900101). The client library's {modifiable, released} model has no place for
//      it. tm:status_text is translated -- display only, never a condition.
//
// ⚠️ tm:obj_func is NOT a customizing marker, though six documents made it look like one:
// a seventh showed it on METH/D, DOMA/D, FUGR/D, TOBJ/D and TRAN/D as well as TABU/K,
// CDAT/K, VDAT/K, TDAT/K. It is E071-OBJFUNC, and its domain was read on 2026-09-10
// (docs/adt-api-reference.md, "The domain OBJFUNC and its six values"): K = the entry has
// rows in the key list (E071K), D = the object was deleted. Cross-checked offline over 8
// requests: blank -> no E071K row 136/136, K -> E071K rows 14/14. So a request that
// DELETES ZCL_X must not read like one that creates it, and "which entries have keys" is
// a question the payload answers -- which is why the attribute is decoded (OBJ_FUNC,
// below) instead of passed through. The attribute is OMITTED when blank, like tm:wbtype:
// every entry measured without it is blank in E071.

/** The gap code this module's findings are filed under. See lib/journal-codes.mjs. */
export const DRIFT_CODE = 'SHAPE_DRIFT';

/**
 * The attributes this server declares, per node. Anything else is DROPPED and reported
 * as drift -- the same construction as the field allowlist in lib/journal.mjs, and for
 * the same reason: a shape that grew is a measurement that aged, and it has to be
 * visible rather than silently carried or silently lost.
 *
 * `detailOnly` are the two the list resource does not send. Their absence in a list
 * answer is expected, not drift.
 */
export const PROJECTION = {
  request: [
    'tm:number',
    'tm:parent',
    'tm:owner',
    'tm:desc',
    'tm:type',
    'tm:status',
    'tm:target',
    'tm:target_desc',
    'tm:cts_project',
    'tm:cts_project_desc',
    'tm:lastchanged_timestamp',
    'tm:uri',
  ],
  requestDetailOnly: ['tm:status_text', 'tm:source_client'],
  object: [
    'tm:pgmid',
    'tm:type',
    'tm:name',
    'tm:position',
    'tm:wbtype',
    'tm:obj_desc',
    'tm:obj_info',
    'tm:obj_func',
  ],
  /**
   * Present in the payload, deliberately not carried.
   *
   * `tm:dummy_uri` is the server-built link to /cts/transportrequests/reference for that
   * object. It is dropped because this server has no route for it: its semantics -- which
   * request the href names when an object has lived in several -- have never been
   * observed here, and a link whose meaning is unmeasured is worse than no link.
   */
  droppedOnPurpose: ['tm:dummy_uri', 'tm:img_activity', 'tm:lock_status'],
  /**
   * Every ELEMENT measured in either representation.
   *
   * ⚠️ This list closes a real hole. Undeclared ATTRIBUTES were reported as drift from the
   * start, but an undeclared ELEMENT was ignored in silence -- so a `<tm:key>` child of
   * tm:abap_object, which is exactly the shape the E071K key of a customizing entry would
   * take if this resource exposed it, would have been dropped without a word. "No key is
   * exposed" then rests on a guard rather than on nobody having looked.
   */
  elements: [
    'tm:root',
    'tm:workbench',
    'tm:customizing',
    'tm:released',
    'tm:modifiable',
    // The list a saved search drives (`targets=true`) nests each status under its transport
    // target; measured 2026-11-10. Its name is already on every request as tm:target.
    'tm:target',
    'tm:request',
    'tm:task',
    'tm:abap_object',
    'tm:all_objects',
    'tm:long_desc',
    'tm:attributes',
    'atom:link',
  ],
};

const DECLARED_REQUEST = new Set([...PROJECTION.request, ...PROJECTION.requestDetailOnly]);
const DECLARED_OBJECT = new Set([...PROJECTION.object, ...PROJECTION.droppedOnPurpose]);
const DECLARED_ELEMENT = new Set(PROJECTION.elements);

/**
 * tm:abap_object/@tm:obj_func -- the fixed values of domain OBJFUNC, read on 2026-09-10.
 *
 * `meaning` is this server's word, derived; `systemText` is the domain's fixed-value text. The
 * system carries it in German only; the repository is English-only, so it is stored translated. A code the domain does not declare is
 * SHAPE_DRIFT with `meaning: null`, never a guessed gloss. Observed on this system: K (in
 * E071 and in the ADT document) and D (ADT document only); M, A and C never.
 */
export const OBJ_FUNC = new Map([
  ['', { meaning: 'normal', systemText: 'Normal case: transport to the target system (see also F1 help)' }],
  ['D', { meaning: 'deleted', systemText: 'Object was deleted (only possible with deleted objects)' }],
  ['M', { meaning: 'dropAndRecreate', systemText: 'Delete and re-create on the database' }],
  ['K', { meaning: 'hasKeyList', systemText: 'Object key according to entries in the key list' }],
  ['A', { meaning: 'archivedViaSara', systemText: 'Key was archived via SARA' }],
  ['C', { meaning: 'userDefinedConversion', systemText: 'User-defined conversion' }],
]);

/**
 * Decode one tm:obj_func value. `undefined` (attribute absent) -> null: the entry is the
 * blank, normal case and the caller decides by other evidence -- see lib/object-keys.mjs.
 * A present value the domain does not declare comes back with `meaning: null`.
 */
export function objFuncOf(raw) {
  if (raw === undefined || raw === null) return null;
  const code = String(raw).trim();
  const known = OBJ_FUNC.get(code);
  return known ? { code, ...known } : { code, meaning: null, systemText: null };
}

/** tm:request/@tm:type. Measured: K, W, T. */
const REQUEST_KIND = new Map([
  ['K', 'workbench'],
  ['W', 'customizing'],
  ['T', 'transport-of-copies'],
]);

/** tm:request/@tm:status and tm:task/@tm:status. Measured: D, R, L. */
const STATUS = new Map([
  ['D', 'modifiable'],
  ['R', 'released'],
  ['L', 'protected'],
]);

/**
 * The kind of a request, from the CODE.
 *
 * Never from tm:status_text or from any other translated string, and never from the
 * objects it carries: a workbench request holds TABU entries too (measured on
 * DEVK900113), so the half is a property of the request and of nothing else.
 */
export const requestKind = (code) => REQUEST_KIND.get(String(code ?? '').trim()) ?? null;

/** The status of a request or a task, from the code. `null` for a value never measured. */
export const statusOf = (code) => STATUS.get(String(code ?? '').trim()) ?? null;

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

const attrsOf = (chunk) => {
  const out = {};
  for (const m of String(chunk ?? '').matchAll(ATTR)) out[m[1]] = unescapeXml(m[2]);
  return out;
};

/** Identity of an object inside one request: what makes two entries the same object. */
const objectKey = (o) => `${o.pgmid}|${o.type}|${o.name}`;

function projectObject(raw, drift, where) {
  for (const key of Object.keys(raw)) {
    if (!DECLARED_OBJECT.has(key)) drift.push({ node: 'tm:abap_object', attribute: key, where });
  }
  const objFunc = objFuncOf(raw['tm:obj_func']);
  if (objFunc && objFunc.meaning === null) {
    // A value outside the six the domain declares. Carried with its code so the answer
    // does not lose it, reported so the vocabulary above gets re-measured.
    drift.push({
      node: 'tm:abap_object',
      attribute: 'tm:obj_func',
      kind: 'undeclared value',
      value: objFunc.code,
      where,
    });
  }
  return {
    pgmid: raw['tm:pgmid'] ?? '',
    type: raw['tm:type'] ?? '',
    name: raw['tm:name'] ?? '',
    position: raw['tm:position'] ?? '',
    wbtype: raw['tm:wbtype'] ?? null,
    objDesc: raw['tm:obj_desc'] ?? null,
    // The description of the object TYPE ("Table contents"), not a value. Measured:
    // it never carries a table key -- the E071K rows behind a TABU entry are not exposed
    // by this resource at all, which is why admitting the customizing half does not move
    // the "the repository, never the contents of a table" frontier.
    objInfo: raw['tm:obj_info'] ?? null,
    objFunc,
  };
}

function projectRequestLike(raw, drift, where, { detail }) {
  for (const key of Object.keys(raw)) {
    if (!DECLARED_REQUEST.has(key)) drift.push({ node: where, attribute: key, where });
  }
  const out = {
    number: raw['tm:number'] ?? '',
    parent: raw['tm:parent'] || null,
    owner: raw['tm:owner'] ?? '',
    desc: raw['tm:desc'] ?? '',
    target: raw['tm:target'] || null,
    targetDesc: raw['tm:target_desc'] || null,
    ctsProject: raw['tm:cts_project'] || null,
    ctsProjectDesc: raw['tm:cts_project_desc'] || null,
    lastChanged: raw['tm:lastchanged_timestamp'] ?? null,
    uri: raw['tm:uri'] ?? null,
    status: statusOf(raw['tm:status']),
    statusCode: raw['tm:status'] ?? '',
  };
  if (detail) {
    // Translated. Kept so a human reading the answer sees what the IDE shows, never
    // branched on.
    out.statusText = raw['tm:status_text'] ?? null;
    out.sourceClient = raw['tm:source_client'] ?? null;
  }
  return out;
}

/**
 * Parse one Transport Organizer document -- either resource, told apart by its own shape
 * rather than by a caller's claim.
 *
 * @param {string} xml raw payload
 * @returns {{resource:'detail'|'list'|'empty', requests:object[], drift:object[],
 *            buckets:object|null, listScope:object|null}}
 */
export function parseTransportDocument(xml) {
  const text = String(xml ?? '');
  const drift = [];
  const requests = [];

  const stack = [];
  let bucket = null; // 'workbench' | 'customizing'
  let statusNode = null; // the tm:released / tm:modifiable wrapper of the list resource
  let current = null;
  let currentTask = null;

  for (const m of text.matchAll(TAG)) {
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (closing) {
      const popped = stack.pop();
      if (popped === 'tm:task') currentTask = null;
      if (popped === 'tm:request') current = null;
      if (popped === 'tm:workbench' || popped === 'tm:customizing') bucket = null;
      if (popped === 'tm:released' || popped === 'tm:modifiable') statusNode = null;
      continue;
    }
    const self = selfClosing === '/';
    const attrs = attrsOf(rawAttrs);

    // An element nobody measured is drift, not noise. It is still skipped -- this parser
    // will not invent a meaning for it -- but the skipping is now on the record.
    if (!DECLARED_ELEMENT.has(tag)) {
      drift.push({
        node: tag,
        attribute: null,
        where: current ? `request ${current.number}` : 'document',
        kind: 'undeclared element',
      });
    }

    if (tag === 'tm:workbench' || tag === 'tm:customizing') {
      bucket = tag === 'tm:workbench' ? 'workbench' : 'customizing';
    } else if (tag === 'tm:released' || tag === 'tm:modifiable') {
      // ⚠️ The status wrapper carries the SERVER'S OWN description of the scope it
      // applied, e.g. "Released (From Last 2 Weeks)". It is the only statement of that
      // window anywhere, so it is carried verbatim rather than reworded.
      statusNode = { node: tag, label: attrs['tm:status'] ?? null };
    } else if (tag === 'tm:request') {
      // A request or a task with no children comes back SELF-CLOSED. Requiring an opening
      // tag would drop it entirely -- and the ones with no children are exactly the empty
      // requests and the objectless tasks, the rows whose absence is indistinguishable
      // from "there was nothing there". They are recorded, then closed immediately.
      current = {
        ...projectRequestLike(attrs, drift, 'tm:request', {
          detail: 'tm:status_text' in attrs,
        }),
        kind: requestKind(attrs['tm:type']),
        kindCode: attrs['tm:type'] ?? '',
        bucket,
        scopeLabel: statusNode?.label ?? null,
        ownObjects: [],
        comments: [],
        tasks: [],
        systemUnion: null,
      };
      requests.push(current);
      if (self) current = null;
    } else if (tag === 'tm:task' && current) {
      currentTask = {
        ...projectRequestLike(attrs, drift, 'tm:task', { detail: 'tm:status_text' in attrs }),
        // NOT requestKind(): on a task this attribute is a localised text, not a code.
        taskType: attrs['tm:type'] ?? '',
        objects: [],
      };
      current.tasks.push(currentTask);
      if (self) currentTask = null;
    } else if (tag === 'tm:abap_object' && current) {
      const where = stack.includes('tm:all_objects')
        ? `tm:all_objects of ${current.number}`
        : currentTask
          ? `task ${currentTask.number}`
          : `request ${current.number}`;
      const obj = projectObject(attrs, drift, where);
      if (stack.includes('tm:all_objects')) {
        // The system's own union. Not merged into the answer -- kept to check ours.
        current.systemUnion = (current.systemUnion ?? 0) + (obj.pgmid === 'CORR' ? 0 : 1);
      } else if (currentTask) {
        currentTask.objects.push(obj);
      } else if (obj.pgmid === 'CORR') {
        // CORR/RELE and CORR/MERG are release and merge COMMENTS, not objects. The
        // system's own tm:all_objects drops them too.
        current.comments.push(obj);
      } else {
        current.ownObjects.push(obj);
      }
    }

    if (!self) stack.push(tag);
  }

  const resource = /<tm:workbench|<tm:customizing/.test(text)
    ? 'list'
    : requests.length
      ? 'detail'
      : 'empty';

  return {
    resource,
    requests,
    drift: dedupeDrift(drift),
    listScope: resource === 'list' ? scopeOf(requests) : null,
  };
}

function dedupeDrift(drift) {
  const seen = new Map();
  for (const d of drift) {
    const key = `${d.node}|${d.attribute}|${d.value ?? ''}`;
    if (!seen.has(key)) seen.set(key, { ...d, count: 0 });
    seen.get(key).count++;
  }
  return [...seen.values()];
}

/**
 * What the list answer says about its own scope.
 *
 * Measured, and none of it is negotiable from here: the answer contained no
 * `tm:modifiable` node and no open request; the window is written into the data as
 * "Released (From Last 2 Weeks)"; and it contained requests owned by OTHER PEOPLE,
 * because the caller holds a task inside them. The parameters that would narrow or widen
 * any of this are the ones that empty the response (lib/adt-get.mjs, `transportList`),
 * and the date filter lives in a search configuration whose creation is a POST this
 * server does not have.
 */
function scopeOf(requests) {
  const labels = [...new Set(requests.map((r) => r.scopeLabel).filter(Boolean))];
  // ⚠️ Request owners are NOT everyone the answer names. Measured live on 2026-09-09:
  // the reply carried three people, and the third (DEVUSER3) owned only a TASK inside
  // someone else's request. A declaration that lists two of three is worse than none,
  // because it reads as complete -- so this walks the tasks as well.
  const owners = [
    ...new Set(requests.flatMap((r) => [r.owner, ...r.tasks.map((t) => t.owner)]).filter(Boolean)),
  ].sort();
  const buckets = [...new Set(requests.map((r) => r.bucket).filter(Boolean))].sort();
  return {
    serverStated: labels,
    buckets,
    owners,
    openRequestsIncluded: requests.some((r) => r.status === 'modifiable'),
    note:
      'this route answers only what the server decided to answer: the status wrapper it ' +
      'returned is quoted verbatim above, and no parameter of this collection can widen ' +
      'it -- sending one empties the reply instead. Requests owned by other developers ' +
      'appear when you hold a task inside them, with their owner named.',
  };
}

/**
 * Every object of one request, by the rule at the top of this file.
 *
 * @returns {{objects:object[], bySource:Map<string,string[]>, ownCount:number,
 *            taskCount:number, unionCount:number, systemUnion:number|null,
 *            unionMatchesSystem:boolean|null}}
 */
export function unionObjects(request) {
  const byKey = new Map();
  const sources = new Map();

  const add = (obj, source) => {
    const key = objectKey(obj);
    if (!byKey.has(key)) byKey.set(key, obj);
    if (!sources.has(key)) sources.set(key, []);
    if (!sources.get(key).includes(source)) sources.get(key).push(source);
  };

  for (const o of request.ownObjects) add(o, 'request');
  for (const t of request.tasks) for (const o of t.objects) add(o, t.number);

  const objects = [...byKey.entries()].map(([key, obj]) => ({
    ...obj,
    // WHO put it there. The whole point of not flattening: an object that appears only
    // under a task is work that has not been merged into the request yet.
    sources: sources.get(key),
  }));
  objects.sort((a, b) => `${a.type}${a.name}`.localeCompare(`${b.type}${b.name}`));

  const systemUnion = request.systemUnion;
  return {
    objects,
    ownCount: request.ownObjects.length,
    taskCount: request.tasks.reduce((n, t) => n + t.objects.length, 0),
    unionCount: objects.length,
    systemUnion,
    // null when the resource did not offer one (the list never does), so "not checked"
    // never reads as "checked and agreed".
    unionMatchesSystem: systemUnion === null ? null : systemUnion === objects.length,
  };
}
