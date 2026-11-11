// The reads behind the guard's members, written here one by one as abap-adt-api leaves
// (docs/security.md, "Removing abap-adt-api"). Each returns exactly the shape the library returned,
// so no tool changes when a member moves; each goes through the closed seams of lib/adt-get.mjs.
//
// Until the last member moves, `mixedApi` gives the tools one object: the members written here,
// and every other allowlisted member still delegated to the library. lib/guard.mjs wraps that
// object exactly as it wrapped the library.

import { derivedGet, namedGet, transportFor, RouteViolation } from './adt-get.mjs';
import { parseObjectStructure } from './object-structure.mjs';
import { parseXml, childOf, childrenOf, typedAttrs, typedValue } from './xml.mjs';
import { allowedMethods } from './guard.mjs';

/** The members that no longer come from the library. Grows by one member per cycle. */
export const OWN_READS = Object.freeze(['getObjectSource', 'objectStructure', 'searchObject', 'objectStructureElements', 'getDataElementProperties', 'getDomainProperties', 'ddicElement']);

/**
 * The hits of a quick search, as the library returned them: every attribute of each
 * adtcore:objectReference, and the name split from a "NAME (description)" form some releases
 * send. Unlike the library, every value stays a string: a name or a description of digits is
 * not a number.
 */
export function parseSearchHits(xml) {
  return childrenOf(parseXml(xml), 'adtcore:objectReference').map((el) => {
    const hit = {};
    for (const [k, v] of Object.entries(el.attrs)) if (k !== 'xmlns' && !k.startsWith('xmlns:')) hit[k] = v;
    const r = /([^\s]*)\s*\((.*)\)/.exec(hit['adtcore:name'] ?? '');
    if (r) {
      hit['adtcore:name'] = r[1];
      if (!hit['adtcore:description']) hit['adtcore:description'] = r[2];
    }
    return hit;
  });
}

const parseBool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);

/** One element of an outline, recursively, in the library's shape (parseStructureElement). */
function outlineElement(el) {
  const a = typedAttrs(el);
  return {
    name: a['adtcore:name'] || '',
    type: a['adtcore:type'] || '',
    description: a['adtcore:description'],
    visibility: a.visibility,
    level: a.level,
    constant: parseBool(a.constant),
    constructor: parseBool(a.constructor),
    testmethod: parseBool(a.testmethod),
    redefinition: parseBool(a.redefinition),
    final: parseBool(a.final),
    links: childrenOf(el, 'atom:link').map(typedAttrs),
    children: childrenOf(el, 'abapsource:objectStructureElement').map(outlineElement),
  };
}

/** The children of the root abapsource:objectStructureElement, as the library returned them. */
export function parseOutline(xml) {
  const root = parseXml(xml);
  if (root.name !== 'abapsource:objectStructureElement') return [];
  return childrenOf(root, 'abapsource:objectStructureElement').map(outlineElement);
}

/** The text of the child `name` of `el`, or undefined when there is none. */
const textOf = (el, name) => {
  const c = childOf(el, name);
  return c ? c.text : undefined;
};
const numberOf = (v) => Number(v) || 0;

/** The metadata block both DDIC documents share, as the library built it. */
function ddicMetaData(root) {
  const a = root.attrs;
  const pkg = childOf(root, 'adtcore:packageRef')?.attrs ?? {};
  return {
    name: a['adtcore:name'],
    description: a['adtcore:description'] || '',
    language: a['adtcore:language'],
    masterLanguage: a['adtcore:masterLanguage'] || '',
    masterSystem: a['adtcore:masterSystem'] || '',
    responsible: a['adtcore:responsible'],
    packageName: pkg['adtcore:name'] || '',
    packageDescription: pkg['adtcore:description'],
    packageUri: pkg['adtcore:uri'],
  };
}

/**
 * A data element document, in the library's shape. Unlike the library, a text of digits stays
 * text (a search help named `0001` is not the number 1).
 */
