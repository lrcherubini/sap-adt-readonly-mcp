// The named GET route.
//
// These tests exist to hold ONE property in place: opening a route to a collection the
// client library never wrapped must not, by any argument a caller can pass, become a
// generic HTTP tool. Every assertion below is a case that a free-form
// `adt_http(method, path, body)` would have allowed and this module refuses before a
// socket is opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES,
  ODATA_ROOTS,
  RouteViolation,
  assertRouteTable,
  buildUrl,
  namedGet,
  routeAuthority,
  routeNames,
  transportFor,
} from '../lib/adt-get.mjs';
import { deniedMethods } from '../lib/guard.mjs';
import { segmentFor } from '../lib/enhancement-elements.mjs';
import { annotationChainTool } from '../tools/annotation-chain.mjs';

/** The reply the development system actually gave on 2026-09-09; see tests/annotation-chain.test.mjs. */
const MEASURED = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'annotation-chain-measured.xml'),
  'utf8'
);
import { openJournal } from '../lib/journal.mjs';
import fs from 'node:fs';
import path from 'node:path';

/** A transport that records exactly what it was asked to do and answers with a payload. */
function spyTransport(reply = {}) {
  const seen = [];
  const fn = async (request) => {
    seen.push(request);
    return {
      status: 200,
      body: '<chain/>',
      headers: { 'content-type': 'application/xml' },
      ...reply,
    };
  };
  fn.seen = seen;
  return fn;
}

// --- the closed table --------------------------------------------------------

test('the route table is closed, and these are the routes in it', () => {
  assert.deepEqual(routeNames(), [
    'annotationChain',
    'atcCheckVariant',
    'atcCustomizing',
    'atcVerdicts',
    'atcWorklist',
    'fdmPage',
    'fdmPages',
    'fdmRoleCatalogs',
    'fdmSpace',
    'fdmSpaces',
    'feedCatalog',
    'flpCatalogsConf',
    'flpCatalogsCust',
    'flpGroups',
    'flpPage',
    'gatewayErrors',
    'objectProperties',
    'odataMetadata',
    'odataMetadataV2Path',
    'odataMetadataV4',
    'odataMetadataV4Path',
    'quickSearch',
    'runtimeDumps',
    'serviceBinding',
    'serviceBindingDetailV2',
    'serviceBindingDetailV4',
    'structureEnhancements',
    'tableEnhancements',
    'transportDetail',
    'transportList',
    'transportObjectKeys',
    'ui5File',
    'ui5Folder',
  ]);
  const spec = TEMPLATES.get('annotationChain');
  assert.equal(spec.path, '/sap/bc/adt/ddic/ddlx/annotation/chain');
  assert.deepEqual(spec.params, ['entity', 'element', 'variant']);
  assert.equal(
    spec.shapeObserved,
    true,
    'measured on the development system 2026-09-09; tests/fixtures/annotation-chain-measured.xml is the reply'
  );
});

test('an unnamed route is refused, and the error says there is no generic HTTP tool', () => {
  assert.throws(() => buildUrl('anything', { entity: 'X' }), (e) => {
    assert.ok(e instanceof RouteViolation);
    assert.match(e.message, /not a named route/);
    assert.match(e.message, /no generic HTTP tool/);
    return true;
  });
  // The shapes someone would actually reach for.
  for (const attempt of ['/sap/bc/adt/repository/nodestructure', '../../etc', 'GET']) {
    assert.throws(() => buildUrl(attempt, {}), RouteViolation);
  }
});

test('a parameter the template does not declare is refused', () => {
  // `method` and `body` are the two that matter: this is the assertion that says the
  // verb cannot be smuggled in as data.
  for (const smuggled of ['method', 'body', 'sap-client', 'url', '$filter']) {
    assert.throws(
      () => buildUrl('annotationChain', { entity: 'ZC_X', [smuggled]: 'POST' }),
      (e) => {
        assert.ok(e instanceof RouteViolation);
        assert.match(e.message, new RegExp(`'${smuggled.replace('$', '\\$')}' is not a parameter`));
        return true;
      }
    );
  }
});

test('a required parameter cannot be blank -- an empty query is a full scan', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.throws(() => buildUrl('annotationChain', { entity: value }), RouteViolation);
  }
});

test('the URL is assembled from the template, encoded, and stable across runs', () => {
  assert.equal(
    buildUrl('annotationChain', { entity: 'ZC_DemoRosterMonitor', element: 'Stcd2' }),
    '/sap/bc/adt/ddic/ddlx/annotation/chain?element=Stcd2&entity=ZC_DemoRosterMonitor'
  );
  // Parameter order in the call does not change the URL: the audit line for one
  // question is comparable to itself across sessions.
  assert.equal(
    buildUrl('annotationChain', { element: 'Stcd2', entity: 'ZC_DemoRosterMonitor' }),
    buildUrl('annotationChain', { entity: 'ZC_DemoRosterMonitor', element: 'Stcd2' })
  );
  assert.match(
    buildUrl('annotationChain', { entity: 'ZC_X', variant: 'a b/c&d' }),
    /variant=a\+b%2Fc%26d$/
  );
  // An omitted optional parameter leaves no trace in the query string.
  assert.equal(
    buildUrl('annotationChain', { entity: 'ZC_X', element: undefined }),
    '/sap/bc/adt/ddic/ddlx/annotation/chain?entity=ZC_X'
  );
});

// --- the request ---------------------------------------------------------------

test('the request is a GET with no body, and the options object is frozen', async () => {
  const transport = spyTransport();
  const out = await namedGet(transport, 'annotationChain', { entity: 'ZC_X' });
  assert.equal(transport.seen.length, 1);
  const req = transport.seen[0];
  assert.equal(req.method, 'GET');
  assert.equal('body' in req, false, 'no body reaches the transport');
  assert.deepEqual(Object.keys(req).sort(), ['headers', 'method', 'url']);
  assert.ok(Object.isFrozen(req), 'a later holder of the options cannot add a method');
  assert.throws(() => {
    req.method = 'POST';
  }, TypeError);
  assert.equal(out.status, 200);
  assert.equal(out.contentType, 'application/xml');
  assert.equal(out.bytes, 8);
  assert.equal(out.shapeObserved, true, 'the table says the shape has been measured');
});

