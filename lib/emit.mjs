// Writing the annotation -- and refusing to write the parts that are not released.
//
// This is the step that makes the tool worth more than a name search. Measured in the
// system's annotation definitions for this release (tests/fixtures/annotation-defs.ddla.txt):
//
//   Consumption.valueHelpDefinition[ ].association                API state  -   -> refuse
//   Consumption.valueHelpDefinition[ ].selectionVariantQualifier  API state  -   -> refuse
//   Consumption.valueHelp                (singular)     KEY_USER only            -> refuse
//   ...entity.name / .element / .label / .qualifier / .distinctValues /
//      .useForValidation / additionalBinding[ ].*        KU + SCP                -> allow
//
// No local check in a measured workspace catches the first three today -- not abaplint, not the
// hook, not the ATC profile in use. So the check lives here, fed by lib/annotation-defs
// (the system's own DDLA), never by memory.
//
// Two further rules, both from the plan and both about not inventing:
//
//   * `additionalBinding` is emitted ONLY when a real precedent showed it, and the
//     precedent is cited in the output. Without one, the block says the binding depends
//     on the caller's own fields and cannot be inferred.
//   * when the definitions are not available, the annotation is still emitted --
//     but marked NOT VALIDATED, with the reason. Silence is the forbidden outcome.

import { normalizeKey } from './annotation-defs.mjs';

/** The annotation this tool emits. Singular `Consumption.valueHelp` is refused. */
export const VHD = 'Consumption.valueHelpDefinition';

/** Scope tokens, as both sources spell them. */
export const ELEMENT = 'ELEMENT';
export const PARAMETER = 'PARAMETER';

const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Render one leaf value the way CDS wants it. */
function renderValue(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  const s = String(value ?? '');
  // An enum value is written `#FILTER`, unquoted.
  return /^#[A-Z0-9_]+$/.test(s) ? s : quote(s);
}

/**
 * The annotation paths one record would write, in emission order.
 *
 * @param {{entity?:{name?:string, element?:string}, label?:string, qualifier?:string,
 *          distinctValues?:boolean, useForValidation?:boolean,
 *          additionalBinding?:{element?:string, localElement?:string, localConstant?:string,
 *                              parameter?:string, localParameter?:string, usage?:string,
 *                              precedent?:string}[],
 *          association?:string, selectionVariantQualifier?:string,
 *          presentationVariantQualifier?:string}} rec
 * @returns {{key:string, value:any, path:string}[]}
 */
export function annotationKeys(rec = {}) {
  const out = [];
  const push = (path, value) => {
    if (value === undefined || value === null) return;
    out.push({ key: `${VHD}[ ].${path}`, path, value });
  };
  if (rec.entity?.name !== undefined) push('entity.name', rec.entity.name);
  if (rec.entity?.element !== undefined) push('entity.element', rec.entity.element);
  for (const field of [
    'label',
    'qualifier',
    'distinctValues',
    'useForValidation',
    'presentationVariantQualifier',
    // Present here on purpose: a caller that asks for one of these must be REFUSED with
    // the release reason, not silently ignored.
    'association',
    'selectionVariantQualifier',
  ]) {
    push(field, rec[field]);
  }
  for (const b of rec.additionalBinding ?? []) {
    for (const field of [
      'element',
      'localElement',
      'localConstant',
      'parameter',
      'localParameter',
      'usage',
    ]) {
      if (b?.[field] !== undefined) {
        out.push({
          key: `${VHD}[ ].additionalBinding[ ].${field}`,
          path: `additionalBinding.${field}`,
          value: b[field],
        });
      }
    }
  }
  return out;
}

/**
 * Check every key against the definitions before anything is written.
 *
 * @param {{key:string, value?:any}[]|string[]} keys
 * @param {import('./annotation-defs.mjs')} defs a defs object (may be unavailable)
 * @param {{scope?:string}} opts scope the annotation is written at (ELEMENT by default)
 * @returns {{ok:boolean, refused:{key:string,reason:string}[],
 *            unvalidated:{key:string,reason:string}[], checked:number,
 *            source:string|null}}
 */
