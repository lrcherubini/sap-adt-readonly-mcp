// A named GET route, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL, and what it deliberately is not.
//
// One question this server is supposed to answer has no client wrapper: "which
// annotation reached this element, and from where". `ddicElement().annotations` comes
// back EMPTY on every node and every path shape (measured -- docs/adt-api-reference.md
// line 107), and the resource that does answer it,
// `/sap/bc/adt/ddic/ddlx/annotation/chain{?entity,element,variant}`, is one of the
// collections abap-adt-api never wrapped. Reaching it needs raw HTTP.
//
// The obvious move -- unblock `httpClient` in lib/guard.mjs, or add an `adt_http(method,
// path, body)` tool -- is exactly the design this repository vetoed, and the veto is
// written into the guard's own header: httpClient hands back an AdtHTTP with a generic
// request(url, config), which makes the whole allowlist irrelevant in one line.
//
// So what opens here is a ROUTE, not a client:
//
//   * the method is not a parameter. There is no argument, anywhere in this module,
//     that can make the request anything but a GET, and no body can be attached;
//   * the URL is not a parameter either. It can only be assembled from the closed
//     TEMPLATES table below -- a template name that is not in the table throws before
//     any socket is opened, and so does a query parameter the template does not declare;
//   * one route MAY declare a single path segment, and that is the narrowest possible
//     version of it: the segment is not a string the caller supplies, it is a value drawn
//     from an ALPHABET declared next to the route (`segment.pattern`). A route that
//     declares no segment refuses one. This is the one addition to the rule above, made
//     on purpose in 2026-09-09 for /cts/transportrequests/<number>, where the number is a
//     path segment and there is no query form of the same question. It is a narrowing
//     against the alternative it replaced -- the library interpolates that number into
//     the path with NO validation at all (api/transports.js:121-127);
//   * `httpClient` STAYS in the guard's DENIED list. The property this server claims --
//     you cannot express a write, because no capability to express one is reachable --
//     is unchanged: adding a route means editing this table on purpose, with a reason,
//     under review.
//
// Widening this table is a security decision, not a refactor. Two rules for whoever
// does it next: the path must be MEASURED on this system in one of TWO authorities, and
// it must be a resource whose GET has no side effect -- an ADT "read" that creates a run,
// a worklist or a lock is a write with a GET verb, and belongs in the IDE. The first two are SAP
// standard (docs/security.md, "The Fiori launchpad -- 2026-10-02"); the third is the one
// exception that reaches a customer (Z) service, and it reaches its DESCRIPTION only
// (docs/security.md, "The $metadata of a service a Fiori app consumes -- 2026-11-09"):
//
//   adt       a collection of /sap/bc/adt/discovery (SAP publishes no endpoint reference;
//             discovery is the authority). Every route before 2026-10-02 is of this kind.
//   gateway   an entity set of an OData V2 service registered in the Gateway catalogue
//             (/IWFND/CATALOGSERVICE), under a root listed in ODATA_ROOTS. GET only: no
//             $batch, no function import -- a route names ONE entity set or ONE key of it.
//   metadata  the `$metadata` document of ONE OData V2 service under /sap/opu/odata/sap, and
//             nothing else of it: no entity set, no service document, no $batch. The route
//             must declare the service as its segment and `/$metadata` as its suffix, so no
//             argument can reach a row. It exists because the $metadata a Fiori app keeps in
//             its repository is a scaffold copy nobody refreshes and the app never loads --
//             the LIVE document is the only one that says whether the app's references hold.
//
// The authority is not a comment: assertRouteTable() runs at import and refuses a route
// whose path is under neither, so the table cannot drift past this rule.
//
// ⚠️ ONE ROUTE HERE READS TABLE ROWS, AND THAT IS A DECISION, NOT AN OVERSIGHT.
// `/sap/bc/adt/cts/transportrequests/<number>/objectkeys?objName=..&objType=..` returns
// the `E071K` key rows of a transported table entry -- `tk:value` is `TABKEY`,
// `tk:position` is `AS4POS` -- with a `tk:keyField` block whose offsets decompose the
// packed key into its fields. MEASURED 2026-09-09 over 151 GETs, cross-checked against an
// export of `E071K` from the same system.
//
// It was REFUSED first, on the frontier that keeps `tableContents` and `runQuery` in the
// guard's DENIED list ("about the repository, never about the contents of a table"), and
// the refusal was OVERRULED the same day by the repository owner, whose requirement is to
// read a transport in full with the concatenated key decoded. The override is sound for a
// reason worth keeping next to the route: `E071K` is a table OF THE CTS, not of the
// business. A key row is the transport's own record of WHICH rows it carries -- the same
// thing SE09 shows -- and reading it is not a SELECT on the business table it points at.
// It returns no field value that the transport was not already carrying. The full
// argument, both halves, is in docs/security.md, "objectkeys: measured, working, and
// refused -- 2026-09-09".
//
// What keeps it narrow is `suffix` plus the segment alphabet: the sub-resource name is a
// literal from this table and can never come from a caller, and the only caller-supplied
// part of the path must look like a transport number.

import { readFileSync } from 'node:fs';

/**
 * The closed table of reachable resources.
 *
 * `params` is the complete set of query parameters the template accepts; `required` is
 * the subset without which the call is meaningless. `shapeObserved: false` means the
 * reply of this resource has NEVER been seen on this system -- callers must present the
 * payload as measurement, never parse it into a conclusion.
 *
 * `segment: {name, pattern}` is optional and appends ONE path segment, whose value must
 * match `pattern`. Absent it, the route has no path segment and passing one is refused.
 *
 * ⚠️ `params: []` is a real declaration, not an oversight. See `transportList`: on this
 * release, sending ANY query parameter to that collection turns a 270 KB answer into an
 * empty one, with HTTP 200 and no hint. An empty `params` makes that mistake
 * inexpressible instead of documented.
 *
 * `segment.style: 'odataKey'` writes the segment as an OData key, `<set>('<value>')`, with
 * a quote doubled as OData escapes it. It is the only other shape a segment can take.
 */

const HTTP_ROUTES = JSON.parse(readFileSync(new URL('../data/defaults/http-routes.json', import.meta.url), 'utf8'));

/**
 * The OData V2 services a route may live under (authority `gateway`), from
 * data/defaults/http-routes.json -- SAP-standard services, the same everywhere. Each root was
 * read in the Gateway catalogue and its $metadata answered 200 before it was listed. Left out ON
 * PURPOSE, each for a measured reason:
 *   - /UI2/PAGE_BUILDER_PERS: the personalization of each user -- data of a person;
 *   - /UI2/FDM_SPACE_REPOSITORY_SRV (no _CUST): 403, not registered;
 *   - /UI2/FDM_PAGE_REPOSITORY_SRV: the same sets as _CUST, minus the client layer;
 *   - /UI2/INTEROP, /UI2/LAUNCHPAD, /UI2/FIORI_CATALOGS, /UI2/FDM_PAGE_RUNTIME_SRV: answer,
 *     but no route below needs them yet.
 * A root here is not a licence for its whole service: the route table still names each
 * entity set, and four sets of FDM_PAGE_REPOSITORY_CUST_SRV answer 501 (an exploratory probe
 * that read every set left entries in /IWFND/ERROR_LOG -- never again).
 */
export const ODATA_ROOTS = Object.freeze([...HTTP_ROUTES.odataRoots]);

/** Where an OData V2 service of the SAP namespace lives; `$metadata` of one service is read under it. */
export const ODATA_METADATA_ROOT = '/sap/opu/odata/sap';
/** The same for OData V4: the service group `sap`, then `<binding>/<srvd group>/sap/<srvd>/<nnnn>`. */
export const ODATA4_METADATA_ROOT = '/sap/opu/odata4/sap';
/**
 * The V4 service path as a manifest writes it, lower case: binding, service group (`srvd` or
 * `srvd_a2x`, the two measured in deployed manifests), the `sap` namespace, the service
 * definition, a four-digit version.
 * Every part is a closed alphabet, so the slashes between them are the only ones there can be.
 */
export const V4_SERVICE_PATH = /^([a-z][a-z0-9_]{0,39})\/(srvd|srvd_a2x)\/sap\/([a-z][a-z0-9_]{0,39})\/(\d{4})$/;