export function parseDataElement(xml) {
  const root = parseXml(xml);
  const d = childOf(root, 'dtel:dataElement');
  const t = (n) => textOf(d, `dtel:${n}`);
  return {
    metaData: ddicMetaData(root),
    properties: {
      typeName: t('typeName') || '',
      dataType: t('dataType') || '',
      dataTypeLength: numberOf(t('dataTypeLength')),
      dataTypeDecimals: numberOf(t('dataTypeDecimals')),
      fieldLabels: {
        shortFieldLabel: t('shortFieldLabel') || '',
        shortFieldLength: Number(t('shortFieldLength')) || undefined,
        mediumFieldLabel: t('mediumFieldLabel') || '',
        mediumFieldLength: Number(t('mediumFieldLength')) || undefined,
        longFieldLabel: t('longFieldLabel') || '',
        longFieldLength: Number(t('longFieldLength')) || undefined,
        headingFieldLabel: t('headingFieldLabel') || '',
        headingFieldLength: Number(t('headingFieldLength')) || undefined,
      },
      searchHelp: t('searchHelp') || undefined,
      searchHelpParameter: t('searchHelpParameter') || undefined,
      setGetParameter: t('setGetParameter') || undefined,
      defaultComponentName: t('defaultComponentName') || undefined,
      deactivateInputHistory: t('deactivateInputHistory') === 'true',
      changeDocument: t('changeDocument') === 'true',
      leftToRightDirection: t('leftToRightDirection') === 'true',
      deactivateBIDIFiltering: t('deactivateBIDIFiltering') === 'true',
    },
  };
}

/**
 * A domain document, in the library's shape. Unlike the library, a fixed value of digits keeps
 * its leading zeros (`01` is not `1`), and `0` is not read as empty.
 */
export function parseDomain(xml) {
  const root = parseXml(xml);
  const content = childOf(root, 'doma:content');
  const typeInfo = childOf(content, 'doma:typeInformation');
  const outputInfo = childOf(content, 'doma:outputInformation');
  const valueInfo = childOf(content, 'doma:valueInformation');
  const ti = (n) => textOf(typeInfo, `doma:${n}`);
  const oi = (n) => textOf(outputInfo, `doma:${n}`);
  let valueInformation;
  if (valueInfo) {
    const fixValues = childrenOf(childOf(valueInfo, 'doma:fixValues'), 'doma:fixValue').map((fv) => ({
      low: textOf(fv, 'doma:low') ?? '',
      high: textOf(fv, 'doma:high') || undefined,
      text: textOf(fv, 'doma:text') || undefined,
    }));
    valueInformation = {
      valueTableRef: childOf(valueInfo, 'doma:valueTableRef')?.attrs['adtcore:name'] || '',
      appendExists: textOf(valueInfo, 'doma:appendExists') === 'true',
      fixValues: fixValues.length > 0 ? fixValues : undefined,
    };
  }
  return {
    metaData: ddicMetaData(root),
    properties: {
      typeInformation: { datatype: ti('datatype') || '', length: numberOf(ti('length')), decimals: numberOf(ti('decimals')) },
      outputInformation: {
        length: numberOf(oi('length')),
        style: oi('style') || undefined,
        conversionExit: oi('conversionExit') || undefined,
        signExists: oi('signExists') === 'true',
        lowercase: oi('lowercase') === 'true',
        ampmFormat: oi('ampmFormat') === 'true',
      },
      valueInformation,
    },
  };
}

/**
 * The properties block of one element, as the library's parseDDICProps built it: the entries'
 * values typed (`000004` is 4), `elementProps` only where a DDIC type is given (else `false`,
 * as the library answered), and `annotations` always empty -- the library's matcher read a named
 * group the pattern does not declare, so it never filled them (measured: empty at every path).
 */
function ddicProps(el) {
  const entries = {};
  for (const e of childrenOf(el, 'abapsource:entry')) {
    entries[e.attrs['abapsource:key']] = e.text === '' ? undefined : typedValue(e.text);
  }
  const has = entries.ddicDataType !== undefined;
  const elementProps = has && {
    ddicIsKey: !!entries.ddicIsKey,
    ddicDataElement: entries.ddicDataElement,
    ddicDataType: entries.ddicDataType,
    ddicLength: entries.ddicLength,
    ddicDecimals: entries.ddicDecimals,
    ddicHeading: entries.ddicHeading,
    ddicLabelShort: entries.ddicLabelShort,
    ddicLabelMedium: entries.ddicLabelMedium,
    ddicLabelLong: entries.ddicLabelLong,
    ddicHeadingLength: entries.ddicHeadingLength,
    ddicLabelShortLength: entries.ddicLabelShortLength,
    ddicLabelMediumLength: entries.ddicLabelMediumLength,
    ddicLabelLongLength: entries.ddicLabelLongLength,
    parentName: entries.parentName,
  };
  return { elementProps, annotations: [] };
}

