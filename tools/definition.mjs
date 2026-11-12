// adt_find_definition -- where is the symbol at one position of a class defined? The IDE's F3,
// on the source the system stores.
//
// MEASURED 2026-11-10 (lib/navigation.mjs; docs/adt-api-reference.md, "Backlog reads"; decision
// in docs/security.md). The server needs the source as a body: this tool reads the class's stored
// active main source through the guarded client and sends exactly that text. The caller names
// the class and a position, never the text.

import { record } from '../lib/audit.mjs';
import { resolveObject } from '../lib/resolve.mjs';
import { buildNavigationRequest, navigationPost, parseNavigationTarget, NavigationViolation } from '../lib/navigation.mjs';
import { finish } from '../lib/completeness.mjs';

const TOOL = 'adt_find_definition';
const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

export function definitionTool(cfg, session, journal) {
  return {
    definition: {
      name: TOOL,
      description:
        'Where the symbol at one position of a class is defined (the IDE\'s F3): the target ' +
        'object, its source URI, line and column. The position is in the stored active main ' +
        'source of the class, as adt_read_source shows it and adt_syntax_check reports ' +
        'positions. Two calls: the source is read, then sent as the request body.',
      inputSchema: {
        type: 'object',
        properties: {
          objectName: { type: 'string', description: 'The class, e.g. ZCL_DEMO' },
          objectType: { type: 'string', description: 'Optional ADT type: CLAS/OC' },
          line: { type: 'integer', minimum: 1, description: 'Line in the main source, from 1' },
          column: { type: 'integer', minimum: 0, description: 'Column of the symbol, as ADT positions count it' },
        },
        required: ['objectName', 'line', 'column'],
      },
    },
    async handler({ objectName, objectType, line, column }) {
      if (!session?.raw) throw new NavigationViolation('this session has no raw client: the definition cannot be asked.');
      const name = String(objectName ?? '').trim();
      if (!name) throw new NavigationViolation(`${TOOL} needs an objectName.`);
      const type = objectType ? String(objectType).trim().toUpperCase() : undefined;
      if (type && type !== 'CLAS/OC') throw new NavigationViolation(`only a class (CLAS/OC) is measured; got ${type}.`);
      const { hit, foundBy } = await resolveObject(session.api, name, type, 'metadata');
      const subject = `${hit['adtcore:type']} ${hit['adtcore:name']}`;
      if (hit['adtcore:type'] !== 'CLAS/OC') throw new NavigationViolation(`${subject} is not a class: only a class's main source is measured.`);
      const object = { name: hit['adtcore:name'], type: hit['adtcore:type'], uri: hit['adtcore:uri'], foundBy };
      const sourceUri = `${hit['adtcore:uri']}/source/main`;

      // 1. The stored active source, through the guarded client: the only text the body can carry.
      let source;
      try {
        source = await session.api.getObjectSource(sourceUri);
      } catch (e) {
        journal?.gap?.({
          code: 'SOURCE_NOT_READ',
          subject,
          detail: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 300),
          impact: 'the position could not be sent: where this symbol is defined is unknown -- NOT "defined nowhere"',
          fallback: 'adt_read_source on the class, or F3 in the IDE',
        });
        throw e;
      } finally {
        record(cfg, TOOL, `${subject} source`, String(source ?? '').length);
      }
      const built = buildNavigationRequest({ sourceUri, line, column, storedSource: source });

      // 2. The navigation POST.
      let res;
      try {
        res = await navigationPost(session.raw, built);
      } catch (e) {
        journal?.gap?.({
          code: 'DEFINITION_NOT_READ',
          subject: `${subject} ${built.line},${built.column}`,
          detail: `${e.name ?? 'Error'}: ${e.message}`.slice(0, 300),
          impact: 'where this symbol is defined is unknown -- NOT "defined nowhere"',
          fallback: 'F3 on the position in the IDE, or adt_where_used / adt_read_source by name',
        });
        throw e;
      } finally {
        // One line per call: the object and the position, never a line of source.
        record(cfg, TOOL, `${subject} ${built.line},${built.column}`, res?.bytes ?? 0);
      }
      const { target, targets, drift } = parseNavigationTarget(res.body);
      if (drift.length) {
        journal?.gap?.({
          code: 'SHAPE_DRIFT',
          subject: `${subject} navigation target`,
          detail: drift.map((d) => `<${d.node}>`).join('; ').slice(0, 300),
          impact: 'the answer stands, but the measured shape no longer describes this reply fully',
          fallback: 're-read the raw reply and update lib/navigation.mjs and docs/adt-api-reference.md',
        });
      }
      const incomplete = drift.length ? [{ list: 'target', code: 'PARSE_FAILED', count: drift.length, reason: 'nodes the measured shape does not describe: see drift' }] : [];
      return asText(finish({
        object,
        position: { line: built.line, column: built.column },
        found: Boolean(target),
        targetCount: targets.length,
        ...(target
          ? { target: { ...target, sameObject: target.objectUri === object.uri } }
          : { reason: 'the server named no definition for this position: it answered, and named none' }),
        ...(targets.length > 1 ? { targets: targets.map((t) => ({ ...t, sameObject: t.objectUri === object.uri })) } : {}),
        rule:
          'the definition the server resolves in the stored active source; an unsaved editor ' +
          'buffer is not seen. Read the target with adt_read_source.',
        ...(drift.length ? { drift } : {}),
      }, incomplete));
    },
  };
}