test('an HTTP error is raised with the status, and the body is capped', async () => {
  const transport = spyTransport({ status: 404, body: 'x'.repeat(9000) });
  await assert.rejects(
    () => namedGet(transport, 'annotationChain', { entity: 'ZC_X' }, { maxBody: 100 }),
    (e) => {
      assert.equal(e.status, 404);
      assert.equal(e.body.length, 100);
      assert.match(e.message, /the parameters are wrong, not that the collection is absent/);
      return true;
    }
  );
});

test('without a session there is no transport, and that is a refusal, not a crash', async () => {
  await assert.rejects(
    () => namedGet(undefined, 'annotationChain', { entity: 'ZC_X' }),
    RouteViolation
  );
  assert.throws(() => transportFor({}), RouteViolation);
  assert.throws(() => transportFor(null), RouteViolation);
});

test('transportFor re-forces GET even if the caller hands it something else', async () => {
  const calls = [];
  const raw = {
    httpClient: {
      request: async (url, config) => {
        calls.push({ url, config });
        return { status: 200, body: '', headers: {} };
      },
    },
  };
  const transport = transportFor(raw);
  // The one caller is namedGet, which already forces GET; this asserts the SECOND,
  // independent statement of the rule -- the one that holds if namedGet is ever changed.
  await transport({ url: '/x', method: 'DELETE', headers: { Accept: 'application/xml' } });
  assert.equal(calls[0].config.method, 'GET');
  assert.equal('body' in calls[0].config, false);
});

test('the escape hatch stays shut: httpClient is still denied by the guard', () => {
  // The route above reaches raw HTTP. If opening it had quietly loosened the guard,
  // this is where it would show.
  for (const method of ['httpClient', 'statelessClone', 'createHttp', 'password']) {
    assert.ok(deniedMethods().includes(method), `${method} is still denied`);
  }
});

// --- the declared path segment ---------------------------------------------------

test('a route without a declared segment refuses one, and a route with one requires it', () => {
  // The two halves of the same rule. A segment is not something a caller may introduce:
  // it exists only where the route declares an alphabet for it.
  assert.throws(
    () => buildUrl('annotationChain', { entity: 'ZC_X', number: 'DEVK900117' }),
    RouteViolation
  );
  assert.throws(() => buildUrl('transportList', { number: 'DEVK900117' }), RouteViolation);
  assert.throws(() => buildUrl('transportDetail', {}), RouteViolation);
  assert.throws(() => buildUrl('transportDetail', { number: '   ' }), RouteViolation);
  assert.equal(
    buildUrl('transportDetail', { number: 'DEVK900117' }),
    '/sap/bc/adt/cts/transportrequests/DEVK900117'
  );
});

test('a transport number cannot carry a path segment, a dot or an encoded slash', () => {
  // The library interpolates the number raw (transports.js:121-127) and only validates it
  // on delete/release/setOwner/addUser. Here the validation IS the reason the route exists.
  for (const bad of [
    'DEVK900117/../../x',
    'DEVK900117%2fx',
    'DEVK900117/objects',
    'DEVK900117.',
    '../etc',
    'devk900117',
    'DEVK90011',
    'DEVK9001177',
    'DEVX900117',
    '',
  ]) {
    assert.throws(
      () => buildUrl('transportDetail', { number: bad }),
      RouteViolation,
      `'${bad}' must never reach a URL`
    );
  }
});

test('the list route declares no parameters, so a query string is inexpressible', () => {
  // Measured: ANY query string on this collection returns 200 with an empty
  // root -- silently. An empty `params` is that measurement turned into a mechanism.
  assert.deepEqual(TEMPLATES.get('transportList').params, []);
  assert.equal(buildUrl('transportList', {}), '/sap/bc/adt/cts/transportrequests');
  for (const bad of [{ user: 'DEVUSER1' }, { targets: 'true' }, { number: 'DEVK900117' }]) {
    assert.throws(() => buildUrl('transportList', bad), RouteViolation);
  }
});

test('each transport route sends its own measured Accept', async () => {
  // The list rejects the type the detail requires, and the service document advertises
  // the one the list refuses. One `accept` on a collection does not describe its members.
  const tree = 'application/vnd.sap.adt.transportorganizertree.v1+xml';
  const single = 'application/vnd.sap.adt.transportorganizer.v1+xml';
  assert.equal(TEMPLATES.get('transportList').accept, tree);
  assert.equal(TEMPLATES.get('transportDetail').accept, single);

  const transport = spyTransport();
  await namedGet(transport, 'transportList', {});
  await namedGet(transport, 'transportDetail', { number: 'DEVK900117' });
  assert.equal(transport.seen[0].headers.Accept, tree);
  assert.equal(transport.seen[0].url, '/sap/bc/adt/cts/transportrequests');
  assert.equal(transport.seen[1].headers.Accept, single);
  assert.equal(transport.seen[1].url, '/sap/bc/adt/cts/transportrequests/DEVK900117');
});

// --- the tool ------------------------------------------------------------------

function toolWith(transportReply, log = [], journalLines = []) {
  const cfg = {
    budget: { reads: 100 },
    auditSink: (line) => log.push(JSON.parse(line)),
    journalSink: (stream, record) => journalLines.push({ stream, ...record }),
  };
  const session = {
    raw: {
      httpClient: {
        request: async () => ({
          status: 200,
          body: '<chain/>',
          headers: { 'content-type': 'application/xml' },
          ...transportReply,
        }),
      },
    },
  };
  return { tool: annotationChainTool(cfg, session, openJournal(cfg)), log, journalLines };
}

test('the tool parses the measured reply and names the source of each annotation', async () => {
  const { tool, log } = toolWith({
    body: MEASURED,
    headers: { 'content-type': 'application/vnd.sap.adt.ddlx.annotation.chain.v2+xml' },
  });
  const res = await tool.handler({ entity: 'ZC_DemoInvMapTP', element: 'BaseUnit' });
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.measured, true);
  assert.equal(out.counts.annotations, 7);
  assert.equal(out.counts.sources, 2);
  assert.equal(out.conflicts.length, 0);
  assert.match(out.summary, /ZC_DemoInvMapTP\.BaseUnit/);
  // The raw payload is no longer echoed: it was evidence for an unmeasured shape, and
  // 9 KB of XML in every answer is a cost with nothing behind it now that it parses.
  assert.equal(out.payload, undefined);
  assert.equal(out.warning, undefined);
  // It costs one ADT call, and the audit line says which object it was about.
  assert.equal(log.length, 1);
  assert.equal(log[0].target, 'ZC_DemoInvMapTP/BaseUnit');
});

