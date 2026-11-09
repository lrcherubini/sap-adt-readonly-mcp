// lib/atc.mjs: the parsers over the measured shapes of round 17 (2026-09-14), on synthetic
// bodies with demo names -- no SAP user, no real object. What is asserted: every measured
// field is read, an element or attribute outside the measured set lands in `drift`, and the
// counts per priority agree between the run reply and the worklist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATC_VARIANTS,
  DEFAULT_VARIANT,
  MAX_VERDICTS,
  WORKLIST_ID,
  assertVariant,
  buildRunBody,
  parseRunReply,
  parseWorklist,
  parseCustomizing,
  installAtcVariants,
  installSystemVariant,
  SYSTEM_VARIANT_WHY,
  AtcViolation,
} from '../lib/atc.mjs';

export const CUSTOMIZING = (variant = 'ZDEMO_SYSTEM_CC') =>
  '<?xml version="1.0" encoding="utf-8"?><atc:customizing xmlns:atc="http://www.sap.com/adt/atc"><properties>' +
  '<property name="ciCheckFlavour" value="true"/>' +
  `<property name="systemCheckVariant" value="${variant}"/>` +
  '<property name="isCCSTunnelEnabled" value="false"/>' +
  '</properties><exemption><validities><validity id="U" value="No restriction"/></validities></exemption></atc:customizing>';

export const RUN_REPLY =
  '<?xml version="1.0" encoding="utf-8"?><atcworklist:worklistRun xmlns:atcworklist="http://www.sap.com/abapxml/atc/worklist">' +
  '<atcworklist:worklistId>0123456789ABCDEF0123456789ABCDEF</atcworklist:worklistId>' +
  '<atcworklist:worklistTimestamp>2026-09-14T12:00:00Z</atcworklist:worklistTimestamp>' +
  '<atcworklist:infos><atcinfo:info xmlns:atcinfo="http://www.sap.com/abapxml/atc/info"><atcinfo:type>FINDING_STATS</atcinfo:type><atcinfo:description>1,1,0</atcinfo:description></atcinfo:info></atcworklist:infos>' +
  '</atcworklist:worklistRun>';

const finding = (prio, checkId, msgId, title, line, extra = '') =>
  `<atcfinding:finding xmlns:atcfinding="http://www.sap.com/abapxml/atc/finding" adtcore:uri="/sap/bc/adt/atc/worklists/0123456789ABCDEF0123456789ABCDEF/findings/${checkId}" ` +
  `atcfinding:location="/sap/bc/adt/oo/classes/zcl_demo/source/main?context=%2Fsap%2Fbc%2Fadt%2Foo%2Fclasses%2Fzcl_demo#start=${line},4" ` +
  `atcfinding:processor="" atcfinding:lastChangedBy="" atcfinding:priority="${prio}" atcfinding:checkId="${checkId}" atcfinding:checkTitle="Check ${checkId}" ` +
  `atcfinding:checkClass="CL_CI_TEST_${checkId}" atcfinding:messageId="${msgId}" atcfinding:messageTitle="${title}" atcfinding:exemptionApproval="" ` +
  `atcfinding:exemptionKind="" atcfinding:checksum="1" atcfinding:quickfixInfo="${checkId}:${msgId}"${extra}>` +
  `<atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="/sap/bc/adt/documentation/atc/documents/${checkId}" rel="http://www.sap.com/adt/relations/documentation" type="text/html"/>` +
  '<atcfinding:quickfixes atcfinding:manual="true" atcfinding:automatic="false" atcfinding:pseudo="false"/>' +
  '<atcfinding:tags><atcfinding:tag atcfinding:name="REF_OBJ_NAME" atcfinding:value="ZCL_DEMO"/><atcfinding:tag atcfinding:name="REF_PACKAGE" atcfinding:value="ZDEMO"/></atcfinding:tags>' +
  '</atcfinding:finding>';

