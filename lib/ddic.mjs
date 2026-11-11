// The field inventory: what a CDS view's fields really are, from the system.
//
// This is the step the working tree cannot do. In a projection the field inherits its
// type without restating it (`key Plant,` and nothing else), so the source says nothing
// about which data element -- and therefore which concept -- is behind the field.
// Measured on the system (docs/adt-api-reference.md):
//
//   ddicElement('ZC_DemoItemRating')      583 children, each with elementProps
//                                           carrying ddicDataElement, ddicDataType,
//                                           ddicLength -- and NO domain
//   getDataElementProperties('werks_d')     typeName WERKS (the domain), dataType
//                                           CHAR, defaultComponentName PLANT,
//                                           searchHelp H_T001W_C, the four labels
//   getDomainProperties('WERKS')            valueInformation.valueTableRef T001W
//
// Three calls, and the third is what saves the Z append case: `ZDEMO_DE_MVGR1` is our
// own data element and matches no standard concept, while the domain it inherits
// (`MVGR1`, value table `TVM1`) does.
//
// Everything here degrades rather than throws. A field whose data element does not
// resolve still comes back, carrying WHY it is incomplete -- a silent gap would read as
// "this field needs no value help", which is a different and wrong answer.

/** The documented URL shapes, from the client's own JSDoc in api/objectcontents.js. */
const dataElementUrl = (name) => `/sap/bc/adt/ddic/dataelements/${String(name).toLowerCase()}`;
const domainUrl = (name) => `/sap/bc/adt/ddic/domains/${String(name).toLowerCase()}`;

/** Field nodes of a ddicElement tree: the ones that carry elementProps. */
function fieldsOf(root) {
  return (root?.children ?? [])
    .filter((c) => c?.properties?.elementProps)
    .map((c) => {
      const p = c.properties.elementProps;
      return {
        name: c.name,
        type: c.type,
        isKey: p.ddicIsKey === true,
        dataElement: p.ddicDataElement || null,
        dataType: p.ddicDataType || null,
        length: p.ddicLength,
        label: p.ddicLabel || p.ddicHeading || null,
        // The field's annotations as the system resolves them -- inherited ones included, which
        // a projection does not restate in its source. KEY (upper case) -> value as text.
        annotations: Object.fromEntries((c.properties.annotations ?? []).map((a) => [a.key, a.value])),
      };
    });
}

/**
 * Resolve one data element to its domain, value table and canonical component name.
 *
 * @returns {{dataElement:string, ok:boolean, domain?:string,
 *            defaultComponentName?:string, valueTable?:string, fixValues?:number,
 *            searchHelp?:string, ddicType?:string, ddicLength?:number,
 *            reason?:string}}
 */
export async function resolveDataElement(api, dataElement) {
  const out = { dataElement, ok: false, calls: 0 };
  let dtel;
  try {
    dtel = await api.getDataElementProperties(dataElementUrl(dataElement));
    out.calls++;
  } catch (e) {
    out.calls++;
    out.reason = `data element ${dataElement} did not resolve: ${e.message ?? e}`;
    return out;
  }
  const p = dtel?.properties ?? {};
  out.ok = true;
  out.domain = p.typeName || undefined;
  out.defaultComponentName = p.defaultComponentName || undefined;
  out.searchHelp = p.searchHelp || undefined;
  // The DDIC built-in type (CHAR, UNIT, CUKY, LANG, ...), taken from the source that
  // was actually MEASURED on this system: docs/adt-api-reference.md:114 records
  // getDataElementProperties('werks_d') answering `dataType: "CHAR"`, verbatim. The
  // domain's typeInformation.datatype, read below, is only a shape from the client's
  // typings, so it is a fallback and not the primary -- an earlier version of this file
  // had that order the wrong way round and made an observed reading depend on an
  // unobserved one.
  out.ddicType = p.dataType || undefined;
  out.ddicLength = p.dataTypeLength ?? undefined;
  if (!out.domain) return out;

  const doma = await readDomain(api, out.domain);
  out.calls += doma.calls;
  if (!doma.ok) {
    out.reason = doma.reason;
    return out;
  }
  out.valueTable = doma.valueTable;
  // The domain's DDIC built-in type (UNIT, CUKY, LANG, CHAR, ...). This is what
  // makes the SEMANTIC signal free: the call has already been made for the value
  // table, and the answer says what the field IS rather than what it is called.
  //
  // Shape from the client's own typings (DomainProperties.typeInformation.datatype in
  // api/objectcontents.d.ts:21-25), and OBSERVED on the system on 2026-09-09: domain
  // MEINS answers `datatype: "UNIT"`. It only fills a hole the data element left, so
  // even on a release that worded it differently the signal would simply not fire --
  // costing a fallback to the active search, never a wrong recommendation.
  out.ddicType = out.ddicType || doma.ddicType;
  // A domain with fixed values wants NO value help: DDIC renders them as a dropdown
  // already, and a value help on top adds a round trip and a second source of truth.
  out.fixValues = doma.fixValues;
  out.fixValueList = doma.fixValueList;
  return out;
}