/** The roots of the full service paths a published binding names (MEASURED 2026-11-09). */
export const ODATA_SERVICE_ROOT = '/sap/opu/odata';
export const ODATA4_SERVICE_ROOT = '/sap/opu/odata4';
/**
 * A V2 service path as a binding publishes it: the namespace (`sap`, or an upper-case one such as
 * `DMO`), the service, and for a version above 1 the Gateway matrix parameter `;v=N`. Measured:
 * `sap/<S>;v=2` (three bindings) and `DMO/<S>` (two). The `;v=` travels literally (buildUrl).
 */
export const V2_SERVICE_PATH = /^(sap|[A-Z][A-Z0-9]{0,9})\/([A-Z][A-Z0-9_]{0,39})(;v=[1-9][0-9]{0,2})?$/;
/**
 * A V4 service path in any namespace: `<ns>/<binding>/<srvd group>/<ns>/<srvd>/<nnnn>`, the
 * namespace written twice and the same both times (back-reference). Measured:
 * `dmo/<binding>/srvd/dmo/<srvd>/0001` (one binding); `sap` is the form odataMetadataV4 reads.
 */
export const V4_FULL_SERVICE_PATH = /^([a-z][a-z0-9]{0,9})\/([a-z][a-z0-9_]{0,39})\/(srvd|srvd_a2x)\/\1\/([a-z][a-z0-9_]{0,39})\/(\d{4})$/;

/** Which of the two authorities a route path is under, or null. */
export function routeAuthority(path) {
  const p = String(path ?? '');
  if (/^\/sap\/bc\/adt\/[a-z0-9_/.-]+$/i.test(p)) return 'adt';
  // The V2 service root itself, exactly: the service and `/$metadata` are added by the route's
  // segment and suffix, which assertRouteTable() demands of every route under this authority.
  if ([ODATA_METADATA_ROOT, ODATA4_METADATA_ROOT, ODATA_SERVICE_ROOT, ODATA4_SERVICE_ROOT].includes(p)) return 'metadata';
  // An entity set name, one segment, directly under a listed root.
  if (ODATA_ROOTS.some((root) => p.startsWith(`${root}/`) && /^[A-Za-z][A-Za-z0-9_]*$/.test(p.slice(root.length + 1)))) {
    return 'gateway';
  }
  return null;
}

const AUTHORITY_TEXT = Object.freeze({
  adt: "this system's own discovery document",
  gateway: 'the Gateway catalogue of this system',
  metadata: 'the OData V2 service root of this system',
});

// OData V2 answers JSON only when asked: `$format=json` is part of every gateway route.
const ODATA_JSON = 'application/json';

// Ids measured in the launchpad content of a development system on 2026-10-02 (every catalogue
// page, group, space, page and role read by the probes): letters INCLUDING accented and
// non-Latin ones (an accented letter as in `Café`, a Cyrillic `С` in an SAP space), digits, `_ - / : .` and
// a zero-width space that two SAP ids really carry. No quote, no blank, no parenthesis,
// no `%`, `?`, `#` or `&` -- so the key can never close itself or start a query. And no
// `..`: the key travels percent-encoded inside the quotes, but whether every hop decodes
// %2F as a separator is not measured, so a dot-segment is refused rather than trusted.
const LAUNCHPAD_ID = /^(?!.*\.\.)[\p{L}\p{N}_\-/:.​]{1,120}$/u;

// A deployed UI5 app (a BSP application name, upper case as the filestore lists it) and,
// optionally, a path inside it. Measured names carry letters, digits, `_ - . @`; no blank, no
// `%`, no `..`, no empty part (`//`), at most eight levels deep.
const UI5_PATH = /^(?!.*\.\.)[A-Z0-9_]{1,30}(?:\/[A-Za-z0-9_.@-]{1,120}){0,8}$/;

