// The annotation index over CDS sources, the one detector that runs on it, and the tool that
// reads those sources from the system (here: a fake ADT client serving the same texts).
//
// Every shape here was measured in the 24 ABAP checkouts of a measured workspace on
// 2026-09-09, not invented from the CDS grammar. The three that cost the most if got
// wrong, in the order they were discovered:
//
//   1. an annotation whose VALUE contains a brace, written before the element block --
//      the parser took that brace for the element block and returned zero elements, so
//      three real DDLX read as "this view annotates nothing";
//   2. `association` treated as a propagating edge -- seven false positives on one
//      element, refuted against the live chain;
//   3. indexing only `UI.*` -- whole families exist ONLY inline in the .ddls, including
//      the very one adt_value_help reasons about.
//
// A test that only proves the detector finds the two known defects would pass on all
// three of those mistakes. So the agnosticism is asserted directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexSources, reaching, upstreamOf, missingUpstream, PROPAGATING } from '../lib/annotation-index.mjs';
import { detectHiddenWithRole, findingForHidden } from '../lib/annotation-detectors.mjs';
import { runAnnotationScan, resetAnnotationIndexCache } from '../tools/annotation-scan.mjs';

/**
 * A miniature of the measured workspace shape:
 *
 *   ZI_Base            hides Plant and Channel in its own DDLX (the upstream hide)
 *   ZC_Armed           projection on ZI_Base, gives Plant a lineItem     -> ARMED
 *   ZC_Held            the same, plus ignorePropagatedAnnotations: true  -> HELD
 *   ZC_Assoc           only ASSOCIATES ZI_Base, gives Plant a lineItem   -> nothing
 *   ZC_Inline          hides a criticality field inline, no display role -> nothing
 *   ZC_Button          hidden upstream, lineItem is #FOR_ACTION only     -> nothing
 *
 * The DDLX of ZC_Armed is written in the shape that broke the parser: a
 * `@Consumption.valueHelpDefinition` whose value carries a brace, before the element
 * block, after a `parameters` clause.
 */
function tinyWorkspace() {
  // file name -> source text; `zi_base.ddlx` is the DDLX of the same name, as the system lists it.
  const root = {};
  const put = (name, lines) => {
    root[name] = lines.join('\n');
  };

  put('zi_base.ddls.asddls', [
    'define view entity ZI_Base',
    '  as select from ztbl_stock',
    '{',
    '  key Plant;',
    '  Channel;',
    '  AvailCriticality;',
    '}',
  ]);
  put('zi_base.ddlx.asddlxs', [
    'annotate entity ZI_Base with',
    '{',
    '  @UI.hidden: true',
    '  Plant;',
    '  @UI.hidden: true',
    '  Channel;',
    '}',
  ]);

  for (const [file, name, extra] of [
    ['zc_armed', 'ZC_Armed', ''],
    ['zc_held', 'ZC_Held', '@Metadata.ignorePropagatedAnnotations: true'],
  ]) {
    put(`${file}.ddls.asddls`, [
      extra,
      `define view entity ${name}`,
      '  as projection on ZI_Base',
      '{',
      '  key Plant;',
      '  Channel;',
      '}',
    ]);
    // The shape that broke the parser: parameters, then an annotation whose value opens
    // a brace, and only THEN the element block.
    put(`${file}.ddlx.asddlxs`, [
      `annotate entity ${name} with`,
      "@Consumption.valueHelpDefinition: [{ entity: { name: 'I_PlantVH', element: 'Plant' } }]",
      '{',
      '  @UI.lineItem: [{ position: 10, importance: #HIGH }]',
      '  @UI.selectionField: [{ position: 10 }]',
      '  Plant;',
      '}',
    ]);
  }

  // Associates rather than selects from. Measured: an element annotation does NOT travel
  // this edge, because the association puts no element in the select list.
  put('zc_assoc.ddls.asddls', [
    'define view entity ZC_Assoc',
    '  as select from ztbl_other',
    '  association [0..1] to ZI_Base as _Base on 1 = 1',
    '{',
    '  key Plant;',
    '}',
  ]);
  put('zc_assoc.ddlx.asddlxs', [
    'annotate entity ZC_Assoc with',
    '{',
    '  @UI.lineItem: [{ position: 10 }]',
    '  Plant;',
    '}',
  ]);

  // A criticality field hidden inline, with no display role of its own. This is the
  // shape of all ten inline @UI.hidden measured in the workspace, and none of them is a
  // defect: the field feeds a colour, it is not meant to render.
  put('zc_inline.ddls.asddls', [
    'define view entity ZC_Inline',
    '  as projection on ZI_Base',
    '{',
    '  key Plant;',
    '  @UI.hidden: true',
    '  AvailCriticality;',
    '}',
  ]);

  // Hidden upstream, and the only lineItem entry is a button anchored on the element.
  // Hiding the element does not contradict a button, so this is not a finding.
  put('zc_button.ddls.asddls', [
    'define view entity ZC_Button',
    '  as projection on ZI_Base',
    '{',
    '  key Channel;',
    '}',
  ]);
  put('zc_button.ddlx.asddlxs', [
    'annotate entity ZC_Button with',
    '{',
    "  @UI.lineItem: [{ position: 10, type: #FOR_ACTION, dataAction: 'go' }]",
    '  Channel;',
    '}',
  ]);

  return { root };
}