function ddicNode(el) {
  return {
    type: el.attrs['adtcore:type'],
    name: el.attrs['adtcore:name'],
    properties: ddicProps(childOf(el, 'abapsource:properties')),
    children: childrenOf(el, 'abapsource:elementInfo').map(ddicNode),
  };
}

/** The element tree of an entity, as abap-adt-api's ddicElement returned it. */
export function parseElementInfo(xml) {
  return ddicNode(parseXml(xml));
}

/** A source URI split into the object it belongs to and the relative part read under it. */
export function splitSourceUri(url) {
  const m = /^(\/sap\/bc\/adt\/.+?)\/(source\/main|includes\/[a-z]+)$/.exec(String(url ?? '').trim());
  if (!m) return null;
  return { object: m[1], href: m[2] };
}

/** The own reads, over the raw client of the session. */
export function ownReads(raw) {
  const transport = transportFor(raw);
  return {
    /** The source text, as the library returned it: a string. */
    async getObjectSource(url) {
      const parts = splitSourceUri(url);
      // derivedGet refuses what is not a source URI; this only finds the object it hangs off.
      const out = await derivedGet(transport, parts?.object ?? String(url ?? ''), parts?.href ?? String(url ?? ''), { kind: 'objectSource' });
      return out.body;
    },
    /** The quick search: major type only, as the library asked it. */
    async searchObject(query, objType, maxResults = 100) {
      const out = await namedGet(transport, 'repositorySearch', {
        query: String(query ?? ''),
        maxResults: String(maxResults),
        ...(objType ? { objectType: String(objType).replace(/\/.*$/, '').toUpperCase() } : {}),
      });
      return parseSearchHits(out.body);
    },
    /**
     * The outline of a class or an interface, as the library returned it. Unlike the library,
     * a failed read is thrown, never answered as `[]` (adt_object_info says it was not read).
     * Any other object has no outline: `[]`, as the library answered without asking.
     */
    async objectStructureElements(url, version) {
      const u = String(url ?? '').trim();
      if (!/\/oo\/(classes|interfaces)\//i.test(u)) return [];
      const out = await derivedGet(transport, u, 'objectstructure', {
        kind: 'objectOutline',
        query: { version: version || 'active', withShortDescriptions: 'true' },
      });
      return parseOutline(out.body);
    },
    /** The DDIC element tree of an entity by name (the library's ddicElement, one name only). */
    async ddicElement(path) {
      if (Array.isArray(path)) throw new RouteViolation('ddicElement reads one entity per call.');
      const out = await namedGet(transport, 'ddicElementInfo', { path: String(path ?? '') });
      return parseElementInfo(out.body);
    },
    /** A data element: its document, parsed as the library parsed it. */
    async getDataElementProperties(url) {
      const out = await derivedGet(transport, url, url, { kind: 'objectDocument' });
      return parseDataElement(out.body);
    },
    /** A domain: its document, parsed as the library parsed it. */
    async getDomainProperties(url) {
      const out = await derivedGet(transport, url, url, { kind: 'objectDocument' });
      return parseDomain(out.body);
    },
    /** The structure document, parsed as the library parsed it. */
    async objectStructure(url) {
      const out = await derivedGet(transport, url, url, { kind: 'objectDocument' });
      return parseObjectStructure(String(url).trim(), out.body);
    },
  };
}

/**
 * One object for the guard: an own member where one exists, the library's otherwise. A member
 * of the library is read lazily, bound to the library, so its getters keep working.
 */
export function mixedApi(library, own) {
  const api = Object.create(null);
  for (const name of allowedMethods()) {
    if (Object.hasOwn(own, name)) {
      api[name] = own[name];
      continue;
    }
    Object.defineProperty(api, name, {
      enumerable: true,
      get() {
        const value = library[name];
        return typeof value === 'function' ? value.bind(library) : value;
      },
    });
  }
  return api;
}
