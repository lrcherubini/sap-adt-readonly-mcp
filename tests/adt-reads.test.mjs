// lib/adt-reads.mjs: the guard's members written over the closed seams, in the library's shapes,
// and the one object that mixes them with what the library still serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownReads, splitSourceUri, OWN_READS } from '../lib/adt-reads.mjs';
import { readOnly, allowedMethods, ReadOnlyViolation } from '../lib/guard.mjs';

function fakeRaw(answer = () => ({ status: 200, body: 'REPORT zdemo.', headers: { 'content-type': 'text/plain' } })) {
  const calls = [];
  return {
    calls,
    httpClient: {
      request: async (url, opts) => {
        calls.push({ url, ...opts });
        return answer(url, opts);
      },
    },
  };
}

test('getObjectSource reads the source URI it is given, with the Accept the library sent, and answers the text', async () => {
  const raw = fakeRaw();
  const reads = ownReads(raw);
  for (const uri of [
    '/sap/bc/adt/programs/programs/zdemo_report/source/main',
    '/sap/bc/adt/oo/classes/zcl_demo/includes/definitions',
    '/sap/bc/adt/oo/classes/%2fdemo%2fcl_x/source/main',
    '/sap/bc/adt/functions/groups/zdemo_fg/fmodules/zdemo_fm/source/main',
    '/sap/bc/adt/ddic/srvd/sources/zdemo_ui/source/main',
  ]) {
    assert.equal(await reads.getObjectSource(uri), 'REPORT zdemo.');
    assert.equal(raw.calls.at(-1).url, uri);
    assert.equal(raw.calls.at(-1).method, 'GET');
    assert.deepEqual(raw.calls.at(-1).headers, { Accept: '*/*' });
  }
});

test('getObjectSource refuses what is not a source URI before anything is sent', async () => {
  const raw = fakeRaw();
  const reads = ownReads(raw);
  for (const bad of [
    '/sap/bc/adt/oo/classes/zcl_demo',
    '/sap/bc/adt/oo/classes/zcl_demo/source/main?version=inactive',
    '/sap/bc/adt/oo/classes/zcl_demo/../x/source/main',
    '/sap/opu/odata/sap/x/source/main',
    '/sap/bc/adt/oo/classes/zcl_demo/includes/locals_imp_x/../../y',
  ]) {
    await assert.rejects(() => reads.getObjectSource(bad), (e) => e.name === 'RouteViolation', bad);
  }
  assert.equal(raw.calls.length, 0);
  assert.equal(splitSourceUri('/x'), null);
});

test('a refused read keeps its status for the callers and the dump lookup', async () => {
  const raw = fakeRaw(() => {
    throw Object.assign(new Error('HTTP 404'), { err: 404, status: 404 });
  });
  const e = await ownReads(raw).getObjectSource('/sap/bc/adt/programs/programs/zdemo/source/main').catch((x) => x);
  assert.equal(e.status, 404);
});

test('the guard wraps exactly these reads: every one allowlisted, nothing else reachable', async () => {
  const reads = ownReads(fakeRaw());
  assert.deepEqual(Object.keys(reads).sort(), [...OWN_READS].sort());
  assert.deepEqual([...OWN_READS].sort(), allowedMethods(), 'the allowlist names the reads, and only them');
  const api = readOnly(reads);
  assert.equal(await api.getObjectSource('/sap/bc/adt/programs/programs/zdemo/source/main'), 'REPORT zdemo.');
  for (const m of ['lock', 'httpClient', 'setObjectSource', 'username', 'baseUrl']) assert.throws(() => api[m], ReadOnlyViolation, m);
  assert.throws(() => {
    api.getObjectSource = () => 'x';
  }, ReadOnlyViolation);
});