/** `<name>.<ddls|ddlx>[.as...]` -> the object the system would list for it. */
const objectOf = (file) => {
  const [base, ext] = file.split('.');
  return { name: base.toUpperCase(), type: ext === 'ddlx' ? 'DDLX/EX' : 'DDLS/DF', layer: ext === 'ddlx' ? 'ddlx' : 'ddls' };
};
/** Index the texts directly, the way the tool does after reading them. */
const indexOf = (root) =>
  indexSources(Object.entries(root).map(([f, text]) => {
    const o = objectOf(f);
    return { file: `ZTEST/${o.name.toLowerCase()}.${o.layer}`, repo: 'ZTEST', layer: o.layer, text };
  }));
const stateOf = (rows, entity, element) =>
  rows.find((r) => r.entity === entity && r.element === element)?.state ?? null;

const COLLECTION = { 'DDLS/DF': '/sap/bc/adt/ddic/ddl/sources/', 'DDLX/EX': '/sap/bc/adt/ddic/ddlx/sources/' };
/** A fake ADT client: package ZTEST lists the files' objects and serves their sources. */
function apiFor(root, { failing = [], calls = { list: 0, read: 0 } } = {}) {
  const objs = Object.entries(root).map(([f, text]) => ({ ...objectOf(f), text }));
  const uriOf = (o) => `${COLLECTION[o.type]}${o.name.toLowerCase()}`;
  return {
    calls,
    nodeContents: async (_t, pkg) => {
      calls.list++;
      return { nodes: pkg === 'ZTEST' ? objs.map((o) => ({ OBJECT_NAME: o.name, OBJECT_TYPE: o.type, OBJECT_URI: uriOf(o) })) : [] };
    },
    getObjectSource: async (uri) => {
      calls.read++;
      const o = objs.find((x) => `${uriOf(x)}/source/main` === uri);
      if (!o) throw Object.assign(new Error(`404 ${uri} not found`), { status: 404 });
      if (failing.includes(o.name)) throw Object.assign(new Error(`500 ${uri} failed`), { status: 500 });
      return o.text;
    },
  };
}
const cfg = (sink) => ({ budget: { reads: 1000 }, auditSink: () => {}, journalSink: sink, paths: {} });

// --- the parser defect this index was blocked on ------------------------------

test('an annotation whose value opens a brace is not mistaken for the element block', () => {
  // The measured defect, in miniature. Before the fix these three DDLX parsed to zero
  // elements and the index reported the views as annotation-free -- a confident wrong
  // answer, which is the one failure mode this server exists to refuse.
  const { root } = tinyWorkspace();
  const index = indexOf(root);
  const armed = index.entities.get('ZC_ARMED');

  assert.ok(armed.elements.has('plant'), 'the element block was found past the annotation value');
  const keys = [...armed.elements.get('plant').keys.values()].map((k) => k.key).sort();
  assert.deepEqual(keys, ['UI.lineItem', 'UI.selectionField']);
  assert.deepEqual(index.unread, [], 'nothing was silently unread');
});