test('a reply that does not match the measured shape is a gap, not "no annotations"', async () => {
  // The dangerous case: 200 OK, bytes on the wire, and nothing the parser recognises.
  // "The element has no annotations" and "I could not read this" must never render the
  // same, so the tool refuses to conclude and hands the payload back for comparison.
  const { tool, journalLines } = toolWith({ body: '<something-else/>' });
  const out = JSON.parse((await tool.handler({ entity: 'ZC_X' })).content[0].text);
  assert.equal(out.measured, true, 'the route is measured; THIS REPLY is not the measured shape');
  assert.match(out.warning, /none of it matched the measured shape/);
  assert.match(out.warning, /may genuinely carry no annotations/);
  assert.equal(out.annotations, undefined, 'nothing is asserted about the element');
  const gap = journalLines.find((l) => l.stream === 'gaps');
  assert.equal(gap.code, 'SHAPE_UNOBSERVED');
  assert.match(gap.impact, /NOT evidence/);
  // The payload must not reach the journal under any key.
  assert.equal(JSON.stringify(journalLines).includes('something-else'), false);
});

test('an overridden annotation is a finding about the workspace, not a gap', async () => {
  // Synthetic override, built on the measured shape -- see tests/annotation-chain.test.mjs.
  const overridden = MEASURED.replace(
    /<\/abapsource:elementInfo>$/,
    '<abapsource:elementInfo adtcore:type="ANNO" adtcore:name="UI.LINEITEM$1$.POSITION" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core"><abapsource:properties>' +
      '<abapsource:entry abapsource:key="SOURCE_NAME">ZE_OTHER</abapsource:entry>' +
      '<abapsource:entry abapsource:key="SOURCE_TYPE">DDLX/EX</abapsource:entry>' +
      '<abapsource:entry abapsource:key="ANNOTATION_VALUE">10</abapsource:entry>' +
      '<abapsource:entry abapsource:key="IS_ACTIVE"/>' +
      '</abapsource:properties></abapsource:elementInfo></abapsource:elementInfo>'
  );
  const { tool, journalLines } = toolWith({ body: overridden });
  const out = JSON.parse((await tool.handler({ entity: 'ZC_DemoInvMapTP', element: 'BaseUnit' })).content[0].text);
  assert.equal(out.counts.conflicts, 1);
  const finding = journalLines.find((l) => l.stream === 'findings');
  assert.equal(finding.code, 'ANNOTATION_OVERRIDDEN');
  assert.match(finding.subject, /ui\.lineitem\[1\]\.position/);
  assert.equal(finding.context.overriddenBy, 'ZE_OTHER');
  assert.match(finding.effect, /ZE_OTHER/, 'effect is the findings field; detail is a gaps field');
  assert.equal(journalLines.some((l) => l.stream === 'gaps'), false, 'the server did fine');
});

test('an ADT failure files ADT_ERROR and never reads as "no conflict"', async () => {
  const { tool, journalLines } = toolWith({ status: 500, body: 'boom' });
  await assert.rejects(() => tool.handler({ entity: 'ZC_X' }));
  const gap = journalLines.find((l) => l.stream === 'gaps');
  assert.equal(gap.code, 'ADT_ERROR');
  assert.match(gap.impact, /NOT evidence/);
});

test('a caller error is not filed as an ADT gap', async () => {
  const { tool, journalLines, log } = toolWith({});
  await assert.rejects(() => tool.handler({}), RouteViolation);
  assert.deepEqual(journalLines, [], 'nothing left the machine, so nothing is a gap');
  assert.deepEqual(log, [], 'and no read was charged');
});

test('hidden-with-a-UI-role is filed as a finding even though nothing conflicts', async () => {
  // The measured ZC_DemoShelfStock/Plant chain (see tests/annotation-chain.test.mjs). The
  // regression this guards: `conflicts` is EMPTY here, so a tool that only reported
  // conflicts would answer "clean chain" about a field that does not render.
  const hiddenRole = fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'annotation-chain-hidden-role.xml'),
    'utf8'
  );
  const { tool, journalLines } = toolWith({ body: hiddenRole });
  const out = JSON.parse(
    (await tool.handler({ entity: 'ZC_DemoShelfStock', element: 'Plant' })).content[0].text
  );
  assert.equal(out.counts.conflicts, 0, 'nothing contests anything -- that is the trap');
  assert.equal(out.hiddenWithUiRole.length, 1);
  assert.equal(out.hiddenWithUiRole[0].hiddenBy.name, 'ZI_DEMOSTORAGELOCATION');
  assert.match(out.summary, /HIDDEN BUT GIVEN A UI ROLE/);

  const finding = journalLines.find((l) => l.stream === 'findings');
  assert.equal(finding.code, 'ANNOTATION_HIDDEN_WITH_ROLE');
  assert.equal(finding.subject, 'ZC_DemoShelfStock.Plant');
  // `effect`, not `detail`: the allowlist drops gaps fields on a finding, silently.
  assert.match(finding.effect, /ZI_DEMOSTORAGELOCATION/);
  assert.match(finding.effect, /no error is raised/);
  assert.equal(finding.context.roleSources, 'ZC_DEMOSHELFSTOCK');
  assert.equal(journalLines.some((l) => l.stream === 'gaps'), false);
});

// --- the status the ADT client hides ---
// MEASURED 2026-09-09 on the development system and reproduced offline here: the real AdtHTTP does not
// return a 4xx response, it THROWS. Everything this module knew about failure lived in a
// branch that read `res.status`, so against the real system the journal recorded
// `HTTP ?` on every ADT error. These two tests are the regression, and the first one
// builds the exception with the LIBRARY'S OWN class rather than a hand-rolled stub --
// a stub would keep passing on the day the library moves the field.

test("a thrown ADT error still yields the status: the library carries it in `err`", async () => {
  const { AdtErrorException } = await import('abap-adt-api');
  const thrown = new AdtErrorException(
    406,
    { 'com.sap.adt.communicationFramework.subType': 'con_not_acceptable' },
    'ExceptionResourceNotAcceptable',
    'Resource does not support the requested content type',
    undefined,
    'com.sap.adt',
    'The resource does not support the requested content type'
  );
  // The shape the old code looked for, absent on this path -- which is the whole defect.
  assert.equal(thrown.status, undefined);
  assert.equal(thrown.response, undefined);

  const transport = async () => {
    throw thrown;
  };
  await assert.rejects(
    () => namedGet(transport, 'transportDetail', { number: 'DEVK900107' }),
    (e) => {
      assert.equal(e.status, 406, 'the status must survive the throw');
      assert.equal(e.adtType, 'ExceptionResourceNotAcceptable');
      assert.match(e.message, /406/);
      // The localised message is what a human can act on, so it is what is carried.
      assert.match(e.message, /does not support the requested content type/);
      assert.equal(e.url, '/sap/bc/adt/cts/transportrequests/DEVK900107');
      assert.equal(e.cause, thrown, 'the original is kept, not swallowed');
      return true;
    }
  );
});