export const WORKLIST = (extraFinding = '') =>
  '<?xml version="1.0" encoding="utf-8"?><atcworklist:worklist xmlns:atcworklist="http://www.sap.com/abapxml/atc/worklist" atcworklist:id="0123456789ABCDEF0123456789ABCDEF" atcworklist:timestamp="2026-09-14T12:00:00Z" atcworklist:usedObjectSet="LAST_RUN" atcworklist:objectSetIsComplete="true">' +
  '<atcworklist:objectSets><atcworklist:objectSet atcworklist:name="ALL" atcworklist:title="All Objects" atcworklist:kind="all"/><atcworklist:objectSet atcworklist:name="LAST_RUN" atcworklist:title="Last Check Run" atcworklist:kind="lastRun"/></atcworklist:objectSets>' +
  '<atcworklist:objects><atcobject:object xmlns:atcobject="http://www.sap.com/abapxml/atc/object" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="/sap/bc/adt/atc/objects/R3TR/CLAS/ZCL_DEMO" adtcore:type="CLAS" adtcore:name="ZCL_DEMO" adtcore:packageName="ZDEMO" atcobject:author="DEMO_AUTHOR">' +
  '<atcobject:findings>' +
  finding(1, 'NOAPI', '0001', 'Use of a non-released API', 12) +
  finding(2, 'SELECT', '0002', 'SELECT * without WHERE', 40, extraFinding) +
  '</atcobject:findings></atcobject:object></atcworklist:objects><atcworklist:infos/></atcworklist:worklist>';

test('the variant fence is a closed set, case-folded, and the default is a listed variant', () => {
  assert.equal(assertVariant(undefined), DEFAULT_VARIANT);
  assert.equal(assertVariant(' default '), 'DEFAULT');
  assert.ok(ATC_VARIANTS.has(DEFAULT_VARIANT));
  assert.throws(() => assertVariant('ZZZ_NOPE_17'), AtcViolation);
  assert.throws(() => assertVariant('DEFAULT&x=1'), AtcViolation);
});

test('parseCustomizing reads every property and the system check variant, upper-cased; none is null', () => {
  const c = parseCustomizing(CUSTOMIZING('zdemo_system_cc'));
  assert.equal(c.systemCheckVariant, 'ZDEMO_SYSTEM_CC');
  assert.equal(c.properties.ciCheckFlavour, 'true');
  assert.equal(c.properties.isCCSTunnelEnabled, 'false');
  assert.equal(parseCustomizing(CUSTOMIZING('')).systemCheckVariant, null);
  assert.equal(parseCustomizing('<x/>').systemCheckVariant, null);
  assert.equal(parseCustomizing(undefined).systemCheckVariant, null);
});

test('installSystemVariant admits the system variant and makes it the default, unless the store named one', () => {
  try {
    installAtcVariants([]);
    let r = installSystemVariant('zdemo_system_cc');
    assert.deepEqual(r, { installed: 'ZDEMO_SYSTEM_CC', defaultVariant: 'ZDEMO_SYSTEM_CC', explicitDefault: false });
    assert.equal(ATC_VARIANTS.get('ZDEMO_SYSTEM_CC'), SYSTEM_VARIANT_WHY);
    assert.equal(assertVariant(undefined), 'ZDEMO_SYSTEM_CC', 'the default of a call that names none');

    // The store's explicit default wins; a variant the store lists keeps its purpose, and says it is also the system's.
    installAtcVariants([{ name: 'ZDEMO_DEV', why: 'development practices' }, { name: 'ZDEMO_SYSTEM_CC', why: 'Clean Core governance' }], 'ZDEMO_DEV');
    r = installSystemVariant('ZDEMO_SYSTEM_CC');
    assert.equal(r.defaultVariant, 'ZDEMO_DEV');
    assert.equal(r.explicitDefault, true);
    assert.equal(ATC_VARIANTS.get('ZDEMO_SYSTEM_CC'), `Clean Core governance -- also ${SYSTEM_VARIANT_WHY}`);

    // No system variant changes nothing; DEFAULT as the system variant keeps its own description.
    installAtcVariants([]);
    assert.deepEqual(installSystemVariant(null), { installed: null, defaultVariant: 'DEFAULT', explicitDefault: false });
    const standardWhy = ATC_VARIANTS.get('DEFAULT');
    assert.equal(installSystemVariant('DEFAULT').defaultVariant, 'DEFAULT');
    assert.equal(ATC_VARIANTS.get('DEFAULT'), standardWhy);

    // A name outside the rule is refused, and reinstalling the store drops the system variant.
    assert.throws(() => installSystemVariant('BAD&NAME'), AtcViolation);
    installSystemVariant('ZDEMO_SYSTEM_CC');
    installAtcVariants([]);
    assert.equal(ATC_VARIANTS.has('ZDEMO_SYSTEM_CC'), false);
    assert.equal(DEFAULT_VARIANT, 'DEFAULT');
  } finally {
    installAtcVariants([]);
  }
});