test('searchObject asks the quick search with the major type, as the library did, and keeps every hit field', async () => {
  const body =
    '<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo" adtcore:type="CLAS/OC" adtcore:name="ZCL_DEMO" adtcore:packageName="ZDEMO_PKG" adtcore:description="Demo &amp; test"/>' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zdemo" adtcore:type="PROG/P" adtcore:name="ZDEMO (Old style)"/>' +
    '<adtcore:objectReference adtcore:uri="/sap/bc/adt/x/0001" adtcore:type="X" adtcore:name="0001" adtcore:description="42"/>' +
    '</adtcore:objectReferences>';
  const raw = fakeRaw(() => ({ status: 200, body, headers: { 'content-type': 'application/xml' } }));
  const hits = await ownReads(raw).searchObject('ZCL_DEMO*', 'CLAS/OC', 5);
  assert.equal(raw.calls[0].url, '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&maxResults=5&objectType=CLAS&query=ZCL_DEMO*');
  assert.deepEqual(raw.calls[0].headers, { Accept: 'application/*' });
  assert.deepEqual(hits[0], {
    'adtcore:uri': '/sap/bc/adt/oo/classes/zcl_demo',
    'adtcore:type': 'CLAS/OC',
    'adtcore:name': 'ZCL_DEMO',
    'adtcore:packageName': 'ZDEMO_PKG',
    'adtcore:description': 'Demo & test',
  });
  assert.deepEqual([hits[1]['adtcore:name'], hits[1]['adtcore:description']], ['ZDEMO', 'Old style'], 'the old NAME (description) form');
  assert.deepEqual([hits[2]['adtcore:name'], hits[2]['adtcore:description']], ['0001', '42'], 'digits stay strings');
  await ownReads(raw).searchObject('*sales*');
  assert.equal(raw.calls[1].url, '/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&maxResults=100&query=*sales*');
  for (const bad of [['two words'], ['x', 'CLAS/OC', 0], ['', 'CLAS/OC'], ['x'.repeat(101)]]) {
    await assert.rejects(() => ownReads(raw).searchObject(...bad), (e) => e.name === 'RouteViolation', JSON.stringify(bad));
  }
});

test('a data element and a domain, in the library shapes; digits keep their zeros, a failure is thrown', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const doc = (n) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ddic-documents', n), 'utf8');
  const withFixValues = doc('werks.xml').replace(
    '<doma:fixValues/>',
    '<doma:fixValues><doma:fixValue><doma:low>01</doma:low><doma:text>First</doma:text></doma:fixValue><doma:fixValue><doma:low>0</doma:low><doma:high>9</doma:high></doma:fixValue></doma:fixValues>'
  );
  const bodies = { '/sap/bc/adt/ddic/dataelements/werks_d': doc('werks_d.xml'), '/sap/bc/adt/ddic/domains/werks': withFixValues };
  const raw = fakeRaw((url) => {
    if (!bodies[url]) throw Object.assign(new Error('HTTP 404'), { err: 404, status: 404 });
    return { status: 200, body: bodies[url], headers: {} };
  });
  const reads = ownReads(raw);
  const dtel = await reads.getDataElementProperties('/sap/bc/adt/ddic/dataelements/werks_d');
  assert.equal(raw.calls[0].headers.Accept, '*/*');
  assert.deepEqual(dtel.metaData, {
    name: 'WERKS_D', description: 'Plant', language: 'EN', masterLanguage: 'DE', masterSystem: 'SAP', responsible: 'SAP',
    packageName: 'BM', packageDescription: undefined, packageUri: '/sap/bc/adt/packages/bm',
  });
  assert.equal(dtel.properties.typeName, 'WERKS');
  assert.equal(dtel.properties.dataType, 'CHAR');
  assert.equal(dtel.properties.dataTypeLength, 4);
  assert.equal(dtel.properties.searchHelp, 'H_T001W_C');
  assert.equal(dtel.properties.defaultComponentName, 'PLANT');
  assert.equal(dtel.properties.changeDocument, true);
  assert.equal(dtel.properties.fieldLabels.headingFieldLength, 4);
  const doma = await reads.getDomainProperties('/sap/bc/adt/ddic/domains/werks');
  assert.deepEqual(doma.properties.typeInformation, { datatype: 'CHAR', length: 4, decimals: 0 });
  assert.equal(doma.properties.outputInformation.conversionExit, undefined);
  assert.equal(doma.properties.outputInformation.lowercase, false);
  assert.equal(doma.properties.valueInformation.valueTableRef, 'T001W');
  assert.deepEqual(doma.properties.valueInformation.fixValues, [
    { low: '01', high: undefined, text: 'First' },
    { low: '0', high: '9', text: undefined },
  ]);
  assert.equal(doma.metaData.packageName, 'BV');
  await assert.rejects(() => reads.getDomainProperties('/sap/bc/adt/ddic/domains/nope'), (e) => e.status === 404);
});