// --- agnosticism, asserted directly -------------------------------------------

test('the index carries any annotation family, from either layer', () => {
  // Measured across the workspace: 342 Semantics.quantity.unitOfMeasure, 18
  // ObjectModel.text.element, 15 Consumption.valueHelpDefinition -- every one of them
  // written INLINE, none in a DDLX. An index that only understood UI.* would pass every
  // detector test in this file and still be wrong.
  const index = indexOf({
    'zi_fam.ddls.asddls': [
      'define view entity ZI_Fam as select from ztbl {',
      "  @Semantics.quantity.unitOfMeasure: 'Unit'",
      '  @Search.defaultSearchElement: true',
      "  @ObjectModel.text.element: [ 'Name' ]",
      '  @Consumption.hidden: true',
      '  key Qty;',
      '}',
    ].join('\n'),
  });
  const keys = [...index.entities.get('ZI_FAM').elements.get('qty').keys.values()].map((k) => k.key);
  assert.deepEqual(keys.sort(), [
    'Consumption.hidden',
    'ObjectModel.text.element',
    'Search.defaultSearchElement',
    'Semantics.quantity.unitOfMeasure',
  ]);
  assert.equal(
    keys.some((k) => k.startsWith('UI.')),
    false,
    'not one UI annotation here, and the index still has four keys'
  );
});

test('an annotation key is matched case-insensitively', () => {
  // The workspace census holds both Search.defaultSearchElement and
  // Search.DefaultSearchElement. Two spellings of one annotation are one annotation.
  const { root } = tinyWorkspace();
  const index = indexOf(root);
  const upper = reaching(index, 'ZC_ARMED', 'Plant', { key: 'ui.LINEITEM' });
  const lower = reaching(index, 'ZC_ARMED', 'Plant', { key: 'UI.lineitem' });
  assert.equal(upper.length, 1);
  assert.deepEqual(
    upper.map((r) => r.key),
    lower.map((r) => r.key)
  );
});

// --- which edges carry an element annotation ----------------------------------

test('association is not a propagating edge, and that is what keeps the index honest', () => {
  // Refuted against the live chain: walking associations reported ZC_DemoEmployee/Stcd2
  // as hit by seven upstream DDLX, and the system returned no UI.HIDDEN at all.
  assert.deepEqual([...PROPAGATING].sort(), ['from', 'join', 'projection']);
  const { root } = tinyWorkspace();
  const index = indexOf(root);
  // ZC_Assoc selects from ztbl_other and ASSOCIATES ZI_Base. The first is upstream; the
  // second must not be, or the hide written in ZI_Base's DDLX would travel to it.
  assert.deepEqual(upstreamOf(index, 'ZC_Assoc').map((u) => u.name), ['ZTBL_OTHER']);
  // Transitive along propagating edges: ZC_Armed projects on ZI_Base, which selects from
  // ztbl_stock. Depth is reported so a distant match can be weighed, not so it is cut.
  assert.deepEqual(
    upstreamOf(index, 'ZC_Armed').map((u) => `${u.name}@${u.depth}`),
    ['ZI_BASE@1', 'ZTBL_STOCK@2']
  );
  assert.equal(
    reaching(index, 'ZC_Assoc', 'Plant').some((r) => r.key === 'UI.hidden'),
    false,
    'the upstream hide does not reach across an association'
  );
});

test('reaching says which layer wrote each key, and how far upstream', () => {
  const { root } = tinyWorkspace();
  const rows = reaching(indexOf(root), 'ZC_Armed', 'Plant');
  const hidden = rows.find((r) => r.key === 'UI.hidden');
  const role = rows.find((r) => r.key === 'UI.lineItem');
  assert.equal(hidden.from, 'ZI_Base');
  assert.equal(hidden.depth, 1, 'written one propagating hop upstream');
  assert.equal(hidden.layer, 'ddlx');
  assert.equal(role.depth, 0, 'written on the view itself');
  assert.ok(role.line > 0, 'a backlog row needs somewhere to click');
});