test('a failure with no readable status says so instead of claiming HTTP 0', async () => {
  // `adtException(message)` defaults that same field to 0. Zero is not a status, and
  // reporting `HTTP 0` would read like a measurement.
  const transport = async () => {
    throw Object.assign(new Error('socket hang up'), { err: 0 });
  };
  await assert.rejects(
    () => namedGet(transport, 'transportList', {}),
    (e) => {
      assert.equal(e.status, null);
      assert.match(e.message, /no readable status/);
      assert.doesNotMatch(e.message, /HTTP 0|answered 0/);
      return true;
    }
  );
});

test('the objectkeys route exists, and it cannot be asked a question it never answers', () => {
  // MEASURED 2026-09-09, then BUILT. An earlier revision of this test asserted the
  // opposite -- that the route was refused by omission -- and the user overruled that:
  // "the goal is to be able to read everything". The reason the refusal was safe to drop is
  // recorded in docs/security.md: E071K is a table OF THE CTS, and a key row is the
  // transport's own record of WHICH rows moved. It is not a SELECT on the business table,
  // and it returns no field value that the transport did not already carry.
  //
  // What replaced the refusal is this: the route is narrow by construction. It reaches
  // exactly one resource, under one number-shaped segment, with both parameters required.
  assert.equal(TEMPLATES.has('transportObjectKeys'), true);
  assert.equal(
    buildUrl('transportObjectKeys', {
      number: 'DEVK900107',
      objName: 'AGR_TIMEB',
      objType: 'TABU',
    }),
    '/sap/bc/adt/cts/transportrequests/DEVK900107/objectkeys?objName=AGR_TIMEB&objType=TABU'
  );

  // ⚠️ Both parameters are required because the resource answers 400 `I::000` to any other
  // parameterisation, and round 1 of the measurement read that six-byte body as "this
  // resource does not exist". A caller must not be able to reproduce that mistake.
  for (const params of [
    { number: 'DEVK900107' },
    { number: 'DEVK900107', objName: 'AGR_TIMEB' },
    { number: 'DEVK900107', objType: 'TABU' },
  ]) {
    assert.throws(() => buildUrl('transportObjectKeys', params), RouteViolation, JSON.stringify(params));
  }
  assert.throws(
    () => buildUrl('transportObjectKeys', {
      number: 'DEVK900107',
      objName: 'AGR_TIMEB',
      objType: 'TABU',
      objPgmId: 'R3TR',
    }),
    RouteViolation,
    'a parameter the template does not declare stays undeclared'
  );
});

test('a transport number cannot smuggle the sub-resource in, on any route', () => {
  // The segment alphabet is what makes the suffix safe: `/objectkeys` is a literal from
  // the table, so the only way to address something else would be through the number.
  for (const route of ['transportDetail', 'transportObjectKeys']) {
    for (const number of [
      'DEVK900107/objectkeys',
      'DEVK900107%2Fobjectkeys',
      'DEVK900107/objectkeys?objName=AGR_TIMEB',
      '../../cts/transportrequests/DEVK900107',
      'DEVK900107/',
    ]) {
      assert.throws(
        () => buildUrl(route, { number, objName: 'AGR_TIMEB', objType: 'TABU' }),
        RouteViolation,
        `${route} <- ${number}`
      );
    }
  }
  assert.equal(
    buildUrl('transportDetail', { number: 'DEVK900107' }),
    '/sap/bc/adt/cts/transportrequests/DEVK900107'
  );
});

test('a suffix without a segment is refused: there would be nothing for it to hang off', () => {
  // The rule is enforced at build time rather than asserted in a comment, because a suffix
  // appended to a COLLECTION path silently addresses a different resource -- and silence
  // is the failure mode this whole table exists to remove. Proven by declaring the broken
  // route the table itself does not contain, and taking it back out.
  assert.equal(
    routeNames().filter((n) => TEMPLATES.get(n).suffix && !TEMPLATES.get(n).segment).length,
    0,
    'no route in the table declares a suffix without a segment'
  );
  TEMPLATES.set('spec:suffixWithoutSegment', {
    path: '/sap/bc/adt/cts/transportrequests',
    suffix: '/objectkeys',
    params: [],
  });
  try {
    assert.throws(() => buildUrl('spec:suffixWithoutSegment', {}), RouteViolation);
  } finally {
    TEMPLATES.delete('spec:suffixWithoutSegment');
  }
  assert.equal(TEMPLATES.has('spec:suffixWithoutSegment'), false);
});

// --- the derived GET: a link the server published, and nothing else -------------

import { derivedGet, VERSION_FEED_ACCEPT } from '../lib/adt-get.mjs';

const CLASS_URI = '/sap/bc/adt/oo/classes/zcl_demo';

test('a published versions link is read under its object, as GET, with the one Accept the feed takes', async () => {
  const t = spyTransport({ body: '<atom:feed/>', headers: { 'content-type': VERSION_FEED_ACCEPT } });
  const out = await derivedGet(t, CLASS_URI, 'includes/main/versions');
  assert.equal(t.seen.length, 1);
  assert.equal(t.seen[0].url, `${CLASS_URI}/includes/main/versions`);
  assert.equal(t.seen[0].method, 'GET');
  assert.deepEqual(t.seen[0].headers, { Accept: VERSION_FEED_ACCEPT });
  assert.ok(Object.isFrozen(t.seen[0]), 'the request object is frozen, like namedGet\'s');
  assert.equal(out.route, 'versions');
  assert.equal(out.bytes, Buffer.byteLength('<atom:feed/>'));
  // An absolute href resolves too -- but only when it stays under the object.
  await derivedGet(t, '/sap/bc/adt/ddic/domains/zdo_demo', '/sap/bc/adt/ddic/domains/zdo_demo/versions');
  assert.equal(t.seen[1].url, '/sap/bc/adt/ddic/domains/zdo_demo/versions');
});

test('the route table does not grow for it: the versions feed is a link, not a name a caller can pass', () => {
  assert.equal(TEMPLATES.has('versions'), false);
  assert.throws(() => buildUrl('versions', {}), RouteViolation);
});