export const TEMPLATES = new Map([
  [
    'annotationChain',
    {
      path: '/sap/bc/adt/ddic/ddlx/annotation/chain',
      params: ['entity', 'element', 'variant'],
      required: ['entity'],
      accept: 'application/xml, application/json;q=0.9, */*;q=0.1',
      // Measured on the development system, 2026-09-09: ZC_DemoInvMapTP/BaseUnit answered 200 with
      // 9,137 bytes of application/vnd.sap.adt.ddlx.annotation.chain.v2+xml, recorded
      // verbatim in docs/adt-api-reference.md and reproduced byte for byte as
      // tests/fixtures/annotation-chain-measured.xml. lib/annotation-chain.mjs parses
      // that shape; flipping this back to false is how a caller says the parser can no
      // longer be trusted, and the tool then hands back the raw payload again.
      shapeObserved: true,
      // docs/adt-api-reference.md:51 -- read out of this system's own discovery
      // document, not out of documentation.
      source: '/sap/bc/adt/discovery, collection "CDS annotation chain"',
      answers:
        'which annotation reached an element of a CDS entity, and which layer of the ' +
        'chain put it there',
    },
  ],
  [
    'transportList',
    {
      path: '/sap/bc/adt/cts/transportrequests',
      // MEASURED on the development system, 2026-09-09, and this empty list is the whole point.
      //
      // Three requests were sent to this exact collection. `?user=X&targets=true` and
      // `?targets=true` both answered HTTP 200 with 297 bytes -- a self-closed <tm:root/>,
      // zero requests, for a user who owns six. The BARE url answered 270,138 bytes: 6
      // requests, 14 tasks, 672 objects. A query parameter does not filter this
      // collection, it SILENCES it, and it does so without an error.
      //
      // So the safety property here is not documentation, it is arithmetic: with no
      // declared parameter, buildUrl has nothing to append and the silent-empty answer
      // cannot be requested. The client library's userTransports always sends
      // `?user=&targets=` (api/transports.js:128), which is one of the three independent
      // reasons it is not in the guard's allowlist.
      params: [],
      required: [],
      // Also measured: the collection ADVERTISES `...transportorganizer.v1+xml` in this
      // system's own discovery document, and then answers 406 to it, naming
      // `...transportorganizertree.v1+xml` instead. The service document is the authority
      // on WHICH collections exist, not on how to talk to them.
      accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "CTS Transport Requests"',
      answers:
        'which transport requests were released in the last two weeks, with their tasks ' +
        'and the objects in each -- the scope is fixed by the server and cannot be widened',
    },
  ],
  [
    'transportDetail',
    {
      path: '/sap/bc/adt/cts/transportrequests',
      // The number is a PATH SEGMENT: there is no query form of this question. The
      // pattern is the SAP transport-request format (system id, K, six digits) and it is
      // the reason this route is safe to have -- `..`, `/`, `%2f` and a second segment
      // are all outside the alphabet, so no argument can turn this into another resource.
      segment: { name: 'number', pattern: /^[A-Z][A-Z0-9]{2}K[0-9]{6}$/ },
      params: [],
      required: [],
      // MEASURED 2026-09-09: HTTP 200 on all six requests read (workbench and customizing,
      // modifiable and released, plus two transports of copies), 19,377 - 102,328 bytes.
      // Note this resource accepts the type the LIST resource rejects: one `accept` on a
      // collection does not describe its members.
      accept: 'application/vnd.sap.adt.transportorganizer.v1+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "CTS Transport Requests"',
      answers:
        'which objects one transport request carries, split by task -- including the ' +
        'tasks that are still open, whose content has not been merged into the request yet',
    },
  ],
  [
    'transportObjectKeys',
    {
      path: '/sap/bc/adt/cts/transportrequests',
      segment: { name: 'number', pattern: /^[A-Z][A-Z0-9]{2}K[0-9]{6}$/ },
      suffix: '/objectkeys',
      // Both are required: the resource answers 400 `I::000` to any other parameterisation,
      // and an earlier round read that six-byte body as "the resource does not exist".
      params: ['objName', 'objType'],
      required: ['objName', 'objType'],
      // MEASURED 2026-09-09 over 151 GETs, cross-checked against an export of E071K. The
      // server publishes the link to this resource itself, from
      // `…/reference?…&tr_number=…`; it accepts exactly this one media type, enumerated
      // from its own 406.
      accept: 'application/vnd.sap.adt.transportorganizer.objectkeys.v1+xml',
      shapeObserved: true,
      source: 'atom:link rel="http://www.sap.com/cts/relations/objectkeys" on the reference resource',
      answers:
        'WHICH ROWS of a configuration table a transport carries -- the E071K key rows of ' +
        'one object, with the DDIC key layout needed to decompose the packed key. Address ' +
        'the CARRIER that owns the object (the task, not its parent request) and name the ' +
        'object exactly as tm:abap_object does.',
    },
  ],
  [
    'quickSearch',
    {
      path: '/sap/bc/adt/repository/informationsystem/search',
      // MEASURED 2026-09-12, fourteen facets x four readings (docs/adt-api-reference.md,
      // "Quick search facets"). The client library's searchObject STRIPS the facet before
      // the request leaves (`objType.replace(/\/.*$/, '')`), and for FUGR/FF that turns a
      // hit into an empty list. This route sends the facet whole. The price, also
      // measured: a reply filtered by a facet carries NO adtcore:description (the same
      // hit answers 285 bytes here against 341 with the major type -- the difference is
      // the description attribute). So this is the SECOND ask, after the library's, not a
      // replacement for it.
      fixed: { operation: 'quickSearch' },
      params: ['query', 'objectType', 'maxResults'],
      required: ['query', 'objectType'],
      validate: {
        // A facet is <major>/<sub>, uppercase, or a bare major (CDBO). Nothing else is a
        // facet, and nothing else reaches the query string.
        objectType: /^[A-Z0-9]{2,5}(\/[A-Z0-9]{1,4})?$/,
        maxResults: /^[1-9][0-9]{0,2}$/,
        // The name, or the name with a trailing wildcard. Leading wildcards are refused
        // here on purpose: this route resolves a NAME the library could not, it does not
        // enumerate (that stays adt_search, with its cap and its descriptions).
        query: /^[A-Z0-9_/]{1,40}\*?$/i,
      },
      accept: 'application/xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "Repository Information System search"',
      answers:
        'whether an object of a given FACET exists under a given name -- the one form of ' +
        'the quick search the client library cannot ask, because it strips the facet',
    },
  ],
  [
    'objectProperties',
    {
      path: '/sap/bc/adt/repository/informationsystem/objectproperties/values',
      // MEASURED 2026-09-14 (measurement, step 1c), 3 of 3 class/interface enhancements
      // (ENHO/XH): 200 with ~2.8 KB of the objproperties result type -- package chain
      // root-first, owner, API state, language, version, creation date. It is the ONE
      // resource that answers for that type without touching the enhoxh persistence
      // (which dumps the server; docs/adt-api-reference.md, "ENHO/XH"). The 406 names
      // exactly one Accept, and it is not the objectproperties.v1 one the name suggests.
      params: ['uri'],
      required: ['uri'],
      validate: {
        // An ADT object URI and nothing else: absolute under /sap/bc/adt, lowercase
        // segments, no query, no fragment, no dot-segments. `%2f` stays allowed because a
        // namespaced name is written that way inside a segment (measured).
        uri: /^\/sap\/bc\/adt(?:\/(?!\.\.?(?:\/|$))[a-z0-9_%.~-]{1,120}){2,8}$/i,
      },
      accept: 'application/vnd.sap.adt.repository.objproperties.result.v1+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "Repository Information System object properties"',
      answers:
        'the repository properties of ONE object by its URI -- package chain, owner, API ' +
        'state, creation date -- the only read a class enhancement (ENHO/XH) survives',
    },
  ],
  [
    'feedCatalog',
    {
      path: '/sap/bc/adt/feeds',
      // MEASURED 2026-09-12: 200, 23.6 KB, seven feeds, each with its
      // href, attributes, operators, paging and query variants. The catalogue is the ONLY
      // place that names the dump and gateway feeds -- neither is a discovery collection --
      // so the two routes below carry hrefs read from this document, never assembled.
      params: [],
      required: [],
      accept: 'application/atom+xml;type=feed',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "Feed Repository"',
      answers:
        'which monitoring feeds this system offers (runtime errors, gateway log, ATC ' +
        'findings, ...), and for each the attributes a query may filter on',
    },
  ],
  [
    'runtimeDumps',
    {
      path: '/sap/bc/adt/runtime/dumps',
      // MEASURED 2026-09-12: 200, 620 KB for 35 entries; `$top`/`$skip`
      // page, `maxResults` is ignored, and the OData-looking `$query=user eq 'X'` is 400.
      // `$query` is the catalogue's own prefix grammar -- `and ( equals ( user , X ) )` --
      // GENERATED by lib/runtime-feeds.mjs from structured filters; the regex here is the
      // second fence: only the measured attribute ids, only the catalogue's operators,
      // values from a closed alphabet, and nothing that is not a clause.
      // ⚠️ At most TWO clauses, and only in the COMMA form `and ( c1 , c2 )`. Round 15
      // (step 1f) sent two clauses side by side and the server DUMPED (ASSERTION_FAILED in
      // CL_ADT_FQL_QUERY, 500) -- a dump this client caused. Round 17 (step 1,
      // 2026-09-14) proved the comma form FILTERS: user alone 33 entries, user + notContains
      // objectName 9, user + datetime >= today 6, no dump. The catalogue's queryDepth is 2,
      // so the regex admits one optional ` , clause` and MAX_CLAUSES = 2 there.
      params: ['$query', '$top', '$skip'],
      required: [],
      validate: {
        $query:
          /^and \( (?:(?:equals|notEquals|contains|notContains|greater|greaterOrEquals|less|lessOrEquals) \( (?:package|packageHierarchy|packageResponsible|objectResponsible|responsible|objectName|component|user|runtimeError|exception|datetime) , [A-Za-z0-9_/.:*+-]{1,60} \))(?: , (?:(?:equals|notEquals|contains|notContains|greater|greaterOrEquals|less|lessOrEquals) \( (?:package|packageHierarchy|packageResponsible|objectResponsible|responsible|objectName|component|user|runtimeError|exception|datetime) , [A-Za-z0-9_/.:*+-]{1,60} \)))? \)$/,
        $top: /^[1-9][0-9]{0,2}$/,
        $skip: /^[0-9]{1,5}$/,
      },
      accept: 'application/atom+xml;type=feed',
      shapeObserved: true,
      source: 'atom:link rel="alternate" of the "ABAP Runtime Errors" entry of /sap/bc/adt/feeds',
      answers:
        'which ABAP runtime errors (ST22 dumps) the system holds, each with the dump ' +
        'report in the entry: header, analysis, source extract and call stack',
    },
  ],
  [
    'gatewayErrors',
    {
      path: '/sap/bc/adt/gw/errorlog',
      // MEASURED 2026-09-12: 200 with the feed type (the 406 names only
      // it), 264 bytes and ZERO entries for the user -- the entry shape is unmeasured, and
      // the parser says so. Same generated `$query`, the gateway attribute ids.
      params: ['$query', '$top', '$skip'],
      required: [],
      validate: {
        $query:
          /^and \( (?:(?:equals|notEquals|contains|notContains|greater|greaterOrEquals|less|lessOrEquals) \( (?:username|namespace|service_name|t100_msgid|t100_msgno|error_component|error_package|remote_address|request_uri|request_id|opid|transaction_id|timestamp) , [A-Za-z0-9_/.:*+-]{1,60} \))(?: , (?:(?:equals|notEquals|contains|notContains|greater|greaterOrEquals|less|lessOrEquals) \( (?:username|namespace|service_name|t100_msgid|t100_msgno|error_component|error_package|remote_address|request_uri|request_id|opid|transaction_id|timestamp) , [A-Za-z0-9_/.:*+-]{1,60} \)))? \)$/,
        $top: /^[1-9][0-9]{0,2}$/,
        $skip: /^[0-9]{1,5}$/,
      },
      accept: 'application/atom+xml;type=feed',
      shapeObserved: false,
      source: 'atom:link rel="alternate" of the "SAP Gateway Error Log" entry of /sap/bc/adt/feeds',
      answers:
        'which OData gateway errors the system logged (/IWFND/ERROR_LOG) -- the envelope ' +
        'is measured, the entries are not yet',
    },
  ],
  [
    'atcVerdicts',
    {
      path: '/sap/bc/adt/atc/feeds/verdicts',
      // MEASURED 2026-09-12: 200 with the feed type; without `$query` an
      // empty envelope (244 bytes) although the catalogue says the query is obligatory; a
      // `$query` on an attribute the feed does not list is 400 "Data is invalid". No entry
      // was read yet, so the entry shape is unmeasured and the parser says so. The five
      // attribute ids are the catalogue's.
      params: ['$query', '$top', '$skip'],
      required: [],
      validate: {
        $query:
          /^and \( (?:(?:equals|notEquals|contains|notContains|greater|greaterOrEquals|less|lessOrEquals) \( (?:priority|applicationComponent|objectName|package|contactPerson) , [A-Za-z0-9_/.:*+-]{1,60} \))(?: , (?:(?:equals|notEquals|contains|notContains|greater|greaterOrEquals|less|lessOrEquals) \( (?:priority|applicationComponent|objectName|package|contactPerson) , [A-Za-z0-9_/.:*+-]{1,60} \)))? \)$/,
        $top: /^[1-9][0-9]{0,2}$/,
        $skip: /^[0-9]{1,5}$/,
      },
      accept: 'application/atom+xml;type=feed',
      shapeObserved: false,
      source: 'atom:link rel="alternate" of the "ATC Findings" entry of /sap/bc/adt/feeds',
      answers:
        'which ATC findings the system holds for a package, an object or a contact person -- ' +
        'the envelope is measured, the entries are not yet',
    },
  ],
  [
    'atcCustomizing',
    {
      path: '/sap/bc/adt/atc/customizing',
      // MEASURED 2026-09-12 and 2026-09-14 (measurement, step 4a): 200, 2.3 KB of the
      // customizing type -- systemCheckVariant, ciCheckFlavour, exemption reasons and
      // validities, scaAttributes. The system's own check variant is read here, never
      // assumed.
      params: [],
      required: [],
      accept: 'application/vnd.sap.atc.customizing-v1+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "ATC customizing"',
      answers: 'which check variant the system runs by default and which exemption reasons it accepts',
    },
  ],
  [
    'atcCheckVariant',
    {
      path: '/sap/bc/adt/atc/checkvariants',
      // A variant created in the ADT (repository object CHKV), lower case as the IDE sends it.
      // MEASURED 2026-11-09 on 18 variants: 200, 1.9-30 KB, the checks and their JSON parameters.
      // A variant created in transaction SCI answers 404: SAP documents that the ADT cannot
      // display it (docs/adt-api-reference.md, "Check variants, broad round"). Only the variant
      // itself: its 300 KB form template is the catalogue of every check, not this variant.
      segment: { name: 'name', pattern: /^[a-z0-9_]{1,30}$/ },
      params: [],
      required: [],
      accept: 'application/vnd.sap.adt.chkvv4+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "Check Variant"',
      answers: 'which ATC checks a check variant created in the ADT contains, with their parameter values',
    },
  ],
  [
    'atcWorklist',
    {
      path: '/sap/bc/adt/atc/worklists',
      // The id is the 32-hex-character token the server hands out when a worklist is
      // created (lib/atc.mjs, the POST): nothing else is a resource under this path.
      segment: { name: 'id', pattern: /^[0-9A-F]{32}$/ },
      params: ['includeExemptedFindings'],
      required: [],
      validate: { includeExemptedFindings: /^(?:true|false)$/ },
      // MEASURED 2026-09-14 (measurement, steps 4d-4f, three worklists): 200, 8-20 KB of
      // application/atc.worklist.v1+xml -- the 406 names only that type, and no Accept
      // answers the same body. Objects, findings with priority/check/message/location.
      accept: 'application/atc.worklist.v1+xml',
      shapeObserved: true,
      source: 'the id answered by POST /sap/bc/adt/atc/worklists?checkVariant=',
      answers: 'the findings of one ATC run: object, priority, check, message, source position',
    },
  ],
  // The two halves of the same resource. They are separate templates and not one route with a
  // caller-chosen collection, because the collection IS the resource identity: `/ddic/tables` and
  // `/ddic/structures` are different resources, and letting a caller pick between them is letting
  // a caller assemble a path -- which is the whole thing this table refuses.
  //
  // WHY THIS WIDENING WAS MADE, against the header's own rule that widening is a security
  // decision. The question it answers has no other route: WHICH append reaches an object. An
  // append is invisible in the base source by design, and `ddicElement` -- the one view that does
  // see append FIELDS -- marks them with anonymous `.append` separators and answers an empty tree
  // for any `TABL/DS`. So for a STRUCTURE there was no route at all: `KOMG` includes `KOMPAZ`,
  // and it is `KOMPAZ` that carries `ZDEMO_KOMPAZ` (`ZZDEMOFLD`), which no read could reach.
  //
  // It meets both rules the header sets for a new route:
  //   * GET with no side effect -- it creates no run, no worklist and no lock; it enumerates
  //     objects that already exist;
  //   * the path is not invented. The server publishes it itself, as an atom:link with
  //     rel="http://www.sap.com/adt/relations/enhancements" on the object's own objectStructure.
  //     Same provenance as `transportObjectKeys`, which is the precedent for a `source` that is a
  //     published link rather than a discovery collection.
  //
  // MEASURED 2026-09-22 on the development system, 7 objects (docs/adt-api-reference.md, "enhancement/elements --
  // the resource that NAMES the appends"): 200 on 5, 369-1272 ms, 1.0-2.6 KB. It NAMES each append
  // and lists no field, so it composes with `ddicElement` instead of replacing it. The negative
  // controls publish no link at all -- and both are #NOT_EXTENSIBLE, so absence of the link is NOT
  // proof of absence of an append, and a caller must not report it as one.
  //
  // ⚠️ The 406 of this resource does NOT enumerate the acceptable types -- it answers the bare
  // string "The message content is not acceptable". The accept below is the `type` attribute of
  // the published link, which is the only way to learn it.
  [
    'tableEnhancements',
    {
      path: '/sap/bc/adt/ddic/tables',
      // Same alphabet as the namespaced ENHO URIs. A namespaced SUBJECT was read through this
      // resource on 2026-11-09 (docs/adt-api-reference.md, "A namespaced SUBJECT answers through
      // the %2f form"): a namespaced table and five namespaced structures, all answered.
      segment: { name: 'name', pattern: /^(?:%2f[a-z0-9_]{1,10}%2f)?[a-z0-9_]{1,30}$/i, keepEncodedSlash: true },
      suffix: '/enhancement/elements',
      params: [],
      required: [],
      accept: 'application/vnd.sap.adt.elementinfo+xml',
      shapeObserved: true,
      source: 'atom:link rel="http://www.sap.com/adt/relations/enhancements" of the table',
      answers: 'which append structures extend one table, by name -- never their fields',
    },
  ],
  [
    'structureEnhancements',
    {
      path: '/sap/bc/adt/ddic/structures',
      segment: { name: 'name', pattern: /^(?:%2f[a-z0-9_]{1,10}%2f)?[a-z0-9_]{1,30}$/i, keepEncodedSlash: true },
      suffix: '/enhancement/elements',
      params: [],
      required: [],
      accept: 'application/vnd.sap.adt.elementinfo+xml',
      shapeObserved: true,
      source: 'atom:link rel="http://www.sap.com/adt/relations/enhancements" of the structure',
      answers:
        'which append structures extend one structure, by name -- the only route to this for a ' +
        'TABL/DS, whose ddicElement tree is always empty',
    },
  ],

  // ---- Fiori launchpad: OData V2, authority `gateway` (docs/security.md, 2026-10-02) ----
  //
  // Every query below is the one MEASURED on the development system between 2026-10-01 and 2026-10-02
  // (probe launchpad rounds 1-5, transcripts outside git). `$select`/`$expand` are FIXED by
  // the route: a property that does not exist is a 404 that lands in /IWFND/ERROR_LOG
  // (`$select=layoutId` did), so a caller never composes one.
  [
    'flpCatalogsConf',
    {
      path: '/sap/opu/odata/UI2/PAGE_BUILDER_CONF/Catalogs',
      // The cross-client layer: what is a repository object (UIAC, with TADIR and package).
      // Measured: a few thousand catalogues come to megabytes without $select; the properties
      // are those of the measured entries.
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,type,domainId,remoteId,title,scope,systemAlias,chipCount,isReadOnly,originalLanguage,outdated' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/PAGE_BUILDER_CONF, entity set Catalogs',
      answers: 'which launchpad catalogues exist at the cross-client (configuration) layer',
    },
  ],
  [
    'flpCatalogsCust',
    {
      path: '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Catalogs',
      // The client view: configuration merged with what the client created or changed. The
      // client layer is `scope = CUSTOMIZING` (measured: about a third of the entries).
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,type,domainId,remoteId,title,scope,systemAlias,chipCount,isReadOnly,originalLanguage,outdated' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/PAGE_BUILDER_CUST, entity set Catalogs',
      answers: 'which launchpad catalogues the client sees, each with its layer (scope)',
    },
  ],
  [
    'flpGroups',
    {
      path: '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Pages',
      // A group is a page of the catalogue /UI2/FLPD_CATALOG. Measured: thousands of groups with
      // this filter; the 404 of round 1 was `$select=layoutId`, never the filter.
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,title,catalogId,scope', $filter: "catalogId eq '/UI2/FLPD_CATALOG'" },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/PAGE_BUILDER_CUST, entity set Pages',
      answers: 'which launchpad groups exist, each with its layer (scope)',
    },
  ],
  [
    'flpPage',
    {
      path: '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Pages',
      // One catalogue page (`X-SAP-UI2-CATALOGPAGE:<id>`) or one group, with its chip
      // instances and the chip behind each: tiles (/UI2/STATIC_APPLAUNCHER) and target
      // mappings (/UI2/ACTION) carry their content in `configuration`. Measured on
      // ZCT_DEMO_23, ZDEMO_CAT and ZDEMO_STOCK; no field of a person in the payload.
      // ⚠️ A key with `/` (catalogues /UI2/...) or an accent travels percent-encoded; `:`
      // was measured that way, `/` and the accent were not yet.
      segment: { name: 'id', pattern: LAUNCHPAD_ID, style: 'odataKey' },
      params: [],
      required: [],
      fixed: { $format: 'json', $expand: 'PageChipInstances/Chip,PageChipInstances/ChipInstanceBags/ChipInstanceProperties' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/PAGE_BUILDER_CUST, entity set Pages, one key',
      answers: 'what one launchpad catalogue or group holds: its tiles and target mappings',
    },
  ],
  [
    'fdmSpaces',
    {
      path: '/sap/opu/odata/UI2/FDM_SPACE_REPOSITORY_CUST_SRV/spacesMasterSet',
      // Measured: 263 spaces, 129 KB, whole list in one answer. No createdBy/modifiedBy and
      // no *Fullname: those are persons, and $select keeps them out.
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,title,description' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/FDM_SPACE_REPOSITORY_CUST_SRV, entity set spacesMasterSet',
      answers: 'which launchpad spaces exist',
    },
  ],
  [
    'fdmSpace',
    {
      path: '/sap/opu/odata/UI2/FDM_SPACE_REPOSITORY_CUST_SRV/spaceSet',
      segment: { name: 'id', pattern: LAUNCHPAD_ID, style: 'odataKey' },
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,title,description,sortPriority,numberOfPages,numberOfRoles,masterLanguage,pages', $expand: 'pages' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/FDM_SPACE_REPOSITORY_CUST_SRV, entity set spaceSet, one key',
      answers: 'which pages one launchpad space holds, in order',
    },
  ],
  [
    'fdmPages',
    {
      path: '/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/pagesMasterSet',
      // ⚠️ MEASURED: the WHOLE list dies in Node with "Header overflow" -- the server sends a
      // `sap-message` header of 63 KB, past the 16 KB Node accepts. Pages of 50 stay under
      // 11.5 KB (measurement, 9 pages, 408 entries). So $top is required and capped at 50.
      params: ['$top', '$skip'],
      required: ['$top'],
      validate: { $top: /^(?:[1-9]|[1-4][0-9]|50)$/, $skip: /^[0-9]{1,5}$/ },
      fixed: { $format: 'json', $select: 'id,title,description' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/FDM_PAGE_REPOSITORY_CUST_SRV, entity set pagesMasterSet',
      answers: 'which launchpad pages exist, 50 at a time',
    },
  ],
  [
    'fdmPage',
    {
      path: '/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/pageSet',
      // Measured on SAP_BASIS_PG_UI_FLP: sections with their visualizations, the spaces that
      // hold the page and the roles that reach it. `transportId` and `devclass` are of the
      // object, not of a person.
      segment: { name: 'id', pattern: LAUNCHPAD_ID, style: 'odataKey' },
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,title,description,devclass,masterLanguage,transportId,sections,roles,spaces', $expand: 'sections/viz,roles,spaces' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/FDM_PAGE_REPOSITORY_CUST_SRV, entity set pageSet, one key',
      answers: 'what one launchpad page shows, and which spaces and roles reach it',
    },
  ],
  [
    'fdmRoleCatalogs',
    {
      path: '/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/roleSet',
      // Measured on ZS:DEMO.ROLE_C and Z_DEMO_ACCOUNTANT. The role list of this
      // set answers EMPTY (20 bytes): only the keyed read is useful.
      segment: { name: 'role', pattern: /^(?!.*\.\.)[A-Z0-9_:./-]{1,30}$/, style: 'odataKey' },
      suffix: '/catalogs',
      params: [],
      required: [],
      fixed: { $format: 'json', $select: 'id,displayId,title' },
      accept: ODATA_JSON,
      shapeObserved: true,
      source: 'the Gateway catalogue: /UI2/FDM_PAGE_REPOSITORY_CUST_SRV, entity set roleSet, navigation catalogs',
      answers: 'which launchpad catalogues one PFCG role grants, as the launchpad resolves them',
    },
  ],

  // ---- The UI5 repository and the service a Fiori app consumes (2026-11-09) ----
  //
  // Measured on the development system on 2026-11-09 (two probes, 49 GETs, transcripts outside git;
  // docs/adt-api-reference.md, "The UI5 repository over the ADT"). The repository is the
  // filestore collection `/sap/bc/adt/filestore/ui5-bsp/objects` of the discovery document.
  //
  // ⚠️ THE PATH INSIDE AN APP IS ONE SEGMENT, with its slashes percent-encoded:
  // `objects/<APP>%2Fcontroller%2FMain.controller.js/content` answers 200, the same path with
  // literal slashes answers a bare 404 (no ADT message: the route does not exist). That is why
  // the segment alphabet admits `/` here and nowhere else -- buildUrl encodes it, so it can
  // never become a second path segment -- while `..` stays refused.
  //
  // Not routed, each measured: the WHOLE list (2,863 apps, 1.4 MB; `name`, `query` and
  // `maxResults` are all ignored, so a caller names its apps); `appindex/<APP>` (405);
  // `deploy-storage` (the same 1.4 MB list); a namespaced app (`/NS/APP`, listed but never read).
  [
    'ui5Folder',
    {
      path: '/sap/bc/adt/filestore/ui5-bsp/objects',
      segment: { name: 'path', pattern: UI5_PATH },
      suffix: '/content',
      params: [],
      required: [],
      accept: 'application/atom+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "SAPUI5 Filestore based on BSP"',
      answers:
        'which files and folders one folder of a deployed UI5 app holds (an Atom feed: ' +
        '`atom:category term="file|folder"`, an etag per file)',
    },
  ],
  [
    'ui5File',
    {
      path: '/sap/bc/adt/filestore/ui5-bsp/objects',
      segment: { name: 'path', pattern: UI5_PATH },
      suffix: '/content',
      params: [],
      required: [],
      // Measured: the content type of the reply follows the file (application/json for the
      // manifest, text/xml, application/x-javascript, application/octet-stream).
      accept: 'application/octet-stream',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "SAPUI5 Filestore based on BSP"',
      answers: 'the content of one file of a deployed UI5 app, as the system serves it',
    },
  ],
  [
    'odataMetadata',
    {
      path: ODATA_METADATA_ROOT,
      // The service name of an OData V2 data source as a manifest writes it
      // (`/sap/opu/odata/sap/<SERVICE>/`). No `;v=`, no `;o=`: neither form is measured.
      segment: { name: 'service', pattern: /^[A-Z][A-Z0-9_]{0,39}$/ },
      suffix: '/$metadata',
      params: [],
      required: [],
      accept: 'application/xml',
      shapeObserved: true,
      source: 'the OData V2 service a Fiori app names in its manifest (sap.app.dataSources)',
      answers:
        'what the service a Fiori app consumes publishes TODAY: entity sets, entity types with ' +
        'their properties and navigations, function imports with their parameters -- metadata, never a row',
    },
  ],
  [
    'odataMetadataV4',
    {
      path: ODATA4_METADATA_ROOT,
      // `<binding>/<srvd group>/sap/<srvd>/<nnnn>`, lower case, as a V4 manifest writes it.
      segment: { name: 'service', pattern: V4_SERVICE_PATH, style: 'pathParts' },
      suffix: '/$metadata',
      params: [],
      required: [],
      accept: 'application/xml',
      // MEASURED 2026-11-09 on three deployed V4 apps (srvd and srvd_a2x): 200, 14-211 KB of
      // application/xml, `edmx Version="4.0"`, one service Schema aliased `SAP__self`
      // (docs/adt-api-reference.md). lib/ui5-repository.mjs parses that shape.
      shapeObserved: true,
      source: 'the OData V4 service a Fiori app names in its manifest (sap.app.dataSources)',
      answers:
        'what the V4 service a Fiori app consumes publishes TODAY: entity sets, entity types, ' +
        'actions and functions with their parameters -- metadata, never a row',
    },
  ],
  // The $metadata of the full service path a published binding names: a V2 service in any
  // namespace or at a version above 1, a V4 service in any namespace. MEASURED 2026-11-09: six
  // reads, all 200 application/xml, 37-189 KB, edmx 1.0 (V2) and 4.0 (V4), no Gateway error-log
  // row. Same decision as odataMetadata / odataMetadataV4 (docs/security.md).
  [
    'odataMetadataV2Path',
    {
      path: ODATA_SERVICE_ROOT,
      segment: { name: 'service', pattern: V2_SERVICE_PATH, style: 'pathParts' },
      suffix: '/$metadata',
      params: [],
      required: [],
      accept: 'application/xml',
      shapeObserved: true,
      source: 'the serviceUrl a published OData V2 binding version names, or a manifest data source of that form',
      answers:
        'what a V2 service in another namespace, or at a version above 1, publishes TODAY -- ' +
        'metadata, never a row',
    },
  ],
  [
    'odataMetadataV4Path',
    {
      path: ODATA4_SERVICE_ROOT,
      segment: { name: 'service', pattern: V4_FULL_SERVICE_PATH, style: 'pathParts' },
      suffix: '/$metadata',
      params: [],
      required: [],
      accept: 'application/xml',
      shapeObserved: true,
      source: 'the serviceUrl a published OData V4 binding version names, or a manifest data source of that form',
      answers: 'what a V4 service in another namespace publishes TODAY -- metadata, never a row',
    },
  ],
  // A service binding and the detail of one of its service versions (docs/adt-api-reference.md,
  // the "Service bindings" sections, MEASURED 2026-11-09 on 388 bindings; decision in
  // docs/security.md). lib/service-binding.mjs parses both replies.
  [
    'serviceBinding',
    {
      path: '/sap/bc/adt/businessservices/bindings',
      // The binding name as the ADT writes it inside a segment, lower case, namespace as `%2f`
      // (measured on three /DMO/ bindings). lib/enhancement-elements.mjs segmentFor builds it.
      segment: { name: 'binding', pattern: /^(?:%2f[a-z0-9_]{1,10}%2f)?[a-z0-9_]{1,30}$/i, keepEncodedSlash: true },
      params: [],
      required: [],
      // The only representation: servicebinding.v1+xml answered 406 on all nine of the broad round.
      accept: 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml',
      shapeObserved: true,
      source: '/sap/bc/adt/discovery, collection "Service Binding"',
      answers:
        'what a service binding is: OData V2/V4 or SQL, UI or Web API, its contract, and each ' +
        'service version with its release state and service definition',
    },
  ],
  ...['V2', 'V4'].map((kind) => [
    `serviceBindingDetail${kind}`,
    {
      path: `/sap/bc/adt/businessservices/odata${kind.toLowerCase()}`,
      // `{objectname}` in the discovery template: the binding, in UPPER case, a namespace as `%2F`
      // (encodeURIComponent of `/NS/NAME`), as the IDE sends it. The path IS read and its case
      // matters: the same binding in lower case answered 200 with the not-found row
      // (`created="false"`, `published="false"`, no URL) for a published version (MEASURED
      // 2026-11-09, ten versions). A slash is admitted only as the namespace wrapper, and it
      // travels encoded, so it can never become a second segment.
      segment: { name: 'binding', pattern: /^(?:\/[A-Z0-9_]{1,10}\/)?[A-Z0-9_]{1,30}$/ },
      params: ['servicename', 'serviceversion', 'srvdname'],
      required: ['servicename', 'serviceversion', 'srvdname'],
      validate: {
        // Read from the binding document, never typed: mixed case is measured (`ABOPRun`).
        servicename: /^(?:\/[A-Za-z0-9_]{1,10}\/)?[A-Za-z0-9_]{1,40}$/,
        serviceversion: /^\d{4}$/,
        srvdname: /^(?:\/[A-Za-z0-9_]{1,10}\/)?[A-Za-z0-9_]{1,30}$/,
      },
      // The IDE's own list ("Fetch binding type information"); the server picks odatav2.v2 and
      // odatav4.v1. ~750 such reads wrote no row to the Gateway error log (measured).
      accept: [1, 2, 3].map((n) => `application/vnd.sap.adt.businessservices.odata${kind.toLowerCase()}.v${n}+xml`).join(', '),
      shapeObserved: true,
      source: `/sap/bc/adt/discovery, collection "OData ${kind}", template {objectname}{?servicename,serviceversion,srvdname}`,
      answers:
        `whether one version of an OData ${kind} binding is published, its service URL, and the ` +
        'entity sets with their navigations it exposes -- read without calling the service. ' +
        'A 200 alone proves nothing: a version the binding does not hold also answers 200',
    },
  ]),
]);

/**
 * Refuse, at import, a route whose path is under neither authority, a gateway
 * route without `$format=json`, and a route with an unknown segment style. The table is
 * code: this is what keeps it from drifting past the rule written in the header.
 */
export function assertRouteTable(table = TEMPLATES) {
  for (const [name, spec] of table) {
    const authority = routeAuthority(spec.path);
    if (!authority) throw new Error(`route '${name}': '${spec.path}' is under no authority of this server.`);
    if (authority === 'gateway' && spec.fixed?.$format !== 'json') {
      throw new Error(`route '${name}': a gateway route fixes $format=json.`);
    }
    if (spec.segment?.style && spec.segment.style !== 'odataKey' && spec.segment.style !== 'pathParts') {
      throw new Error(`route '${name}': unknown segment style '${spec.segment.style}'.`);
    }
    if (spec.segment?.style === 'pathParts' && authority !== 'metadata') {
      throw new Error(`route '${name}': a multi-part segment belongs to a metadata route.`);
    }
    if (spec.segment?.style === 'odataKey' && authority !== 'gateway') {
      throw new Error(`route '${name}': an OData key belongs to a gateway route.`);
    }
    if (authority === 'metadata' && (!spec.segment || spec.suffix !== '/$metadata' || spec.params.length || spec.fixed)) {
      throw new Error(`route '${name}': a metadata route names one service and reads its /$metadata, nothing else.`);
    }
  }
  return true;
}
assertRouteTable();

export class RouteViolation extends Error {
  constructor(message) {
    super(`Blocked: ${message}`);
    this.name = 'RouteViolation';
  }
}

/** Template names a caller may use, for error messages and for the tool description. */
export const routeNames = () => [...TEMPLATES.keys()].sort();

/**
 * Assemble the URL of a named route.
 *
 * Every rejection here happens BEFORE any network call, and each one is a case that a
 * free-form `adt_http` would have allowed:
 *
 *   unknown template  -> an arbitrary path
 *   unknown parameter -> smuggling `sap-client`, a second path segment, or a method
 *   empty value       -> a query the resource reads as "all", which for some ADT
 *                        collections is a full scan of the repository
 *   bad segment       -> `..`, `/`, `%2f` or a second segment under a route that does
 *                        declare one; and any segment at all under a route that does not
 */
export function buildUrl(template, params = {}) {
  const spec = TEMPLATES.get(String(template));
  if (!spec) {
    throw new RouteViolation(
      `'${template}' is not a named route. This server has no generic HTTP tool; the ` +
        `only reachable routes are: ${routeNames().join(', ')}.`
    );
  }

  // The single optional path segment. It is resolved BEFORE the query parameters,
  // because a wrong segment is a different RESOURCE, while a wrong query parameter is
  // only a different question about the same one.
  const seg = spec.segment;
  let path = spec.path;
  if (seg) {
    const raw = params[seg.name];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      throw new RouteViolation(`route '${template}' requires the '${seg.name}' path segment.`);
    }
    const value = String(raw).trim();
    if (!seg.pattern.test(value)) {
      throw new RouteViolation(
        `'${value}' is not a valid '${seg.name}' for route '${template}': it must match ` +
          `${seg.pattern}. The alphabet is declared next to the route rather than ` +
          `sanitised here, because a path segment is the one argument that can turn a ` +
          `named route into an arbitrary one.`
      );
    }
    // A segment that declares `keepEncodedSlash` carries `%2f` as the namespace wrapper
    // the ADT itself writes; encoding it again (`%252f`) names a resource that does not
    // exist. Only a pattern that admits `%2f` in that one position can get here.
    if (seg.style === 'odataKey') {
      // OData V2 key: `<set>('<value>')`, a quote doubled the way OData escapes it (the
      // alphabets admit none today -- this is the second fence, not the first). The value
      // is percent-encoded inside the quotes: `:` travels as %3A, measured.
      path = `${spec.path}('${encodeURIComponent(value.replace(/'/g, "''"))}')`;
    } else if (seg.style === 'pathParts') {
      // The V4 service path is several REAL path segments (the gateway routes on them), so the
      // slashes travel literally and each part is encoded on its own. Only a pattern that fixes
      // the number and the alphabet of the parts may declare this style (assertRouteTable).
      // The one exception to encoding: the Gateway version parameter `;v=N` at the end of a part
      // travels literally, as the published serviceUrl writes it (measured); only a pattern that
      // admits it can put it there.
      path = `${spec.path}/${value.split('/').map((p) => encodeURIComponent(p).replace(/%3Bv%3D([0-9]{1,3})$/, ';v=$1')).join('/')}`;
    } else {
      const encoded = seg.keepEncodedSlash ? encodeURIComponent(value).replace(/%252[fF]/g, '%2f') : encodeURIComponent(value);
      path = `${spec.path}/${encoded}`;
    }
  }
  // A literal sub-resource name, declared in the table and never supplied by a caller.
  // It exists because one measured resource lives UNDER the segment
  // (`…/transportrequests/<number>/objectkeys`), and the alternative -- letting the
  // caller pass `DEVK900107/objectkeys` as the segment -- is exactly the smuggling the
  // segment pattern refuses. A route may only declare a suffix if it declares a segment:
  // without one there is nothing for the suffix to hang off, and appending it to the
  // collection path would silently address a different resource.
  if (spec.suffix) {
    if (!seg) throw new RouteViolation(`route '${template}' declares a suffix but no segment.`);
    path = `${path}${spec.suffix}`;
  }

  const given = Object.entries(params).filter(
    ([key, v]) => v !== undefined && v !== null && !(seg && key === seg.name)
  );
  for (const [key, value] of given) {
    // A fixed parameter is part of the route's identity, not an argument: a caller that
    // names it is trying to make this route another one.
    if (!spec.params.includes(key)) {
      throw new RouteViolation(
        `'${key}' is not a parameter of route '${template}'. It accepts: ` +
          `${spec.params.join(', ')}.`
      );
    }
    const rule = spec.validate?.[key];
    if (rule && !rule.test(String(value).trim())) {
      throw new RouteViolation(
        `'${value}' is not a valid '${key}' for route '${template}': it must match ${rule}.`
      );
    }
  }
  for (const key of spec.required) {
    const value = params[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new RouteViolation(`route '${template}' requires '${key}'.`);
    }
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(spec.fixed ?? {})) query.set(key, value);
  // Sorted, so the same question produces the same URL -- the audit line and the
  // journal line for one call are comparable across runs.
  for (const [key, value] of given.sort(([a], [b]) => a.localeCompare(b))) {
    const text = String(value).trim();
    if (text === '') continue;
    query.set(key, text);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Perform one named GET.
 *
 * `transport` is injected -- in the server it is bound to the logged-in AdtHTTP, in the
 * tests it is a function that records what it was asked to do. That seam is what makes
 * the GET-only property TESTABLE rather than asserted: tests/adt-get.test.mjs asserts
 * on the exact options object this function builds.
 *
 * @returns {Promise<{route:string, url:string, status:number, contentType:string|null,
 *                    body:string, bytes:number, shapeObserved:boolean, spec:object}>}
 */
export async function namedGet(transport, template, params = {}, opts = {}) {
  if (typeof transport !== 'function') {
    throw new RouteViolation('no transport: this route needs a logged-in ADT session.');
  }
  const spec = TEMPLATES.get(String(template));
  const url = buildUrl(template, params);
  // Frozen so that a caller holding a reference cannot add `method` or `body` to the
  // options object after this function built it.
  const request = Object.freeze({
    url,
    method: 'GET',
    headers: Object.freeze({ Accept: spec.accept }),
  });
  // ⚠️ MEASURED 2026-09-09: the AdtHTTP behind `transport` THROWS on 4xx/5xx instead of
  // returning the response, so the `status >= 400` branch below never ran against the
  // real system and every ADT_ERROR journal entry read `HTTP ?`. The status is carried
  // in a field named `err` -- AdtException.js builds the exception as
  // `new AdtErrorException(response.status, ...)` and the constructor assigns it to
  // `this.err`, leaving `.status` and `.response` undefined on this path. Both shapes
  // are normalised here so the branch below is the ONE place that describes a failure.
  let res;
  try {
    res = await transport(request);
  } catch (e) {
    throw adtFailure(e, template, url, opts);
  }
  const status = Number(res?.status ?? 0);
  const body = String(res?.body ?? '');
  const headers = res?.headers ?? {};
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? null;
  if (status >= 400) {
    const err = new Error(
      `ADT answered ${status} for route '${template}'. The route is measured in ` +
        `${AUTHORITY_TEXT[routeAuthority(spec.path)] ?? 'an authority of this server'}, so a 404 ` +
        `here means the parameters are wrong, not that the collection is absent.`
    );
    err.status = status;
    err.url = url;
    err.body = body.slice(0, opts.maxBody ?? 4000);
    throw err;
  }
  return {
    route: String(template),
    url,
    status,
    contentType: contentType === null ? null : String(contentType),
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
    shapeObserved: spec.shapeObserved === true,
    spec,
  };
}

/**
 * Normalise what the ADT client throws into the failure this module raises everywhere
 * else, so a caller (and the journal) sees one shape.
 *
 * The status search order is measured, not defensive: `err` is where AdtErrorException
 * puts `response.status`; `status` is the getter AdtHttpException exposes; `response
 * .status` is the shape a plain HTTP client would use. A value below 100 is not a status
 * -- `adtException(message)` defaults that field to 0 -- so it is reported as unknown
 * rather than as `HTTP 0`.
 */
function adtFailure(cause, template, url, opts = {}) {
  const candidates = [cause?.err, cause?.status, cause?.response?.status];
  const status = candidates.map(Number).find((n) => Number.isInteger(n) && n >= 100) ?? null;
  const said = cause?.localizedMessage || cause?.message || String(cause ?? '');
  const err = new Error(
    `ADT answered ${status ?? 'no readable status'} for route '${template}': ${said}`
  );
  err.status = status;
  err.url = url;
  err.adtType = cause?.type || null;
  err.body = String(said).slice(0, opts.maxBody ?? 4000);
  err.cause = cause;
  return err;
}

/** The one media type the version feed accepts. Measured: a bogus Accept on the same URL answers 406 naming exactly this one. */
export const VERSION_FEED_ACCEPT = 'application/atom+xml;type=feed';

/** Longest href this server follows; the measured ones are under 90 characters. */
export const MAX_DERIVED_HREF = 200;

/** A class or a program: the two object families whose versions were measured. */
const SOURCE_OBJECT = /^\/sap\/bc\/adt\/(oo\/classes|programs\/programs)\/[a-z0-9_%.-]{1,120}$/i;

/**
 * The kinds of derived read, closed. `versions` follows a link the object published;
 * `enhoxhb` reads the object's OWN URI -- a BAdI implementation names its spot, BAdI and
 * implementing class only in its body (measured step 10:
 * `objectStructure` carries three links and nothing else), so the URI the search resolved
 * is read once more with the one Accept the resource answers. `self` is the whole rule: the
 * href must BE the object URI, and the URI must be of that resource.
 */
export const DERIVED_KINDS = Object.freeze({
  versions: Object.freeze({ end: /\/versions$/, accept: VERSION_FEED_ACCEPT, what: 'the version feed' }),
  enhoxhb: Object.freeze({
    self: /^\/sap\/bc\/adt\/enhancements\/enhoxhb\/[a-z0-9_%.-]{1,80}$/i,
    accept: 'application/vnd.sap.adt.enh.enhoxhb.v4+xml',
    what: 'the BAdI implementation body',
  }),
  // The ST22 dump resource: the entry's adt:// self link has an HTTP twin,
  // `/sap/bc/adt/runtime/dump/<ST22 key, blanks as %20>`; `*/*` answers the dump.v1+xml
  // (header, links, chapter index) and `<uri>/formatted` is the whole report as text/plain
  // -- including the chosen variables, which the list's summary does not carry.
  runtimeDump: Object.freeze({
    self: /^\/sap\/bc\/adt\/runtime\/dump\/[A-Za-z0-9_%.-]{1,160}$/,
    accept: 'application/vnd.sap.adt.runtime.dump.v1+xml',
    what: 'the dump resource',
  }),
  runtimeDumpText: Object.freeze({
    base: /^\/sap\/bc\/adt\/runtime\/dump\/[A-Za-z0-9_%.-]{1,160}$/,
    end: /\/formatted$/,
    accept: 'text/plain',
    what: 'the formatted dump report',
  }),
  // The three reads behind a version comparison, MEASURED 2026-11-10 on one class and four
  // programs (docs/adt-api-reference.md, "Old versions, the inactive version and the syntax
  // check run"). All three are held to the two families measured, classes and programs.
  //
  // The content of one version: the entry's `atom:content/@src`, never assembled -- the stamp in
  // it is the feed's, not the version's.
  versionContent: Object.freeze({
    base: SOURCE_OBJECT,
    end: /\/versions\/\d{14}\/\d{5}\/content$/,
    accept: 'text/plain',
    what: 'the content of a version',
  }),
  // A source with `?version=` added HERE from a closed list: the stored active or inactive one.
  sourceVersion: Object.freeze({
    base: SOURCE_OBJECT,
    end: /\/(source\/main|includes\/(main|definitions|implementations|macros|testclasses))$/,
    accept: 'text/plain',
    query: Object.freeze({ version: Object.freeze(['active', 'inactive']) }),
    what: 'the source of a stored version',
  }),
  // The object document with `?version=`: its root `adtcore:version` is the only signal that an
  // inactive version exists (the source answers the active one, 200, when there is none).
  objectVersion: Object.freeze({
    self: SOURCE_OBJECT,
    accept: '*/*',
    query: Object.freeze({ version: Object.freeze(['active', 'inactive']) }),
    what: 'the object document of a stored version',
  }),
});

/**
 * Perform one GET on a link the SERVER published -- the second kind of route, and the
 * narrowest one possible after a named template.
 *
 * WHY A SECOND KIND. The version history of an object is published by `objectStructure`
 * as `atom:link rel=".../relations/versions"`, and its shape depends on the object type:
 * a class carries FIVE (`includes/{definitions,implementations,macros,testclasses,main}/
 * versions`), a program one (`source/main/versions`), a domain one (`versions`) --
 * measured, docs/adt-api-reference.md. A URL assembled from a convention is
 * wrong for two of the three, so the href has to come from the server's own reply.
 *
 * WHAT KEEPS IT NARROW. A published href is still a string, and this function accepts
 * only one shape of it:
 *   - the resolved URL must START with `objectUri` -- the object the caller already
 *     resolved through the guarded client, so the read stays under that object;
 *   - it must END with the literal `/versions`, nothing after it, no query string --
 *     `.../versions/<stamp>/<id>/content` (the source of an OLD version, a different
 *     question, docs/security.md) is refused here by construction;
 *   - no `..`, no `//`, no `?`, no `#`, no encoded slash anywhere in the href;
 *   - the Accept is fixed to the one type the resource accepts (its own 406 said so).
 * The method is GET, re-forced by `transportFor` as everywhere else. TEMPLATES does not
 * grow: this is not a route a caller can name, it is a link the server handed over.
 *
 * `opts.kind` picks one of DERIVED_KINDS (default `versions`); a `self` kind reads the
 * object URI itself and refuses any other href.
 */
export async function derivedGet(transport, objectUri, href, opts = {}) {
  if (typeof transport !== 'function') {
    throw new RouteViolation('no transport: this route needs a logged-in ADT session.');
  }
  const kindName = opts.kind ?? 'versions';
  const kind = Object.hasOwn(DERIVED_KINDS, kindName) ? DERIVED_KINDS[kindName] : null;
  if (!kind) throw new RouteViolation(`'${kindName}' is not a kind of derived read (${Object.keys(DERIVED_KINDS).join(', ')}).`);
  const base = String(objectUri ?? '').trim();
  if (!/^\/sap\/bc\/adt\/[a-z0-9_/%.-]+$/i.test(base) || base.includes('..') || base.includes('//')) {
    throw new RouteViolation(`'${objectUri}' is not an ADT object URI this server reads under.`);
  }
  if (kind.base && !kind.base.test(base)) {
    throw new RouteViolation(`'${objectUri}' is not a resource ${kind.what} is read under.`);
  }
  const link = String(href ?? '').trim();
  if (kind.self) {
    // The object's own URI, once more: nothing relative, nothing appended, and only a URI
    // of the resource this kind is for (a percent-encoded namespace is inside one segment).
    if (link !== base || !kind.self.test(base)) {
      throw new RouteViolation(`'${href}' is not ${kind.what} of '${base}': a ${kindName} read is the object URI itself.`);
    }
  } else if (!link || link.length > MAX_DERIVED_HREF || /[?#]|%2f|\.\.|\/\//i.test(link) || /\s/.test(link)) {
    throw new RouteViolation(
      `'${href}' is not a link this server follows: no query, no fragment, no '..', no encoded slash.`
    );
  }
  // Resolve the way the library's followUrl does: absolute stays, relative hangs off the object.
  const url = link.startsWith('/') ? link : `${base.replace(/\/$/, '')}/${link}`;
  if (!url.startsWith(base)) {
    throw new RouteViolation(`'${href}' resolves outside ${base}; a version feed is read under its object only.`);
  }
  if (kind.end && !kind.end.test(url)) {
    throw new RouteViolation(
      kindName === 'versions'
        ? `'${href}' does not end in /versions. The content of an old version ` +
            `(.../versions/<stamp>/<id>/content) is read as kind versionContent, never as the feed.`
        : `'${href}' is not ${kind.what} (${kind.end}).`
    );
  }
  // A query exists only where the kind declares it, with values from its closed list: the
  // caller picks one of them and never writes the string.
  const query = opts.query ?? null;
  if (query !== null && !kind.query) {
    throw new RouteViolation(`${kind.what} takes no query.`);
  }
  let search = '';
  if (kind.query) {
    const pairs = [];
    for (const [key, allowed] of Object.entries(kind.query)) {
      const value = query?.[key];
      if (!allowed.includes(value)) {
        throw new RouteViolation(`${kind.what} needs ${key} = ${allowed.join(' | ')}; got '${value}'.`);
      }
      pairs.push(`${key}=${value}`);
    }
    const extra = Object.keys(query ?? {}).filter((k) => !Object.hasOwn(kind.query, k));
    if (extra.length) throw new RouteViolation(`${kind.what} takes no '${extra.join("', '")}'.`);
    search = `?${pairs.join('&')}`;
  }
  const request = Object.freeze({
    url: url + search,
    method: 'GET',
    headers: Object.freeze({ Accept: kind.accept }),
  });
  let res;
  try {
    res = await transport(request);
  } catch (e) {
    throw adtFailure(e, kindName, request.url, opts);
  }
  const status = Number(res?.status ?? 0);
  const body = String(res?.body ?? '');
  const headers = res?.headers ?? {};
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? null;
  if (status >= 400) {
    const err = new Error(`ADT answered ${status} for ${kind.what} ${request.url}.`);
    err.status = status;
    err.url = request.url;
    err.body = body.slice(0, opts.maxBody ?? 4000);
    throw err;
  }
  return {
    route: kindName,
    url: request.url,
    status,
    contentType: contentType === null ? null : String(contentType),
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
    shapeObserved: true,
  };
}

/**
 * Bind a transport to a logged-in AdtHTTP.
 *
 * This is the ONE place that touches `client.httpClient`, and it does so through a
 * closure that accepts nothing but the options built by `namedGet` -- the AdtHTTP
 * itself never escapes, so no caller can obtain the generic request() the guard blocks.
 * The method is re-forced here as well: two independent statements of the same rule,
 * because the cost of the rule failing quietly is a write against the system.
 */
export function transportFor(rawClient) {
  const http = rawClient?.httpClient;
  if (!http || typeof http.request !== 'function') {
    throw new RouteViolation('the ADT session exposes no HTTP transport.');
  }
  return async ({ url, headers }) =>
    http.request(url, { method: 'GET', headers: { ...headers } });
}