test('a bare document answers the library defaults: empty strings, zero, undefined, never a throw', async () => {
  const { parseDataElement, parseDomain, parseOutline } = await import('../lib/adt-reads.mjs');
  const dtel = parseDataElement('<blue:wbobj adtcore:name="ZDEMO_DE"><dtel:dataElement/></blue:wbobj>');
  assert.deepEqual(dtel.metaData, {
    name: 'ZDEMO_DE', description: '', language: undefined, masterLanguage: '', masterSystem: '', responsible: undefined,
    packageName: '', packageDescription: undefined, packageUri: undefined,
  });
  assert.equal(dtel.properties.typeName, '');
  assert.equal(dtel.properties.dataTypeLength, 0);
  assert.equal(dtel.properties.fieldLabels.shortFieldLength, undefined);
  assert.equal(dtel.properties.searchHelp, undefined);
  assert.equal(dtel.properties.changeDocument, false);
  const doma = parseDomain('<doma:domain adtcore:name="ZDEMO_DO"/>');
  assert.deepEqual(doma.properties.typeInformation, { datatype: '', length: 0, decimals: 0 });
  assert.equal(doma.properties.outputInformation.style, undefined);
  assert.equal(doma.properties.valueInformation, undefined);
  const noTable = parseDomain('<doma:domain><doma:content><doma:valueInformation><doma:fixValues/></doma:valueInformation></doma:content></doma:domain>');
  assert.deepEqual(noTable.properties.valueInformation, { valueTableRef: '', appendExists: false, fixValues: undefined });
  assert.deepEqual(parseOutline('<other/>'), []);
  const one = parseOutline('<abapsource:objectStructureElement><abapsource:objectStructureElement final="false" constant="x"/></abapsource:objectStructureElement>');
  assert.deepEqual([one[0].name, one[0].type, one[0].final, one[0].constant], ['', '', false, undefined]);
});

test('ddicElement: the element tree by entity name, typed as the library typed it, one name per call', async () => {
  const body =
    '<?xml version="1.0" encoding="utf-8"?><abapsource:elementInfo adtcore:uri="/sap/bc/adt/ddic/ddl/sources/zdemo_i_rate" adtcore:type="DDLS/STOB" adtcore:name="ZDEMO_I_Rate" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<abapsource:properties><abapsource:entry abapsource:key="entityType">view</abapsource:entry><abapsource:entry abapsource:key="annotationKey.0">ENDUSERTEXT.LABEL</abapsource:entry><abapsource:entry abapsource:key="annotationValue.0">Exchange rate</abapsource:entry></abapsource:properties>' +
    '<abapsource:documentation abapsource:rel="shorttext" abapsource:type="text/plain">Exchange rate</abapsource:documentation>' +
    '<abapsource:elementInfo adtcore:type="STOB/DOF" adtcore:name="RateType"><abapsource:properties>' +
    '<abapsource:entry abapsource:key="ddicIsKey">true</abapsource:entry><abapsource:entry abapsource:key="ddicDataElement">zdemo_rate_type</abapsource:entry>' +
    '<abapsource:entry abapsource:key="ddicDataType">char</abapsource:entry><abapsource:entry abapsource:key="ddicLength">000004</abapsource:entry>' +
    '<abapsource:entry abapsource:key="ddicLabelShort">Rate type</abapsource:entry></abapsource:properties></abapsource:elementInfo>' +
    '<abapsource:elementInfo adtcore:type="STOB/DOF" adtcore:name="_Currency"><abapsource:properties><abapsource:entry abapsource:key="parentName">ZDEMO_I_RATE</abapsource:entry></abapsource:properties>' +
    '<abapsource:elementInfo adtcore:type="STOB/DOF" adtcore:name="Currency"><abapsource:properties><abapsource:entry abapsource:key="ddicDataType">cuky</abapsource:entry><abapsource:entry abapsource:key="ddicDataElement"/></abapsource:properties></abapsource:elementInfo>' +
    '</abapsource:elementInfo></abapsource:elementInfo>';
  const raw = fakeRaw(() => ({ status: 200, body, headers: {} }));
  const tree = await ownReads(raw).ddicElement('ZDEMO_I_Rate');
  assert.equal(raw.calls[0].url, '/sap/bc/adt/ddic/ddl/elementinfo?getTargetForAssociation=false&getExtensionViews=true&getSecondaryObjects=true&path=ZDEMO_I_Rate');
  assert.deepEqual(raw.calls[0].headers, { Accept: 'application/vnd.sap.adt.elementinfo+xml' });
  assert.deepEqual([tree.type, tree.name], ['DDLS/STOB', 'ZDEMO_I_Rate']);
  assert.equal(tree.properties.elementProps, false, 'no DDIC type on the root: false, as the library answered');
  assert.deepEqual(tree.properties.annotations, [{ key: 'ENDUSERTEXT.LABEL', value: 'Exchange rate' }], 'the pairs the library never read');
  const [key, assoc] = tree.children;
  assert.deepEqual(key.properties.elementProps, {
    ddicIsKey: true, ddicDataElement: 'zdemo_rate_type', ddicDataType: 'char', ddicLength: 4, ddicDecimals: undefined,
    ddicHeading: undefined, ddicLabelShort: 'Rate type', ddicLabelMedium: undefined, ddicLabelLong: undefined,
    ddicHeadingLength: undefined, ddicLabelShortLength: undefined, ddicLabelMediumLength: undefined, ddicLabelLongLength: undefined,
    parentName: undefined,
  });
  assert.equal(assoc.properties.elementProps, false);
  assert.equal(assoc.children[0].properties.elementProps.ddicIsKey, false);
  assert.equal(assoc.children[0].properties.elementProps.ddicDataElement, undefined);
  await assert.rejects(() => ownReads(raw).ddicElement(['A', 'B']), (e) => e.name === 'RouteViolation');
  await assert.rejects(() => ownReads(raw).ddicElement('A B'), (e) => e.name === 'RouteViolation');
});