// --- what can reach an element -------------------------------------------------

/**
 * The views measured against the chain on 2026-11-17 (docs/adt-api-reference.md, "What reaches
 * a CDS element"). ZDEMO_I_CHANNELUP hides Channel in its DDLX and gives it a lineItem and a
 * selectionField; each top view asks for Channel through a different view in between.
 *
 *   ZDEMO_C_CHANCTRL    nothing in between                  chain: the three UI.* arrive
 *   ZDEMO_C_CHANPARIGN  parameter + ignorePropagated (#1)   chain: none of them
 *   ZDEMO_C_CHANPAR     parameter only                      chain: none of them
 *   ZDEMO_C_CHANIGN     ignorePropagated only               chain: all three, silenced
 */
function channelWorkspace() {
  const root = {};
  const put = (name, lines) => {
    root[name] = lines.join('\n');
  };
  put('zdemo_i_channelup.ddls.asddls', [
    '@Metadata.allowExtensions: true',
    'define view entity ZDEMO_I_CHANNELUP',
    '  as select from tvtw',
    '{',
    '  key vtweg as Channel',
    '}',
  ]);
  put('zdemo_i_channelup.ddlx.asddlxs', [
    '@Metadata.layer: #CORE',
    'annotate entity ZDEMO_I_CHANNELUP with',
    '{',
    '  @UI.hidden: true',
    '  @UI.lineItem: [{ position: 10 }]',
    '  @UI.selectionField: [{ position: 10 }]',
    '  Channel;',
    '}',
  ]);
  const withParameter = (name, ignore) => [
    ...(ignore ? ['@Metadata.ignorePropagatedAnnotations: true'] : []),
    `define view entity ${name}`,
    '  with parameters',
    '    p_channel : vtweg',
    '  as select from ZDEMO_I_CHANNELUP',
    '{',
    '  key Channel              as SourceChannel,',
    '      $parameters.p_channel as Channel',
    '}',
  ];
  put('zdemo_i_chanparign.ddls.asddls', withParameter('ZDEMO_I_CHANPARIGN', true));
  put('zdemo_i_chanpar.ddls.asddls', withParameter('ZDEMO_I_CHANPAR', false));
  put('zdemo_i_chanign.ddls.asddls', [
    '@Metadata.ignorePropagatedAnnotations: true',
    'define view entity ZDEMO_I_CHANIGN',
    '  as select from ZDEMO_I_CHANNELUP',
    '{',
    '  key Channel',
    '}',
  ]);
  for (const [top, base, params] of [
    ['ZDEMO_C_CHANCTRL', 'ZDEMO_I_CHANNELUP', false],
    ['ZDEMO_C_CHANPARIGN', 'ZDEMO_I_CHANPARIGN', true],
    ['ZDEMO_C_CHANPAR', 'ZDEMO_I_CHANPAR', true],
    ['ZDEMO_C_CHANIGN', 'ZDEMO_I_CHANIGN', false],
  ]) {
    put(`${top.toLowerCase()}.ddls.asddls`, [
      `define view entity ${top}`,
      ...(params ? ['  with parameters p_channel : vtweg'] : []),
      `  as select from ${base}${params ? '( p_channel: $parameters.p_channel )' : ''}`,
      '{',
      params ? '  key SourceChannel,' : '  key Channel',
      ...(params ? ['      Channel'] : []),
      '}',
    ]);
  }
  return root;
}

const upstreamUi = (index, entity) =>
  reaching(index, entity, 'Channel').filter((r) => r.from === 'ZDEMO_I_CHANNELUP');

