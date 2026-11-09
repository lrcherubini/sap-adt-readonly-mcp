// What the MCP specification asks a tool definition and a tool result to carry, applied in ONE
// place so fifteen tool files do not each restate it (spec 2025-06-18, "Tools").
//
//   title        a human-readable name, for clients that show tools to people;
//   annotations  behaviour hints. Every tool here is read-only and non-destructive by
//                construction (the guard, the route table). They are hints, not a security
//                boundary -- the boundary is lib/guard.mjs and lib/adt-get.mjs;
//   inputSchema  closed (`additionalProperties: false`) and enforced before the handler runs;
//   structuredContent  the answer as JSON, next to the same JSON as text (the spec's
//                backward-compatibility rule).
//
// No `outputSchema` is declared, on purpose: a client that receives one MUST validate the answer
// against it, and the answers here are rich, versioned by measurement, and partly shaped by what
// the system returned. A schema that lags one field behind would make a correct answer read as
// a protocol error. structuredContent without a schema is allowed by the specification.

/** title + whether a second identical call has no additional effect on the system. */
export const TOOL_META = Object.freeze({
  adt_search: { title: 'Search ABAP repository objects', idempotent: true },
  adt_read_source: { title: 'Read object source', idempotent: true },
  adt_object_info: { title: 'Object metadata', idempotent: true },
  adt_where_used: { title: 'Where-used list', idempotent: true },
  adt_package_tree: { title: 'Package contents', idempotent: true },
  adt_value_help: { title: 'Value help recommendation', idempotent: true },
  adt_clean_core_scan: { title: 'Clean Core scan of a package', idempotent: true },
  adt_contract_check: { title: 'OData contract check', idempotent: true },
  adt_annotation_scan: { title: 'CDS annotation layer scan', idempotent: true },
  adt_annotation_chain: { title: 'CDS annotation chain of an element', idempotent: true },
  adt_transport: { title: 'Transport requests and object history', idempotent: true },
  adt_customizing: { title: 'Customizing table read (closed list)', idempotent: true },
  adt_runtime_errors: { title: 'Runtime errors (ST22) and ADT feeds', idempotent: true },
  // Each run leaves an ATC result worklist on the server: read-only for the code, but not
  // idempotent -- two calls leave two worklists.
  adt_atc_run: { title: 'ATC check run on one object', idempotent: false },
  adt_launchpad: { title: 'Fiori launchpad content', idempotent: true },
});

/** The behaviour hints of one tool. Every tool talks to the SAP system: openWorldHint. */
export const annotationsOf = (name) => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: TOOL_META[name]?.idempotent ?? true,
  openWorldHint: true,
});

/** A copy of a JSON schema with every object that lists properties closed to others. */
export function closeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (out.type === 'object' && out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, closeSchema(v)]));
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (out.items) out.items = closeSchema(out.items);
  for (const key of ['oneOf', 'anyOf']) if (Array.isArray(out[key])) out[key] = out[key].map(closeSchema);
  return out;
}

/** The definition as published by tools/list: title, annotations, closed input schema. */
export function publish(definition) {
  const meta = TOOL_META[definition.name];
  return {
    ...definition,
    ...(meta?.title && !definition.title ? { title: meta.title } : {}),
    annotations: { ...annotationsOf(definition.name), ...(definition.annotations ?? {}) },
    inputSchema: closeSchema(definition.inputSchema),
  };
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (type, v) => {
  const t = typeOf(v);
  if (type === 'number') return t === 'number' || t === 'integer';
  return t === type;
};

/**
 * The subset of JSON Schema the tool schemas use, checked against one value: type (a name or a
 * list), enum, minimum/maximum, minLength/maxLength, items, minItems/maxItems, required,
 * properties and additionalProperties: false, oneOf/anyOf. Returns error strings, never throws,
 * never coerces. `null` counts as absent for an optional property (clients send it that way).
 */
export function schemaErrors(schema, value, where = 'arguments') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      const ok = schema[key].some((s) => !schemaErrors(s, value, where).length);
      if (!ok) errors.push(`${where} matches none of the allowed shapes`);
      return errors;
    }
  }
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some((t) => fits(t, value))) {
    errors.push(`${where} must be ${types.join(' or ')}, got ${typeOf(value)}${typeof value === 'string' ? ` '${value.slice(0, 40)}'` : ''}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where} must be one of ${schema.enum.join(', ')}, got '${value}'`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be >= ${schema.minimum}, got ${value}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where} must be <= ${schema.maximum}, got ${value}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where} must have at least ${schema.minLength} character(s)`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where} must have at most ${schema.maxLength} character(s)`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where} takes at most ${schema.maxItems} item(s), got ${value.length}`);
    if (schema.items) value.forEach((v, i) => errors.push(...schemaErrors(schema.items, v, `${where}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties ?? {};
    const received = Object.keys(value).join(', ') || 'nothing';
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) errors.push(`missing required argument '${key}' (received: ${received})`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      if (props[key]) errors.push(...schemaErrors(props[key], v, where === 'arguments' ? `argument '${key}'` : `${where}.${key}`));
      else if (schema.additionalProperties === false) {
        errors.push(`unknown argument '${key}'${where === 'arguments' ? '' : ` in ${where}`} (accepted: ${Object.keys(props).join(', ') || 'none'})`);
      }
    }
  }
  return errors;
}

/** The result with `structuredContent` added when its text is one JSON object. */
export function withStructuredContent(result) {
  if (!result || result.structuredContent || result.isError) return result;
  const text = result.content?.length === 1 && result.content[0]?.type === 'text' ? result.content[0].text : null;
  if (typeof text !== 'string' || !text.startsWith('{')) return result;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...result, structuredContent: parsed } : result;
  } catch {
    // Text that merely starts with a brace (an ABAP source, a message) is not structured: the
    // answer stays text-only, exactly as it was produced.
    return result;
  }
}

/**
 * Progress for one call: `report(done, total, message)` sends notifications/progress when the
 * client asked for it (a progressToken in the request's _meta), and does nothing otherwise.
 * Notifications are best effort -- a failed one never fails the answer.
 */
export function progressOf(extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || typeof extra?.sendNotification !== 'function') return () => {};
  return (progress, total, message) => {
    extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, ...(total ? { total } : {}), ...(message ? { message } : {}) } })
      .catch(() => {});
  };
}