test('annotationDefinitions: the DDLA text of the one CDATA, line ends read as the XML rule says', async () => {
  const ddla = '\r\n@Scope: [#ANNOTATION]\r\nannotation DemoAnnotation {\r\n  hidden : Boolean default true;\r\n};\r\n';
  const body = `<?xml version="1.0" encoding="utf-8"?> <cds:annotation xmlns:cds="http://www.sap.com/ddic/cds"> <cds:definitions> <![CDATA[${ddla}]]> </cds:definitions> </cds:annotation>`;
  const raw = fakeRaw(() => ({ status: 200, body, headers: {} }));
  const text = await ownReads(raw).annotationDefinitions();
  assert.equal(raw.calls[0].url, '/sap/bc/adt/ddic/cds/annotation/definitions');
  assert.match(raw.calls[0].headers.Accept, /annotation\.definitions\.v1\+xml, .*definitions\.v2\+xml/);
  assert.equal(text, ` ${ddla.replace(/\r\n/g, '\n')} `);
  const other = fakeRaw(() => ({ status: 200, body: '<other/>', headers: {} }));
  assert.equal(await ownReads(other).annotationDefinitions(), undefined, 'another document gives no DDLA, as the library gave none');
});

test('objectEnhancements: the S/4 path first, the ECC path only after its 404, the context encoded, the library shape', async () => {
  const src = Buffer.from('* demo\nWRITE 1.').toString('base64');
  const body =
    '<?xml version="1.0" encoding="utf-8"?><enh:enhancements xmlns:enh="http://www.sap.com/adt/abapsource/enhancements" xmlns:adtcore="http://www.sap.com/adt/core">' +
    '<enh:enhancementImplementations adtcore:name="ZDEMO_ENH" adtcore:type="ENHO/XHH" adtcore:version="active"><enh:elements>' +
    `<enh:sourceCodePlugin enh:uri="/sap/bc/adt/enhancements/enhoxhh/zdemo_enh/source/main#start=1" enh:id=" 1 " enh:full_name="\PR:ZDEMO\SE:BEGIN\EI" enh:replacing="true"><enh:source>${src}</enh:source>` +
    '<enh:option><enh:sourceCodePluginOption><enh:position adtcore:uri="/sap/bc/adt/programs/includes/zdemo_inc/source/main#start=12,0"/></enh:sourceCodePluginOption></enh:option></enh:sourceCodePlugin>' +
    '</enh:elements><enh:enhancedObject adtcore:uri="/sap/bc/adt/programs/programs/zdemo" adtcore:type="PROG/P" adtcore:name="ZDEMO"/></enh:enhancementImplementations></enh:enhancements>';
  const raw = fakeRaw(() => ({ status: 200, body, headers: {} }));
  const out = await ownReads(raw).objectEnhancements('/sap/bc/adt/programs/includes/zdemo_inc', '/sap/bc/adt/programs/programs/zdemo', true);
  assert.equal(raw.calls.length, 1);
  assert.equal(raw.calls[0].url, '/sap/bc/adt/programs/includes/zdemo_inc/source/main/enhancements/elements?context=%2Fsap%2Fbc%2Fadt%2Fprograms%2Fprograms%2Fzdemo');
  assert.match(raw.calls[0].headers.Accept, /^application\/vnd\.sap\.adt\.enhancements\.v3\+xml, /);
  const [impl] = out.implementations;
  assert.deepEqual([impl.name, impl.type, impl.version, impl.enhancedObject.name], ['ZDEMO_ENH', 'ENHO/XHH', 'active', 'ZDEMO']);
  assert.deepEqual(impl.elements[0], {
    uri: '/sap/bc/adt/enhancements/enhoxhh/zdemo_enh/source/main#start=1',
    id: '1',
    fullname: '\PR:ZDEMO\SE:BEGIN\EI',
    mode: '',
    replacing: true,
    source: '* demo\nWRITE 1.',
    position: { uri: '/sap/bc/adt/programs/includes/zdemo_inc/source/main#start=12,0', startLine: 11, startColumn: 0 },
  });

  let first = true;
  const ecc = fakeRaw(() => {
    if (first) {
      first = false;
      throw Object.assign(new Error('HTTP 404'), { err: 404, status: 404 });
    }
    return { status: 200, body: '', headers: {} };
  });
  assert.deepEqual(await ownReads(ecc).objectEnhancements('/sap/bc/adt/oo/classes/zcl_demo/includes/main'), { implementations: [] });
  assert.deepEqual(ecc.calls.map((c) => c.url), [
    '/sap/bc/adt/oo/classes/zcl_demo/includes/main/enhancements/elements',
    '/sap/bc/adt/oo/classes/zcl_demo/includes/main/enhancements',
  ]);
  const failing = fakeRaw(() => {
    throw Object.assign(new Error('HTTP 500'), { err: 500, status: 500 });
  });
  await assert.rejects(() => ownReads(failing).objectEnhancements('/sap/bc/adt/programs/programs/zdemo'), (e) => e.status === 500);
  assert.equal(failing.calls.length, 1, 'only a 404 asks the other path');
  await assert.rejects(() => ownReads(raw).objectEnhancements('/sap/bc/adt/programs/programs/zdemo', '/sap/bc/adt/../x'), (e) => e.name === 'RouteViolation');
});