test('with nothing in between, the upstream rows reach the element unmarked', () => {
  const rows = upstreamUi(indexOf(channelWorkspace()), 'ZDEMO_C_CHANCTRL');
  assert.deepEqual(rows.map((r) => r.key), ['UI.hidden', 'UI.lineItem', 'UI.selectionField']);
  assert.ok(rows.every((r) => !r.unreachable && !r.heldBy && !r.unverified));
  assert.ok(rows.every((r) => r.depth === 1), 'depth counts hops from the asked view');
});

test('a parameter projection is unreachable from above, ignore or not (issue #1)', () => {
  const index = indexOf(channelWorkspace());
  for (const top of ['ZDEMO_C_CHANPARIGN', 'ZDEMO_C_CHANPAR']) {
    const rows = upstreamUi(index, top);
    assert.equal(rows.length, 3, `${top}: the rows are listed, not dropped`);
    for (const r of rows) {
      assert.equal(r.unreachable?.reason, 'parameter', top);
      assert.match(r.unreachable.entity, /^ZDEMO_I_CHANPAR/, 'names the view that projects the parameter');
      assert.equal(r.heldBy, undefined, 'the parameter is checked before the ignore');
      assert.equal(r.depth, 2, 'two hops: the asked view, the base view, the source');
    }
  }
});

test('ignorePropagatedAnnotations in a view in between holds what is above it', () => {
  const rows = upstreamUi(indexOf(channelWorkspace()), 'ZDEMO_C_CHANIGN');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.heldBy?.entity === 'ZDEMO_I_CHANIGN'));
  assert.ok(rows.every((r) => r.heldBy.by === 'ignorePropagatedAnnotations'));
});

test('a renamed element is followed under the name it has upstream', () => {
  const index = indexOf({
    'zdemo_i_src.ddls.asddls': ['define view entity ZDEMO_I_SRC as select from t001w {', '  @UI.hidden: true', '  key werks as Werks', '}'].join('\n'),
    'zdemo_c_ren.ddls.asddls': ['define view entity ZDEMO_C_REN as select from ZDEMO_I_SRC {', '  key Werks as Plant', '}'].join('\n'),
    'zdemo_c_same.ddls.asddls': ['define view entity ZDEMO_C_SAME as select from ZDEMO_I_SRC as s {', '  key s.Werks', '}'].join('\n'),
  });
  assert.deepEqual(reaching(index, 'ZDEMO_C_REN', 'Plant').map((r) => `${r.key}@${r.from}`), ['UI.hidden@ZDEMO_I_SRC']);
  assert.equal(reaching(index, 'ZDEMO_C_REN', 'Werks').length, 0, 'the view has no element Werks');
  assert.equal(reaching(index, 'ZDEMO_C_SAME', 'Werks').length, 1, 'a qualified field is a field');
});

test('an element computed by an expression is listed as unverified, never as reaching', () => {
  const index = indexOf({
    'zdemo_i_src.ddls.asddls': ['define view entity ZDEMO_I_SRC as select from t001w {', '  @UI.hidden: true', '  key werks as Werks', '}'].join('\n'),
    'zdemo_c_cast.ddls.asddls': [
      'define view entity ZDEMO_C_CAST as select from ZDEMO_I_SRC {',
      '  key cast( Werks as abap.char(4) ) as Werks',
      '}',
    ].join('\n'),
  });
  const [row] = reaching(index, 'ZDEMO_C_CAST', 'Werks');
  assert.deepEqual(row.unverified, { entity: 'ZDEMO_C_CAST', reason: 'expression' });
});

test('a view reached along an open path and a held one reaches', () => {
  const index = indexOf({
    'zdemo_i_src.ddls.asddls': ['define view entity ZDEMO_I_SRC as select from t001w {', '  @UI.hidden: true', '  key Plant', '}'].join('\n'),
    'zdemo_i_held.ddls.asddls': ['@Metadata.ignorePropagatedAnnotations: true', 'define view entity ZDEMO_I_HELD as select from ZDEMO_I_SRC {', '  key Plant', '}'].join('\n'),
    'zdemo_c_both.ddls.asddls': [
      'define view entity ZDEMO_C_BOTH as select from ZDEMO_I_HELD',
      '  inner join ZDEMO_I_SRC on ZDEMO_I_HELD.Plant = ZDEMO_I_SRC.Plant',
      '{',
      '  key ZDEMO_I_HELD.Plant',
      '}',
    ].join('\n'),
  });
  const rows = reaching(index, 'ZDEMO_C_BOTH', 'Plant');
  assert.equal(rows.length, 1, 'one source, one row');
  assert.equal(rows[0].heldBy, undefined, 'the join reaches it directly');
});