test('a link the server did not publish cannot be read: outside the object, past /versions, or with a query', async () => {
  const t = spyTransport();
  const refused = [
    // The content of an old version -- a different question, docs/security.md.
    'includes/main/versions/20260901011434/00041/content',
    // Another object.
    '/sap/bc/adt/oo/classes/zcl_other/versions',
    '../zcl_other/versions',
    // Query and fragment.
    'versions?version=inactive',
    'versions#x',
    // Encoded slash and doubled slash.
    'includes%2Fmain/versions',
    'includes//main/versions',
    // Not a versions link at all.
    'source/main',
    'transports',
    '',
  ];
  for (const href of refused) {
    await assert.rejects(() => derivedGet(t, CLASS_URI, href), RouteViolation, `href ${JSON.stringify(href)}`);
  }
  // A base that is not an ADT object URI is refused before the href is even looked at.
  await assert.rejects(() => derivedGet(t, 'https://elsewhere/x', 'versions'), RouteViolation);
  await assert.rejects(() => derivedGet(t, '/sap/bc/adt/oo/classes/../cts/x', 'versions'), RouteViolation);
  await assert.rejects(() => derivedGet(null, CLASS_URI, 'versions'), RouteViolation);
  assert.equal(t.seen.length, 0, 'nothing reached the transport');
});

test('a failing feed read carries the status, and a 4xx returned as a response is not read as success', async () => {
  const thrown = async () => {
    const e = new Error('Not Found');
    e.response = { status: 404 };
    throw e;
  };
  await assert.rejects(() => derivedGet(thrown, CLASS_URI, 'versions'), (e) => {
    assert.equal(e.status, 404);
    assert.match(e.message, /route 'versions'/);
    return true;
  });
  const returned = spyTransport({ status: 406, body: 'Accepted content types: application/atom+xml;type=feed' });
  await assert.rejects(() => derivedGet(returned, CLASS_URI, 'versions'), (e) => {
    assert.equal(e.status, 406);
    assert.match(e.body, /atom\+xml/);
    return true;
  });
});

// --- quickSearch: the facet sent whole, and nothing else ----------------------------

test('quickSearch sends the facet whole, with operation fixed by the route and not by the caller', async () => {
  const t = spyTransport({ body: '<adtcore:objectReferences/>' });
  const out = await namedGet(t, 'quickSearch', { query: 'Z_DEMO_FM', objectType: 'FUGR/FF', maxResults: 20 });
  assert.equal(
    t.seen[0].url,
    '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&maxResults=20&objectType=FUGR%2FFF&query=Z_DEMO_FM'
  );
  assert.equal(t.seen[0].method, 'GET');
  assert.equal(t.seen[0].headers.Accept, 'application/xml');
  assert.equal(out.route, 'quickSearch');
  // `operation` is the route's identity: a caller naming it is refused, even with the same value.
  assert.throws(() => buildUrl('quickSearch', { query: 'X', objectType: 'PROG/P', operation: 'quickSearch' }), RouteViolation);
  assert.throws(() => buildUrl('quickSearch', { query: 'X', objectType: 'PROG/P', operation: 'fullSearch' }), RouteViolation);
});

test('quickSearch refuses what is not a name and a facet: leading wildcards, paths, injections, absurd caps', () => {
  const ok = { query: 'ZCL_DEMO*', objectType: 'CLAS/OC' };
  assert.ok(buildUrl('quickSearch', ok));
  assert.ok(buildUrl('quickSearch', { query: 'I_COMPANYCODEVH', objectType: 'CDBO' }), 'a bare major type is a facet too');
  const refused = [
    { ...ok, query: '*DEMO*' },
    { ...ok, query: '' },
    { ...ok, query: 'a b' },
    { ...ok, query: 'x&objectType=PROG' },
    { ...ok, objectType: 'clas/oc' },
    { ...ok, objectType: 'CLAS/OC/X' },
    { ...ok, objectType: '../x' },
    { ...ok, maxResults: 0 },
    { ...ok, maxResults: 1000 },
    { ...ok, maxResults: '20; DROP' },
    { query: 'ZCL_DEMO' }, // no facet: that is the library's search, not this route
  ];
  for (const params of refused) {
    assert.throws(() => buildUrl('quickSearch', params), RouteViolation, JSON.stringify(params));
  }
});

// --- the second kind of derived read: the object's own URI, for a resource whose body is the answer

test('an ENHO/XHB body is read at the object URI itself, with the one Accept, and nothing else passes as that kind', async () => {
  const { DERIVED_KINDS } = await import('../lib/adt-get.mjs');
  assert.deepEqual(Object.keys(DERIVED_KINDS), ['versions', 'enhoxhb', 'runtimeDump', 'runtimeDumpText']);
  const XHB = '/sap/bc/adt/enhancements/enhoxhb/zdemo_badi_impl';
  const t = spyTransport({ body: '<enho:objectData/>', headers: { 'content-type': DERIVED_KINDS.enhoxhb.accept } });
  const out = await derivedGet(t, XHB, XHB, { kind: 'enhoxhb' });
  assert.equal(t.seen[0].url, XHB);
  assert.equal(t.seen[0].method, 'GET');
  assert.deepEqual(t.seen[0].headers, { Accept: 'application/vnd.sap.adt.enh.enhoxhb.v4+xml' });
  assert.equal(out.route, 'enhoxhb');
  // A namespaced implementation keeps its percent-encoded name: one segment, no escape.
  const NS = '/sap/bc/adt/enhancements/enhoxhb/%2fxnfe%2fzdemo_impl';
  await derivedGet(t, NS, NS, { kind: 'enhoxhb' });
  assert.equal(t.seen[1].url, NS);
  for (const [base, href, kind] of [
    [XHB, `${XHB}/versions`, 'enhoxhb'], // appended
    [XHB, 'versions', 'enhoxhb'], // relative
    [CLASS_URI, CLASS_URI, 'enhoxhb'], // a class is not that resource
    ['/sap/bc/adt/enhancements/enhoxh/zdemo', '/sap/bc/adt/enhancements/enhoxh/zdemo', 'enhoxhb'], // XH is not XHB
    [XHB, `${XHB}?version=active`, 'enhoxhb'],
    [XHB, XHB, 'source'], // not a kind
    [XHB, XHB, 'versions'], // the versions kind still wants /versions
  ]) {
    await assert.rejects(() => derivedGet(t, base, href, { kind }), RouteViolation, `${kind} ${href}`);
  }
  assert.equal(t.seen.length, 2, 'the refused ones never reached the transport');
});