test('buildRunBody interpolates only a validated URI and a bounded count, and freezes the result', () => {
  const b = buildRunBody({ uri: '/sap/bc/adt/programs/programs/zdemo' });
  assert.equal(b.maxVerdicts, MAX_VERDICTS);
  assert.match(b.xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><atc:run maximumVerdicts="100"/);
  assert.match(b.xml, /<objectSet kind="inclusive">/);
  assert.match(b.xml, /adtcore:uri="\/sap\/bc\/adt\/programs\/programs\/zdemo"\/>/);
  assert.ok(Object.isFrozen(b));
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/programs/programs/zdemo', maxVerdicts: 0 }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/programs/programs/zdemo', maxVerdicts: 1.5 }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/programs/programs/zdemo"/><x a="' }), AtcViolation);
  assert.throws(() => buildRunBody({ uri: '/sap/bc/adt/programs/programs/zdemo#frag' }), AtcViolation);
  assert.throws(() => buildRunBody({}), AtcViolation);
});

test('parseRunReply reads the worklist id, the timestamp and the FINDING_STATS per priority', () => {
  const r = parseRunReply(RUN_REPLY);
  assert.equal(r.worklistId, '0123456789ABCDEF0123456789ABCDEF');
  assert.ok(WORKLIST_ID.test(r.worklistId));
  assert.equal(r.timestamp, '2026-09-14T12:00:00Z');
  assert.deepEqual(r.infos, [{ type: 'FINDING_STATS', description: '1,1,0' }]);
  assert.deepEqual(r.byPriority, { 1: 1, 2: 1, 3: 0 });
  assert.equal(parseRunReply('<x/>').byPriority, null);
});

test('parseWorklist reads objects, findings, locations, quickfixes, tags and documentation; no drift on the measured shape', () => {
  const w = parseWorklist(WORKLIST());
  assert.equal(w.id, '0123456789ABCDEF0123456789ABCDEF');
  assert.equal(w.usedObjectSet, 'LAST_RUN');
  assert.equal(w.objectSetIsComplete, true);
  assert.deepEqual(w.objectSets.map((s) => s.name), ['ALL', 'LAST_RUN']);
  assert.equal(w.objects.length, 1);
  assert.equal(w.objects[0].name, 'ZCL_DEMO');
  assert.equal(w.objects[0].package, 'ZDEMO');
  assert.equal(w.findings.length, 2);
  const f = w.findings[0];
  assert.equal(f.object, 'ZCL_DEMO');
  assert.equal(f.priority, 1);
  assert.equal(f.checkId, 'NOAPI');
  assert.equal(f.messageTitle, 'Use of a non-released API');
  assert.deepEqual(f.location, { uri: '/sap/bc/adt/oo/classes/zcl_demo/source/main', context: '/sap/bc/adt/oo/classes/zcl_demo', line: 12, column: 4 });
  assert.equal(f.exemption, null);
  assert.equal(f.quickfixInfo, 'NOAPI:0001');
  assert.deepEqual(f.quickfixes, { manual: true, automatic: false, pseudo: false });
  assert.equal(f.documentation, '/sap/bc/adt/documentation/atc/documents/NOAPI');
  assert.deepEqual(f.tags, { REF_OBJ_NAME: 'ZCL_DEMO', REF_PACKAGE: 'ZDEMO' });
  assert.deepEqual(w.byPriority, { 1: 1, 2: 1, 3: 0 });
  assert.deepEqual(w.byPriority, parseRunReply(RUN_REPLY).byPriority, 'the run stats and the worklist agree');
  assert.deepEqual(w.drift, []);
});

test('parseWorklist reports an element or a finding attribute outside the measured set as drift, and drops nothing', () => {
  const body = WORKLIST(' atcfinding:severity="9"').replace('<atcworklist:infos/>', '<atcworklist:infos/><atcworklist:newThing/>');
  const w = parseWorklist(body);
  assert.equal(w.findings.length, 2);
  assert.deepEqual(w.drift, [
    { node: 'atcworklist:newThing', count: 1, where: 'worklist' },
    { node: 'finding/@atcfinding:severity', count: 1, where: 'worklist' },
  ]);
  const empty = parseWorklist('<atcworklist:worklist xmlns:atcworklist="x" atcworklist:id="0123456789ABCDEF0123456789ABCDEF"><atcworklist:objects/></atcworklist:worklist>');
  assert.equal(empty.findings.length, 0);
  assert.deepEqual(empty.byPriority, { 1: 0, 2: 0, 3: 0 });
});