test('lookup mode marks each row that cannot reach, and counts them (issue #1)', async () => {
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg(), apiFor(channelWorkspace()), { package: 'ZTEST', entity: 'ZDEMO_C_CHANPARIGN', element: 'Channel' });
  assert.equal(out.rows.length, 3);
  assert.ok(out.rows.every((r) => r.unreachable?.reason === 'parameter'));
  assert.deepEqual([out.reaching, out.unreachable, out.held, out.unverified], [0, 3, 0, 0]);
  resetAnnotationIndexCache();
});

// --- the detector --------------------------------------------------------------

test('hidden upstream with a display role downstream comes out ARMED', () => {
  const { root } = tinyWorkspace();
  const rows = detectHiddenWithRole(indexOf(root));
  assert.equal(stateOf(rows, 'ZC_Armed', 'Plant'), 'ARMED');
  const hit = rows.find((r) => r.entity === 'ZC_Armed');
  assert.deepEqual(hit.roles, ['ui.lineitem', 'ui.selectionfield']);
  assert.equal(hit.depth, 1);
  // The row points at a line that carries a DISPLAY role. Measured on
  // ZI_DemoStockRecon/Channel: the first ui.* row there is a UI.facet, which this very
  // detector excludes from being a role -- pointing at it would send a reader astray.
  assert.match(hit.file, /zc_armed\.ddlx/);
});

test('ignorePropagatedAnnotations makes it HELD, which is not the same as clean', () => {
  const { root } = tinyWorkspace();
  const rows = detectHiddenWithRole(indexOf(root));
  assert.equal(stateOf(rows, 'ZC_Held', 'Plant'), 'HELD');
  const finding = findingForHidden(rows.find((r) => r.entity === 'ZC_Held'));
  assert.equal(finding.code, 'ANNOTATION_HIDDEN_HELD');
  assert.match(finding.effect, /re-arms it/, 'the effect names what removing that line does');
});

test('an inline @UI.hidden with no display role is not a finding, and the reason is the role', () => {
  // All ten inline @UI.hidden measured in the workspace are of this shape: a criticality
  // or flag field that feeds a colour and is not meant to render. None is a defect.
  // Nothing here may look at the element NAME or at which layer the hide was written in
  // -- both are legal, and neither means anything.
  const { root } = tinyWorkspace();
  const index = indexOf(root);
  const rows = detectHiddenWithRole(index);
  assert.equal(stateOf(rows, 'ZC_Inline', 'AvailCriticality'), null);

  const reached = reaching(index, 'ZC_Inline', 'AvailCriticality');
  assert.equal(
    reached.some((r) => r.key === 'UI.hidden'),
    true,
    'the hide IS indexed -- it is the missing display role that clears it, not a blind spot'
  );
  assert.equal(reached.some((r) => /^UI\.(lineItem|selectionField)/.test(r.key)), false);
});

test('a lineItem that is only a button does not contradict a hide', () => {
  const { root } = tinyWorkspace();
  const rows = detectHiddenWithRole(indexOf(root));
  assert.equal(stateOf(rows, 'ZC_Button', 'Channel'), null);
});

// --- the tool: the sources come from the system ---------------------------------