test('a dump is read at the HTTP twin of its self link, and its formatted report under it; nothing else', async () => {
  const KEY = '/sap/bc/adt/runtime/dump/20260912153234vhdemohost_DEV_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20OTHERDEV%20%20%20%20001%20%20%20%20%20%20%2021';
  const t = spyTransport({ body: '<dump:dump/>', headers: { 'content-type': 'application/vnd.sap.adt.runtime.dump.v1+xml' } });
  const r = await derivedGet(t, KEY, KEY, { kind: 'runtimeDump' });
  assert.equal(r.route, 'runtimeDump');
  assert.deepEqual(t.seen[0].headers, { Accept: 'application/vnd.sap.adt.runtime.dump.v1+xml' });
  const f = await derivedGet(t, KEY, 'formatted', { kind: 'runtimeDumpText' });
  assert.equal(t.seen[1].url, `${KEY}/formatted`);
  assert.deepEqual(t.seen[1].headers, { Accept: 'text/plain' });
  assert.equal(f.route, 'runtimeDumpText');
  for (const [base, href, kind] of [
    [KEY, 'unformatted', 'runtimeDumpText'], // a link the resource publishes, but not the one kind read
    [KEY, 'summary', 'runtimeDumpText'],
    [KEY, `${KEY}/formatted`, 'runtimeDump'], // the resource kind is the URI itself
    [CLASS_URI, 'formatted', 'runtimeDumpText'], // not under a dump
    ['/sap/bc/adt/vit/runtime/dumps/x', '/sap/bc/adt/vit/runtime/dumps/x', 'runtimeDump'], // the GUI twin is not the resource
    [KEY, 'formatted?x=1', 'runtimeDumpText'],
  ]) {
    await assert.rejects(() => derivedGet(t, base, href, { kind }), RouteViolation, `${kind} ${href}`);
  }
  assert.equal(t.seen.length, 2);
});

// --- objectProperties: the one read an ENHO/XH survives (2026-09-14) -------

test('objectProperties takes one absolute ADT object URI and nothing that could be another resource', () => {
  const ENHO = '/sap/bc/adt/enhancements/enhoxh/zcl_demo_utilities';
  assert.equal(
    buildUrl('objectProperties', { uri: ENHO }),
    '/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=%2Fsap%2Fbc%2Fadt%2Fenhancements%2Fenhoxh%2Fzcl_demo_utilities'
  );
  // A namespaced name is written with %2f inside its segment (measured).
  buildUrl('objectProperties', { uri: '/sap/bc/adt/enhancements/enhoxhb/%2fxnfe%2fzdemo' });
  for (const bad of ['/sap/bc/adt/a', '/sap/bc/adt/x/../y', '/sap/bc/adt/a?b=1', '/sap/bc/adt/a#x', '/sap/bc/adt/a//b', '/etc/passwd', 'http://x/sap/bc/adt/a/b', '']) {
    assert.throws(() => buildUrl('objectProperties', { uri: bad }), RouteViolation, bad);
  }
  assert.throws(() => buildUrl('objectProperties', { uri: ENHO, version: 'active' }), /not a parameter/);
  assert.equal(TEMPLATES.get('objectProperties').accept, 'application/vnd.sap.adt.repository.objproperties.result.v1+xml');
});

// --- ATC routes (2026-09-14) -------------------------------------------------

test('atcWorklist takes the 32-hex worklist id and one boolean, atcCustomizing takes nothing', () => {
  const ID = '111E68A43C261FD1AC8CEF8EE873FA8A';
  assert.equal(buildUrl('atcWorklist', { id: ID }), `/sap/bc/adt/atc/worklists/${ID}`);
  assert.equal(buildUrl('atcWorklist', { id: ID, includeExemptedFindings: 'true' }), `/sap/bc/adt/atc/worklists/${ID}?includeExemptedFindings=true`);
  for (const bad of ['', 'abc', ID.toLowerCase(), `${ID}/x`, '../runs', `${ID}?x=1`, 'ZDEMO_CLEAN_CORE']) {
    assert.throws(() => buildUrl('atcWorklist', { id: bad }), RouteViolation, JSON.stringify(bad));
  }
  assert.throws(() => buildUrl('atcWorklist', { id: ID, includeExemptedFindings: 'yes' }), RouteViolation);
  assert.throws(() => buildUrl('atcWorklist', { id: ID, timestamp: '1' }), /not a parameter/);
  assert.equal(TEMPLATES.get('atcWorklist').accept, 'application/atc.worklist.v1+xml');
  assert.equal(buildUrl('atcCustomizing', {}), '/sap/bc/adt/atc/customizing');
  assert.throws(() => buildUrl('atcCustomizing', { checkVariant: 'X' }), /not a parameter/);
});

// --- enhancement/elements: the two routes added 2026-09-22 ------------------------------------
//
// The resource that NAMES the append structures of a table or a structure. It is the only route
// to that question for a TABL/DS, whose ddicElement tree is always empty (measured the same day).

test('the enhancement routes address two different collections, never one with a chosen prefix', () => {
  assert.equal(
    buildUrl('tableEnhancements', { name: 'wbrf' }),
    '/sap/bc/adt/ddic/tables/wbrf/enhancement/elements'
  );
  assert.equal(
    buildUrl('structureEnhancements', { name: 'kompaz' }),
    '/sap/bc/adt/ddic/structures/kompaz/enhancement/elements'
  );
});

test('the enhancement routes accept the type their published link declares', () => {
  for (const r of ['tableEnhancements', 'structureEnhancements']) {
    const spec = TEMPLATES.get(r);
    assert.equal(spec.accept, 'application/vnd.sap.adt.elementinfo+xml');
    // This resource answers 406 with a bare "The message content is not acceptable" and does NOT
    // enumerate what it wants -- so the link's `type` is the only source, and guessing costs a
    // round trip that teaches nothing.
    assert.deepEqual(spec.params, [], 'this resource takes no question, only a subject');
    assert.equal(spec.shapeObserved, true);
  }
});