export function validateEmission(keys, defs, opts = {}) {
  const scope = (opts.scope ?? ELEMENT).toUpperCase();
  const entries = (keys ?? []).map((k) => (typeof k === 'string' ? { key: k } : k));
  const refused = [];
  const unvalidated = [];

  if (!defs?.available) {
    const reason =
      defs?.note ??
      'the system DDLA was not available, so no annotation definition could be checked';
    for (const { key } of entries) unvalidated.push({ key, reason });
    return { ok: true, refused, unvalidated, checked: 0, source: null };
  }

  for (const { key, value } of entries) {
    // The singular form is refused by name as well as by API state: it is the mistake
    // that reads as correct, and the message has to name the replacement.
    if (normalizeKey(key) === normalizeKey('Consumption.valueHelp')) {
      refused.push({
        key,
        reason:
          'Consumption.valueHelp (singular) is released for Key User apps only; ' +
          `use ${VHD} instead`,
      });
      continue;
    }

    const refusal = defs.refusalReason(key);
    if (refusal === undefined) {
      unvalidated.push({
        key,
        reason: 'the annotation definitions of this release do not list this key',
      });
      continue;
    }
    if (refusal) {
      refused.push({ key, reason: refusal });
      continue;
    }

    const scopes = defs.scopes(key);
    if (scopes.length && !scopes.includes(scope)) {
      refused.push({
        key,
        reason: `its scope is ${scopes.join(', ')}, and it is being written at ${scope}`,
      });
      continue;
    }

    const enums = defs.enums(key);
    if (enums.length && value !== undefined && value !== null) {
      const token = String(value).replace(/^#/, '').toUpperCase();
      if (!enums.includes(token)) {
        refused.push({
          key,
          reason: `'${value}' is not in the closed enum #${enums.join(' | #')}`,
        });
      }
    }
  }

  return {
    ok: refused.length === 0,
    refused,
    unvalidated,
    checked: entries.length - unvalidated.length,
    source: defs.source ?? null,
  };
}

/**
 * Render the annotation block for one field.
 *
 * `additionalBinding` entries without a `precedent` are DROPPED, and the drop is
 * reported in `notes` -- the plan's rule that a binding is never invented.
 *
 * @param {object} rec see annotationKeys
 * @param {{indent?:string, field?:string}} opts
 * @returns {{text:string, notes:string[], omitted:string[]}}
 */
export function renderAnnotation(rec = {}, opts = {}) {
  const indent = opts.indent ?? '';
  const notes = [];
  const omitted = [];
  const inner = [];

  const entity = [];
  if (rec.entity?.name) entity.push(`name: ${quote(rec.entity.name)}`);
  if (rec.entity?.element) entity.push(`element: ${quote(rec.entity.element)}`);
  if (entity.length) inner.push(`entity: { ${entity.join(', ')} }`);

  for (const field of [
    'label',
    'qualifier',
    'distinctValues',
    'useForValidation',
    'presentationVariantQualifier',
  ]) {
    if (rec[field] !== undefined && rec[field] !== null) {
      inner.push(`${field}: ${renderValue(rec[field])}`);
    }
  }

  const bindings = (rec.additionalBinding ?? []).filter((b) => {
    if (b?.precedent) return true;
    omitted.push(
      `additionalBinding ${JSON.stringify(b)} was not written: no precedent shows it`
    );
    return false;
  });
  if (bindings.length) {
    const rendered = bindings.map((b) => {
      const parts = [];
      for (const field of [
        'localElement',
        'localConstant',
        'localParameter',
        'element',
        'parameter',
        'usage',
      ]) {
        if (b[field] !== undefined && b[field] !== null) {
          parts.push(`${field}: ${renderValue(b[field])}`);
        }
      }
      notes.push(`additionalBinding taken from the precedent ${b.precedent}`);
      return `{ ${parts.join(', ')} }`;
    });
    inner.push(`additionalBinding: [ ${rendered.join(', ')} ]`);
  } else if (!(rec.additionalBinding ?? []).length) {
    notes.push(
      'no additionalBinding: it depends on the fields of the consuming view and cannot ' +
        'be inferred -- add one only from a real precedent'
    );
  }

  const body = inner.map((line) => `${indent}  ${line}`).join(',\n');
  const text = `${indent}@${VHD}: [{\n${body}\n${indent}}]`;
  return { text, notes, omitted };
}

/**
 * Validate, then render. The single entry point the tool uses.
 *
 * @returns {{text:string|null, validation:object, notes:string[], omitted:string[],
 *            warnings:string[]}}
 */
export function emit(rec, defs, opts = {}) {
  const validation = validateEmission(annotationKeys(rec), defs, opts);
  const warnings = [];

  if (!validation.ok) {
    // A refused key is not dropped quietly: nothing is rendered, and the caller reports
    // which key and why. Rendering "most of" a refused annotation would ship the
    // violation with a reassuring block next to it.
    return {
      text: null,
      validation,
      notes: [],
      omitted: [],
      warnings: validation.refused.map((r) => `${r.key} refused: ${r.reason}`),
    };
  }

  const rendered = renderAnnotation(rec, opts);
  if (validation.source) {
    warnings.push(...validation.unvalidated.map((u) => `${u.key} NOT VALIDATED: ${u.reason}`));
  } else {
    warnings.push(
      'NOT VALIDATED: ' +
        (validation.unvalidated[0]?.reason ?? 'no annotation definition source available') +
        ' -- scope and release state of every key below are unchecked'
    );
  }
  return { ...rendered, validation, warnings };
}

/**
 * The skeleton for a value help of our own, when no released standard entity fits.
 *
 * Two things are part of the template:
 *   - the NAME, from the installation's naming rule (`valueHelp.namePattern`, default
 *     `ZI_{entity}VH`) and its label prefix (`valueHelp.labelPrefix`) -- a naming convention is
 *     a team's choice, never this server's;
 *   - `@Metadata.ignorePropagatedAnnotations: true`, which is NOT a choice: without it a
 *     `@UI.hidden` from the source view propagates and the F4 renders empty.
 *
 * @param {{concept:string, source:string, key:string, text?:string}} spec
 * @param {{namePattern?:string, labelPrefix?:string}} naming
 */
export function renderOwnVhProposal(spec = {}, naming = {}) {
  const concept = String(spec.concept ?? 'Entity').replace(/[^A-Za-z0-9]/g, '');
  const pattern = naming.namePattern ?? 'ZI_{entity}VH';
  const name = pattern.replace('{entity}', concept);
  const source = spec.source ?? '<released source entity>';
  const key = spec.key ?? concept;
  const prefix = naming.labelPrefix ?? 'Value help - ';
  // A CDS label holds 60 characters; cut first, then escape, so a quote is never split.
  const label = `${prefix}${spec.text ?? concept}`.slice(0, 60).replace(/'/g, "''");
  const text = [
    `@AbapCatalog.viewEnhancementCategory: [#NONE]`,
    `@AccessControl.authorizationCheck: #NOT_REQUIRED`,
    `@EndUserText.label: '${label}'`,
    `@Metadata.ignorePropagatedAnnotations: true`,
    `@ObjectModel.usageType: { serviceQuality: #X, sizeCategory: #S, dataClass: #MIXED }`,
    `@Search.searchable: true`,
    `define view entity ${name}`,
    `  as select distinct from ${source}`,
    `{`,
    `      @Search.defaultSearchElement: true`,
    `  key ${key}`,
    `}`,
  ].join('\n');
  return {
    name,
    text,
    notes: [
      `name follows the configured naming rule ${pattern.replace('{entity}', '<entity>')} ` +
        '(valueHelp.namePattern)',
      '@Metadata.ignorePropagatedAnnotations: true is required: without it a @UI.hidden ' +
        'from the source view propagates and the F4 renders empty',
      'the new entity must also be exposed explicitly in the .srvd.srvdsrv of the ' +
        'service, or the ValueList points at an entity the service does not have',
    ],
  };
}