test('lookup mode lists the layers and picks no winner', async () => {
  const { root } = tinyWorkspace();
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg(), apiFor(root), { package: 'ZTEST', entity: 'ZC_Armed', element: 'Plant' });
  assert.equal(out.mode, 'lookup');
  assert.deepEqual(
    out.rows.map((r) => `${r.annotation}@${r.writtenBy}`).sort(),
    ['UI.hidden@ZI_Base', 'UI.lineItem@ZC_Armed', 'UI.selectionField@ZC_Armed']
  );
  assert.equal(out.reminder, undefined, "the fixed reading of the answer is the tool's description and docs/tools.md, not a field of every answer");
  assert.equal(out.scope.package, 'ZTEST');
  assert.equal(out.complete, true);
});

test('an entity in neither the package nor upstream is said to be missing, not answered as empty', async () => {
  const { root } = tinyWorkspace();
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg(), apiFor(root), { package: 'ZTEST', entity: 'ZC_NotHere', element: 'Plant' });
  assert.deepEqual(out.rows, []);
  assert.match(out.reminder, /is in ZTEST or upstream/);
  assert.match(out.reminder, /adt_object_info/, 'and it names the route that would answer');
});

test('detect mode journals one finding per hit, ARMED and HELD under different codes, on the scanned package', async () => {
  const { root } = tinyWorkspace();
  const lines = [];
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg((l) => lines.push(l)), apiFor(root), { package: 'ZTEST' }, journalFor(lines));
  assert.equal(out.armed, 1);
  assert.equal(out.held, 1);
  const findings = lines.filter((l) => /^ANNOTATION_/.test(l.code));
  assert.deepEqual(findings.map((l) => l.code).sort(), ['ANNOTATION_HIDDEN_HELD', 'ANNOTATION_HIDDEN_WITH_ROLE']);
  assert.ok(findings.every((f) => f.repo === 'ZTEST'), 'a later complete scan of ZTEST is what retires them');
});

test('upstream views are read on demand, so a hide written in a standard view is seen too', async () => {
  // ZC_Std projects on a STANDARD view the package does not hold; its source comes upstream.
  const root = {
    'zc_std.ddls.asddls': ['define view entity ZC_Std', '  as projection on I_DemoStd', '{', '  key Plant;', '}'].join('\n'),
    'zc_std.ddlx.asddlxs': ['annotate entity ZC_Std with', '{', '  @UI.lineItem: [{ position: 10 }]', '  Plant;', '}'].join('\n'),
  };
  const upstream = {
    'i_demostd.ddls.asddls': ['define view entity I_DemoStd', '  as select from t001w', '{', '  @UI.hidden: true', '  key Plant;', '}'].join('\n'),
  };
  const api = apiFor({ ...root, ...upstream });
  const listOnly = api.nodeContents;
  api.nodeContents = async (t, p) => {
    const r = await listOnly(t, p);
    return { nodes: r.nodes.filter((n) => n.OBJECT_NAME !== 'I_DEMOSTD') };
  };
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg(), api, { package: 'ZTEST' });
  assert.equal(out.scope.upstream.read, 1);
  assert.equal(out.armed, 1, 'the hide in the standard view reaches the display role downstream');
  assert.ok(out.scope.upstream.notFound.includes('T001W'), 'a table has no DDLS: listed apart, not a hole');
  assert.deepEqual(out.scope.upstream.notRead, []);
  assert.equal(out.complete, true, 'a table answering 404 is not incompleteness');
  resetAnnotationIndexCache();
  const none = await runAnnotationScan(cfg(), api, { package: 'ZTEST', upstream: 0 });
  assert.equal(none.armed, 0, 'upstream: 0 reads nothing upstream');
  assert.deepEqual(none.scope.upstream.notFollowed, ['I_DEMOSTD']);
  assert.equal(none.complete, false);
  assert.deepEqual(none.incomplete.map((i) => `${i.list}:${i.code}`), ['upstream:BUDGET_REACHED']);
});