test('an enhancement route refuses a segment that would name another resource', () => {
  for (const r of ['tableEnhancements', 'structureEnhancements']) {
    // Path traversal, a second segment, and the raw slash that would make one.
    for (const bad of ['..', 'wbrf/source', 'wbrf%2fsource', '../../oo/classes/cl_x', 'a'.repeat(31)]) {
      assert.throws(() => buildUrl(r, { name: bad }), /Blocked/, `${r} accepted '${bad}'`);
    }
    // And no segment at all: the route is about ONE object, never a collection listing.
    assert.throws(() => buildUrl(r, {}), /requires the 'name' path segment/);
  }
});

test('a namespaced subject is admitted only as the %2f wrapper the ADT itself writes', () => {
  assert.equal(
    buildUrl('structureEnhancements', { name: '%2fisdfps%2fmerep_outtab_purchdoc' }),
    '/sap/bc/adt/ddic/structures/%2fisdfps%2fmerep_outtab_purchdoc/enhancement/elements'
  );
  // The measured form (2026-11-09): segmentFor writes it lower case, and both routes take it.
  assert.equal(segmentFor('/BOFU/DDMOCUST_H'), '%2fbofu%2fddmocust_h');
  assert.equal(
    buildUrl('tableEnhancements', { name: segmentFor('/BOFU/DDMOCUST_H') }),
    '/sap/bc/adt/ddic/tables/%2fbofu%2fddmocust_h/enhancement/elements'
  );
  // Double encoding names a resource that does not exist (measured on a function-group route,
  // 2026-09-14), and a bare slash is a second segment.
  assert.throws(() => buildUrl('structureEnhancements', { name: '/isdfps/merep_outtab' }), /Blocked/);
});

// --- three authorities: launchpad (gateway) and PFCG roles (http), 2026-10-02 ----------

test('every route is under one of the three authorities, and the table is checked at import', () => {
  for (const name of routeNames()) {
    assert.ok(routeAuthority(TEMPLATES.get(name).path), `${name} is under no authority`);
  }
  assert.equal(assertRouteTable(), true);
  const one = (spec) => new Map([['x', { params: [], required: [], ...spec }]]);
  // A path outside the three, a gateway route that forgets JSON, an OData key off the gateway.
  assert.throws(() => assertRouteTable(one({ path: '/sap/bc/ui2/flp' })), /under no authority/);
  assert.throws(() => assertRouteTable(one({ path: '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Pages' })), /\$format=json/);
  assert.throws(
    () => assertRouteTable(one({ path: '/sap/bc/adt/feeds', segment: { name: 'id', pattern: /^x$/, style: 'odataKey' } })),
    /OData key belongs to a gateway route/
  );
  assert.throws(
    () => assertRouteTable(one({ path: '/sap/bc/adt/feeds', segment: { name: 'id', pattern: /^x$/, style: 'raw' } })),
    /unknown segment style/
  );
});

test('a gateway root is a closed list: personalization, $batch and nested paths are under none', () => {
  assert.equal(routeAuthority('/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Pages'), 'gateway');
  assert.ok(!ODATA_ROOTS.some((r) => /PERS/.test(r)), 'PAGE_BUILDER_PERS holds the personalization of each user');
  for (const p of [
    '/sap/opu/odata/UI2/PAGE_BUILDER_PERS/Pages', // a person's data
    '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/$batch', // many requests in one, any verb inside
    '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/$metadata',
    '/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Pages/x', // more than one entity set segment
    '/sap/opu/odata/UI2/PAGE_BUILDER_CUST', // the service document itself
    '/sap/opu/odata/UI2/FDM_SPACE_REPOSITORY_SRV/spaceSet', // not registered (403)
    '/sap/bc/http/sap/zother_service', // a customer HTTP service: never an authority
  ]) {
    assert.equal(routeAuthority(p), null, p);
  }
});