/**
 * One domain, as `getDomainProperties` answers it: type, value table and the fixed values.
 * `fixValues` is the COUNT (what the value-help ranking tests); `fixValueList` is the list
 * itself, each entry as the server sent it (`low`/`high`/`text` in the client's typings,
 * read on OBJFUNC on 2026-09-10) -- passed through, never re-shaped, so nothing is dropped.
 * Degrades: a failed read comes back `ok: false` with the reason, never as "no fixed values".
 */
export async function readDomain(api, domain) {
  const out = { domain, ok: false, calls: 0 };
  let doma;
  try {
    doma = await api.getDomainProperties(domainUrl(domain));
    out.calls++;
  } catch (e) {
    out.calls++;
    out.reason = `domain ${domain} did not resolve: ${e.message ?? e}`;
    return out;
  }
  const p = doma?.properties ?? {};
  const v = p.valueInformation;
  out.ok = true;
  out.description = doma?.metaData?.description || undefined;
  out.packageName = doma?.metaData?.packageName || undefined;
  out.ddicType = p.typeInformation?.datatype || undefined;
  out.ddicLength = p.typeInformation?.length ?? undefined;
  out.decimals = p.typeInformation?.decimals ?? undefined;
  out.conversionExit = p.outputInformation?.conversionExit || undefined;
  out.lowercase = p.outputInformation?.lowercase ?? undefined;
  out.valueTable = v?.valueTableRef || undefined;
  out.fixValueList = Array.isArray(v?.fixValues) ? v.fixValues : [];
  out.fixValues = out.fixValueList.length;
  return out;
}

/**
 * The inventory of an entity's fields, with the DDIC chain resolved for the ones asked
 * for. Data elements are resolved ONCE each, however many fields share them.
 *
 * @param {object} api guarded ADT client
 * @param {string} entity CDS entity name (the measured `path` for ddicElement)
 * @param {{only?:string[], max?:number}} opts
 * @returns {{entity:string, fields:object[], resolved:number, calls:number,
 *            notes:string[]}}
 */
export async function inventory(api, entity, opts = {}) {
  const notes = [];
  let calls = 0;
  let root;
  try {
    root = await api.ddicElement(entity);
    calls++;
  } catch (e) {
    throw new Error(`Field list of ${entity} could not be read: ${e.message ?? e}`);
  }

  const all = fieldsOf(root);
  if (!all.length) {
    // Measured trap: a wrong `path` shape returns HTTP 200 with an empty tree and no
    // hint at all. Saying so beats reporting "no fields".
    notes.push(
      `${entity} returned no field nodes. Either the entity does not exist or the ` +
        'element info was requested with a path shape this release does not answer ' +
        '(the measured shape is the plain entity name).'
    );
  }

  const wanted = opts.only?.length
    ? all.filter((f) => opts.only.some((n) => n.toLowerCase() === f.name.toLowerCase()))
    : all;
  const missing = (opts.only ?? []).filter(
    (n) => !all.some((f) => f.name.toLowerCase() === n.toLowerCase())
  );
  for (const n of missing) notes.push(`${entity} has no field named '${n}'`);

  // A page of the matched fields, in the order the system lists them: `offset` starts after
  // the ones an earlier call resolved.
  const limit = Number.isFinite(opts.max) ? opts.max : wanted.length;
  const from = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  const selected = wanted.slice(from, from + limit);
  if (wanted.length > from + selected.length) {
    notes.push(
      `${wanted.length} fields matched, ${selected.length} resolved (max ${limit}); ` +
        'raise `maxFields`, name the fields explicitly, or pass `fieldsOffset`'
    );
  }

  const cache = new Map();
  for (const f of selected) {
    if (!f.dataElement) {
      f.reason =
        'the system reports no data element for this field (a calculated or literal ' +
        'element): there is no concept to match on';
      continue;
    }
    if (!cache.has(f.dataElement)) {
      const resolved = await resolveDataElement(api, f.dataElement);
      cache.set(f.dataElement, resolved);
      calls += resolved.calls;
    }
    const { calls: _spent, ...chain } = cache.get(f.dataElement);
    Object.assign(f, chain);
  }

  // The annotations of EVERY field, not only the ones selected: a semantic reference points from
  // one field to another (a quantity names its unit), and the carrier need not be among them.
  const annotations = Object.fromEntries(all.filter((f) => Object.keys(f.annotations).length).map((f) => [f.name, f.annotations]));
  return { entity, fields: selected, allFields: all.length, matched: wanted.length, offset: from, missing, annotations, resolved: cache.size, calls, notes };
}