test('a source that declares elements and parses to none is a gap, not a clean answer', async () => {
  // The failure this whole cycle turned on: silently returning {} makes a broken read
  // look exactly like a view with no annotations. CDS_PARSE_EMPTY says "I could not read
  // it" instead, and names the other tool that reads through the same parser.
  const root = { 'zc_broken.ddlx.asddlxs': ['annotate entity ZC_Broken with', '  Plant;', '  Channel;', '  Storage;', '  Sku;'].join('\n') };
  const lines = [];
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg((l) => lines.push(l)), apiFor(root), { package: 'ZTEST' }, journalFor(lines));
  assert.equal(out.scope.unreadSources.length, 1);
  const gap = lines.find((l) => l.code === 'CDS_PARSE_EMPTY');
  assert.ok(gap, 'the gap is journaled');
  assert.match(gap.impact, /adt_value_help/, 'it names the other reader of the same parser');
  resetAnnotationIndexCache();
});

test('key or entity without element is refused, because it would silently do something else', async () => {
  const { root } = tinyWorkspace();
  const { annotationScanTool } = await import('../tools/annotation-scan.mjs');
  const tool = annotationScanTool(cfg(), apiFor(root), null);
  await assert.rejects(() => tool.handler({ package: 'ZTEST', key: 'UI.' }), /pass `element` too/);
  await assert.rejects(() => tool.handler({ package: 'ZTEST', entity: 'ZC_Armed' }), /pass `element` too/);
});

// --- degradation, which is the only failure mode that looks like success ------

test('an object the system does not return is a gap of its own, and the scope says incomplete', async () => {
  // An index that read less than it was asked to read and says nothing produces a
  // CLEANER answer than the truth -- fewer annotations, so fewer contradictions.
  const { root } = tinyWorkspace();
  const lines = [];
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg((l) => lines.push(l)), apiFor(root, { failing: ['ZI_BASE'] }), { package: 'ZTEST' }, journalFor(lines));
  assert.equal(out.complete, false);
  assert.deepEqual(out.scope.notRead.map((n) => n.object), ['DDLS/DF ZI_BASE', 'DDLX/EX ZI_BASE']);
  const gaps = lines.filter((l) => l.code === 'SOURCE_NOT_READ');
  assert.equal(gaps.length, 2);
  assert.match(gaps[0].impact, /a floor, not a total/);
  resetAnnotationIndexCache();
});

test('the object cap is a gap too: part of the package is not the package', async () => {
  const { root } = tinyWorkspace();
  const lines = [];
  resetAnnotationIndexCache();
  const out = await runAnnotationScan(cfg((l) => lines.push(l)), apiFor(root), { package: 'ZTEST', maxObjects: 3, upstream: 0 }, journalFor(lines));
  assert.equal(out.scope.read, 3);
  assert.equal(out.scope.skipped, Object.keys(root).length - 3);
  assert.ok(lines.some((l) => l.code === 'SCAN_AT_CAP'));
  resetAnnotationIndexCache();
});

test('the index is kept for follow-up lookups, and refresh rebuilds it', async () => {
  const { root } = tinyWorkspace();
  const calls = { list: 0, read: 0 };
  const api = apiFor(root, { calls });
  resetAnnotationIndexCache();
  await runAnnotationScan(cfg(), api, { package: 'ZTEST', element: 'Plant' });
  const reads = calls.read;
  const again = await runAnnotationScan(cfg(), api, { package: 'ZTEST', element: 'Channel' });
  assert.equal(calls.read, reads, 'the second lookup read nothing');
  assert.equal(again.scope.cached, true);
  assert.equal(typeof again.scope.ageSeconds, 'number');
  await runAnnotationScan(cfg(), api, { package: 'ZTEST', element: 'Plant', refresh: true });
  assert.ok(calls.read > reads);
  resetAnnotationIndexCache();
});

test('missingUpstream names exactly the views to read next', () => {
  const { root } = tinyWorkspace();
  assert.deepEqual(missingUpstream(indexOf(root)), ['ZTBL_OTHER', 'ZTBL_STOCK']);
});

/** A journal that records into `lines`, in the shape lib/journal.mjs hands out. */
function journalFor(lines) {
  return {
    enabled: true,
    finding: (f) => lines.push(f),
    gap: (g) => lines.push(g),
    call: () => {},
    counts: () => ({ findings: 0, gaps: 0 }),
  };
}