test('an OData key is quoted, encoded and can neither close itself nor walk out', () => {
  // The shape measured on the development system: `:` as %3A inside the quotes.
  assert.equal(
    buildUrl('flpPage', { id: 'X-SAP-UI2-CATALOGPAGE:ZCT_DEMO_23' }),
    "/sap/opu/odata/UI2/PAGE_BUILDER_CUST/Pages('X-SAP-UI2-CATALOGPAGE%3AZCT_DEMO_23')" +
      '?%24format=json&%24expand=PageChipInstances%2FChip%2CPageChipInstances%2FChipInstanceBags%2FChipInstanceProperties'
  );
  // Real ids of this system: an accent, a zero-width space, a namespace.
  for (const id of ['X-SAP-UI2-CATALOGPAGE:Café', 'X-SAP-UI2-CATALOGPAGE:SAP_SFIN_BC_AA_UPA_MDAT​', 'X-SAP-UI2-CATALOGPAGE:/UI2/C2GFLPPLUGIN']) {
    assert.match(buildUrl('flpPage', { id }), /\/Pages\('[^'()/?#&]+'\)\?/);
  }
  for (const id of ["Z'X", 'Z X', 'Z(X)', 'Z%2fX', 'Z?X', 'Z#X', 'Z&X', '../../x', 'A..B', 'x'.repeat(121)]) {
    assert.throws(() => buildUrl('flpPage', { id }), RouteViolation, id);
  }
  assert.throws(() => buildUrl('flpPage', {}), /requires the 'id' path segment/);
  assert.equal(
    buildUrl('fdmRoleCatalogs', { role: 'ZS:DEMO.ROLE_C' }),
    "/sap/opu/odata/UI2/FDM_PAGE_REPOSITORY_CUST_SRV/roleSet('ZS%3ADEMO.ROLE_C')/catalogs?%24format=json&%24select=id%2CdisplayId%2Ctitle"
  );
  assert.throws(() => buildUrl('fdmRoleCatalogs', { role: 'z_lower' }), RouteViolation);
});

test('a launchpad route fixes its own $select, $expand and $filter: a caller composes none', () => {
  for (const name of routeNames().filter((n) => routeAuthority(TEMPLATES.get(n).path) === 'gateway')) {
    const spec = TEMPLATES.get(name);
    for (const smuggled of ['$select', '$expand', '$filter', '$format', '$batch', 'sap-client']) {
      assert.ok(!spec.params.includes(smuggled), `${name} lets the caller set ${smuggled}`);
    }
    // No route selects a person: FDM carries createdBy, modifiedBy and *Fullname.
    assert.doesNotMatch(String(spec.fixed.$select ?? ''), /created|modified|fullname|user/i, name);
  }
  assert.match(buildUrl('flpGroups'), /%24filter=catalogId\+eq\+%27%2FUI2%2FFLPD_CATALOG%27/);
});

test('the FDM page list is read 50 at a time: the whole list overflows the header limit', () => {
  assert.throws(() => buildUrl('fdmPages', {}), /requires '\$top'/);
  for (const top of ['0', '51', '500', '-1', '1e2']) assert.throws(() => buildUrl('fdmPages', { $top: top }), RouteViolation, top);
  assert.match(buildUrl('fdmPages', { $top: '50', $skip: '100' }), /%24skip=100&%24top=50$/);
});

test('a failing launchpad read names the Gateway catalogue as its authority, not the ADT discovery', async () => {
  const transport = spyTransport({ status: 404, body: 'not found' });
  await assert.rejects(
    () => namedGet(transport, 'flpPage', { id: 'ZDEMO_STOCK' }),
    (e) => /Gateway catalogue/.test(e.message) && !/discovery/.test(e.message)
  );
  assert.equal(transport.seen[0].method, 'GET');
  assert.equal(transport.seen[0].headers.Accept, 'application/json');
});

// --- service bindings (docs/security.md, 2026-11-09) ---------------------------

test('the binding routes: one document, the detail of one version, nothing else', () => {
  assert.equal(buildUrl('serviceBinding', { binding: 'zdemo_ui_o4' }), '/sap/bc/adt/businessservices/bindings/zdemo_ui_o4');
  assert.equal(buildUrl('serviceBinding', { binding: '%2fdmo%2fui_agency_o4' }), '/sap/bc/adt/businessservices/bindings/%2fdmo%2fui_agency_o4');
  assert.equal(TEMPLATES.get('serviceBinding').accept, 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml');
  // The detail path is read and its case matters (measured: lower case answered the not-found
  // row for a published version). Upper case, a namespace as %2F -- exactly what was measured.
  assert.equal(
    buildUrl('serviceBindingDetailV2', { binding: 'ZDEMO_UI_O2', servicename: 'ZDEMO_UI_O2', serviceversion: '0002', srvdname: 'ZDEMO_SRVD' }),
    '/sap/bc/adt/businessservices/odatav2/ZDEMO_UI_O2?servicename=ZDEMO_UI_O2&serviceversion=0002&srvdname=ZDEMO_SRVD'
  );
  assert.equal(
    buildUrl('serviceBindingDetailV4', { binding: '/DMO/UI_DEMO_O4', servicename: 'DemoRun', serviceversion: '0001', srvdname: '/DMO/X' }),
    '/sap/bc/adt/businessservices/odatav4/%2FDMO%2FUI_DEMO_O4?servicename=DemoRun&serviceversion=0001&srvdname=%2FDMO%2FX'
  );
  assert.throws(() => buildUrl('serviceBindingDetailV2', { binding: 'zdemo_ui_o2', servicename: 'X', serviceversion: '0001', srvdname: 'X' }), /Blocked/, 'lower case reads the not-found row');
  for (const k of ['V2', 'V4']) assert.ok(TEMPLATES.get(`serviceBindingDetail${k}`).accept.endsWith(`odata${k.toLowerCase()}.v3+xml`));
  // Every parameter is required: a detail without its version would answer a row for nothing.
  assert.throws(() => buildUrl('serviceBindingDetailV2', { binding: 'ZDEMO_UI_O2', servicename: 'ZDEMO_UI_O2', srvdname: 'X' }), /requires 'serviceversion'/);
  assert.throws(() => buildUrl('serviceBindingDetailV2', { binding: 'ZDEMO_UI_O2', servicename: 'ZDEMO_UI_O2', serviceversion: '2', srvdname: 'X' }), /Blocked/);
  // The actions published next to the detail are not reachable through it.
  for (const binding of ['PUBLISHJOBS/X', '../BINDINGS', 'A?X=1', '/A/B/C']) {
    assert.throws(() => buildUrl('serviceBindingDetailV4', { binding, servicename: 'X', serviceversion: '0001', srvdname: 'X' }), /Blocked/);
  }
  assert.throws(() => buildUrl('serviceBinding', { binding: '/dmo/ui_agency_o4' }), /Blocked/, 'a bare slash is a second segment');
});

test('the full service paths a binding publishes: a V2 namespace or version, a V4 namespace', () => {
  // The exact URLs measured 2026-11-09 (names anonymised): `;v=N` travels literally.
  assert.equal(buildUrl('odataMetadataV2Path', { service: 'sap/ZDEMO_UI_O2;v=2' }), '/sap/opu/odata/sap/ZDEMO_UI_O2;v=2/$metadata');
  assert.equal(buildUrl('odataMetadataV2Path', { service: 'DMO/UI_DEMO_V2' }), '/sap/opu/odata/DMO/UI_DEMO_V2/$metadata');
  assert.equal(buildUrl('odataMetadataV4Path', { service: 'dmo/ui_demo/srvd/dmo/ui_demo/0001' }), '/sap/opu/odata4/dmo/ui_demo/srvd/dmo/ui_demo/0001/$metadata');
  for (const service of ['sap/X;o=1', 'sap/X;v=2;v=3', 'sap/X;v=0', 'DMO/X/Y', '../X', 'dmo/X', 'sap/X%3Bv%3D2']) {
    assert.throws(() => buildUrl('odataMetadataV2Path', { service }), /Blocked/, service);
  }
  // The namespace is written twice and must be the same both times.
  for (const service of ['dmo/x/srvd/sap/x/0001', 'dmo/x/srvd_f4/dmo/x/0001', 'dmo/x/srvd/dmo/x/1', 'dmo/x/srvd/dmo/x/0001/x']) {
    assert.throws(() => buildUrl('odataMetadataV4Path', { service }), /Blocked/, service);
  }
  // Only $metadata: nothing below the two roots is under any authority.
  for (const p of ['/sap/opu/odata/DMO/UI_DEMO_V2', '/sap/opu/odata/DMO', '/sap/opu/odata4/dmo/x']) assert.equal(routeAuthority(p), null, p);
});

test('the check-variant route reads one variant created in the ADT, never its 300 KB form template', () => {
  assert.equal(buildUrl('atcCheckVariant', { name: 'abap_cloud_readiness' }), '/sap/bc/adt/atc/checkvariants/abap_cloud_readiness');
  assert.equal(TEMPLATES.get('atcCheckVariant').accept, 'application/vnd.sap.adt.chkvv4+xml');
  for (const name of ['formtemplate?chkvName=x', 'schema/x', '../customizing', 'ABAP_CLOUD', '']) {
    assert.throws(() => buildUrl('atcCheckVariant', { name }), /Blocked/, name);
  }
});