test('parseWorklist reads noExemption (measured 2026-11-09) as read, not as drift; absent stays null', () => {
  const w = parseWorklist(WORKLIST(' atcfinding:noExemption="true"'));
  assert.deepEqual(w.drift, []);
  assert.equal(w.findings[0].noExemption, null, 'the finding without the attribute');
  assert.equal(w.findings[1].noExemption, true);
  assert.equal(parseWorklist(WORKLIST(' atcfinding:noExemption="false"')).findings[1].noExemption, false);
});

test('parseWorklist tolerates a finding with the bare minimum, a reversed documentation link and every XML escape', () => {
  const minimal =
    '<atcworklist:worklist xmlns:atcworklist="x"><atcworklist:objects><atcobject:object adtcore:name="ZCL_MIN">' +
    '<atcobject:findings><atcfinding:finding atcfinding:priority="3" atcfinding:messageTitle="a &lt;b&gt; &amp; &apos;c&apos; &#x41;&#66; &quot;d&quot;">' +
    '<atom:link href="/doc/x" rel="http://www.sap.com/adt/relations/documentation"/>' +
    '</atcfinding:finding></atcobject:findings></atcobject:object></atcworklist:objects></atcworklist:worklist>';
  const w = parseWorklist(minimal);
  assert.equal(w.id, null);
  assert.equal(w.objectSetIsComplete, false);
  assert.deepEqual(w.objectSets, []);
  const f = w.findings[0];
  assert.equal(f.object, 'ZCL_MIN');
  assert.equal(f.objectType, null);
  assert.equal(f.messageTitle, 'a <b> & \'c\' AB "d"');
  assert.equal(f.location, null);
  assert.equal(f.checkId, null);
  assert.equal(f.documentation, '/doc/x');
  assert.deepEqual(f.quickfixes, { manual: false, automatic: false, pseudo: false });
  assert.deepEqual(f.tags, {});
  assert.deepEqual(w.byPriority, { 1: 0, 2: 0, 3: 1 });
  assert.deepEqual(w.drift, []);
  assert.deepEqual(parseRunReply(null).infos, []);
  assert.equal(parseWorklist(undefined).findings.length, 0);
  const noStart = parseWorklist(minimal.replace('atcfinding:priority="3"', 'atcfinding:priority="3" atcfinding:location="/sap/bc/adt/x/source/main"'));
  assert.deepEqual(noStart.findings[0].location, { uri: '/sap/bc/adt/x/source/main', context: null, line: null, column: null });
  const noCol = parseWorklist(minimal.replace('atcfinding:priority="3"', 'atcfinding:priority="3" atcfinding:location="/sap/bc/adt/x/source/main#start=7"'));
  assert.deepEqual(noCol.findings[0].location, { uri: '/sap/bc/adt/x/source/main', context: null, line: 7, column: null });
});

test('atcPost carries the status of a failed request whichever field the transport put it in, and reads a bare reply', async () => {
  const { atcPost, buildRunBody } = await import('../lib/atc.mjs');
  const failing = (e) => ({ httpClient: { request: async () => { throw e; } } });
  await assert.rejects(() => atcPost(failing(Object.assign(new Error('x'), { response: { status: 503 } })), 'worklist', { variant: 'DEFAULT' }), (e) => e.status === 503);
  await assert.rejects(() => atcPost(failing(Object.assign(new Error('x'), { status: 500, localizedMessage: 'boom' })), 'worklist', { variant: 'DEFAULT' }), /500.*boom/);
  await assert.rejects(() => atcPost(failing(new Error('no status at all')), 'worklist', { variant: 'DEFAULT' }), (e) => e.status === null && /no readable status/.test(e.message));
  await assert.rejects(() => atcPost({}, 'worklist', { variant: 'DEFAULT' }), AtcViolation);
  const bare = { httpClient: { request: async () => ({}) } };
  const out = await atcPost(bare, 'run', { worklistId: '0123456789ABCDEF0123456789ABCDEF', body: buildRunBody({ uri: '/sap/bc/adt/oo/classes/zcl_t' }) });
  assert.equal(out.status, 0);
  assert.equal(out.body, '');
  assert.equal(out.bytes, 0);
  assert.equal(out.contentType, null);
});