test('the inventory of an entity carries each field\'s annotations as the system resolved them', async () => {
  const { inventory } = await import('../lib/ddic.mjs');
  const { parseElementInfo } = await import('../lib/adt-reads.mjs');
  const tree = parseElementInfo(
    '<abapsource:elementInfo adtcore:type="DDLS/STOB" adtcore:name="ZDEMO_C_Item" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core">' +
      '<abapsource:elementInfo adtcore:type="STOB/DOF" adtcore:name="Quantity"><abapsource:properties>' +
      '<abapsource:entry abapsource:key="ddicDataType">quan</abapsource:entry>' +
      '<abapsource:entry abapsource:key="annotationKey.1">ENDUSERTEXT.LABEL</abapsource:entry><abapsource:entry abapsource:key="annotationValue.1">Quantity</abapsource:entry>' +
      '<abapsource:entry abapsource:key="annotationKey.0">SEMANTICS.QUANTITY.UNITOFMEASURE</abapsource:entry><abapsource:entry abapsource:key="annotationValue.0">QuantityUnit</abapsource:entry>' +
      '<abapsource:entry abapsource:key="annotationKey.2">OBJECTMODEL.MANDATORY</abapsource:entry>' +
      '</abapsource:properties></abapsource:elementInfo></abapsource:elementInfo>'
  );
  assert.deepEqual(tree.children[0].properties.annotations, [
    { key: 'SEMANTICS.QUANTITY.UNITOFMEASURE', value: 'QuantityUnit' },
    { key: 'ENDUSERTEXT.LABEL', value: 'Quantity' },
    { key: 'OBJECTMODEL.MANDATORY', value: '' },
  ], 'in n order, a key without its value kept with an empty value');
  const inv = await inventory({ ddicElement: async () => tree }, 'ZDEMO_C_Item');
  assert.deepEqual(inv.fields[0].annotations, {
    'SEMANTICS.QUANTITY.UNITOFMEASURE': 'QuantityUnit',
    'ENDUSERTEXT.LABEL': 'Quantity',
    'OBJECTMODEL.MANDATORY': '',
  });
});

test('a search reply of another shape is an error, never an empty list', async () => {
  const raw = fakeRaw(() => ({ status: 200, body: '<html><body>logon</body></html>', headers: {} }));
  await assert.rejects(() => ownReads(raw).searchObject('ZCL_DEMO'), /not adtcore:objectReferences/);
});
